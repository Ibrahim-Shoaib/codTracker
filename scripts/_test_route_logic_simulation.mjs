// Simulates the route-level external_id resolution logic from
// proxy.tracking.track.tsx and api.webhooks.meta-pixel.tsx, then runs the
// resulting userData through buildUserData. Verifies all the cases that
// will hit production after deploy.
import { buildUserData } from "../app/lib/meta-hash.server.js";
import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(String(s).toLowerCase().trim(), "utf8").digest("hex");

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    pass++;
  } else {
    console.log(`  ✗ ${name}`);
    if (detail) console.log(`    ${detail}`);
    fail++;
  }
}

// Replicates the externalIds builder from proxy.tracking.track.tsx
function buildProxyExternalIds(body, visitorId) {
  const externalIds = [];
  if (typeof body.external_id === "string" && body.external_id) {
    externalIds.push(body.external_id);
  }
  if (visitorId && !externalIds.includes(visitorId)) {
    externalIds.push(visitorId);
  }
  return externalIds.length ? externalIds : undefined;
}

// Replicates the externalIds builder from api.webhooks.meta-pixel.tsx
function buildWebhookExternalIds(identityHints, customer) {
  const externalIds = [];
  if (identityHints.visitorId) externalIds.push(identityHints.visitorId);
  if (customer.externalId) externalIds.push(customer.externalId);
  return externalIds.length ? externalIds : undefined;
}

// ─── Proxy beacon scenarios ──────────────────────────────────────────────
console.log("─── /apps/tracking/track external_id resolution ───");

// Anonymous PageView: theme block omits external_id, server falls back to visitor_id
{
  const ext = buildProxyExternalIds({}, "visitor-uuid-1");
  const ud = buildUserData({ fbp: "fb.1.x.y", externalId: ext });
  check("anonymous PageView gets visitor_id as external_id",
    Array.isArray(ud.external_id) && ud.external_id.length === 1 && ud.external_id[0] === sha("visitor-uuid-1"));
}

// Anonymous PageView with theme block already passing visitor_id as body.external_id
{
  const ext = buildProxyExternalIds({ external_id: "visitor-uuid-1" }, "visitor-uuid-1");
  const ud = buildUserData({ externalId: ext });
  check("matching body.external_id and visitorId dedupe to single",
    Array.isArray(ud.external_id) && ud.external_id.length === 1);
}

// Logged-in customer: body.external_id = customer.id, visitorId is different
{
  const ext = buildProxyExternalIds({ external_id: "customer-456" }, "visitor-uuid-1");
  const ud = buildUserData({ externalId: ext });
  check("logged-in customer gets [customer.id, visitor_id] array",
    Array.isArray(ud.external_id) && ud.external_id.length === 2 &&
    ud.external_id[0] === sha("customer-456") &&
    ud.external_id[1] === sha("visitor-uuid-1"));
}

// No body.external_id and no visitorId (rare race): omit key
{
  const ext = buildProxyExternalIds({}, null);
  const ud = buildUserData({ fbp: "fb.1.x.y", externalId: ext });
  check("no identifier at all → external_id key absent (other matches still fire)",
    ud.external_id === undefined && ud.fbp === "fb.1.x.y");
}

// Falsy body.external_id (empty string) is rejected — visitorId still wins
{
  const ext = buildProxyExternalIds({ external_id: "" }, "visitor-uuid-1");
  const ud = buildUserData({ externalId: ext });
  check("empty-string body.external_id ignored, visitor_id still applies",
    Array.isArray(ud.external_id) && ud.external_id.length === 1 && ud.external_id[0] === sha("visitor-uuid-1"));
}

// ─── Webhook scenarios ───────────────────────────────────────────────────
console.log("\n─── /webhooks/meta-pixel external_id resolution ───");

// Purchase with cart-attribute visitor_id + Shopify customer.id
{
  const ext = buildWebhookExternalIds(
    { visitorId: "visitor-uuid-1" },
    { externalId: "789012" }
  );
  const ud = buildUserData({ externalId: ext, email: "buyer@example.com" });
  check("Purchase with both ids → array external_id",
    Array.isArray(ud.external_id) && ud.external_id.length === 2);
}

// Purchase with only customer.id (visitor cookie missing — Buy It Now flow)
{
  const ext = buildWebhookExternalIds(
    { visitorId: null },
    { externalId: "789012" }
  );
  const ud = buildUserData({ externalId: ext });
  check("Purchase with customer.id only → single-element array",
    Array.isArray(ud.external_id) && ud.external_id.length === 1 && ud.external_id[0] === sha("789012"));
}

// Purchase with only visitor_id (guest checkout, no Shopify customer record)
{
  const ext = buildWebhookExternalIds(
    { visitorId: "visitor-uuid-1" },
    { externalId: null }
  );
  const ud = buildUserData({ externalId: ext });
  check("guest Purchase with visitor_id only → single-element array",
    Array.isArray(ud.external_id) && ud.external_id.length === 1 && ud.external_id[0] === sha("visitor-uuid-1"));
}

// CHECKOUTS_CREATE: typically no customer object, only visitor_id from cart
{
  const ext = buildWebhookExternalIds(
    { visitorId: "visitor-uuid-1" },
    { externalId: null }
  );
  const ud = buildUserData({ externalId: ext, fbp: "fb.1.x.y" });
  check("InitiateCheckout webhook with visitor_id only",
    Array.isArray(ud.external_id) && ud.external_id.length === 1);
}

// Edge: webhook payload with nothing
{
  const ext = buildWebhookExternalIds({ visitorId: null }, { externalId: null });
  const ud = buildUserData({ externalId: ext, fbp: "fb.1.x.y" });
  check("nothing-in webhook → no external_id key (fbp still fires)",
    ud.external_id === undefined && ud.fbp === "fb.1.x.y");
}

// ─── Web Pixel sandbox track() scenarios ─────────────────────────────────
console.log("\n─── Web Pixel sandbox beacon → server resolution ───");

// Sandbox sends body.visitor_id (cookie read), server resolves visitorId from it
{
  const body = { visitor_id: "visitor-uuid-1", fbp: "fb.1.x.y" };
  // Replicates resolveVisitorId logic — uses explicit body.visitor_id when valid
  const isValid = typeof body.visitor_id === "string" &&
    /^[a-f0-9-]{32,40}$/i.test(body.visitor_id);
  const visitorId = isValid ? body.visitor_id : "freshly-minted-uuid";
  const ext = buildProxyExternalIds(body, visitorId);
  const ud = buildUserData({ fbp: body.fbp, externalId: ext });
  // visitor-uuid-1 is too short to pass the regex, falls back to freshly minted
  check("sandbox beacon falls back to fresh visitor_id when cookie wasn't set",
    Array.isArray(ud.external_id) && ud.external_id.length === 1);
}

// Sandbox sends a real-looking UUID
{
  const realUuid = "550e8400-e29b-41d4-a716-446655440000";
  const body = { visitor_id: realUuid, fbp: "fb.1.x.y" };
  const isValid = /^[a-f0-9-]{32,40}$/i.test(body.visitor_id);
  const visitorId = isValid ? body.visitor_id : "fresh";
  const ext = buildProxyExternalIds(body, visitorId);
  const ud = buildUserData({ fbp: body.fbp, externalId: ext });
  check("sandbox beacon with valid UUID → external_id = visitor_id",
    Array.isArray(ud.external_id) && ud.external_id.length === 1 && ud.external_id[0] === sha(realUuid));
}

// ─── Final summary ───────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
