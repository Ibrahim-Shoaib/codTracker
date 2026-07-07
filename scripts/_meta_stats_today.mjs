// Pull Meta's own view of today's events for cross-check.
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

// PKT today
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const todayPktDate = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
const startUtc = new Date(`${todayPktDate}T00:00:00Z`).getTime() - PKT_OFFSET_MS;

// event aggregation (per-hour event volume)
const res = await fetch(
  `https://graph.facebook.com/v24.0/${ds}/stats?` +
    new URLSearchParams({ access_token: token, aggregation: "event" })
);
const json = await res.json();

console.log(`Meta /stats per-hour event totals for ${todayPktDate} (PKT)\n`);
console.log("hour-bucket-start             event              count");
console.log("─".repeat(70));

const totals = new Map();
for (const bucket of json.data ?? []) {
  const bucketStart = new Date(bucket.start_time).getTime();
  if (bucketStart < startUtc) continue; // skip pre-today buckets
  for (const row of bucket.data ?? []) {
    const ev = row.value;
    const cnt = Number(row.count ?? 0);
    totals.set(ev, (totals.get(ev) ?? 0) + cnt);
    if (ev === "Purchase") {
      console.log(`${bucket.start_time.padEnd(28)} ${ev.padEnd(18)} ${cnt}`);
    }
  }
}

console.log("\n─── Today's event totals (PKT, all hours so far) ───");
for (const [ev, c] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${ev.padEnd(18)} ${c}`);
}

console.log(`\nMeta saw ${totals.get("Purchase") ?? 0} Purchase events today (PKT).`);
console.log(`(this is total events received — Meta dedupes by event_id when reporting`);
console.log(`in Ads Manager / Events Manager Total events, so the 'unique purchases'`);
console.log(`count after dedup matches our delivery log's distinct event_id count.)`);
