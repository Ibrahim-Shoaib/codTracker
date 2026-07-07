// Probe Meta Graph API for any endpoint that returns a real per-event EMQ
// score for our dataset. Tries multiple `aggregation` values on /stats and
// enumerates fields on the dataset object.
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../app/lib/crypto.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const GRAPH = "https://graph.facebook.com/v24.0";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: conn } = await sb
  .from("meta_pixel_connections")
  .select("dataset_id, bisu_token, business_id")
  .eq("store_id", SHOP)
  .maybeSingle();
const token = decryptSecret(conn.bisu_token);
const datasetId = conn.dataset_id;

console.log(`Probing dataset ${datasetId}\n`);

// ─── 1. Try a wide range of `aggregation` values on /stats ──────────────────
const aggregations = [
  "count",
  "had_pii",
  "customer_information_quality",
  "event_match_quality",
  "event_match_quality_score",
  "event_match_quality_per_event_name",
  "match_quality",
  "match_quality_per_event_name",
  "match_quality_score",
  "match_rate",
  "match_rate_per_event_name",
  "event_match_rate",
  "user_data_match_rate",
  "unique_events",
  "connection_method",
];

for (const agg of aggregations) {
  const params = new URLSearchParams({ access_token: token, aggregation: agg });
  const r = await fetch(`${GRAPH}/${datasetId}/stats?${params}`);
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const err = j?.error;
    console.log(`  ✗ ${agg.padEnd(40)} HTTP ${r.status}: ${err?.message?.slice(0, 80) ?? "?"}`);
    continue;
  }
  const buckets = j?.data;
  const bucketCount = Array.isArray(buckets) ? buckets.length : 0;
  // Take a sample row to see the shape
  let sample = "";
  if (bucketCount > 0) {
    const first = buckets[0];
    const rows = Array.isArray(first?.data) ? first.data : [];
    sample = rows.length > 0 ? JSON.stringify(rows[0]) : "(empty)";
  }
  console.log(`  ✓ ${agg.padEnd(40)} buckets=${bucketCount}  sample=${sample}`);
}

// ─── 2. Enumerate fields on the dataset object ──────────────────────────────
console.log(`\n--- Enumerate fields on dataset object ---`);

// First, ask Meta what fields are available with no field selector
const baseRes = await fetch(`${GRAPH}/${datasetId}?access_token=${token}`);
console.log(`  GET /{dataset_id} → HTTP ${baseRes.status}`);
console.log(`  ${JSON.stringify(await baseRes.json())}`);

// Try common match-quality field names directly
const fieldsToTry = [
  "match_quality",
  "match_rate",
  "match_rate_approx",
  "automatic_matching_fields",
  "event_stats",
  "data_use_setting",
  "first_party_cookie_status",
  "is_unavailable",
  "name",
  "id",
  "owner_business",
  "owner_ad_account",
  "creation_time",
  "last_fired_time",
  "user_match_rate",
  "ams_event_count",
  "advanced_matching_enabled",
  "config",
];
for (const f of fieldsToTry) {
  const r = await fetch(`${GRAPH}/${datasetId}?fields=${f}&access_token=${token}`);
  const j = await r.json().catch(() => null);
  if (r.ok) {
    console.log(`  ✓ ${f.padEnd(35)} ${JSON.stringify(j).slice(0, 120)}`);
  } else {
    console.log(`  ✗ ${f.padEnd(35)} ${j?.error?.message?.slice(0, 80) ?? "?"}`);
  }
}

// ─── 3. Try /diagnostics or other sub-paths ─────────────────────────────────
console.log(`\n--- Try sub-paths ---`);
const subpaths = ["diagnostics", "events_stats", "event_stats", "user_data_stats", "stats", "events"];
for (const sp of subpaths) {
  const r = await fetch(`${GRAPH}/${datasetId}/${sp}?access_token=${token}&limit=1`);
  const j = await r.json().catch(() => null);
  if (r.ok) {
    console.log(`  ✓ /${sp.padEnd(20)} → ${JSON.stringify(j).slice(0, 180)}`);
  } else {
    console.log(`  ✗ /${sp.padEnd(20)} HTTP ${r.status}: ${j?.error?.message?.slice(0, 80) ?? "?"}`);
  }
}

// ─── 4. /stats with /event_match_quality_score path ─────────────────────────
console.log(`\n--- Try /stats with various query params ---`);
const variants = [
  `aggregation=had_pii&breakdowns=event_name`,
  `aggregation=had_pii&breakdowns=match_keys`,
  `event_type=Purchase&aggregation=customer_information_quality`,
];
for (const v of variants) {
  const r = await fetch(`${GRAPH}/${datasetId}/stats?${v}&access_token=${token}`);
  const j = await r.json().catch(() => null);
  if (r.ok) {
    console.log(`  ✓ ${v.padEnd(60)} ${JSON.stringify(j).slice(0, 180)}`);
  } else {
    console.log(`  ✗ ${v.padEnd(60)} HTTP ${r.status}: ${j?.error?.message?.slice(0, 80) ?? "?"}`);
  }
}
