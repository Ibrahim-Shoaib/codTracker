// Final cross-check that the dashboard, Meta CAPI delivery log, and Shopify
// orders all agree for today.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const todayPkt = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
const startUtc = new Date(`${todayPkt}T00:00:00Z`).getTime() - PKT_OFFSET_MS;
const startIso = new Date(startUtc).toISOString();

// 1) Shopify orders today
const { data: sessions } = await sb.from("shopify_sessions").select("accessToken").eq("shop", SHOP).eq("isOnline", false);
const r = await fetch(
  `https://${SHOP}/admin/api/2025-01/orders.json?` +
    new URLSearchParams({ created_at_min: startIso, status: "any", limit: "100" }),
  { headers: { "X-Shopify-Access-Token": sessions[0].accessToken } }
);
const { orders } = await r.json();
console.log(`═══ Shopify orders today (since ${todayPkt} 00:00 PKT) ═══`);
console.log(`  Count: ${orders.length}`);
for (const o of orders) {
  const hasFbpAttr = (o.note_attributes ?? []).some((a) => (a.name === "_fbp" || a.key === "_fbp"));
  const hasVisitorAttr = (o.note_attributes ?? []).some((a) => (a.name === "_cod_visitor_id" || a.key === "_cod_visitor_id"));
  const hasUaAttr = (o.note_attributes ?? []).some((a) => (a.name === "_client_ua" || a.key === "_client_ua"));
  const ua = o.client_details?.user_agent ?? "";
  const isIab = /\bInstagram\b|IABMV\/|FB_IAB|FBAV/.test(ua);
  console.log(
    `  ${o.name.padEnd(8)} ${String(o.id).padEnd(16)} ${o.total_price.padStart(8)} ${o.source_name.padEnd(20)} ${isIab ? "IAB" : "   "} ` +
    `cart_attrs: fbp=${hasFbpAttr ? "✓" : "✗"} vid=${hasVisitorAttr ? "✓" : "✗"} ua=${hasUaAttr ? "✓" : "✗"}`
  );
}

// 2) order_attribution rows today
console.log(`\n═══ order_attribution rows attributed today ═══`);
const { data: attribs } = await sb
  .from("order_attribution")
  .select("shopify_order_id, channel, utm_source, utm_campaign, attributed_at")
  .eq("store_id", SHOP)
  .gte("attributed_at", startIso)
  .order("attributed_at", { ascending: true });
const channelCounts = { facebook_ads: 0, instagram_ads: 0, direct_organic: 0 };
for (const a of attribs ?? []) {
  channelCounts[a.channel]++;
  console.log(`  ${a.shopify_order_id.padEnd(16)} ${a.channel.padEnd(15)} utm=${a.utm_source ?? "(none)"} ${a.attributed_at}`);
}
console.log(`\n  By channel:  facebook_ads=${channelCounts.facebook_ads}  instagram_ads=${channelCounts.instagram_ads}  direct_organic=${channelCounts.direct_organic}  total=${(attribs ?? []).length}`);

// 3) capi_delivery_log for today
console.log(`\n═══ capi_delivery_log entries today ═══`);
const { data: cdl } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, status, http_status, sent_at")
  .eq("store_id", SHOP)
  .eq("event_name", "Purchase")
  .gte("sent_at", startIso)
  .order("sent_at", { ascending: true });
const uniqueEventIds = new Set();
let allOk = true;
for (const c of cdl ?? []) {
  uniqueEventIds.add(c.event_id);
  if (c.status !== "sent" || c.http_status !== 200) allOk = false;
  console.log(`  ${(c.status === "sent" ? "✓" : "✗")} ${c.event_id.padEnd(70)} http=${c.http_status} ${c.sent_at}`);
}
console.log(`\n  Total log entries:    ${(cdl ?? []).length}`);
console.log(`  Unique event_ids:     ${uniqueEventIds.size} (Meta dedupes — orders/create + orders/paid both log)`);
console.log(`  All HTTP 200:         ${allOk ? "✓" : "✗"}`);

// 4) capi_retries (should be empty)
const { data: retries } = await sb.from("capi_retries").select("event_id").eq("store_id", SHOP);
console.log(`\n═══ capi_retries pending ═══`);
console.log(`  ${retries?.length ?? 0} pending  ${(retries?.length ?? 0) === 0 ? "✓" : "⚠"}`);

// 5) Cross-reference: every Shopify order has both an attribution row and a CAPI fire
console.log(`\n═══ Cross-reference (every order should have both) ═══`);
const attribIds = new Set((attribs ?? []).map((a) => a.shopify_order_id));
const capiIds = new Set();
for (const c of cdl ?? []) {
  const m = c.event_id.match(/purchase:[^:]+:(.+)$/);
  if (m) capiIds.add(m[1]);
}
let coverageOk = true;
for (const o of orders) {
  const id = String(o.id);
  const hasAttrib = attribIds.has(id);
  const hasCapi = capiIds.has(id);
  const ok = hasAttrib && hasCapi;
  if (!ok) coverageOk = false;
  console.log(`  ${o.name.padEnd(8)} order_attribution=${hasAttrib ? "✓" : "✗"}  capi_delivery_log=${hasCapi ? "✓" : "✗"}  ${ok ? "" : "⚠ GAP"}`);
}
console.log(`\n  100% coverage: ${coverageOk ? "✓ every order is fully covered" : "✗ gaps detected"}`);

// 6) IAB capture-rate snapshot — useful for measuring keepalive impact going forward
console.log(`\n═══ IAB cart-attr capture rate (baseline before keepalive deploy) ═══`);
let iabTotal = 0, iabWithUa = 0, iabWithVid = 0, iabWithFbp = 0;
for (const o of orders) {
  const ua = o.client_details?.user_agent ?? "";
  if (!/\bInstagram\b|IABMV\/|FB_IAB|FBAV/.test(ua)) continue;
  iabTotal++;
  if ((o.note_attributes ?? []).some((a) => (a.name === "_client_ua" || a.key === "_client_ua"))) iabWithUa++;
  if ((o.note_attributes ?? []).some((a) => (a.name === "_cod_visitor_id" || a.key === "_cod_visitor_id"))) iabWithVid++;
  if ((o.note_attributes ?? []).some((a) => (a.name === "_fbp" || a.key === "_fbp"))) iabWithFbp++;
}
console.log(`  IAB orders today:           ${iabTotal}`);
console.log(`  with _client_ua attr:       ${iabWithUa} / ${iabTotal}`);
console.log(`  with _cod_visitor_id attr:  ${iabWithVid} / ${iabTotal}`);
console.log(`  with _fbp attr:             ${iabWithFbp} / ${iabTotal}`);
console.log(`  → All orders before keepalive deploy. Compare to next day's numbers.`);
