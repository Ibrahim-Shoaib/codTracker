// Run the same logic as /api/cron/emq, but only for the Trendy store, locally.
// Lets us see whether Meta returns EMQ data, and write the snapshot row if it does.
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../app/lib/crypto.server.js";
import { fetchEMQ } from "../app/lib/meta-pixel.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: conn, error } = await sb
  .from("meta_pixel_connections")
  .select("store_id, dataset_id, bisu_token, status")
  .eq("store_id", SHOP)
  .single();

if (error || !conn) {
  console.error("connection not found:", error?.message);
  process.exit(1);
}
console.log(`connection: status=${conn.status} dataset=${conn.dataset_id}`);

const token = decryptSecret(conn.bisu_token);
console.log(`token decrypted: len=${token?.length ?? 0}`);

console.log("\n→ Calling Meta /stats with aggregation=event_match_quality_per_event_name");
const stats = await fetchEMQ(token, conn.dataset_id);
console.log("Meta returned:", JSON.stringify(stats, null, 2));

if (!stats) {
  console.log("\nfetchEMQ returned null — trying raw fetch to inspect HTTP error");
  const params = new URLSearchParams({
    access_token: token,
    aggregation: "event_match_quality_per_event_name",
  });
  const res = await fetch(
    `https://graph.facebook.com/v24.0/${conn.dataset_id}/stats?${params}`
  );
  console.log("HTTP status:", res.status);
  console.log("body:", await res.text());
  process.exit(0);
}

const perEvent = {};
let total = 0, count = 0;
for (const row of stats) {
  if (row?.event_name && typeof row.value === "number") {
    perEvent[row.event_name] = row.value;
    total += row.value;
    count++;
  }
}
const overall = count > 0 ? total / count : null;
console.log(`\noverall_emq=${overall}`);
console.log(`per_event=${JSON.stringify(perEvent, null, 2)}`);

if (overall != null) {
  const { error: insertErr } = await sb.from("emq_snapshots").insert({
    store_id: conn.store_id,
    dataset_id: conn.dataset_id,
    overall_emq: overall,
    per_event: perEvent,
  });
  if (insertErr) {
    console.error("insert failed:", insertErr.message);
  } else {
    console.log("✓ snapshot inserted");
  }
}
