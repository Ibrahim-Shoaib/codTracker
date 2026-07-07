// Mirrors the identity-build path in app/routes/api.webhooks.meta-pixel.tsx →
// handleOrderPaid, so we can see EXACTLY what user_data was sent to Meta for
// a given order. Doesn't re-send anything; pure reconstruction.
import { createClient } from "@supabase/supabase-js";
import {
  extractIdentityFromOrder,
  extractCustomerIdentity,
} from "../app/lib/cart-attributes.server.js";
import {
  getVisitor,
  findVisitorByFbclid,
  findRecentVisitorByIpUa,
  pickBestFbc,
} from "../app/lib/visitors.server.js";
import { buildUserData } from "../app/lib/meta-hash.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const ORDER_ID = process.env.ORDER_ID || "7659075993916"; // #9387

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

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

console.log(`═══ Order ${order.name} (id=${order.id}) ═══\n`);

// Step 1: pull identity hints from cart attributes + landing_site
const identityHints = extractIdentityFromOrder(order);
const customer = extractCustomerIdentity(order);

console.log(`── Step 1: extractIdentityFromOrder ──`);
console.log(`  fbp from cart attr:     ${identityHints.fbp ?? "✗ missing"}`);
console.log(`  fbc from cart attr:     ${identityHints.fbc ? "✓ present" : "✗ missing — falling through to landing_site"}`);
console.log(`  fbclid from URL:        ${identityHints.fbclid ?? "✗ missing"}`);
console.log(`  visitor_id (cart attr): ${identityHints.visitorId ?? "✗ missing"}`);
console.log(`  client_ip:              ${identityHints.clientIp ?? "✗ missing"}`);
console.log(`  client_ua:              ${(identityHints.clientUa ?? "").slice(0, 80)}...`);

if (identityHints.fbc && !identityHints.fbp) {
  console.log(`\n  → fbc was synthesized by extractIdentityFromOrder from landing_site fbclid:`);
  console.log(`     "${identityHints.fbc.slice(0, 60)}..."`);
}

console.log(`\n── Step 2: customer identity from order ──`);
console.log(`  email:   ${customer.email ?? "(none)"}`);
console.log(`  phone:   ${customer.phone ?? "(none)"}`);
console.log(`  name:    ${customer.firstName ?? ""} ${customer.lastName ?? ""}`);
console.log(`  city:    ${customer.city ?? "(none)"}`);
console.log(`  country: ${customer.country ?? "(none)"}`);
console.log(`  cust_id: ${customer.externalId ?? "(none)"}`);

// Step 3: visitor lookup tiers (same as webhook handler)
console.log(`\n── Step 3: Visitor lookup tiers ──`);
let visitor = null;
let recoveredVisitorId = identityHints.visitorId;
let lookupSource = null;
if (recoveredVisitorId) {
  visitor = await getVisitor({ storeId: SHOP, visitorId: recoveredVisitorId });
  lookupSource = "cart_attribute";
} else if (identityHints.fbclid) {
  visitor = await findVisitorByFbclid({ storeId: SHOP, fbclid: identityHints.fbclid });
  if (visitor) {
    recoveredVisitorId = visitor.visitor_id;
    lookupSource = "fbclid";
  }
}
if (!visitor && identityHints.clientIp && identityHints.clientUa) {
  visitor = await findRecentVisitorByIpUa({
    storeId: SHOP,
    ip: identityHints.clientIp,
    ua: identityHints.clientUa,
    referenceTime: order.processed_at ?? order.created_at,
    windowMinutes: 60,
  });
  if (visitor) {
    recoveredVisitorId = visitor.visitor_id;
    lookupSource = "ip_ua";
  }
}
console.log(`  Tier 1 (cart_attribute visitor_id):  ${identityHints.visitorId ? "✓ tried" : "✗ skipped (no cart attr)"}`);
console.log(`  Tier 2 (fbclid lookup):              ${identityHints.fbclid && !identityHints.visitorId ? (visitor && lookupSource === "fbclid" ? "✓ found" : "✗ no match") : "✗ skipped"}`);
console.log(`  Tier 3 (ip+ua recency):              ${!visitor && identityHints.clientIp && identityHints.clientUa ? "tried" : "skipped"}`);
console.log(`  Final visitor: ${visitor ? `found via ${lookupSource}, id=${recoveredVisitorId}` : "MISS — no visitor row"}`);

// Step 4: pick best fbc
const { fbc: bestFbc, source: fbcSource } = pickBestFbc({
  cartAttrFbc: identityHints.fbc,
  visitor,
});
console.log(`\n── Step 4: pickBestFbc ──`);
console.log(`  best fbc:       ${bestFbc ? "✓ " + bestFbc.slice(0, 50) + "..." : "✗ NONE"}`);
console.log(`  source:         ${fbcSource ?? "none"}`);

// Step 5: build the actual user_data Meta received
const externalIds = [];
if (recoveredVisitorId) externalIds.push(recoveredVisitorId);
if (customer.externalId) externalIds.push(customer.externalId);

const userData = buildUserData({
  ...customer,
  externalId: externalIds.length ? externalIds : undefined,
  fbp: identityHints.fbp ?? visitor?.latest_fbp ?? undefined,
  fbc: bestFbc ?? undefined,
  clientIp: identityHints.clientIp ?? visitor?.latest_ip ?? undefined,
  clientUa: identityHints.clientUa ?? visitor?.latest_ua ?? undefined,
});

console.log(`\n═══ FINAL user_data sent to Meta CAPI ═══`);
const keys = Object.keys(userData);
console.log(`  Keys present: [${keys.join(", ")}]\n`);
for (const k of keys) {
  const v = userData[k];
  if (Array.isArray(v)) {
    console.log(`  ${k.padEnd(22)} (hashed array, ${v.length} entry) ${String(v[0]).slice(0, 16)}...`);
  } else {
    console.log(`  ${k.padEnd(22)} ${String(v).slice(0, 80)}${String(v).length > 80 ? "..." : ""}`);
  }
}

console.log(`\n═══ Direct answer ═══`);
console.log(`  fbp sent?  ${userData.fbp ? "✓ YES — " + userData.fbp.slice(0, 30) + "..." : "✗ NO — never recovered"}`);
console.log(`  fbc sent?  ${userData.fbc ? "✓ YES — " + userData.fbc.slice(0, 30) + "..." : "✗ NO"}`);
