// Inspect the Purchase events and their identity coverage.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

console.log("─── Purchase events in capi_delivery_log ───");
const { data: purchases } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, status, http_status, error_msg, trace_id, sent_at")
  .eq("store_id", SHOP)
  .eq("event_name", "Purchase")
  .order("sent_at", { ascending: false });
for (const p of purchases ?? []) {
  console.log(JSON.stringify(p));
}

console.log("\n─── InitiateCheckout events (should have identity) ───");
const { data: ics } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, http_status, error_msg, trace_id, sent_at")
  .eq("store_id", SHOP)
  .eq("event_name", "InitiateCheckout")
  .order("sent_at", { ascending: false });
for (const ic of ics ?? []) {
  console.log(JSON.stringify(ic));
}

console.log("\n─── AddToCart events ───");
const { data: atcs } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, http_status, error_msg, trace_id, sent_at")
  .eq("store_id", SHOP)
  .eq("event_name", "AddToCart")
  .order("sent_at", { ascending: false })
  .limit(5);
for (const a of atcs ?? []) {
  console.log(JSON.stringify(a));
}

console.log("\n─── Visitor identity-coverage histogram ───");
const { data: allVisitors } = await sb
  .from("visitors")
  .select("latest_fbp, latest_fbc, em_hash, ph_hash, fn_hash, latest_ip, latest_ua, fbc_history")
  .eq("store_id", SHOP);
let hasFbp = 0, hasFbc = 0, hasEmail = 0, hasPhone = 0, hasName = 0, hasIp = 0, hasUa = 0;
let multipleClicks = 0;
for (const v of allVisitors ?? []) {
  if (v.latest_fbp) hasFbp++;
  if (v.latest_fbc) hasFbc++;
  if (v.em_hash) hasEmail++;
  if (v.ph_hash) hasPhone++;
  if (v.fn_hash) hasName++;
  if (v.latest_ip) hasIp++;
  if (v.latest_ua) hasUa++;
  if ((v.fbc_history ?? []).length > 1) multipleClicks++;
}
const n = allVisitors?.length ?? 0;
console.log(`total visitors: ${n}`);
console.log(`  fbp coverage : ${hasFbp}/${n} = ${(100 * hasFbp / Math.max(1, n)).toFixed(1)}%`);
console.log(`  fbc coverage : ${hasFbc}/${n} = ${(100 * hasFbc / Math.max(1, n)).toFixed(1)}%`);
console.log(`  email hash   : ${hasEmail}/${n} = ${(100 * hasEmail / Math.max(1, n)).toFixed(1)}%`);
console.log(`  phone hash   : ${hasPhone}/${n} = ${(100 * hasPhone / Math.max(1, n)).toFixed(1)}%`);
console.log(`  first-name   : ${hasName}/${n} = ${(100 * hasName / Math.max(1, n)).toFixed(1)}%`);
console.log(`  ip + ua      : ${hasIp}/${n} & ${hasUa}/${n}`);
console.log(`  multi-click  : ${multipleClicks}/${n} (visitors with >1 fbc in history)`);

console.log("\n─── Time gaps between events (last 50) ───");
const { data: lastEvents } = await sb
  .from("capi_delivery_log")
  .select("event_name, sent_at")
  .eq("store_id", SHOP)
  .order("sent_at", { ascending: false })
  .limit(50);
if (lastEvents?.length) {
  const oldest = new Date(lastEvents[lastEvents.length - 1].sent_at);
  const newest = new Date(lastEvents[0].sent_at);
  const minutes = (newest - oldest) / 60000;
  console.log(`  ${lastEvents.length} events spanning ${minutes.toFixed(1)} minutes (newest=${newest.toISOString()}, oldest=${oldest.toISOString()})`);
}

console.log("\n─── Cart-relay sanity: visitor_events with fbp/fbc ratios ───");
const { data: vis } = await sb
  .from("visitor_events")
  .select("event_name, fbp, fbc")
  .eq("store_id", SHOP);
const tally = {};
for (const e of vis ?? []) {
  if (!tally[e.event_name]) tally[e.event_name] = { total: 0, fbp: 0, fbc: 0 };
  tally[e.event_name].total++;
  if (e.fbp) tally[e.event_name].fbp++;
  if (e.fbc) tally[e.event_name].fbc++;
}
for (const [k, v] of Object.entries(tally)) {
  console.log(`  ${k.padEnd(20)} total=${v.total}  fbp=${v.fbp} (${(100*v.fbp/v.total).toFixed(0)}%)  fbc=${v.fbc} (${(100*v.fbc/v.total).toFixed(0)}%)`);
}

// ─── ad_account_id mismatch check ───
console.log("\n─── ad_account_id cross-ref ───");
const { data: connRow } = await sb
  .from("meta_pixel_connections")
  .select("ad_account_id, dataset_id, business_id, business_name")
  .eq("store_id", SHOP)
  .single();
const { data: storeRow } = await sb
  .from("stores")
  .select("meta_ad_account_id, meta_ad_account_name")
  .eq("store_id", SHOP)
  .single();
console.log(`  meta_pixel_connections.ad_account_id: ${connRow?.ad_account_id ?? "(null)"}`);
console.log(`  meta_pixel_connections.business_id  : "${connRow?.business_id ?? "(null)"}"`);
console.log(`  meta_pixel_connections.business_name: ${connRow?.business_name ?? "(null)"}`);
console.log(`  stores.meta_ad_account_id           : ${storeRow?.meta_ad_account_id ?? "(null)"}`);
console.log(`  stores.meta_ad_account_name         : ${storeRow?.meta_ad_account_name ?? "(null)"}`);
