// Find what fired LAST before the 9-hour CAPI silence (≈15:00Z → 00:12Z).
// If it was a 401/403/190 failure, the auth-error handler at meta-capi:213
// would have flipped status='error' and silently dropped everything after.
import { createClient } from "@supabase/supabase-js";
const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

console.log("─── Last CAPI events for shop BEFORE 15:00Z ───");
const { data: before } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, status, http_status, error_msg, sent_at, trace_id")
  .eq("store_id", SHOP)
  .lt("sent_at", "2026-05-09T15:00:00Z")
  .order("sent_at", { ascending: false })
  .limit(20);
for (const r of before ?? []) {
  console.log(` ${r.sent_at} | ${r.event_name.padEnd(20)} | ${r.status.padEnd(6)} | http=${r.http_status} | err=${r.error_msg ?? "—"}`);
}

console.log("\n─── ALL failed CAPI rows for shop in last 7 days ───");
const { data: failures } = await sb
  .from("capi_delivery_log")
  .select("event_name, status, http_status, error_msg, sent_at")
  .eq("store_id", SHOP)
  .eq("status", "failed")
  .order("sent_at", { ascending: false })
  .limit(50);
console.log(`  Total failed rows: ${failures?.length ?? 0}`);
for (const r of failures ?? []) {
  console.log(` ${r.sent_at} | ${r.event_name} | http=${r.http_status} | err=${r.error_msg}`);
}

console.log("\n─── ALL retries for shop in last 7 days ───");
const { data: retries } = await sb
  .from("capi_retries")
  .select("event_name, attempts, last_error, last_attempt_at, created_at")
  .eq("store_id", SHOP)
  .order("created_at", { ascending: false })
  .limit(30);
console.log(`  Total retry rows: ${retries?.length ?? 0}`);
for (const r of retries ?? []) {
  console.log(` ${r.created_at} | ${r.event_name} | attempts=${r.attempts} | err=${r.last_error}`);
}

// Sanity: pageview + product_viewed beacon endpoint also writes capi events.
// Show the very LAST event before #9393's webhook (19:44Z).
console.log("\n─── Last 5 events for shop strictly before #9393's webhook (19:44Z) ───");
const { data: lastBefore9393 } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, status, http_status, error_msg, sent_at")
  .eq("store_id", SHOP)
  .lt("sent_at", "2026-05-09T19:45:00Z")
  .order("sent_at", { ascending: false })
  .limit(5);
for (const r of lastBefore9393 ?? []) {
  console.log(` ${r.sent_at} | ${r.event_name.padEnd(20)} | ${r.status.padEnd(6)} | http=${r.http_status} | err=${r.error_msg ?? "—"}`);
}

// And visitor_events for the same shop right before 15:00Z — to know if the
// silence was caused by stopped traffic vs stopped CAPI.
console.log("\n─── visitor_events for shop in 14:50Z–15:10Z window ───");
const { data: ve } = await sb
  .from("visitor_events")
  .select("occurred_at, event_name, visitor_id")
  .eq("store_id", SHOP)
  .gte("occurred_at", "2026-05-09T14:50:00Z")
  .lt("occurred_at",  "2026-05-09T15:10:00Z")
  .order("occurred_at", { ascending: true });
console.log(`  Visitor events in 20-min window straddling silence start: ${ve?.length ?? 0}`);
for (const e of ve ?? []) console.log(`    ${e.occurred_at} | ${e.event_name} | ${e.visitor_id}`);
