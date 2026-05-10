// One-off recovery: replay today's missed Purchase events to Meta CAPI for
// the-trendy-homes-pk. Background: merchant disconnected the Pixel last night
// and forgot to reconnect; 7 orders fired with no active connection so the
// webhook handler returned no_connection and silently dropped (nothing went
// into capi_retries). Pixel has since been reconnected, so we can pull the
// orders from Shopify Admin API and fire CAPI events directly.
//
// Identity available: hashed PII (email/phone/name/address) + IP/UA from
// client_details. fbp/fbc/_cod_visitor_id are absent because the Web Pixel
// was uninstalled at disconnect, so the theme-block didn't write them. Match
// quality will rely on Advanced Matching.
//
// Run:
//   DRY_RUN=1 node --env-file=.env scripts/_replay_missed_capi_today.mjs
//   node --env-file=.env scripts/_replay_missed_capi_today.mjs
//
// Env-flag knobs:
//   DRY_RUN=1            — print payloads, don't send
//   SKIP_DRAFT=1         — skip orders with source_name=shopify_draft_order
//   ORDER_IDS=a,b,c      — only send these (Shopify numeric ids)

import { createClient } from "@supabase/supabase-js";
import {
  buildCAPIEvent,
  sendCAPIEventsForShop,
} from "../app/lib/meta-capi.server.js";
import { buildUserData } from "../app/lib/meta-hash.server.js";
import {
  extractIdentityFromOrder,
  extractCustomerIdentity,
} from "../app/lib/cart-attributes.server.js";
import {
  getVisitor,
  findVisitorByFbclid,
  findRecentVisitorByIpUa,
  pickBestFbc,
} from "../app/lib/visitors.server.js";
import {
  recordOrderAttribution,
  markAttributionCapiSent,
} from "../app/lib/channel-attribution.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const DRY_RUN = process.env.DRY_RUN === "1";
const SKIP_DRAFT = process.env.SKIP_DRAFT === "1";
const ORDER_FILTER = process.env.ORDER_IDS
  ? new Set(process.env.ORDER_IDS.split(",").map((s) => s.trim()))
  : null;

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Pull the offline session token to call Shopify Admin API.
const { data: sessions } = await sb
  .from("shopify_sessions")
  .select("shop, accessToken")
  .eq("shop", SHOP)
  .eq("isOnline", false);
if (!sessions?.length) {
  console.error("No offline Shopify session for", SHOP);
  process.exit(1);
}
const accessToken = sessions[0].accessToken;

// Today PKT window.
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const todayPktDate = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
const startUtc = new Date(`${todayPktDate}T00:00:00Z`).getTime() - PKT_OFFSET_MS;
const startIso = new Date(startUtc).toISOString();

// Default Shopify Admin REST returns the full order payload (no fields filter)
// — we need customer.email/phone/first_name/last_name, shipping_address,
// client_details, note_attributes, line_items, total_price, processed_at.
const url = `https://${SHOP}/admin/api/2025-01/orders.json?` +
  new URLSearchParams({
    created_at_min: startIso,
    status: "any",
    limit: "100",
  });

const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
if (!res.ok) {
  console.error(`Shopify API ${res.status}:`, await res.text());
  process.exit(1);
}
const { orders } = await res.json();

console.log(`Pulled ${orders.length} orders since ${startIso} (${todayPktDate} 00:00 PKT)\n`);

let attempted = 0;
let succeeded = 0;
let failed = 0;
let skipped = 0;

for (const order of orders) {
  const orderIdStr = String(order.id);

  if (ORDER_FILTER && !ORDER_FILTER.has(orderIdStr)) {
    continue;
  }
  if (SKIP_DRAFT && order.source_name === "shopify_draft_order") {
    console.log(`⏭  ${order.name} skipped (source_name=shopify_draft_order)`);
    skipped++;
    continue;
  }

  const identityHints = extractIdentityFromOrder(order);
  const customer = extractCustomerIdentity(order);

  // Mirror handleOrderPaid's three-tier visitor lookup — without it, the
  // recordOrderAttribution call below skips Tier 1 (visitor_events scan for
  // utm_source=ig) and a Meta IAB order classified as instagram_ads gets
  // clobbered to facebook_ads (URL fallback can't see the IG referrer).
  let visitor = null;
  let recoveredVisitorId = identityHints.visitorId;
  if (recoveredVisitorId) {
    visitor = await getVisitor({ storeId: SHOP, visitorId: recoveredVisitorId });
  } else if (identityHints.fbclid) {
    visitor = await findVisitorByFbclid({ storeId: SHOP, fbclid: identityHints.fbclid });
    if (visitor) recoveredVisitorId = visitor.visitor_id;
  }
  if (!visitor && identityHints.clientIp && identityHints.clientUa) {
    visitor = await findRecentVisitorByIpUa({
      storeId: SHOP,
      ip: identityHints.clientIp,
      ua: identityHints.clientUa,
      referenceTime: order.processed_at ?? order.created_at,
      windowMinutes: 60,
    });
    if (visitor) recoveredVisitorId = visitor.visitor_id;
  }

  const { fbc: bestFbc } = pickBestFbc({
    cartAttrFbc: identityHints.fbc,
    visitor,
  });
  const externalIds = [];
  if (recoveredVisitorId) externalIds.push(recoveredVisitorId);
  if (customer.externalId) externalIds.push(customer.externalId);

  const userData = buildUserData({
    ...customer,
    externalId: externalIds.length ? externalIds : undefined,
    fbp: identityHints.fbp ?? visitor?.latest_fbp ?? undefined,
    fbc: bestFbc ?? undefined,
    clientIp: identityHints.clientIp ?? visitor?.latest_ip ?? undefined,
    clientUa: identityHints.clientUa ?? visitor?.latest_ua ?? undefined,
  });

  // Same deterministic id the webhook handler would have produced. Safe even
  // if Shopify ever re-fires the webhook for this order — Meta dedupes.
  const eventId = `purchase:${SHOP}:${order.id}`;

  const value = Number(order.current_total_price ?? order.total_price ?? 0);
  const currency = order.presentment_currency ?? order.currency ?? "PKR";
  const contentIds = (order.line_items ?? [])
    .map((li) => (li.product_id ? String(li.product_id) : null))
    .filter(Boolean);
  const numItems = (order.line_items ?? []).reduce(
    (sum, li) => sum + (li.quantity ?? 0),
    0
  );

  const eventTime = order.processed_at
    ? new Date(order.processed_at)
    : new Date(order.created_at);

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
      order_id: orderIdStr,
    },
  });

  attempted++;
  const matchKeys = Object.keys(userData);
  console.log(
    `→ ${order.name} (id=${order.id}) value=${value} ${currency} match_keys=[${matchKeys.join(",")}] event_id=${eventId}`
  );

  if (DRY_RUN) {
    console.log("   DRY_RUN — not sending. Payload preview:");
    console.log(JSON.stringify(event, null, 2));
    continue;
  }

  const result = await sendCAPIEventsForShop({ storeId: SHOP, events: [event] });
  if (result.ok) {
    succeeded++;
    console.log(
      `   ✓ sent — events_received=${result.eventsReceived} trace=${result.traceId}`
    );
    // Mirror the webhook handler: record channel attribution for the dashboard.
    // Pass landingSite so the URL-fallback classifier (Tier 2 in
    // channel-attribution.server.js) can credit Meta when fbclid is in the
    // landing URL — without this the replay clobbers a previously-correct
    // facebook_ads/instagram_ads classification with direct_organic.
    try {
      await recordOrderAttribution({
        storeId: SHOP,
        shopifyOrderId: order.id,
        visitorId: recoveredVisitorId ?? null,
        landingSite: order.landing_site ?? null,
        attributedAt: eventTime,
      });
    } catch (err) {
      console.log(`   ⚠ recordOrderAttribution failed: ${err?.message ?? err}`);
    }

    // Stamp capi_sent_at so the dashboard hero counts this as confirmed sent.
    try {
      await markAttributionCapiSent({ storeId: SHOP, shopifyOrderId: order.id });
    } catch (err) {
      console.log(`   ⚠ markAttributionCapiSent failed: ${err?.message ?? err}`);
    }
  } else {
    failed++;
    console.log(`   ✗ failed — reason=${result.reason}`);
  }
}

console.log(`\n─── Summary ───`);
console.log(`  Pulled:    ${orders.length}`);
console.log(`  Attempted: ${attempted}`);
console.log(`  Succeeded: ${succeeded}`);
console.log(`  Failed:    ${failed}`);
console.log(`  Skipped:   ${skipped}`);
if (DRY_RUN) console.log(`\n(DRY_RUN — no events were actually sent.)`);
