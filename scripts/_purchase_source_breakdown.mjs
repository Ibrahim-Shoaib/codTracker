// Precise Purchase-only browser/server split, per hour, today (PKT).
// Uses the match_keys aggregation (returns rows tagged by event_name) joined
// against the event_source aggregation. We have to be careful — event_source
// aggregation doesn't break out by event_name natively, so we infer.
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

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const todayPktDate = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
const startUtc = new Date(`${todayPktDate}T00:00:00Z`).getTime() - PKT_OFFSET_MS;

// Pull our delivery log
const { data: ourFires } = await sb
  .from("capi_delivery_log")
  .select("event_id, sent_at, status")
  .eq("store_id", SHOP)
  .eq("event_name", "Purchase")
  .gte("sent_at", new Date(startUtc).toISOString())
  .order("sent_at", { ascending: true });

// Pull Meta's per-hour Purchase totals
const eventRes = await fetch(
  `https://graph.facebook.com/v24.0/${ds}/stats?` +
    new URLSearchParams({ access_token: token, aggregation: "event" })
);
const eventJson = await eventRes.json();

console.log(`Purchase events today (${todayPktDate} PKT)`);
console.log(`${"hour-UTC".padEnd(28)} ${"PKT".padEnd(7)} meta-saw  our-fires   gap`);
console.log("─".repeat(70));

let metaTotal = 0, ourTotal = 0;
for (const bucket of eventJson.data ?? []) {
  const bucketStart = new Date(bucket.start_time).getTime();
  if (bucketStart < startUtc) continue;
  let metaPurchases = 0;
  for (const row of bucket.data ?? []) {
    if (row.value === "Purchase") metaPurchases += Number(row.count ?? 0);
  }
  if (metaPurchases === 0) continue;

  const ourInHour = (ourFires ?? []).filter((r) => {
    const t = new Date(r.sent_at).getTime();
    return t >= bucketStart && t < bucketStart + 3600000;
  }).length;

  const pktTime = new Date(bucketStart + PKT_OFFSET_MS).toISOString().slice(11, 16);
  const gap = metaPurchases - ourInHour;
  const note = gap > 0 ? `← ${gap} from elsewhere` : "";
  console.log(
    `${bucket.start_time.padEnd(28)} ${pktTime.padEnd(7)} ${String(metaPurchases).padStart(8)}  ${String(ourInHour).padStart(8)}  ${String(gap).padStart(4)}  ${note}`
  );
  metaTotal += metaPurchases;
  ourTotal += ourInHour;
}

console.log("─".repeat(70));
console.log(`TOTAL today                        ${String(metaTotal).padStart(8)}  ${String(ourTotal).padStart(8)}  ${String(metaTotal - ourTotal).padStart(4)}`);

// Distinct order_ids in our log
const distinctOrderIds = new Set();
for (const r of ourFires ?? []) {
  const m = r.event_id.match(/purchase:[^:]+:(.+)$/);
  if (m) distinctOrderIds.add(m[1]);
}

console.log(`
─── Summary ───
Meta /stats counts events fired (each fire = 1, no dedup at this level):
  Total Purchase fires Meta saw today: ${metaTotal}
  Our app's fires:                     ${ourTotal} (${distinctOrderIds.size} distinct orders, dual-fired)
  Fires from somewhere else:           ${metaTotal - ourTotal}

What Ads Manager will report (after dedup):
  IF the external fires share our event_id (purchase:shop:order_id):
    → ${distinctOrderIds.size} purchases (clean dedup)
  IF the external fires use different event_ids:
    → up to ${metaTotal / 2} purchases (likely 2× counted = ${metaTotal / 2 / distinctOrderIds.size}× inflation)

Distinct orders our app fired Purchase for today:
${[...distinctOrderIds].map((id) => `  • Shopify order ${id}`).join("\n")}
`);
