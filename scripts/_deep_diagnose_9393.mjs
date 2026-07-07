// Deep root-cause analysis for #9393 missing CAPI fire.
// Test multiple hypotheses with hard data:
//   H1 — connection state at 19:44Z was != 'active' (status flipped, then back)
//   H2 — connection row was deleted+reinserted around the gap
//   H3 — beacons (proxy.tracking.track) also silent-dropped during the gap
//        (would prove the connection was unreachable for ALL CAPI calls, not
//        just the order webhook)
//   H4 — exception path that we mistakenly think is silent-drop
//   H5 — webhook simply did not deliver / handler did not run for #9393
//        (recordOrderAttribution can also be triggered from a different code path)
import { createClient } from "@supabase/supabase-js";
const SHOP = "the-trendy-homes-pk.myshopify.com";
const ORDER_ID = "7660041437500";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(" Deep diagnosis for #9393 (id=" + ORDER_ID + ")");
console.log("═══════════════════════════════════════════════════════════════════════════\n");

// ─── Connection row (raw) ─────────────────────────────────────────────────
const { data: conn } = await sb
  .from("meta_pixel_connections")
  .select("*")
  .eq("store_id", SHOP)
  .single();
console.log("CURRENT CONNECTION ROW:");
console.log("  status:        ", conn?.status);
console.log("  status_reason: ", conn?.status_reason);
console.log("  dataset_id:    ", conn?.dataset_id);
console.log("  config_id:     ", conn?.config_id);
console.log("  connected_at:  ", conn?.connected_at);
console.log("  created_at:    ", conn?.created_at);
console.log("  updated_at:    ", conn?.updated_at);
console.log("  last_event_sent_at: ", conn?.last_event_sent_at);
console.log("  last_health_check:  ", conn?.last_health_check);

// ─── H1/H2: Look at FIRST CAPI event after the 9-h gap ─────────────────────
// If created_at on the connection were updated by reconnection, it'd be
// somewhere between 19:48Z and 00:12Z. It is 12:23Z, which suggests the
// row was NOT recreated after the gap.
console.log("\n─── First CAPI event after the gap ───");
const { data: firstAfter } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, status, http_status, sent_at, trace_id, error_msg")
  .eq("store_id", SHOP)
  .gte("sent_at", "2026-05-09T19:00:00Z")
  .lt("sent_at", "2026-05-10T02:00:00Z")
  .order("sent_at", { ascending: true })
  .limit(3);
for (const r of firstAfter ?? []) console.log(" ", r.sent_at, "|", r.event_name, "|", r.status, r.http_status, "|", r.event_id);

// ─── H3: Beacons during the gap ────────────────────────────────────────────
// Compare visitors.last_seen_at activity vs CAPI logs in the same window.
// visitors gets written by the beacon endpoint *before* it calls
// sendCAPIEventsForShop. So visitor activity but no CAPI = silent drop.
console.log("\n─── Visitor beacon activity vs CAPI activity (gap window) ───");
const gapStart = "2026-05-09T15:00:00Z";
const gapEnd = "2026-05-10T00:12:00Z";
const { data: gapVisitors } = await sb
  .from("visitors")
  .select("visitor_id, first_seen_at, last_seen_at")
  .eq("store_id", SHOP)
  .gte("last_seen_at", gapStart)
  .lt("last_seen_at", gapEnd)
  .order("last_seen_at", { ascending: true });
const { data: gapCapi } = await sb
  .from("capi_delivery_log")
  .select("event_name, status")
  .eq("store_id", SHOP)
  .gte("sent_at", gapStart)
  .lt("sent_at", gapEnd);
console.log(`  Visitor rows touched in [${gapStart}, ${gapEnd}): ${gapVisitors?.length ?? 0}`);
console.log(`  CAPI events fired   in same window:               ${gapCapi?.length ?? 0}`);
console.log(`  Visitor IDs (first 10):`);
for (const v of (gapVisitors ?? []).slice(0, 10)) {
  console.log(`    ${v.visitor_id}  first=${v.first_seen_at}  last=${v.last_seen_at}`);
}

// ─── H1 deeper: visitor events table (per-event) ───────────────────────────
// If you have a visitor_events table, raw beacon payloads live there.
const { data: visitorEvents, error: visitorEventsErr } = await sb
  .from("visitor_events")
  .select("event_name, occurred_at, visitor_id")
  .eq("store_id", SHOP)
  .gte("occurred_at", gapStart)
  .lt("occurred_at", gapEnd)
  .order("occurred_at", { ascending: true })
  .limit(20);
if (visitorEventsErr?.code === "42P01") {
  console.log("\n  (no visitor_events table)");
} else {
  console.log(`\n  visitor_events in gap: ${visitorEvents?.length ?? 0}`);
  for (const e of visitorEvents ?? []) console.log(`    ${e.occurred_at} | ${e.event_name} | ${e.visitor_id}`);
}

// ─── H4: Re-evaluate by simulating sendCAPIEventsForShop NOW for the order
// (if the call would succeed now, we know decryption works and the connection
// is reachable — narrows the gap-time failure to a state issue).
console.log("\n─── H4: simulate sendCAPIEventsForShop NOW for #9393 ───");
const { decryptSecret } = await import("../app/lib/crypto.server.js");
let decryptOk = false;
try {
  const tok = decryptSecret(conn.bisu_token);
  decryptOk = !!tok && tok.length > 10;
} catch (err) {
  console.log("  decryptSecret threw:", err?.message ?? err);
}
console.log("  decryptSecret(bisu_token) ok? ", decryptOk);

// ─── H5: alternate paths to recordOrderAttribution ─────────────────────────
// Grep-ish: are there any other callers that could have written the row?
console.log("\n─── H5: order_attribution row provenance ───");
const { data: attr } = await sb
  .from("order_attribution")
  .select("*")
  .eq("store_id", SHOP)
  .eq("shopify_order_id", ORDER_ID)
  .maybeSingle();
console.log("  attributed_at:", attr?.attributed_at);
console.log("  visitor_id:   ", attr?.visitor_id);
console.log("  channel:      ", attr?.channel);
console.log("  first_touch_url:", attr?.first_touch_url);

// Was the visitor row's last_seen_at AFTER the order create time?
// If visitor activity continued past the order webhook, that's a sign the
// beacon kept firing and we'd see CAPI fires for that visitor too.
console.log("\n─── Visitor bfae3794 timeline ───");
const { data: vis } = await sb
  .from("visitors")
  .select("visitor_id, first_seen_at, last_seen_at, latest_fbc, latest_fbp, latest_ip, latest_ua")
  .eq("visitor_id", "bfae3794-5d62-4478-943a-c12428807e29")
  .maybeSingle();
console.log("  first_seen:", vis?.first_seen_at);
console.log("  last_seen: ", vis?.last_seen_at);
console.log("  has fbc:   ", !!vis?.latest_fbc);

// ─── 5b. Pull the order webhook delivery from Shopify itself ───────────────
// Shopify has /admin/api/.../webhooks but no per-event delivery log via REST.
// We can however look at the ORDER's `client_details` and confirm it's the
// real order Shopify created.
const { data: sessions } = await sb
  .from("shopify_sessions")
  .select("accessToken")
  .eq("shop", SHOP)
  .eq("isOnline", false);
const accessToken = sessions[0].accessToken;
const r = await fetch(
  `https://${SHOP}/admin/api/2025-01/orders/${ORDER_ID}.json`,
  { headers: { "X-Shopify-Access-Token": accessToken } }
);
const { order } = await r.json();
console.log("\n─── Shopify order #9393 (verification) ───");
console.log("  name:        ", order?.name);
console.log("  created_at:  ", order?.created_at);
console.log("  processed_at:", order?.processed_at);
console.log("  source_name: ", order?.source_name);
console.log("  test:        ", order?.test);
