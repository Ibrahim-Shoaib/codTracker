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

  const userData = buildUserData({
    ...customer,
    fbp: identityHints.fbp ?? undefined,
    fbc: identityHints.fbc ?? undefined,
    clientIp: identityHints.clientIp ?? undefined,
    clientUa: identityHints.clientUa ?? undefined,
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

  await sendCAPIEventsForShop({ storeId: shop, events: [event] });
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

  const userData = buildUserData({
    ...customer,
    fbp: identityHints.fbp ?? undefined,
    fbc: identityHints.fbc ?? undefined,
    clientIp: identityHints.clientIp ?? undefined,
    clientUa: identityHints.clientUa ?? undefined,
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
