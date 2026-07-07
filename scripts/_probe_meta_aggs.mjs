// Probe each valid aggregation Meta accepts on /stats to find the EMQ source.
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

const aggs = [
  "event",
  "match_keys",
  "had_pii",
  "event_total_counts",
  "event_processing_results",
  "event_source",
];
for (const agg of aggs) {
  const params = new URLSearchParams({ access_token: token, aggregation: agg });
  const res = await fetch(
    `https://graph.facebook.com/v24.0/${ds}/stats?${params}`
  );
  const body = await res.text();
  console.log(`\n=== aggregation=${agg} (HTTP ${res.status}) ===`);
  console.log(body.slice(0, 2200));
}
