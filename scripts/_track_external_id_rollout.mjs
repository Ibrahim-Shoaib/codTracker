// Track external_id coverage over time. Run periodically post-deploy to
// watch the rollout: pre-deploy events show ~13% external_id; post-deploy
// events should climb toward ~100% as Meta processes the new format.
//
// Meta's stats endpoint has hourly buckets with 30-60 min processing
// delay — i.e., events fired NOW won't appear in match_keys data for
// up to an hour.
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../app/lib/crypto.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const { data: conn } = await sb
  .from("meta_pixel_connections")
  .select("dataset_id, bisu_token")
  .eq("store_id", SHOP)
  .single();
const token = decryptSecret(conn.bisu_token);
const ds = conn.dataset_id;

// Pull match_keys + event totals
const [matchKeysRes, totalsRes] = await Promise.all([
  fetch(
    `https://graph.facebook.com/v24.0/${ds}/stats?` +
      new URLSearchParams({ access_token: token, aggregation: "match_keys" })
  ),
  fetch(
    `https://graph.facebook.com/v24.0/${ds}/stats?` +
      new URLSearchParams({ access_token: token, aggregation: "event" })
  ),
]);
const matchKeysJson = await matchKeysRes.json();
const totalsJson = await totalsRes.json();

// Per-hour external_id coverage by event_name
console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(" external_id coverage per hourly bucket (last 24h)");
console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(`${"hour-bucket-start".padEnd(28)} event              total  ext_id  cov%`);
console.log("─".repeat(80));

// Build map of (hour → event → total)
const totalsMap = new Map(); // start_time -> Map(event -> count)
for (const bucket of totalsJson.data ?? []) {
  const m = new Map();
  for (const row of bucket.data ?? []) {
    m.set(row.value, Number(row.count ?? 0));
  }
  totalsMap.set(bucket.start_time, m);
}

// Build map of (hour → event → external_id_count)
const externalIdMap = new Map();
for (const bucket of matchKeysJson.data ?? []) {
  const m = new Map();
  for (const row of bucket.data ?? []) {
    if (row.value === "external_id") {
      m.set(row.event, Number(row.count ?? 0));
    }
  }
  externalIdMap.set(bucket.start_time, m);
}

// Print most-recent 8 hourly buckets
const sortedHours = [...totalsMap.keys()].sort().reverse().slice(0, 8).reverse();
for (const hour of sortedHours) {
  const totals = totalsMap.get(hour);
  const externals = externalIdMap.get(hour) ?? new Map();
  for (const [event, total] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
    const ext = externals.get(event) ?? 0;
    const pct = total > 0 ? ((100 * ext) / total).toFixed(0) : "—";
    const bar = "█".repeat(Math.round((100 * ext) / total / 5));
    console.log(
      `${hour.padEnd(28)} ${event.padEnd(18)} ${String(total).padStart(5)}  ${String(ext).padStart(5)}  ${pct.padStart(3)}%  ${bar}`
    );
  }
  console.log();
}

// Aggregate last 1h (likely no-data yet) and last 6h (baseline period)
console.log("─".repeat(80));
console.log("Summary:");
const newestHour = sortedHours[sortedHours.length - 1];
const totalsLast = totalsMap.get(newestHour) ?? new Map();
const extLast = externalIdMap.get(newestHour) ?? new Map();
let totLast = 0, extL = 0;
for (const [, c] of totalsLast) totLast += c;
for (const [, c] of extLast) extL += c;
console.log(`  Most recent hour bucket (${newestHour}):`);
console.log(`    total events: ${totLast}, external_id coverage: ${totLast > 0 ? ((100 * extL) / totLast).toFixed(0) : "—"}%`);

let totSum = 0, extSum = 0;
for (const hour of sortedHours) {
  const t = totalsMap.get(hour);
  const e = externalIdMap.get(hour);
  if (t) for (const [, c] of t) totSum += c;
  if (e) for (const [, c] of e) extSum += c;
}
console.log(`  Last 8 hours combined:`);
console.log(`    total events: ${totSum}, external_id coverage: ${totSum > 0 ? ((100 * extSum) / totSum).toFixed(0) : "—"}%`);

console.log(`
Note: Meta's stats endpoint has 30-60 min processing delay. Events fired
right after the deploy will appear in the next 1-2 hourly buckets. The
*before/after* trend is most visible by comparing buckets from BEFORE
the deploy (typically <30%) to ones from AFTER (target: >90%).

Re-run this script every 30 min for the next 4 hours to see the rollout.
`);
