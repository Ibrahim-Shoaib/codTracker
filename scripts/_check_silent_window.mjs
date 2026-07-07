// Find the silent-window boundary: when did CAPI stop firing for trendy yesterday, and when did it resume?
import { createClient } from "@supabase/supabase-js";
const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Last entries BEFORE 04:40Z today
const { data: pre } = await sb
  .from("capi_delivery_log")
  .select("event_name, status, sent_at")
  .eq("store_id", SHOP)
  .lt("sent_at", "2026-05-11T04:40:00Z")
  .order("sent_at", { ascending: false })
  .limit(5);
console.log("Last 5 CAPI entries BEFORE 04:40Z today:");
for (const r of pre ?? []) console.log(" ", r.sent_at, r.event_name, r.status);

// First entries AFTER 04:40Z today
const { data: post } = await sb
  .from("capi_delivery_log")
  .select("event_name, status, sent_at")
  .eq("store_id", SHOP)
  .gte("sent_at", "2026-05-11T04:00:00Z")
  .order("sent_at", { ascending: true })
  .limit(5);
console.log("\nFirst 5 CAPI entries AFTER 04:00Z today:");
for (const r of post ?? []) console.log(" ", r.sent_at, r.event_name, r.status);

// Were any OTHER shops also silent in that window? Check 2 different shops.
const { data: shops } = await sb.from("meta_pixel_connections").select("store_id").eq("status", "active");
console.log(`\nAll active shops: ${shops?.length}`);
for (const s of shops ?? []) {
  const { data: window } = await sb
    .from("capi_delivery_log")
    .select("sent_at", { count: "exact", head: false })
    .eq("store_id", s.store_id)
    .gte("sent_at", "2026-05-10T14:30:00Z")
    .lt("sent_at", "2026-05-11T04:40:00Z")
    .order("sent_at", { ascending: true })
    .limit(3);
  console.log(`  ${s.store_id}: ${window?.length ?? 0} events between 14:30Z May 10 and 04:40Z May 11`);
  for (const r of window ?? []) console.log(`     ${r.sent_at}`);
}
