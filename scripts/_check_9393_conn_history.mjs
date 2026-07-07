// Find any meta_pixel_connections audit trail or related signals around
// 2026-05-09T19:44Z when order #9393 fired but CAPI silently dropped.
import { createClient } from "@supabase/supabase-js";
const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// 1. Full meta_pixel_connections row (all columns)
const { data: conn, error: connErr } = await sb
  .from("meta_pixel_connections")
  .select("*")
  .eq("store_id", SHOP)
  .single();
console.log("Connection row (all columns):");
console.log(conn);
if (connErr) console.log("err:", connErr);

// 2. Any failed-events around 19:44Z that night for ANY shop event_id?
const start = "2026-05-09T15:00:00Z";
const end = "2026-05-10T01:00:00Z";
const { data: fail } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, status, http_status, error_msg, sent_at")
  .eq("store_id", SHOP)
  .gte("sent_at", start)
  .lt("sent_at", end)
  .order("sent_at", { ascending: true });
console.log(`\nAll capi_delivery_log entries between ${start} and ${end}: ${fail?.length ?? 0}`);
for (const r of fail ?? []) console.log(" ", r.event_id, "|", r.event_name, "|", r.status, "|", r.http_status, "|", r.sent_at);

// 3. Visitors row for order #9393's visitor_id (already known: bfae3794-5d62-4478-943a-c12428807e29)
const { data: visitor } = await sb
  .from("visitors")
  .select("visitor_id, latest_fbc, latest_fbp, latest_ip, latest_ua, first_seen_at, last_seen_at")
  .eq("visitor_id", "bfae3794-5d62-4478-943a-c12428807e29")
  .maybeSingle();
console.log("\nVisitor record for #9393:");
console.log(visitor);

// 4. emq_snapshot if any
const { data: snap } = await sb
  .from("emq_snapshot")
  .select("*")
  .eq("store_id", SHOP)
  .order("snapshot_at", { ascending: false })
  .limit(5);
console.log(`\nLatest emq_snapshot rows: ${snap?.length ?? 0}`);
for (const s of snap ?? []) console.log(" ", s);
