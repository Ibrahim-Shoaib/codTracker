// Verify order #9386 was transmitted normally end-to-end:
//  1. Shopify has it (source of truth)
//  2. capi_delivery_log shows status=sent for purchase event
//  3. capi_retries does NOT have a row for it (no failures)
//  4. order_attribution row exists (dashboard channel breakdown)
//  5. Inspect what fbp/fbc/visitor_id the order arrived with — confirms the
//     theme block + Web Pixel are working again post-reconnect.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const ORDER_NAME = "#9386";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: sessions } = await sb
  .from("shopify_sessions")
  .select("accessToken")
  .eq("shop", SHOP)
  .eq("isOnline", false);
const accessToken = sessions[0].accessToken;

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const todayPktDate = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
const startUtc = new Date(`${todayPktDate}T00:00:00Z`).getTime() - PKT_OFFSET_MS;
const startIso = new Date(startUtc).toISOString();

const url = `https://${SHOP}/admin/api/2025-01/orders.json?` +
  new URLSearchParams({ created_at_min: startIso, status: "any", limit: "5" });
const r = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
const { orders } = await r.json();

const o = orders.find((x) => x.name === ORDER_NAME);
if (!o) {
  console.error(`Order ${ORDER_NAME} not found in Shopify (latest names: ${orders.map((x) => x.name).join(", ")})`);
  process.exit(1);
}

console.log(`═══ Shopify side ═══`);
console.log(`  ${o.name} (id=${o.id})`);
console.log(`  created_at:    ${o.created_at}`);
console.log(`  processed_at:  ${o.processed_at}`);
console.log(`  total_price:   ${o.total_price} ${o.currency}`);
console.log(`  source_name:   ${o.source_name}`);
console.log(`  financial:     ${o.financial_status}`);
console.log(`  customer:      ${o.customer?.email ?? "(no email)"} / ${o.customer?.phone ?? o.phone ?? "(no phone)"}`);
console.log(`  client_ip:     ${o.client_details?.browser_ip ?? "(none)"}`);

console.log(`\n  cart attributes (note_attributes):`);
const targetKeys = ["_cod_visitor_id", "_fbp", "_fbc", "_fbclid", "_cod_event_id", "_client_ua"];
const present = {};
for (const k of targetKeys) {
  const a = (o.note_attributes ?? []).find((x) => x.name === k || x.key === k);
  present[k] = a?.value ?? null;
  console.log(`    ${k.padEnd(20)} ${a?.value ? `✓ "${String(a.value).slice(0, 80)}${String(a.value).length > 80 ? "..." : ""}"` : "✗ (missing)"}`);
}
console.log(`  landing_site:  ${o.landing_site ?? "(none)"}`);

console.log(`\n═══ CAPI delivery log ═══`);
const expectedEventId = `purchase:${SHOP}:${o.id}`;
const customEventId = present._cod_event_id;
const { data: log } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, status, http_status, error_msg, trace_id, sent_at")
  .eq("store_id", SHOP)
  .or(`event_id.eq.${expectedEventId}${customEventId ? `,event_id.eq.${customEventId}` : ""}`)
  .order("sent_at", { ascending: false });
if (!log?.length) {
  console.log(`  ✗ NO ROW found for event_id ${expectedEventId}${customEventId ? ` or ${customEventId}` : ""}`);
} else {
  for (const row of log) {
    const ok = row.status === "sent" && row.http_status >= 200 && row.http_status < 300;
    console.log(`  ${ok ? "✓" : "✗"} ${row.event_name.padEnd(18)} status=${row.status} http=${row.http_status} trace=${row.trace_id ?? "—"} sent_at=${row.sent_at}`);
    if (row.error_msg) console.log(`    error: ${row.error_msg}`);
  }
}

console.log(`\n═══ CAPI retries (should be empty) ═══`);
const { data: retries } = await sb
  .from("capi_retries")
  .select("event_id, event_name, attempts, last_error, next_attempt_at")
  .eq("store_id", SHOP)
  .or(`event_id.eq.${expectedEventId}${customEventId ? `,event_id.eq.${customEventId}` : ""}`);
if (!retries?.length) {
  console.log(`  ✓ no pending retries`);
} else {
  for (const row of retries) {
    console.log(`  ⚠ ${row.event_name} attempts=${row.attempts} last_error=${row.last_error} next=${row.next_attempt_at}`);
  }
}

console.log(`\n═══ Order attribution (dashboard channel) ═══`);
const { data: attr } = await sb
  .from("order_attribution")
  .select("channel, utm_source, utm_medium, utm_campaign, fbclid_present, visitor_id, attributed_at")
  .eq("store_id", SHOP)
  .eq("shopify_order_id", o.id)
  .single();
if (!attr) {
  console.log(`  ✗ no row in order_attribution`);
} else {
  console.log(`  ✓ channel:      ${attr.channel}`);
  console.log(`    visitor_id:   ${attr.visitor_id ?? "(none)"}`);
  console.log(`    fbclid:       ${attr.fbclid_present ? "yes" : "no"}`);
  console.log(`    utm_source:   ${attr.utm_source ?? "(none)"}`);
  console.log(`    utm_campaign: ${attr.utm_campaign ?? "(none)"}`);
  console.log(`    attributed_at:${attr.attributed_at}`);
}

console.log(`\n═══ Verdict ═══`);
const hasGoodLog = log?.some((r) => r.event_name === "Purchase" && r.status === "sent" && r.http_status === 200);
const noRetries = !retries?.length;
const hasAttribution = !!attr;
const fullIdentity = !!present._fbp && !!present._cod_visitor_id;
console.log(`  CAPI sent + 200:           ${hasGoodLog ? "✓" : "✗"}`);
console.log(`  No pending retries:        ${noRetries ? "✓" : "✗"}`);
console.log(`  Channel attribution row:   ${hasAttribution ? "✓" : "✗"}`);
console.log(`  Full identity (fbp+vid):   ${fullIdentity ? "✓" : "⚠ partial — likely cart-attr race or merchant flow"}`);
