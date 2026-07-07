// Diagnose why 6 of today's 10 trendy-homes orders did not fire CAPI.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// 1. Connection row, raw
const { data: conn } = await sb.from("meta_pixel_connections").select("*").eq("store_id", SHOP).maybeSingle();
console.log("meta_pixel_connections columns + values:");
for (const [k, v] of Object.entries(conn ?? {})) {
  const dispVal = k === "access_token" || k === "refresh_token" || k === "system_user_token"
    ? (v ? `present(${String(v).length} chars)` : "—")
    : v;
  console.log(`  ${k}: ${dispVal}`);
}

// 2. Earliest CAPI log entry today + last entry yesterday → find the silence boundary.
const ts = new Date(Date.now() - 36*60*60*1000).toISOString();
const { data: log } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, status, sent_at")
  .eq("store_id", SHOP)
  .gte("sent_at", ts)
  .order("sent_at", { ascending: true });
console.log(`\nLast 36h of capi_delivery_log for trendy-homes (${log?.length} rows)`);
console.log(`  Earliest: ${log?.[0]?.sent_at}  ${log?.[0]?.event_name}`);
console.log(`  Latest:   ${log?.[log.length-1]?.sent_at}  ${log?.[log.length-1]?.event_name}`);

// 3. Find the GAP — list any gap between consecutive log entries > 1 hour
console.log(`\n  Gaps > 1h between consecutive events:`);
let prev = null;
for (const r of log ?? []) {
  if (prev) {
    const dt = (new Date(r.sent_at) - new Date(prev.sent_at)) / 60000;
    if (dt > 60) {
      console.log(`    ${prev.sent_at} → ${r.sent_at}  (gap = ${dt.toFixed(0)} min)`);
    }
  }
  prev = r;
}

// 4. Check capi_retries for any of the missing events
const missingIds = ["7663117173052","7663069823292","7662978367804","7662691516732","7662582989116","7662573027644"];
const missingEventIds = missingIds.map(id => `purchase:${SHOP}:${id}`);
const { data: retries } = await sb
  .from("capi_retries")
  .select("*")
  .in("event_id", missingEventIds);
console.log(`\ncapi_retries for the 6 missing purchase events: ${retries?.length ?? 0}`);

// 5. Check if Shopify EVEN delivered the orders/create webhook for those 6.
// We don't have direct webhook log table — but we have order_attribution row presence.
const { data: attr } = await sb
  .from("order_attribution")
  .select("shopify_order_id, channel, capi_sent_at, created_at")
  .eq("store_id", SHOP)
  .in("shopify_order_id", missingIds);
console.log(`\norder_attribution rows for the 6 missing orders: ${attr?.length ?? 0}`);
for (const a of attr ?? []) console.log(" ", a);

// 6. Cross-check shop's other Purchase events today to confirm shape
const todayStart = "2026-05-10T19:00:00Z";
const { data: purchases } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, http_status, sent_at, error_msg")
  .eq("store_id", SHOP)
  .eq("event_name", "Purchase")
  .gte("sent_at", todayStart)
  .order("sent_at", { ascending: true });
console.log(`\nAll Purchase rows for trendy-homes today: ${purchases?.length ?? 0}`);
for (const p of purchases ?? []) console.log(" ", p.sent_at, p.status, p.http_status, p.event_id);

// 7. ad_tracking_settings (the URL fallback / etc — to make sure not paused)
const { data: settings } = await sb
  .from("ad_tracking_settings")
  .select("*")
  .eq("store_id", SHOP)
  .maybeSingle();
console.log(`\nad_tracking_settings:`);
console.log(settings);
