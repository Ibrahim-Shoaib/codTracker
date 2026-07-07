// Proper stats queries for the dataset
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
const head = (s) => console.log("\n" + "═".repeat(80) + "\n " + s + "\n" + "═".repeat(80));

const { data: pix } = await sb.from("meta_pixel_connections").select("*").eq("store_id", SHOP).single();
const datasetId = pix.dataset_id;
const accessToken = decryptSecret(pix.bisu_token);
const G = "https://graph.facebook.com/v24.0";

const tryGet = async (path, params = {}) => {
  const u = new URL(G + path);
  u.searchParams.set("access_token", accessToken);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
};

const now = Math.floor(Date.now() / 1000);
const ranges = [
  { name: "last 1h",  start: now - 3600 },
  { name: "last 24h", start: now - 86400 },
  { name: "last 7d",  start: now - 7 * 86400 },
  { name: "last 30d", start: now - 30 * 86400 },
];

// Stats with valid aggregations
for (const agg of ["event", "event_total_counts", "match_keys", "had_pii", "event_source", "pixel_fire", "event_processing_results"]) {
  for (const r of ranges) {
    head(`stats agg=${agg} ${r.name}`);
    const out = await tryGet(`/${datasetId}/stats`, {
      aggregation: agg,
      start_time: r.start,
      end_time: now,
    });
    console.log("status:", out.status);
    if (out.body?.data) {
      console.log("data rows:", out.body.data.length);
      console.log(JSON.stringify(out.body.data.slice(0, 30), null, 2));
    } else {
      console.log("body:", JSON.stringify(out.body, null, 2));
    }
  }
  // only loop ranges for first agg to keep noise low — show just last 7d for the rest
  if (agg !== "event") break;
}
console.log("\n---only event 4 ranges shown above; others below for last 7d only---");

for (const agg of ["event_total_counts", "match_keys", "had_pii", "event_source", "pixel_fire", "event_processing_results"]) {
  head(`stats agg=${agg} last 7d`);
  const out = await tryGet(`/${datasetId}/stats`, {
    aggregation: agg,
    start_time: now - 7 * 86400,
    end_time: now,
  });
  console.log("status:", out.status);
  if (out.body?.data) console.log(JSON.stringify(out.body.data.slice(0, 40), null, 2));
  else console.log(JSON.stringify(out.body, null, 2));
}
