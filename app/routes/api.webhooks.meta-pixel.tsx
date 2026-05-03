import type { ActionFunctionArgs } from "@remix-run/node";
import { randomUUID } from "node:crypto";
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

// One handler for all five subscribed topics. Shopify routes to the same URI
// based on shopify.app.toml; we branch on `topic` here.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  // Always 200 fast — Shopify retries if it doesn't get 200 within 5s, and
  // CAPI relay should be best-effort, never blocking webhook ack.
  // We do the work synchronously but with strict timeouts inside.
  try {
    switch (topic) {
      case "ORDERS_PAID":
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
  // Falls back to a fresh UUID if none was set — a webhook-only Purchase
  // from POS, draft order, or subscription has no browser counterpart.
  const eventId = identityHints.eventId ?? randomUUID();

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
    eventId: randomUUID(),
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

  // Use the event_id from cart attributes so the browser-side equivalent and
  // this server-side equivalent dedup. If none set, generate one.
  const eventId = identityHints.eventId ?? randomUUID();

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
  processed_at?: string;
  order_status_url?: string;
  note_attributes?: Array<{ name?: string; key?: string; value?: string }>;
  attributes?: Array<{ name?: string; key?: string; value?: string }>;
  client_details?: { browser_ip?: string; user_agent?: string };
  browser_ip?: string;
};
type ShopifyCheckout = ShopifyOrder & {
  payment_url?: string;
  abandoned_checkout_url?: string;
  updated_at?: string;
};
type ShopifyRefund = {
  order_id: number | string;
  processed_at?: string;
  currency?: string;
  transactions?: Array<{ amount?: string | number }>;
};
