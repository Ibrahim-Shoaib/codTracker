// Comprehensive ad-tracking health check for the-trendy-homes-pk.myshopify.com.
// Run: node --env-file=.env scripts/_verify_ad_tracking_trendy.mjs
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function hr(t) {
  console.log("\n" + "═".repeat(70));
  console.log(" " + t);
  console.log("═".repeat(70));
}
function summary(rows, fields) {
  if (!rows?.length) {
    console.log("  (none)");
    return;
  }
  for (const r of rows) {
    const obj = {};
    for (const f of fields) obj[f] = r[f];
    console.log("  " + JSON.stringify(obj));
  }
}

// ─── 1. meta_pixel_connections ────────────────────────────────────────────
hr("1. meta_pixel_connections (the connection record)");
const { data: conn, error: connErr } = await sb
  .from("meta_pixel_connections")
  .select("*")
  .eq("store_id", SHOP)
  .maybeSingle();
if (connErr) console.error("  ERROR:", connErr.message);
if (!conn) console.log("  ❌ NO CONNECTION ROW for this shop");
else {
  console.log("  store_id           :", conn.store_id);
  console.log("  config_id          :", conn.config_id);
  console.log("  business_id        :", conn.business_id, "(", conn.business_name, ")");
  console.log("  dataset_id         :", conn.dataset_id, "(", conn.dataset_name, ")");
  console.log("  ad_account_id      :", conn.ad_account_id ?? "(null)");
  console.log("  web_pixel_id       :", conn.web_pixel_id ?? "(null)");
  console.log("  status             :", conn.status, conn.status_reason ? `(${conn.status_reason})` : "");
  console.log("  bisu_token present :", !!conn.bisu_token, "len:", conn.bisu_token?.length ?? 0);
  console.log("  connected_at       :", conn.connected_at);
  console.log("  last_event_sent_at :", conn.last_event_sent_at);
  console.log("  last_health_check  :", conn.last_health_check);
}

// ─── 2. capi_delivery_log ────────────────────────────────────────────────
hr("2. capi_delivery_log — recent CAPI events");
const { data: logRows, error: logErr } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, status, http_status, error_msg, trace_id, sent_at")
  .eq("store_id", SHOP)
  .order("sent_at", { ascending: false })
  .limit(30);
if (logErr) console.error("  ERROR:", logErr.message);
console.log(`  total rows returned (capped at 30): ${logRows?.length ?? 0}`);
summary(logRows ?? [], ["event_name", "status", "http_status", "trace_id", "sent_at"]);

// totals + breakdown by status
const { count: sentCount } = await sb
  .from("capi_delivery_log")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP)
  .eq("status", "sent");
const { count: failedCount } = await sb
  .from("capi_delivery_log")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP)
  .eq("status", "failed");
console.log(`  totals — sent: ${sentCount ?? 0}, failed: ${failedCount ?? 0}`);

// recent failures detail
const { data: failures } = await sb
  .from("capi_delivery_log")
  .select("event_name, http_status, error_msg, sent_at")
  .eq("store_id", SHOP)
  .eq("status", "failed")
  .order("sent_at", { ascending: false })
  .limit(5);
if (failures?.length) {
  console.log("  recent failures:");
  summary(failures, ["event_name", "http_status", "error_msg", "sent_at"]);
}

// breakdown by event name (sent only)
const { data: allSent } = await sb
  .from("capi_delivery_log")
  .select("event_name")
  .eq("store_id", SHOP)
  .eq("status", "sent");
if (allSent?.length) {
  const tally = {};
  for (const r of allSent) tally[r.event_name] = (tally[r.event_name] ?? 0) + 1;
  console.log("  sent counts by event_name:");
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(20)} ${v}`);
  }
}

// ─── 3. capi_retries ──────────────────────────────────────────────────────
hr("3. capi_retries — events still in retry backoff");
const { data: retries, error: retriesErr } = await sb
  .from("capi_retries")
  .select("event_id, event_name, attempts, next_attempt_at, last_error, created_at")
  .eq("store_id", SHOP)
  .order("next_attempt_at", { ascending: true });
if (retriesErr) console.error("  ERROR:", retriesErr.message);
console.log(`  pending retries: ${retries?.length ?? 0}`);
summary(retries ?? [], ["event_name", "attempts", "next_attempt_at", "last_error"]);

// ─── 4. emq_snapshots ─────────────────────────────────────────────────────
hr("4. emq_snapshots — Event Match Quality history");
const { data: emq, error: emqErr } = await sb
  .from("emq_snapshots")
  .select("captured_at, overall_emq, per_event, per_field_coverage")
  .eq("store_id", SHOP)
  .order("captured_at", { ascending: false })
  .limit(7);
if (emqErr) console.error("  ERROR:", emqErr.message);
console.log(`  snapshots returned: ${emq?.length ?? 0}`);
for (const s of emq ?? []) {
  console.log(`  ─ ${s.captured_at} — overall=${s.overall_emq}`);
  console.log(`    per_event:`, JSON.stringify(s.per_event));
  console.log(`    per_field:`, JSON.stringify(s.per_field_coverage));
}

// ─── 5. visitors / visitor_events ────────────────────────────────────────
hr("5. visitors — cross-session identity store");
const { count: visitorCount } = await sb
  .from("visitors")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP);
console.log(`  visitors total: ${visitorCount ?? 0}`);

const { data: visSample } = await sb
  .from("visitors")
  .select(
    "visitor_id, em_hash, ph_hash, latest_fbp, latest_fbc, fbc_history, first_seen_at, last_seen_at"
  )
  .eq("store_id", SHOP)
  .order("last_seen_at", { ascending: false })
  .limit(5);
if (visSample?.length) {
  console.log("  most-recent 5 visitors:");
  for (const v of visSample) {
    console.log(`    ${v.visitor_id.slice(0, 16)}…  fbp=${!!v.latest_fbp}  fbc=${!!v.latest_fbc}  em=${!!v.em_hash}  ph=${!!v.ph_hash}  fbc_hist=${(v.fbc_history ?? []).length}  last_seen=${v.last_seen_at}`);
  }
} else {
  console.log("  (no visitor rows)");
}

const { count: eventCount } = await sb
  .from("visitor_events")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP);
console.log(`  visitor_events total: ${eventCount ?? 0}`);

const { data: evSample } = await sb
  .from("visitor_events")
  .select("event_name, occurred_at, fbp, fbc, utm_source, utm_campaign")
  .eq("store_id", SHOP)
  .order("occurred_at", { ascending: false })
  .limit(10);
if (evSample?.length) {
  console.log("  most-recent 10 visitor_events:");
  for (const e of evSample) {
    console.log(`    ${e.occurred_at}  ${e.event_name.padEnd(18)} fbp=${!!e.fbp} fbc=${!!e.fbc} utm=${e.utm_source ?? "-"}/${e.utm_campaign ?? "-"}`);
  }
} else {
  console.log("  (no visitor_events rows)");
}

// breakdown by event_name
if (evSample) {
  const { data: allEvs } = await sb
    .from("visitor_events")
    .select("event_name")
    .eq("store_id", SHOP);
  if (allEvs?.length) {
    const tally = {};
    for (const r of allEvs) tally[r.event_name] = (tally[r.event_name] ?? 0) + 1;
    console.log("  visitor_events tally:");
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(20)} ${v}`);
    }
  }
}

// ─── 6. stores row (meta ad account / token) ─────────────────────────────
hr("6. stores — the parent store record");
const { data: store, error: storeErr } = await sb
  .from("stores")
  .select(
    "store_id, meta_ad_account_id, meta_ad_account_name, meta_token_expires_at, last_meta_sync_at, meta_sync_error, meta_access_token"
  )
  .eq("store_id", SHOP)
  .maybeSingle();
if (storeErr) console.error("  ERROR:", storeErr.message);
if (!store) console.log("  ❌ NO STORE ROW");
else {
  console.log("  store_id              :", store.store_id);
  console.log("  meta_ad_account_id    :", store.meta_ad_account_id);
  console.log("  meta_ad_account_name  :", store.meta_ad_account_name);
  console.log("  meta_token_expires_at :", store.meta_token_expires_at);
  console.log("  last_meta_sync_at     :", store.last_meta_sync_at);
  console.log("  meta_sync_error       :", store.meta_sync_error);
  console.log("  has meta_access_token :", !!store.meta_access_token);
}

console.log("\n" + "═".repeat(70));
console.log(" Done.");
console.log("═".repeat(70));
