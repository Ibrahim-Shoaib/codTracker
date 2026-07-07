// Why did order #9393 (id=7660041437500) skip CAPI?
import { createClient } from "@supabase/supabase-js";
const SHOP = "the-trendy-homes-pk.myshopify.com";
const ORDER_ID = "7660041437500";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const eventId = `purchase:${SHOP}:${ORDER_ID}`;
console.log(`Checking event_id: ${eventId}\n`);

// 1. capi_delivery_log — any rows ever?
const { data: logs } = await sb
  .from("capi_delivery_log")
  .select("event_name, status, http_status, error_msg, sent_at, trace_id")
  .eq("store_id", SHOP)
  .eq("event_id", eventId)
  .order("sent_at", { ascending: false });
console.log(`capi_delivery_log rows: ${logs?.length ?? 0}`);
for (const l of logs ?? []) console.log(" ", l);

// 2. capi_retries
const { data: retries } = await sb
  .from("capi_retries")
  .select("*")
  .eq("store_id", SHOP)
  .eq("event_id", eventId);
console.log(`\ncapi_retries rows: ${retries?.length ?? 0}`);
for (const r of retries ?? []) console.log(" ", r);

// 3. meta_pixel_connections — was it active when #9393 fired (00:44 PKT = 19:44 UTC yesterday)?
const { data: conn } = await sb
  .from("meta_pixel_connections")
  .select("*")
  .eq("store_id", SHOP);
console.log(`\nmeta_pixel_connections rows: ${conn?.length ?? 0}`);
for (const c of conn ?? []) {
  console.log("  pixel_id:", c.pixel_id, "status:", c.status, "created_at:", c.created_at, "updated_at:", c.updated_at, "disconnected_at:", c.disconnected_at);
}

// 4. order_attribution row (we saw instagram_ads in audit — confirm)
const { data: attr } = await sb
  .from("order_attribution")
  .select("*")
  .eq("store_id", SHOP)
  .eq("shopify_order_id", ORDER_ID)
  .maybeSingle();
console.log(`\norder_attribution row:`, attr);

// 5. webhook arrival — check meta_sync_error or webhook tracking if exists
const tableNames = ["meta_sync_error", "webhook_log", "shopify_webhook_log"];
for (const t of tableNames) {
  const { data, error } = await sb.from(t).select("*").limit(1);
  if (error?.code === "42P01") continue;  // table not found
  console.log(`\nTable ${t} exists; sample: ${data?.length ?? 0} rows`);
}

// 6. Look at sibling events — what other events fired between 19:44Z and 19:50Z (around #9393's create time)
const around = new Date("2026-05-09T19:30:00Z");
const after = new Date("2026-05-09T20:30:00Z");
const { data: sibling } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, status, http_status, sent_at")
  .eq("store_id", SHOP)
  .gte("sent_at", around.toISOString())
  .lt("sent_at", after.toISOString())
  .order("sent_at", { ascending: true });
console.log(`\nAll CAPI deliveries between 2026-05-09T19:30Z and 20:30Z (the ±1h window around #9393 created):`);
for (const r of sibling ?? []) console.log(" ", r.event_id, "|", r.event_name, "|", r.status, "|", r.sent_at);
