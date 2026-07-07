// Pull live constraint definitions for capi_delivery_log + capi_retries +
// meta_pixel_connections so I write the right DDL.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Use Postgres catalog views via PostgREST RPC if available; otherwise use
// raw SQL via the supabase-js .rpc("exec_sql") if you have one. Easiest path
// is .rpc("postgres_changes") or a one-off pg_proc query — but PostgREST
// doesn't expose pg_catalog directly. Instead, I'll use the
// `information_schema` view through PostgREST by creating a dummy view-like
// call. PostgREST CAN read from information_schema schemas if exposed; by
// default they aren't. So fall back to: probe behavior via INSERT attempts.

// Probe what statuses are allowed by trying inserts with a known-good store_id.
// I'll use the actual connected shop's store_id so the FK passes.
const KNOWN_SHOP = "the-trendy-homes-pk.myshopify.com";
async function probeStatus(status) {
  const { error } = await sb.from("capi_delivery_log").insert({
    store_id: KNOWN_SHOP,
    event_id: `__probe_${status}__:${Date.now()}`,
    event_name: "Probe",
    status,
    error_msg: "schema_probe_safe_to_delete",
  }).select();
  if (!error) {
    // clean up
    await sb.from("capi_delivery_log").delete()
      .eq("store_id", KNOWN_SHOP).eq("event_name", "Probe");
    return "ALLOWED";
  }
  if (error.code === "23514") return "BLOCKED_BY_CHECK: " + error.message.slice(0, 80);
  if (error.code === "23503") return "BLOCKED_BY_FK: " + error.message.slice(0, 80);
  return error.code + ": " + error.message.slice(0, 80);
}
for (const s of ["sent", "failed", "dropped", "skipped", "no_connection"]) {
  console.log(`status='${s}'`, "→", await probeStatus(s));
}

// Probe FK by trying to insert with a non-existent store_id.
{
  const { error } = await sb.from("capi_delivery_log").insert({
    store_id: "__nonexistent__",
    event_id: "fk-probe",
    event_name: "Probe",
    status: "sent",
  }).select();
  console.log("\nFK probe (nonexistent shop, status=sent):", error ? error.code + " — " + error.message.slice(0, 120) : "ALLOWED (no FK?)");
}
