// Unit tests for app/lib/meta-capi.server.js — payload builder + name mapping.
// Run with:  node --test tests/meta-capi.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCAPIEvent, shopifyEventToMeta } from "../app/lib/meta-capi.server.js";

// ─── Webhook idempotency contract ────────────────────────────────────────────
// Same shape as `deterministicEventId` in api.webhooks.meta-pixel.tsx.
// We test it here as a black-box invariant: the same inputs MUST produce the
// same event_id, otherwise Shopify webhook retries inflate Meta conversions.
function deterministicEventId(eventName, shop, resourceId) {
  return `${eventName.toLowerCase()}:${shop}:${resourceId}`;
}

test("deterministicEventId is stable across calls (idempotent webhook retries)", () => {
  const a = deterministicEventId("Purchase", "shop.myshopify.com", 12345);
  const b = deterministicEventId("Purchase", "shop.myshopify.com", 12345);
  assert.equal(a, b);
});

test("deterministicEventId differs across resources (no collision)", () => {
  assert.notEqual(
    deterministicEventId("Purchase", "shop.myshopify.com", 1),
    deterministicEventId("Purchase", "shop.myshopify.com", 2)
  );
});

test("deterministicEventId stays under Meta's 100-char limit for typical shops", () => {
  const id = deterministicEventId(
    "InitiateCheckout",
    "very-long-merchant-shop-name-12345.myshopify.com",
    "abcdef1234567890abcdef1234567890"
  );
  assert.ok(id.length <= 100, `event_id too long: ${id.length}`);
});

test("buildCAPIEvent requires eventName", () => {
  assert.throws(() =>
    buildCAPIEvent({ eventId: "x", eventTime: 0, userData: {} })
  );
});

test("buildCAPIEvent requires eventId", () => {
  assert.throws(() =>
    buildCAPIEvent({ eventName: "Purchase", eventTime: 0, userData: {} })
  );
});

test("buildCAPIEvent converts ms timestamps to seconds", () => {
  const ms = 1_700_000_000_000; // 2023-11-14
  const evt = buildCAPIEvent({
    eventName: "Purchase",
    eventId: "id",
    eventTime: ms,
    userData: {},
  });
  assert.equal(evt.event_time, Math.floor(ms / 1000));
});

test("buildCAPIEvent passes through second timestamps", () => {
  const s = 1_700_000_000;
  const evt = buildCAPIEvent({
    eventName: "Purchase",
    eventId: "id",
    eventTime: s,
    userData: {},
  });
  assert.equal(evt.event_time, s);
});

test("buildCAPIEvent converts Date objects to seconds", () => {
  const d = new Date("2025-05-03T12:00:00Z");
  const evt = buildCAPIEvent({
    eventName: "Purchase",
    eventId: "id",
    eventTime: d,
    userData: {},
  });
  assert.equal(evt.event_time, Math.floor(d.getTime() / 1000));
});

test("buildCAPIEvent defaults action_source to 'website'", () => {
  const evt = buildCAPIEvent({
    eventName: "Purchase",
    eventId: "id",
    userData: {},
  });
  assert.equal(evt.action_source, "website");
});

test("buildCAPIEvent omits empty custom_data", () => {
  const evt = buildCAPIEvent({
    eventName: "Purchase",
    eventId: "id",
    userData: {},
    customData: {},
  });
  assert.equal(evt.custom_data, undefined);
});

test("buildCAPIEvent includes custom_data when provided", () => {
  const evt = buildCAPIEvent({
    eventName: "Purchase",
    eventId: "id",
    userData: {},
    customData: { value: 100, currency: "PKR" },
  });
  assert.deepEqual(evt.custom_data, { value: 100, currency: "PKR" });
});

test("buildCAPIEvent includes event_source_url when provided", () => {
  const evt = buildCAPIEvent({
    eventName: "Purchase",
    eventId: "id",
    eventSourceUrl: "https://shop.com/checkout",
    userData: {},
  });
  assert.equal(evt.event_source_url, "https://shop.com/checkout");
});

// ─── Event name mapping ──────────────────────────────────────────────────────

test("shopifyEventToMeta maps known events", () => {
  assert.equal(shopifyEventToMeta("checkout_completed"), "Purchase");
  assert.equal(shopifyEventToMeta("product_added_to_cart"), "AddToCart");
  assert.equal(shopifyEventToMeta("product_viewed"), "ViewContent");
  assert.equal(shopifyEventToMeta("checkout_started"), "InitiateCheckout");
  assert.equal(shopifyEventToMeta("payment_info_submitted"), "AddPaymentInfo");
  assert.equal(shopifyEventToMeta("search_submitted"), "Search");
});

test("shopifyEventToMeta returns null for skipped events", () => {
  assert.equal(shopifyEventToMeta("cart_viewed"), null);
  assert.equal(shopifyEventToMeta("checkout_address_info_submitted"), null);
});

test("shopifyEventToMeta returns null for unknown events", () => {
  assert.equal(shopifyEventToMeta("custom_event_name"), null);
  assert.equal(shopifyEventToMeta(""), null);
});
