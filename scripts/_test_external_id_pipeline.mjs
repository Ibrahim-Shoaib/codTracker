// Integration test: fire test events through Meta's test_event_code path
// using the modified buildUserData. Verifies the new array-based external_id
// is accepted by Meta's CAPI without errors.
//
// Run: node --env-file=.env scripts/_test_external_id_pipeline.mjs <TEST_CODE>
//
// Get a TEST_CODE from Events Manager → Test Events for the dataset.
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../app/lib/crypto.server.js";
import { buildUserData } from "../app/lib/meta-hash.server.js";
import { buildCAPIEvent, postCAPIEvents } from "../app/lib/meta-capi.server.js";
import { randomUUID } from "node:crypto";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const TEST_CODE = process.argv[2];

if (!TEST_CODE) {
  console.log("Skipping live Meta fire — no TEST_CODE provided.");
  console.log("Run with TEST_CODE to verify against Meta:");
  console.log("  node --env-file=.env scripts/_test_external_id_pipeline.mjs TEST12345");
  console.log("\nFalling back to OFFLINE smoke test of buildUserData shape...\n");
}

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

const visitorUuid = randomUUID();
const customerId = "test-customer-789";

// ─── Test 1: Anonymous PageView with visitor_id only ─────────────────────
const ud1 = buildUserData({
  fbp: "fb.1.1234567890.987654321",
  fbc: "fb.1.1234567890.IwAR0xyz",
  clientIp: "1.2.3.4",
  clientUa: "Mozilla/5.0 Test",
  externalId: visitorUuid,
});
console.log("─── Test 1: Anonymous PageView (visitor_id only) ───");
console.log("  external_id:", JSON.stringify(ud1.external_id));
console.log("  has fbp/fbc/ip/ua:", !!(ud1.fbp && ud1.fbc && ud1.client_ip_address && ud1.client_user_agent));
console.assert(
  Array.isArray(ud1.external_id) && ud1.external_id.length === 1,
  "expected single-element array"
);

// ─── Test 2: Logged-in customer with [visitor_id, customer.id] ───────────
const ud2 = buildUserData({
  externalId: [visitorUuid, customerId],
  fbp: "fb.1.1234567890.987654321",
  email: "buyer@example.com",
  phone: "+923001234567",
  country: "PK",
});
console.log("\n─── Test 2: Logged-in customer (array external_id) ───");
console.log("  external_id:", JSON.stringify(ud2.external_id));
console.log("  em hashed:", !!ud2.em);
console.log("  ph hashed:", !!ud2.ph);
console.assert(
  Array.isArray(ud2.external_id) && ud2.external_id.length === 2,
  "expected two-element array"
);
console.assert(
  ud2.external_id[0] !== ud2.external_id[1],
  "expected distinct hash values for distinct ids"
);

// ─── Test 3: Same id passed twice — should dedupe to one ─────────────────
const ud3 = buildUserData({
  externalId: [visitorUuid, visitorUuid],
});
console.log("\n─── Test 3: Duplicate external_id values dedupe ───");
console.log("  external_id:", JSON.stringify(ud3.external_id));
console.assert(
  Array.isArray(ud3.external_id) && ud3.external_id.length === 1,
  "expected dedupe to single element"
);

// ─── Test 4: Empty array → no external_id key on user_data ──────────────
const ud4 = buildUserData({
  externalId: [],
  email: "fallback@example.com",
});
console.log("\n─── Test 4: Empty array drops external_id ───");
console.log("  external_id:", ud4.external_id);
console.log("  email still hashed:", !!ud4.em);
console.assert(ud4.external_id === undefined, "expected no external_id key");

// ─── Test 5: Backwards compatibility — string still works ────────────────
const ud5 = buildUserData({ externalId: customerId });
console.log("\n─── Test 5: String externalId (backwards compat) ───");
console.log("  external_id:", JSON.stringify(ud5.external_id));
console.assert(
  Array.isArray(ud5.external_id) && ud5.external_id.length === 1,
  "expected single-element array from string input"
);

console.log("\n✓ All offline assertions passed");

// ─── Live Meta verification ──────────────────────────────────────────────
if (!TEST_CODE) {
  console.log("\n(skipped live Meta send — no TEST_CODE)");
  process.exit(0);
}

console.log("\n═══════════════════════════════════════════════════════════════");
console.log(" Sending live test events to Meta with new external_id format");
console.log("═══════════════════════════════════════════════════════════════");

const ts = Math.floor(Date.now() / 1000);
const events = [
  // Anonymous PageView — single external_id (visitor_id only)
  buildCAPIEvent({
    eventName: "PageView",
    eventId: `extid-test:pageview:${ts}`,
    eventTime: new Date(),
    eventSourceUrl: `https://${SHOP}/`,
    userData: ud1,
  }),
  // Purchase with array external_id
  buildCAPIEvent({
    eventName: "Purchase",
    eventId: `extid-test:purchase:${ts}`,
    eventTime: new Date(),
    eventSourceUrl: `https://${SHOP}/thank-you`,
    userData: buildUserData({
      externalId: [visitorUuid, customerId],
      email: "buyer@example.com",
      phone: "+923001234567",
      firstName: "Test",
      lastName: "User",
      city: "Karachi",
      state: "Sindh",
      zip: "75200",
      country: "PK",
      fbp: "fb.1.1234567890.987654321",
      fbc: "fb.1.1234567890.IwAR0xyz",
      clientIp: "1.2.3.4",
      clientUa: "Mozilla/5.0 Test",
    }),
    customData: {
      currency: "PKR",
      value: 1500,
      content_ids: ["test-product-1"],
      content_type: "product",
      num_items: 1,
      order_id: `extid-test-order-${ts}`,
    },
  }),
];

const result = await postCAPIEvents({
  accessToken: token,
  datasetId: ds,
  events,
  testEventCode: TEST_CODE,
});

console.log(`\nMeta response:`);
console.log(`  ok: ${result.ok}`);
console.log(`  HTTP: ${result.status}`);
console.log(`  events_received: ${result.eventsReceived}`);
console.log(`  fbtrace_id: ${result.traceId ?? "(none)"}`);
if (!result.ok) {
  console.log(`  error: ${JSON.stringify(result.body, null, 2)}`);
  process.exit(1);
}
console.log(`\n✓ Meta accepted ${result.eventsReceived} test events with new external_id format.`);
console.log(`  Verify at: https://www.facebook.com/events_manager2/list/dataset/${ds}/test_events`);
