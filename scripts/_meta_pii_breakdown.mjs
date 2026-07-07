// Aggregate PII coverage from Meta API for the dataset.
// Per-event-name × per-day: events received, has_pii %, top match_keys.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { decryptSecret } from "../app/lib/crypto.server.js";
try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: pix } = await sb.from("meta_pixel_connections").select("*").eq("store_id", SHOP).single();
const datasetId = pix.dataset_id;
const accessToken = decryptSecret(pix.bisu_token);
const G = "https://graph.facebook.com/v24.0";

const fetchAgg = async (agg, startTime) => {
  const u = new URL(`${G}/${datasetId}/stats`);
  u.searchParams.set("access_token", accessToken);
  u.searchParams.set("aggregation", agg);
  u.searchParams.set("start_time", startTime);
  u.searchParams.set("end_time", Math.floor(Date.now() / 1000));
  const r = await fetch(u);
  return (await r.json())?.data ?? [];
};

const head = (s) => console.log("\n" + "═".repeat(80) + "\n " + s + "\n" + "═".repeat(80));
const pad = (s, n) => String(s ?? "").padEnd(n);

// Get hourly buckets for last 7 days, then collapse by date+event.
const startTime = Math.floor(Date.now() / 1000) - 7 * 86400;

const eventBuckets = await fetchAgg("event", startTime);
const piiBuckets = await fetchAgg("had_pii", startTime);
const sourceBuckets = await fetchAgg("event_source", startTime);
const matchKeyBuckets = await fetchAgg("match_keys", startTime);

// Collapse hourly → daily per event_name
const dayKey = (iso) => iso.slice(0, 10);
const eventByDay = {}; // { day: { event: count } }
for (const b of eventBuckets) {
  const d = dayKey(b.start_time);
  eventByDay[d] ??= {};
  for (const r of b.data ?? []) {
    eventByDay[d][r.value] = (eventByDay[d][r.value] ?? 0) + r.count;
  }
}

const piiByDay = {}; // { day: { event: { has_pii, not_has_pii } } }
for (const b of piiBuckets) {
  const d = dayKey(b.start_time);
  piiByDay[d] ??= {};
  for (const r of b.data ?? []) {
    piiByDay[d][r.event] ??= { has_pii: 0, not_has_pii: 0 };
    piiByDay[d][r.event][r.value] = (piiByDay[d][r.event][r.value] ?? 0) + r.count;
  }
}

const sourceByDay = {}; // { day: { source: count } }
for (const b of sourceBuckets) {
  const d = dayKey(b.start_time);
  sourceByDay[d] ??= {};
  for (const r of b.data ?? []) {
    sourceByDay[d][r.value] = (sourceByDay[d][r.value] ?? 0) + r.count;
  }
}

const mkByEvent = {}; // { event: { match_key: count } }
for (const b of matchKeyBuckets) {
  for (const r of b.data ?? []) {
    mkByEvent[r.event] ??= {};
    mkByEvent[r.event][r.value] = (mkByEvent[r.event][r.value] ?? 0) + r.count;
  }
}

head("Daily volume × event (last 7d)");
const days = Object.keys(eventByDay).sort();
const eventNames = ["PageView", "ViewContent", "AddToCart", "InitiateCheckout", "Purchase", "AddPaymentInfo", "Search"];
console.log(`${pad("date", 12)} ${eventNames.map((e) => pad(e, 12)).join("")}`);
for (const d of days) {
  console.log(`${pad(d, 12)} ${eventNames.map((e) => pad(eventByDay[d][e] ?? 0, 12)).join("")}`);
}

head("Daily PII coverage (% of events with PII)");
console.log(`${pad("date", 12)} ${eventNames.map((e) => pad(e, 14)).join("")}`);
for (const d of days) {
  const cells = eventNames.map((e) => {
    const p = piiByDay[d]?.[e];
    if (!p) return pad("—", 14);
    const total = p.has_pii + p.not_has_pii;
    return total ? pad(`${p.has_pii}/${total} (${Math.round((p.has_pii / total) * 100)}%)`, 14) : pad("—", 14);
  });
  console.log(`${pad(d, 12)} ${cells.join("")}`);
}

head("Daily SERVER vs BROWSER split");
console.log(`${pad("date", 12)} ${pad("SERVER", 10)} ${pad("BROWSER", 10)} server%`);
for (const d of days) {
  const s = sourceByDay[d]?.SERVER ?? 0;
  const b = sourceByDay[d]?.BROWSER ?? 0;
  const tot = s + b;
  console.log(`${pad(d, 12)} ${pad(s, 10)} ${pad(b, 10)} ${tot ? Math.round((s / tot) * 100) + "%" : "—"}`);
}

head("Match-key coverage by event (last 7d totals)");
for (const ev of eventNames) {
  const keys = mkByEvent[ev];
  if (!keys) continue;
  console.log(`\n  ${ev}:`);
  const sorted = Object.entries(keys).sort((a, b) => b[1] - a[1]);
  const total = eventByDay[days[days.length - 1]]?.[ev] ?? 0; // last-day count for ratio context
  for (const [k, v] of sorted) {
    console.log(`    ${pad(k, 22)} ${v}`);
  }
}

// Daily EMQ from our snapshots
head("Daily EMQ from our snapshots (per event)");
const { data: snaps } = await sb
  .from("emq_snapshots")
  .select("captured_at, overall_emq, per_event")
  .eq("store_id", SHOP)
  .order("captured_at", { ascending: true });
for (const s of snaps ?? []) {
  console.log(`  ${s.captured_at}  overall=${s.overall_emq}  ${JSON.stringify(s.per_event)}`);
}
