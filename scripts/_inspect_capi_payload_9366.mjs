// Reconstruct the exact Meta CAPI Purchase payload sent for order #9366
// by replaying handleOrderPaid logic with the real order data.
import { createClient } from "@supabase/supabase-js";
import { extractIdentityFromOrder, extractCustomerIdentity } from "../app/lib/cart-attributes.server.js";
import { buildUserData } from "../app/lib/meta-hash.server.js";
import { buildCAPIEvent } from "../app/lib/meta-capi.server.js";
import { getVisitor, findVisitorByFbclid, findRecentVisitorByIpUa, pickBestFbc } from "../app/lib/visitors.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const ORDER_ID = "7644594831676";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: sessions } = await sb.from("shopify_sessions").select("accessToken").eq("shop", SHOP).eq("isOnline", false);
const sToken = sessions[0].accessToken;

const oRes = await fetch(
  `https://${SHOP}/admin/api/2025-01/orders/${ORDER_ID}.json?fields=id,name,email,phone,customer,shipping_address,billing_address,line_items,current_total_price,total_price,currency,presentment_currency,created_at,processed_at,order_status_url,landing_site,referring_site,note_attributes,attributes,client_details`,
  { headers: { "X-Shopify-Access-Token": sToken } }
);
const { order } = await oRes.json();

console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(` REPLAY — handleOrderPaid for ${order.name} (${ORDER_ID})`);
console.log("═══════════════════════════════════════════════════════════════════════════");

const identityHints = extractIdentityFromOrder(order);
const customer = extractCustomerIdentity(order);

console.log("\n─── Step 1: extractIdentityFromOrder ───");
console.log(`  fbp:        ${identityHints.fbp}`);
console.log(`  fbc:        ${identityHints.fbc?.slice(0, 70)}`);
console.log(`  fbclid:     ${identityHints.fbclid?.slice(0, 60)}…`);
console.log(`  visitorId:  ${identityHints.visitorId}    ← cart attribute`);
console.log(`  clientIp:   ${identityHints.clientIp}`);
console.log(`  clientUa:   ${identityHints.clientUa?.slice(0, 70)}`);

console.log("\n─── Step 2: extractCustomerIdentity ───");
console.log(`  email:      ${customer.email}`);
console.log(`  phone:      ${customer.phone}`);
console.log(`  firstName:  ${customer.firstName}`);
console.log(`  lastName:   ${customer.lastName}`);
console.log(`  city:       ${customer.city}`);
console.log(`  state:      ${customer.state}`);
console.log(`  zip:        ${customer.zip}`);
console.log(`  country:    ${customer.country}`);
console.log(`  externalId: ${customer.externalId}    ← Shopify customer.id`);

// Three-tier visitor lookup
let visitor = null;
let recoveredVisitorId = identityHints.visitorId;
let lookupSource = null;
if (recoveredVisitorId) {
  visitor = await getVisitor({ storeId: SHOP, visitorId: recoveredVisitorId });
  if (visitor) lookupSource = "cart_attribute";
  else recoveredVisitorId = null;
}
if (!visitor && identityHints.fbclid) {
  visitor = await findVisitorByFbclid({ storeId: SHOP, fbclid: identityHints.fbclid });
  if (visitor) {
    recoveredVisitorId = visitor.visitor_id;
    lookupSource = "fbclid";
  }
}
if (!visitor && identityHints.clientIp && identityHints.clientUa) {
  visitor = await findRecentVisitorByIpUa({ storeId: SHOP, ip: identityHints.clientIp, ua: identityHints.clientUa, referenceTime: order.processed_at ?? order.created_at, windowMinutes: 60 });
  if (visitor) {
    recoveredVisitorId = visitor.visitor_id;
    lookupSource = "ip_ua";
  }
}

console.log(`\n─── Step 3: Three-tier visitor lookup ───`);
console.log(`  Source:           ${lookupSource}`);
console.log(`  visitor_id:       ${recoveredVisitorId}`);
console.log(`  visitor row found: ${!!visitor}`);

const { fbc: bestFbc, source: fbcSource } = pickBestFbc({ cartAttrFbc: identityHints.fbc, visitor });

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

console.log(`\n─── Step 4: external_id strategy (today's commit 1479e21) ───`);
console.log(`  externalIds array: ${JSON.stringify(externalIds)}`);
console.log(`  → Meta receives ${externalIds.length} hashed external_id values`);
console.log(`    (visitor_id for cross-session stitching + customer.id for account graph)`);

console.log(`\n─── Step 5: user_data block sent to Meta ───`);
const fields = [
  ["em",  "email hash",              userData.em ? "✓" : "✗"],
  ["ph",  "phone hash",              userData.ph ? "✓" : "✗"],
  ["fn",  "first name hash",         userData.fn ? "✓" : "✗"],
  ["ln",  "last name hash",          userData.ln ? "✓" : "✗"],
  ["ct",  "city hash",               userData.ct ? "✓" : "✗"],
  ["st",  "state hash",              userData.st ? "✓" : "✗"],
  ["zp",  "zip hash",                userData.zp ? "✓" : "✗"],
  ["country", "country hash",        userData.country ? "✓" : "✗"],
  ["external_id", "external_id(s)",  userData.external_id ? `✓ (${userData.external_id.length})` : "✗"],
  ["fbp", "browser cookie",          userData.fbp ? "✓" : "✗"],
  ["fbc", "click ID",                userData.fbc ? "✓" : "✗"],
  ["client_ip_address", "IP",        userData.client_ip_address ? "✓" : "✗"],
  ["client_user_agent", "UA",        userData.client_user_agent ? "✓" : "✗"],
];
for (const [k, d, s] of fields) {
  console.log(`  ${s.padEnd(8)} ${k.padEnd(20)} ${d}`);
}

const value = Number(order.total_price ?? order.current_total_price ?? 0);
const currency = order.presentment_currency ?? order.currency ?? "USD";
const eventId = identityHints.eventId ?? `purchase:${SHOP}:${order.id}`;

const event = buildCAPIEvent({
  eventName: "Purchase",
  eventId,
  eventTime: order.processed_at ? new Date(order.processed_at) : new Date(),
  eventSourceUrl: order.order_status_url,
  userData,
  customData: {
    currency,
    value,
    content_ids: order.line_items?.map((li) => li.product_id ? String(li.product_id) : null).filter(Boolean),
    content_type: "product",
    num_items: order.line_items?.reduce((s, li) => s + (li.quantity ?? 0), 0),
    order_id: String(order.id),
  },
});

console.log(`\n─── Step 6: Final CAPI event payload ───`);
console.log(JSON.stringify(event, null, 2));

const matchKeyCount = ["em", "ph", "fn", "ln", "ct", "st", "zp", "country", "external_id"].filter((k) => userData[k]).length;
console.log(`\n═══════════════════════════════════════════════════════════════════════════`);
console.log(` SUMMARY`);
console.log(`═══════════════════════════════════════════════════════════════════════════`);
console.log(`  Hashed PII fields:             ${matchKeyCount} of 9`);
console.log(`  fbp + fbc + IP + UA:           all present`);
console.log(`  external_id values:            ${userData.external_id?.length ?? 0}`);
console.log(`  Visitor stitching:             ${lookupSource ?? "no link"}`);
console.log(`  Order value:                   ${value} ${currency}`);
console.log(`  Predicted EMQ:                 ${matchKeyCount >= 8 ? "9.0-9.5" : matchKeyCount >= 5 ? "7-8" : "5-7"}`);
