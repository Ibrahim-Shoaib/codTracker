import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  buildCAPIEvent,
  sendCAPIEventsForShop,
} from "../lib/meta-capi.server.js";
import { buildUserData } from "../lib/meta-hash.server.js";
import {
  extractIdentityFromOrder,
  extractCustomerIdentity,
} from "../lib/cart-attributes.server.js";
import {
  getVisitor,
  findVisitorByFbclid,
  findRecentVisitorByIpUa,
  pickBestFbc,
} from "../lib/visitors.server.js";
import {
  recordOrderAttribution,
  markAttributionCapiSent,
} from "../lib/channel-attribution.server.js";

// Deterministic event_id for webhook-driven events. Critical for idempotency:
// Shopify retries any non-2xx webhook with the SAME resource id, so we MUST
// reuse the same event_id across retries — otherwise Meta double-counts the
// conversion. Format: "<event>:<shop>:<resource>" — stays under Meta's 100-char
// event_id limit even for very long shop domains.
function deterministicEventId(eventName: string, shop: string, resourceId: string | number) {
  return `${eventName.toLowerCase()}:${shop}:${resourceId}`;
}

// One handler for all five subscribed topics. Shopify routes to the same URI
// based on shopify.app.toml; we branch on `topic` here.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  // Always 200 fast — Shopify retries if it doesn't get 200 within 5s, and
  // CAPI relay should be best-effort, never blocking webhook ack.
  // We do the work synchronously but with strict timeouts inside.
  try {
    switch (topic) {
      case "ORDERS_CREATE":
      case "ORDERS_PAID":
        // Both topics route to the same Purchase handler; the deterministic
        // event_id (purchase:<shop>:<order_id>) ensures Meta dedupes when
        // both fire (which happens for traditional-payment stores —
        // orders/create + orders/paid land seconds apart). For COD stores,
        // only ORDERS_CREATE fires at conversion time; ORDERS_PAID may
        // fire days later when the merchant marks payment received, by
        // which point Meta's 7-day attribution window has often closed,
        // so ORDERS_CREATE is what actually drives optimization.
        await handleOrderPaid(shop, payload as ShopifyOrder);
        break;
      case "ORDERS_EDITED":
        // We could re-fire Purchase with corrected value, but most edits are
        // address fixes that don't move CAPI numbers. Skipping in v1.
        break;
      case "REFUNDS_CREATE":
        await handleRefund(shop, payload as ShopifyRefund);
        break;
      case "CHECKOUTS_CREATE":
      case "CHECKOUTS_UPDATE":
        await handleCheckout(shop, topic, payload as ShopifyCheckout);
        break;
      default:
        // Topic we don't handle (e.g. APP_UNINSTALLED routes elsewhere)
        break;
    }
  } catch (err) {
    // Logged but never re-thrown — failing to fire CAPI shouldn't NACK the webhook.
    console.error(`[meta-pixel webhook ${topic} ${shop}]`, err);
  }

  return new Response(null, { status: 200 });
};

// ─── Order paid → CAPI Purchase ───────────────────────────────────────────────

async function handleOrderPaid(shop: string, order: ShopifyOrder) {
  const identityHints = extractIdentityFromOrder(order);
  const customer = extractCustomerIdentity(order);

  // Cross-session enrichment — pull the visitor row written by earlier
  // /apps/tracking/track beacons. Gives us the original ad-click fbc
  // even when the current session's cart attribute is missing it
  // (Buy It Now, FB in-app browser, returning-after-7-days etc.) and
  // any identity fields seen in pre-checkout sessions.
  //
  // Three-tier lookup chain (each tier kicks in only when the prior misses):
  //   1. _cod_visitor_id cart attribute — works on regular-cart flows
  //      where identity-relay.js's /cart/update.js wrote through.
  //   2. fbclid extracted from order.landing_site — handles Meta IAB
  //      cases where cart attrs are stripped but the fbclid travels in
  //      the URL. Works when Facebook keeps the fbclid stable across
  //      page loads (typical Instagram IAB).
  //   3. IP + User-Agent + recency — handles Facebook iOS IAB where
  //      the fbclid rotates per page transition (so tier 2 misses).
  //      The buyer's IP and UA stay constant within the session even
  //      when cookies and fbclids are wiped between requests.
  let visitor = null;
  let recoveredVisitorId = identityHints.visitorId;
  let lookupSource = null;
  if (recoveredVisitorId) {
    visitor = await getVisitor({ storeId: shop, visitorId: recoveredVisitorId });
    lookupSource = "cart_attribute";
  } else if (identityHints.fbclid) {
    visitor = await findVisitorByFbclid({
      storeId: shop,
      fbclid: identityHints.fbclid,
    });
    if (visitor) {
      recoveredVisitorId = visitor.visitor_id;
      lookupSource = "fbclid";
    }
  }
  if (!visitor && identityHints.clientIp && identityHints.clientUa) {
    visitor = await findRecentVisitorByIpUa({
      storeId: shop,
      ip: identityHints.clientIp,
      ua: identityHints.clientUa,
      referenceTime: order.processed_at ?? order.created_at,
      windowMinutes: 60,
    });
    if (visitor) {
      recoveredVisitorId = visitor.visitor_id;
      lookupSource = "ip_ua";
    }
  }
  console.log(
    `[meta-pixel webhook ORDERS_${order.id}] visitor lookup: ${
      visitor ? `found via ${lookupSource}, visitor_id=${recoveredVisitorId}` : "miss"
    }`
  );

  // Pick best fbc: cart-attribute first (most-recent click), then
  // visitor.latest_fbc, then visitor.fbc_history. The landing_site
  // fallback inside extractIdentityFromOrder already populates
  // identityHints.fbc when the URL had ?fbclid=, so this only kicks in
  // for the "returning visitor whose original click cookie expired"
  // case — exactly the multi-session pattern we're solving.
  const { fbc: bestFbc, source: fbcSource } = pickBestFbc({
    cartAttrFbc: identityHints.fbc,
    visitor,
  });
  if (bestFbc && fbcSource !== "cart_attribute") {
    console.log(
      `[meta-pixel webhook ORDERS_${order.id}] fbc enriched from ${fbcSource}`
    );
  }

  // Combine visitor_id (cross-session browser identity, from cart attribute
  // OR recovered via fbclid lookup) with the order's customer.id (Shopify
  // account identity). Meta accepts an array of external_ids per event and
  // matches against any of them — this preserves the visitor's pre-purchase
  // browse history (where every event fired with external_id=visitor_id)
  // AND ties it to the merchant's customer-graph identity at conversion
  // time. Without both, an anonymous-then-logged-in visitor's pre-checkout
  // browses look like a different person from the buyer.
  const externalIds = [];
  if (recoveredVisitorId) externalIds.push(recoveredVisitorId);
  if (customer.externalId) externalIds.push(customer.externalId);

  const userData = buildUserData({
    ...customer,
    externalId: externalIds.length ? externalIds : undefined,
    fbp: identityHints.fbp ?? visitor?.latest_fbp ?? undefined,
    fbc: bestFbc ?? undefined,
    clientIp:
      identityHints.clientIp ?? visitor?.latest_ip ?? undefined,
    clientUa:
      identityHints.clientUa ?? visitor?.latest_ua ?? undefined,
  });

  // Use the event_id stamped onto cart attributes by our Custom Web Pixel
  // (so browser-side Purchase + this server-side Purchase share a dedup key).
  // Falls back to a deterministic id derived from order.id — webhook retries
  // for the same order will produce the same id, preventing Meta double-counts.
  const eventId =
    identityHints.eventId ?? deterministicEventId("purchase", shop, order.id);

  const value = Number(order.current_total_price ?? order.total_price ?? 0);
  const currency = order.presentment_currency ?? order.currency ?? "USD";
  const contentIds = (order.line_items ?? [])
    .map((li) => li.product_id ? String(li.product_id) : null)
    .filter(Boolean) as string[];
  const numItems = (order.line_items ?? []).reduce(
    (sum, li) => sum + (li.quantity ?? 0),
    0
  );

  const eventTime = order.processed_at
    ? new Date(order.processed_at)
    : new Date();

  const event = buildCAPIEvent({
    eventName: "Purchase",
    eventId,
    eventTime,
    eventSourceUrl: order.order_status_url ?? undefined,
    userData,
    customData: {
      currency,
      value,
      content_ids: contentIds,
      content_type: "product",
      num_items: numItems,
      order_id: String(order.id),
    },
  });

  const capiResult = await sendCAPIEventsForShop({ storeId: shop, events: [event] });

  // Record channel attribution for the Ad Tracking dashboard. Runs after
  // the CAPI fire so that latency-sensitive Meta delivery isn't gated on
  // a Postgres write. Idempotent on (store_id, shopify_order_id) so the
  // orders/create + orders/paid pair converges on a single row.
  await recordOrderAttribution({
    storeId: shop,
    shopifyOrderId: order.id,
    visitorId: recoveredVisitorId ?? null,
    landingSite: order.landing_site ?? null,
    attributedAt: order.processed_at ? new Date(order.processed_at) : new Date(),
  });

  // Stamp capi_sent_at on the attribution row so the dashboard hero can
  // count "actually confirmed sent" without relying on capi_delivery_log
  // (which has a 500-row-per-shop trim that evicts old Purchase entries
  // when beacon volume is high). Skipped on failure/silent-drop so the
  // row stays NULL and the recon cron picks it up next tick.
  if (capiResult.ok) {
    await markAttributionCapiSent({ storeId: shop, shopifyOrderId: order.id });
  }
}

// ─── Refund → negative-value Purchase (Custom Event "Refund") ─────────────────

async function handleRefund(shop: string, refund: ShopifyRefund) {
  // Refund webhooks don't carry full customer/order context — we recover what
  // we can from the embedded order_adjustments + transactions. For maximum
  // signal, the recommended pattern is to fire a custom "Refund" event so
  // it doesn't pollute Purchase metrics on Meta's side.
  const refundedTotal = (refund.transactions ?? []).reduce(
    (sum, t) => sum + Number(t.amount ?? 0),
    0
  );
  if (refundedTotal === 0) return;

  // Without an enriched order payload here, we can't supply customer hashes.
  // We fire a minimal event — Meta's algorithm will still subtract conversion
  // value from the matched original Purchase based on event_id linkage.
  const event = buildCAPIEvent({
    eventName: "Refund",
    // Deterministic — webhook retries for the same refund.id reuse this id.
    eventId: deterministicEventId(
      "refund",
      shop,
      `${refund.order_id}-${"id" in refund ? refund.id : refundedTotal}`
    ),
    eventTime: refund.processed_at ? new Date(refund.processed_at) : new Date(),
    userData: {}, // no identity available on refund webhook payload
    customData: {
      currency: refund.currency ?? "USD",
      value: -Math.abs(refundedTotal),
      order_id: String(refund.order_id),
    },
  });

  await sendCAPIEventsForShop({ storeId: shop, events: [event] });
}

// ─── Checkout created/updated → InitiateCheckout / AddPaymentInfo ─────────────

async function handleCheckout(
  shop: string,
  topic: string,
  checkout: ShopifyCheckout
) {
  const identityHints = extractIdentityFromOrder(checkout);
  const customer = extractCustomerIdentity(checkout);

  // Same three-tier visitor lookup as handleOrderPaid: cart-attribute,
  // then fbclid, then IP+UA+recency. See handleOrderPaid comment block
  // for the full rationale.
  let visitor = null;
  let recoveredVisitorId = identityHints.visitorId;
  if (recoveredVisitorId) {
    visitor = await getVisitor({ storeId: shop, visitorId: recoveredVisitorId });
  } else if (identityHints.fbclid) {
    visitor = await findVisitorByFbclid({
      storeId: shop,
      fbclid: identityHints.fbclid,
    });
    if (visitor) recoveredVisitorId = visitor.visitor_id;
  }
  if (!visitor && identityHints.clientIp && identityHints.clientUa) {
    visitor = await findRecentVisitorByIpUa({
      storeId: shop,
      ip: identityHints.clientIp,
      ua: identityHints.clientUa,
      referenceTime: checkout.updated_at ?? new Date(),
      windowMinutes: 60,
    });
    if (visitor) recoveredVisitorId = visitor.visitor_id;
  }
  const { fbc: bestFbc } = pickBestFbc({
    cartAttrFbc: identityHints.fbc,
    visitor,
  });

  // Match handleOrderPaid's external_id strategy — pass visitor_id (always)
  // and customer.id (when present, e.g. logged-in checkout) as an array.
  // For checkout events the customer.id is usually null so this collapses to
  // a single visitor_id, but the cross-session linkage still works.
  const externalIds = [];
  if (recoveredVisitorId) externalIds.push(recoveredVisitorId);
  if (customer.externalId) externalIds.push(customer.externalId);

  const userData = buildUserData({
    ...customer,
    externalId: externalIds.length ? externalIds : undefined,
    fbp: identityHints.fbp ?? visitor?.latest_fbp ?? undefined,
    fbc: bestFbc ?? undefined,
    clientIp:
      identityHints.clientIp ?? visitor?.latest_ip ?? undefined,
    clientUa:
      identityHints.clientUa ?? visitor?.latest_ua ?? undefined,
  });

  // CHECKOUTS_CREATE = InitiateCheckout. CHECKOUTS_UPDATE fires many times
  // during the funnel — we map "payment provider attached" to AddPaymentInfo
  // and skip the rest to avoid drowning Meta in noise.
  const eventName =
    topic === "CHECKOUTS_CREATE"
      ? "InitiateCheckout"
      : checkout.payment_url
      ? "AddPaymentInfo"
      : null;
  if (!eventName) return;

  // Meta CAPI rejects events whose user_data carries no matching parameter
  // with HTTP 400 "Invalid parameter" — wastes a delivery attempt and adds
  // a red row to the merchant's "Recent events" feed. CHECKOUTS_CREATE
  // fires the moment a visitor reaches the checkout page, BEFORE they've
  // entered email/phone, and if the cart-relay theme block hasn't yet
  // pushed fbp/fbc to cart attributes (race on first page-load), the
  // resulting user_data is genuinely empty. Skip the fire in that case —
  // an InitiateCheckout with no identity is worthless to Meta anyway, and
  // the eventual orders/paid webhook will carry full identity for the
  // canonical Purchase event.
  //
  // "Has any matching field" means: any hashed PII key, fbp, fbc, or the
  // (client_ip_address + client_user_agent) tuple per Meta's spec.
  const hasMatchableIdentity =
    !!userData.em ||
    !!userData.ph ||
    !!userData.fn ||
    !!userData.ln ||
    !!userData.ct ||
    !!userData.st ||
    !!userData.zp ||
    !!userData.country ||
    !!userData.external_id ||
    !!userData.fbp ||
    !!userData.fbc ||
    (!!userData.client_ip_address && !!userData.client_user_agent);
  if (!hasMatchableIdentity) {
    console.log(
      `[meta-pixel webhook ${topic} ${shop}] skipping ${eventName} — empty user_data (visitor hit checkout before identity-relay could write cart attrs)`
    );
    return;
  }

  // Use the event_id from cart attributes so the browser-side equivalent and
  // this server-side equivalent dedup. Fall back to a deterministic id keyed
  // by checkout token + event name so webhook retries (CHECKOUTS_UPDATE fires
  // many times during a single checkout) reuse the same id. Without this,
  // each retry produces a new event_id and Meta counts duplicate funnel events.
  const checkoutId =
    "token" in checkout && checkout.token
      ? checkout.token
      : checkout.id ?? "unknown";
  const eventId =
    identityHints.eventId ?? deterministicEventId(eventName, shop, checkoutId);

  const value = Number(checkout.total_price ?? 0);
  const currency = checkout.presentment_currency ?? checkout.currency ?? "USD";
  const contentIds = (checkout.line_items ?? [])
    .map((li) => (li.product_id ? String(li.product_id) : null))
    .filter(Boolean) as string[];
  const numItems = (checkout.line_items ?? []).reduce(
    (sum, li) => sum + (li.quantity ?? 0),
    0
  );

  const event = buildCAPIEvent({
    eventName,
    eventId,
    eventTime: checkout.updated_at ? new Date(checkout.updated_at) : new Date(),
    eventSourceUrl: checkout.abandoned_checkout_url ?? undefined,
    userData,
    customData: {
      currency,
      value,
      content_ids: contentIds,
      num_items: numItems,
      content_type: "product",
    },
  });

  await sendCAPIEventsForShop({ storeId: shop, events: [event] });
}

// ─── Webhook payload types ────────────────────────────────────────────────────
// Minimal shapes — Shopify sends much more, but we only access what we need.
// Using `unknown` + casts keeps us type-safe without modeling the entire API.

type ShopifyLineItem = { product_id?: number | string; quantity?: number };
type ShopifyAddress = {
  city?: string;
  province?: string;
  province_code?: string;
  zip?: string;
  country?: string;
  country_code?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
};
type ShopifyOrder = {
  id: number | string;
  email?: string;
  phone?: string;
  customer?: {
    id?: number | string;
    email?: string;
    phone?: string;
    first_name?: string;
    last_name?: string;
  };
  shipping_address?: ShopifyAddress;
  billing_address?: ShopifyAddress;
  line_items?: ShopifyLineItem[];
  current_total_price?: string | number;
  total_price?: string | number;
  currency?: string;
  presentment_currency?: string;
  created_at?: string;
  processed_at?: string;
  order_status_url?: string;
  // landing_site is the URL the visitor first hit. For Meta-ad clicks it
  // carries ?fbclid=... — extractIdentityFromOrder reads this as a fallback
  // when cart attributes are empty (Buy It Now flow, FB in-app browser).
  landing_site?: string;
  referring_site?: string;
  note_attributes?: Array<{ name?: string; key?: string; value?: string }>;
  attributes?: Array<{ name?: string; key?: string; value?: string }>;
  client_details?: { browser_ip?: string; user_agent?: string };
  browser_ip?: string;
};
type ShopifyCheckout = ShopifyOrder & {
  token?: string;
  payment_url?: string;
  abandoned_checkout_url?: string;
  updated_at?: string;
};
type ShopifyRefund = {
  id?: number | string;
  order_id: number | string;
  processed_at?: string;
  currency?: string;
  transactions?: Array<{ amount?: string | number; kind?: string }>;
};
