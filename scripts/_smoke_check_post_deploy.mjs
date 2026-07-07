// Post-deploy smoke check. Confirms new external_id format isn't breaking
// anything by inspecting the most-recent capi_delivery_log rows for failures.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(" Post-deploy smoke check — last 30 events");
console.log("═══════════════════════════════════════════════════════════════════════════");

// Most-recent events
const { data: recent } = await sb
  .from("capi_delivery_log")
  .select("event_name, status, http_status, error_msg, sent_at, trace_id")
  .eq("store_id", SHOP)
  .order("sent_at", { ascending: false })
  .limit(30);

let sent = 0, failed = 0;
const errors = [];
for (const r of recent ?? []) {
  if (r.status === "sent") sent++;
  else {
    failed++;
    errors.push(`  ${r.sent_at}  ${r.event_name}  HTTP ${r.http_status}  ${r.error_msg ?? "(no msg)"}`);
  }
}

const oldest = recent[recent.length - 1];
const newest = recent[0];
const spanMin = ((new Date(newest.sent_at) - new Date(oldest.sent_at)) / 60000).toFixed(1);

console.log(`\nLast 30 events span: ${spanMin} min  (newest=${newest.sent_at}, oldest=${oldest.sent_at})`);
console.log(`  sent:   ${sent}`);
console.log(`  failed: ${failed}`);
if (errors.length) {
  console.log(`\nFAILURES:`);
  for (const e of errors) console.log(e);
} else {
  console.log(`\n✓ Zero failures in last 30 events`);
}

// Check for retries piling up (a sign of new failures)
const { count: retryCount } = await sb
  .from("capi_retries")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP);
console.log(`\ncapi_retries pending: ${retryCount ?? 0}`);

// Visitor row growth — new visitor_ids being minted as expected
const { count: visitorCount } = await sb
  .from("visitors")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP);
console.log(`visitors total: ${visitorCount ?? 0}`);

// Connection still healthy
const { data: conn } = await sb
  .from("meta_pixel_connections")
  .select("status, status_reason, last_event_sent_at")
  .eq("store_id", SHOP)
  .single();
console.log(`\nconnection status: ${conn.status}${conn.status_reason ? ` (${conn.status_reason})` : ""}`);
console.log(`last_event_sent_at: ${conn.last_event_sent_at}`);

const lastEventAge = ((Date.now() - new Date(conn.last_event_sent_at)) / 1000).toFixed(0);
console.log(`(${lastEventAge}s ago)`);

console.log("\n═══════════════════════════════════════════════════════════════════════════");
if (failed === 0 && (retryCount ?? 0) === 0 && conn.status === "active") {
  console.log(" ✓ Pipeline healthy. New external_id format accepted by Meta.");
} else {
  console.log(" ⚠ Issues detected — see above");
}
console.log("═══════════════════════════════════════════════════════════════════════════");
