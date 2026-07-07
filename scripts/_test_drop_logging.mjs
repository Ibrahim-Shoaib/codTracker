// Verify the always-log-drops behaviour on a fresh test connection row.
// Steps:
//   1. INSERT a meta_pixel_connections row with status='inactive' (so
//      lookupConnection returns conn=null with exists=true).
//   2. Call sendCAPIEventsForShop with a small Purchase event.
//   3. Confirm a `dropped` row landed in capi_delivery_log.
//   4. Cleanup.
//
// Assumes the DDL adding 'dropped' to the CHECK constraint has been applied.
// If not, this script will print the constraint error and exit so you know.
import { createClient } from "@supabase/supabase-js";
import { buildCAPIEvent, sendCAPIEventsForShop } from "../app/lib/meta-capi.server.js";
import { encryptSecret } from "../app/lib/crypto.server.js";

const SHOP = "__droptest__.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Setup
console.log("1. Inserting test connection row with status='inactive'...");
const { error: insErr } = await sb.from("meta_pixel_connections").upsert({
  store_id: SHOP,
  config_id: "test",
  bisu_token: encryptSecret("dummy"),
  business_id: "",
  dataset_id: "0",
  status: "inactive",
  status_reason: "drop-logging-test",
  connected_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}, { onConflict: "store_id" });
if (insErr) {
  console.error("setup failed:", insErr);
  process.exit(1);
}

try {
  // Fire a CAPI Purchase event — should silent-drop because status='inactive',
  // but with the new code, also write a `dropped` row to capi_delivery_log.
  const event = buildCAPIEvent({
    eventName: "Purchase",
    eventId: `purchase:${SHOP}:droptest-${Date.now()}`,
    eventTime: new Date(),
    userData: { em: ["a".repeat(64)] },
    customData: { value: 1, currency: "USD" },
  });
  console.log("\n2. Calling sendCAPIEventsForShop (expect ok=false reason=no_connection)...");
  const result = await sendCAPIEventsForShop({ storeId: SHOP, events: [event] });
  console.log("   result:", result);

  console.log("\n3. Checking capi_delivery_log for the dropped row...");
  const { data: logs } = await sb
    .from("capi_delivery_log")
    .select("event_id, status, error_msg, sent_at")
    .eq("store_id", SHOP)
    .order("sent_at", { ascending: false })
    .limit(5);
  if (!logs?.length) {
    console.log("   ✗ NO ROW — did the DDL run? capi_delivery_log_status_check may still block 'dropped'.");
  } else {
    for (const r of logs) console.log(`   ${r.status} | err=${r.error_msg} | ${r.event_id}`);
    const found = logs.find((l) => l.status === "dropped");
    console.log(found ? "\n   ✓ dropped row logged successfully" : "\n   ✗ no 'dropped' row found");
  }
} finally {
  console.log("\n4. Cleanup — deleting test connection + log rows...");
  await sb.from("capi_delivery_log").delete().eq("store_id", SHOP);
  await sb.from("meta_pixel_connections").delete().eq("store_id", SHOP);
  console.log("   done.");
}
