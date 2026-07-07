// Reconcile dashboard vs CAPI log: dashboard reads order_attribution.capi_sent_at,
// my audit reads capi_delivery_log. If they disagree, one is stale or one is wrong.
import { createClient } from "@supabase/supabase-js";
const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ids = ["7664132751676","7664026779964","7663958229308","7663877882172","7663117173052","7663069823292","7662978367804","7662691516732","7662582989116","7662573027644"];

// Try numeric .in()
const idNums = ids.map(Number);
const { data: byNum, error: e1 } = await sb
  .from("order_attribution")
  .select("shopify_order_id, channel, capi_sent_at, created_at")
  .eq("store_id", SHOP)
  .in("shopify_order_id", idNums);
console.log(`.in(numeric): ${byNum?.length ?? 0} rows  err=${e1?.message ?? "—"}`);
for (const r of byNum ?? []) console.log(" ", r);

// Try string .in()
const { data: byStr, error: e2 } = await sb
  .from("order_attribution")
  .select("shopify_order_id, channel, capi_sent_at, created_at")
  .eq("store_id", SHOP)
  .in("shopify_order_id", ids);
console.log(`\n.in(string): ${byStr?.length ?? 0} rows  err=${e2?.message ?? "—"}`);

// Pull EVERY order_attribution row for trendy today by created_at
const todayStart = "2026-05-10T19:00:00Z";
const { data: today } = await sb
  .from("order_attribution")
  .select("shopify_order_id, channel, capi_sent_at, created_at, utm_campaign")
  .eq("store_id", SHOP)
  .gte("created_at", todayStart)
  .order("created_at", { ascending: false });
console.log(`\nAll order_attribution rows for trendy today: ${today?.length ?? 0}`);
for (const r of today ?? []) console.log(`  ${r.shopify_order_id}  channel=${r.channel}  capi_sent_at=${r.capi_sent_at ?? "—"}  created_at=${r.created_at}`);

// Cross-reference: for each row that has capi_sent_at set, check capi_delivery_log
console.log(`\n--- For each order_attribution row with capi_sent_at set, find capi_delivery_log row ---`);
for (const r of today ?? []) {
  if (!r.capi_sent_at) continue;
  const eventId = `purchase:${SHOP}:${r.shopify_order_id}`;
  const { data: log } = await sb
    .from("capi_delivery_log")
    .select("status, http_status, sent_at")
    .eq("store_id", SHOP)
    .eq("event_id", eventId);
  console.log(`  order ${r.shopify_order_id} (capi_sent_at=${r.capi_sent_at}): ${log?.length ?? 0} delivery_log rows`);
}
