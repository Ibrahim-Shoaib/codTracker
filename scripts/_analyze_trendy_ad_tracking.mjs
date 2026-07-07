// Comprehensive ad-tracking health check for Trendy Homes
// Pulls: pixel connection state, web pixel install, theme embed,
// CAPI delivery (24h/7d), retries, EMQ snapshots, channel attribution,
// visitor identity coverage, order_attribution gap analysis.
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/_analyze_trendy_ad_tracking.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// crude .env loader (no dotenv dep)
try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PKT = 5 * 60 * 60 * 1000;
const now = new Date();
const today = new Date(now.getTime() + PKT).toISOString().slice(0, 10);
const startToday = new Date(`${today}T00:00:00Z`).getTime() - PKT;
const startWeek = startToday - 6 * 86400000;

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString());
const pad = (s, n) => String(s ?? "").padEnd(n);
const head = (s) => console.log("\n" + "═".repeat(80) + "\n " + s + "\n" + "═".repeat(80));
const sub = (s) => console.log("\n── " + s + " ──");

console.log(`\nAd-Tracking analysis for ${SHOP}`);
console.log(`Today PKT: ${today} (now ${now.toISOString()})`);

// ── 1. Store row ──
head("1. STORE STATE");
const { data: store, error: storeErr } = await sb
  .from("stores")
  .select("*")
  .eq("store_id", SHOP)
  .single();

if (storeErr || !store) {
  console.error("Store row not found:", storeErr);
  process.exit(1);
}

console.log(`  shop_name:                ${store.shop_name ?? "—"}`);
console.log(`  currency:                 ${store.currency} (${store.money_format})`);
console.log(`  ingest_mode:              ${store.ingest_mode}`);
console.log(`  is_demo:                  ${store.is_demo}`);
console.log(`  onboarding_complete:      ${store.onboarding_complete} (step ${store.onboarding_step})`);
console.log(`  postex token present:     ${!!store.postex_token}`);
console.log(`  meta_access_token:        ${store.meta_access_token ? "present" : "—"}`);
console.log(`  meta_ad_account:          ${store.meta_ad_account_id ?? "—"} (${store.meta_ad_account_name ?? "—"})`);
console.log(`  meta_ad_account_currency: ${store.meta_ad_account_currency ?? "—"}`);
console.log(`  meta_token_expires_at:    ${store.meta_token_expires_at ?? "—"}`);
console.log(`  meta_sync_error:          ${store.meta_sync_error ?? "—"}`);
console.log(`  last_postex_sync_at:      ${store.last_postex_sync_at ?? "—"}`);
console.log(`  last_meta_sync_at:        ${store.last_meta_sync_at ?? "—"}`);

// ── 2. Pixel connection ──
head("2. META PIXEL CONNECTION");
const { data: pixel } = await sb
  .from("meta_pixel_connections")
  .select("dataset_id, business_id, business_name, ad_account_id, web_pixel_id, status, embed_status, created_at, updated_at, last_event_at")
  .eq("store_id", SHOP)
  .maybeSingle();

if (!pixel) {
  console.log("  ⚠  No meta_pixel_connections row — pixel not connected.");
} else {
  console.log(`  dataset_id:      ${pixel.dataset_id}`);
  console.log(`  business:        ${pixel.business_name ?? "—"} (${pixel.business_id ?? "—"})`);
  console.log(`  ad_account_id:   ${pixel.ad_account_id ?? "—"}`);
  console.log(`  web_pixel_id:    ${pixel.web_pixel_id ?? "—"}  (web-pixel install)`);
  console.log(`  status:          ${pixel.status}`);
  console.log(`  embed_status:    ${pixel.embed_status ?? "—"}  (theme app-embed)`);
  console.log(`  created_at:      ${pixel.created_at}`);
  console.log(`  updated_at:      ${pixel.updated_at}`);
  console.log(`  last_event_at:   ${pixel.last_event_at ?? "—"}`);
}

// ── 3. CAPI delivery: last 24h breakdown by event ──
head("3. CAPI DELIVERY (last 24h, then today PKT)");
const last24Iso = new Date(now.getTime() - 86400000).toISOString();

const { data: capi24 } = await sb
  .from("capi_delivery_log")
  .select("event_name, status, http_status, error_msg, sent_at, event_id, source")
  .eq("store_id", SHOP)
  .gte("sent_at", last24Iso)
  .order("sent_at", { ascending: false });

sub(`Last 24h: ${capi24?.length ?? 0} rows`);
const byEvent24 = {};
for (const r of capi24 ?? []) {
  const k = r.event_name;
  byEvent24[k] ??= { sent: 0, failed: 0, distinct: new Set(), distinct_sent: new Set(), latest: null };
  byEvent24[k].distinct.add(r.event_id);
  if (r.status === "sent") {
    byEvent24[k].sent++;
    byEvent24[k].distinct_sent.add(r.event_id);
  } else byEvent24[k].failed++;
  if (!byEvent24[k].latest || r.sent_at > byEvent24[k].latest) byEvent24[k].latest = r.sent_at;
}
console.log(`  ${pad("event", 22)} ${pad("rows", 6)} ${pad("sent", 6)} ${pad("failed", 7)} ${pad("distinct", 9)} ${pad("dist_sent", 10)} latest`);
for (const [k, v] of Object.entries(byEvent24)) {
  console.log(`  ${pad(k, 22)} ${pad(v.sent + v.failed, 6)} ${pad(v.sent, 6)} ${pad(v.failed, 7)} ${pad(v.distinct.size, 9)} ${pad(v.distinct_sent.size, 10)} ${v.latest}`);
}

// today PKT
const { data: capiToday } = await sb
  .from("capi_delivery_log")
  .select("event_name, status, error_msg, sent_at, event_id, source, http_status")
  .eq("store_id", SHOP)
  .gte("sent_at", new Date(startToday).toISOString())
  .order("sent_at", { ascending: false });

sub(`Today PKT (${today}): ${capiToday?.length ?? 0} rows`);
const purchToday = (capiToday ?? []).filter((r) => r.event_name === "Purchase");
const distinctPurchToday = new Set(purchToday.map((r) => r.event_id));
const distinctPurchSentToday = new Set(purchToday.filter((r) => r.status === "sent").map((r) => r.event_id));
console.log(`  Purchase rows:                 ${purchToday.length}`);
console.log(`  Distinct Purchase event_ids:   ${distinctPurchToday.size}`);
console.log(`  Distinct Purchase sent:        ${distinctPurchSentToday.size}`);

const byEventToday = {};
for (const r of capiToday ?? []) {
  byEventToday[r.event_name] ??= { sent: 0, failed: 0 };
  if (r.status === "sent") byEventToday[r.event_name].sent++;
  else byEventToday[r.event_name].failed++;
}
console.log("  Per-event today:");
for (const [k, v] of Object.entries(byEventToday)) {
  console.log(`    ${pad(k, 22)} sent=${v.sent} failed=${v.failed}`);
}

// failures detail
const failures = (capi24 ?? []).filter((r) => r.status !== "sent");
if (failures.length) {
  sub(`Recent failures (last 24h): ${failures.length}`);
  for (const r of failures.slice(0, 8)) {
    console.log(`  [${r.sent_at}] ${pad(r.event_name, 18)} http=${r.http_status ?? "?"} → ${(r.error_msg ?? "").slice(0, 120)}`);
  }
}

// ── 4. CAPI retry queue ──
head("4. CAPI RETRY QUEUE");
const { data: retries } = await sb
  .from("capi_retries")
  .select("event_name, attempt_count, last_error, next_attempt_at, created_at")
  .eq("store_id", SHOP)
  .order("next_attempt_at", { ascending: true });

console.log(`  Pending retries: ${retries?.length ?? 0}`);
for (const r of (retries ?? []).slice(0, 10)) {
  console.log(`  ${pad(r.event_name, 18)} attempts=${r.attempt_count} next=${r.next_attempt_at} err=${(r.last_error ?? "").slice(0, 80)}`);
}

// ── 5. EMQ snapshots ──
head("5. EVENT MATCH QUALITY (last 14 days)");
const since14 = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);
const { data: emq } = await sb
  .from("emq_snapshots")
  .select("snapshot_date, dataset_id, overall_emq, event_scores, field_coverage")
  .eq("store_id", SHOP)
  .gte("snapshot_date", since14)
  .order("snapshot_date", { ascending: false });

console.log(`  Snapshots: ${emq?.length ?? 0}`);
console.log(`  ${pad("date", 12)} ${pad("dataset", 18)} ${pad("overall", 8)} per-event scores`);
for (const e of emq ?? []) {
  const ev = e.event_scores
    ? Object.entries(e.event_scores).map(([k, v]) => `${k}=${v?.score ?? v}`).join(" ")
    : "—";
  console.log(`  ${pad(e.snapshot_date, 12)} ${pad(e.dataset_id, 18)} ${pad(e.overall_emq, 8)} ${ev}`);
}
if (emq?.[0]?.field_coverage) {
  sub("Latest field coverage (Purchase)");
  const fc = emq[0].field_coverage?.Purchase ?? emq[0].field_coverage;
  console.log("  " + JSON.stringify(fc, null, 2).split("\n").join("\n  "));
}

// ── 6. Channel attribution (last 7d) ──
head("6. ORDER CHANNEL ATTRIBUTION (last 7 days)");
const { data: attr } = await sb
  .from("order_attribution")
  .select("channel, order_id, order_name, fbclid, utm_source, utm_medium, utm_campaign, visitor_id, capi_sent_at, created_at")
  .eq("store_id", SHOP)
  .gte("created_at", new Date(startWeek).toISOString())
  .order("created_at", { ascending: false });

console.log(`  Total order_attribution rows (7d): ${attr?.length ?? 0}`);
const byCh = {};
for (const a of attr ?? []) {
  byCh[a.channel] ??= { count: 0, capi_sent: 0, with_visitor: 0, with_fbclid: 0 };
  byCh[a.channel].count++;
  if (a.capi_sent_at) byCh[a.channel].capi_sent++;
  if (a.visitor_id) byCh[a.channel].with_visitor++;
  if (a.fbclid) byCh[a.channel].with_fbclid++;
}
console.log(`  ${pad("channel", 18)} ${pad("orders", 8)} ${pad("capi_sent", 10)} ${pad("w/ visitor_id", 14)} w/ fbclid`);
for (const [k, v] of Object.entries(byCh)) {
  console.log(`  ${pad(k, 18)} ${pad(v.count, 8)} ${pad(v.capi_sent, 10)} ${pad(v.with_visitor, 14)} ${v.with_fbclid}`);
}

// today subset
const attrToday = (attr ?? []).filter((a) => new Date(a.created_at).getTime() >= startToday);
sub(`Today PKT subset: ${attrToday.length}`);
const todayCh = {};
for (const a of attrToday) {
  todayCh[a.channel] ??= 0;
  todayCh[a.channel]++;
}
console.log("  " + JSON.stringify(todayCh));

// ── 7. CAPI gap: orders without capi_sent_at ──
sub("Orders missing CAPI fire (last 7d, capi_sent_at IS NULL)");
const missingCapi = (attr ?? []).filter((a) => !a.capi_sent_at);
console.log(`  Count: ${missingCapi.length}`);
for (const a of missingCapi.slice(0, 10)) {
  console.log(`  ${pad(a.order_name ?? a.order_id, 14)} ch=${pad(a.channel, 16)} created=${a.created_at} fbclid=${a.fbclid ? "y" : "n"} vid=${a.visitor_id ? "y" : "n"}`);
}

// ── 8. Visitors table health ──
head("7. VISITOR IDENTITY STORE (last 7d activity)");
const { data: visitors } = await sb
  .from("visitors")
  .select("cod_visitor_id, last_seen_at, em_hash, ph_hash, fn_hash, fbp, fbc, fbc_history, utm_history")
  .eq("store_id", SHOP)
  .gte("last_seen_at", new Date(startWeek).toISOString());

const v = visitors ?? [];
console.log(`  Active visitors (7d): ${v.length}`);
let withEm = 0, withPh = 0, withFn = 0, withFbp = 0, withFbc = 0, withFbcHist = 0, withUtmHist = 0;
for (const r of v) {
  if (r.em_hash) withEm++;
  if (r.ph_hash) withPh++;
  if (r.fn_hash) withFn++;
  if (r.fbp) withFbp++;
  if (r.fbc) withFbc++;
  if (r.fbc_history && r.fbc_history.length > 0) withFbcHist++;
  if (r.utm_history && r.utm_history.length > 0) withUtmHist++;
}
const pct = (n) => v.length ? `${((n / v.length) * 100).toFixed(0)}%` : "—";
console.log(`  Coverage:`);
console.log(`    em_hash:      ${withEm} (${pct(withEm)})`);
console.log(`    ph_hash:      ${withPh} (${pct(withPh)})`);
console.log(`    fn_hash:      ${withFn} (${pct(withFn)})`);
console.log(`    fbp present:  ${withFbp} (${pct(withFbp)})`);
console.log(`    fbc present:  ${withFbc} (${pct(withFbc)})`);
console.log(`    fbc_history:  ${withFbcHist} (${pct(withFbcHist)})`);
console.log(`    utm_history:  ${withUtmHist} (${pct(withUtmHist)})`);

// ── 9. Visitor events activity ──
sub("visitor_events (last 24h, by event_name)");
const { data: vEvents } = await sb
  .from("visitor_events")
  .select("event_name, created_at")
  .eq("store_id", SHOP)
  .gte("created_at", last24Iso);

const byVe = {};
for (const e of vEvents ?? []) {
  byVe[e.event_name] ??= 0;
  byVe[e.event_name]++;
}
console.log(`  Total: ${vEvents?.length ?? 0}`);
for (const [k, v2] of Object.entries(byVe)) console.log(`    ${pad(k, 22)} ${v2}`);

// ── 10. Ad spend cross-check ──
head("8. AD SPEND vs PURCHASES (last 7d)");
const { data: spend } = await sb
  .from("ad_spend")
  .select("spend_date, amount")
  .eq("store_id", SHOP)
  .gte("spend_date", new Date(startWeek).toISOString().slice(0, 10))
  .order("spend_date", { ascending: false });

console.log(`  ${pad("date", 12)} amount (${store.currency})`);
let totalSpend = 0;
for (const s of spend ?? []) {
  totalSpend += Number(s.amount) || 0;
  console.log(`  ${pad(s.spend_date, 12)} ${fmt(s.amount)}`);
}
console.log(`  ─ 7d total: ${fmt(totalSpend.toFixed(0))} ${store.currency}`);

// ── 11. Recent orders w/ flags ──
head("9. RECENT ORDERS (last 24h, PostEx)");
const { data: recentOrders } = await sb
  .from("orders")
  .select("order_ref_number, transaction_date, transaction_status, status_code, is_delivered, is_in_transit, is_returned, invoice_payment, shopify_order_id, cogs_match_source")
  .eq("store_id", SHOP)
  .gte("transaction_date", last24Iso)
  .order("transaction_date", { ascending: false })
  .limit(15);

console.log(`  Rows: ${recentOrders?.length ?? 0}`);
for (const o of recentOrders ?? []) {
  const flag = o.is_delivered ? "DELIV" : o.is_returned ? "RET  " : o.is_in_transit ? "TRANS" : "?    ";
  console.log(`  ${pad(o.order_ref_number, 10)} ${pad(o.transaction_date, 25)} ${flag} pay=${pad(fmt(o.invoice_payment), 10)} cogs=${pad(o.cogs_match_source ?? "—", 14)} sopify=${o.shopify_order_id ?? "—"}`);
}

console.log("\n" + "═".repeat(80) + "\n DONE\n" + "═".repeat(80) + "\n");
