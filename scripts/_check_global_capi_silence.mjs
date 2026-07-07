// Was there ANY CAPI activity (any shop) between 12:23Z and 00:12Z 2026-05-09?
// If zero across all shops → server-wide silence (deploy issue / outage).
// If other shops fired → silence was specific to Trendy.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const start = "2026-05-09T12:23:22Z";
const end   = "2026-05-10T00:12:32Z";

const { data: byHour } = await sb.rpc("get_global_capi_silence_check");  // noop fallback
const { data: rows, error } = await sb
  .from("capi_delivery_log")
  .select("store_id, sent_at, event_name, status")
  .gte("sent_at", start)
  .lt("sent_at", end)
  .order("sent_at", { ascending: true })
  .limit(50);
console.log(`CAPI events across ALL shops in [${start}, ${end}): ${rows?.length ?? 0}${error ? " err: " + error.message : ""}`);
for (const r of (rows ?? []).slice(0, 20)) console.log(" ", r.sent_at, "|", r.store_id, "|", r.event_name, "|", r.status);

// And visitor_events for all shops in the same window — to see if traffic was
// hitting the server endpoints (proves the app was running / receiving requests).
const { data: ve } = await sb
  .from("visitor_events")
  .select("store_id, occurred_at, event_name")
  .gte("occurred_at", start)
  .lt("occurred_at", end)
  .order("occurred_at", { ascending: true })
  .limit(20);
console.log(`\nvisitor_events across ALL shops in same window (sample): ${ve?.length ?? 0}`);
for (const r of ve ?? []) console.log(" ", r.occurred_at, "|", r.store_id, "|", r.event_name);

// Count visitor_events per hour to see traffic density.
const { data: bucketed, error: buckErr } = await sb
  .from("visitor_events")
  .select("occurred_at")
  .gte("occurred_at", start)
  .lt("occurred_at", end);
if (!buckErr) {
  const counts = new Map();
  for (const r of bucketed ?? []) {
    const hour = r.occurred_at.slice(0, 13) + "Z";
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  console.log(`\nvisitor_events by hour:`);
  for (const [h, c] of [...counts].sort()) console.log(`  ${h}  ${c}`);
}
