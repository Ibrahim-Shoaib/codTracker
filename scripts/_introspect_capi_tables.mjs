// Read live schema for capi_delivery_log + meta_pixel_connections so I know
// what columns exist and what status values are allowed.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Sample one row to see column shape.
for (const t of ["capi_delivery_log", "capi_retries", "meta_pixel_connections", "order_attribution"]) {
  const { data, error } = await sb.from(t).select("*").limit(1);
  console.log(`─── ${t} ───`);
  if (error) console.log("  err:", error.message);
  else if (!data?.length) console.log("  (no rows)");
  else console.log("  cols:", Object.keys(data[0]).join(", "));
  console.log();
}

// Distinct status values seen on capi_delivery_log
const { data: statuses } = await sb
  .from("capi_delivery_log")
  .select("status")
  .limit(500);
const set = new Set();
for (const r of statuses ?? []) set.add(r.status);
console.log("Distinct capi_delivery_log.status values seen:", [...set].join(", "));

// Active connections count + sample
const { data: conns } = await sb
  .from("meta_pixel_connections")
  .select("store_id, status, dataset_id")
  .eq("status", "active");
console.log(`\nActive connections: ${conns?.length ?? 0}`);
for (const c of conns ?? []) console.log(" ", c.store_id);
