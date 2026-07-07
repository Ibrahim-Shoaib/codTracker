// Reconstruct the CAPI Purchase payload for order #9367.
import { createClient } from "@supabase/supabase-js";
import { extractIdentityFromOrder, extractCustomerIdentity } from "../app/lib/cart-attributes.server.js";
import { buildUserData } from "../app/lib/meta-hash.server.js";
import { buildCAPIEvent } from "../app/lib/meta-capi.server.js";
import { getVisitor, findVisitorByFbclid, findRecentVisitorByIpUa, pickBestFbc } from "../app/lib/visitors.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const ORDER_ID = "7644639592764";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: sessions } = await sb.from("shopify_sessions").select("accessToken").eq("shop", SHOP).eq("isOnline", false);
const sToken = sessions[0].accessToken;

const oRes = await fetch(
  `https://${SHOP}/admin/api/2025-01/orders/${ORDER_ID}.json?fields=id,name,email,phone,customer,shipping_address,billing_address,line_items,total_price,currency,presentment_currency,processed_at,landing_site,referring_site,note_attributes,client_details,order_status_url`,
  { headers: { "X-Shopify-Access-Token": sToken } }
);
const { order } = await oRes.json();

console.log(`═══ Order ${order.name} (${order.id}) ═══\n`);
console.log("Full UA:", order.client_details?.user_agent);
console.log("Full landing:", order.landing_site?.slice(0, 200));
console.log("\nfull customer:", JSON.stringify(order.customer, null, 2));
console.log("\nphone on order:", order.phone, "phone on customer:", order.customer?.phone);
console.log("email on order:", order.email, "email on customer:", order.customer?.email);
console.log("shipping:", JSON.stringify(order.shipping_address, null, 2));

const identityHints = extractIdentityFromOrder(order);
const customer = extractCustomerIdentity(order);

console.log("\n─── extractIdentity ───");
console.log("  fbp:", identityHints.fbp);
console.log("  fbc:", identityHints.fbc?.slice(0, 70));
console.log("  fbclid:", identityHints.fbclid?.slice(0, 60));
console.log("  visitorId (cart attr):", identityHints.visitorId);
console.log("  clientIp:", identityHints.clientIp);

console.log("\n─── extractCustomerIdentity ───");
console.log(JSON.stringify(customer, null, 2));

// Three-tier lookup
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
  visitor = await findRecentVisitorByIpUa({ storeId: SHOP, ip: identityHints.clientIp, ua: identityHints.clientUa, referenceTime: order.processed_at, windowMinutes: 60 });
  if (visitor) {
    recoveredVisitorId = visitor.visitor_id;
    lookupSource = "ip_ua";
  }
}

console.log(`\n─── Three-tier visitor lookup ───`);
console.log(`  source: ${lookupSource}`);
console.log(`  visitor_id: ${recoveredVisitorId ?? "(none recovered)"}`);
if (visitor) {
  console.log(`  visitor row's latest_fbp: ${visitor.latest_fbp}`);
  console.log(`  visitor row's latest_fbc: ${visitor.latest_fbc?.slice(0, 60)}`);
  console.log(`  visitor row's first_seen_at: ${visitor.first_seen_at}`);
  console.log(`  visitor row's last_seen_at: ${visitor.last_seen_at}`);
}

const { fbc: bestFbc } = pickBestFbc({ cartAttrFbc: identityHints.fbc, visitor });

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

console.log(`\n─── user_data sent to Meta ───`);
const fields = [
  ["em", "email hash", userData.em],
  ["ph", "phone hash", userData.ph],
  ["fn", "first name", userData.fn],
  ["ln", "last name", userData.ln],
  ["ct", "city", userData.ct],
  ["st", "state", userData.st],
  ["zp", "zip", userData.zp],
  ["country", "country", userData.country],
  ["external_id", "external_ids", userData.external_id],
  ["fbp", "browser ID", userData.fbp],
  ["fbc", "click ID", userData.fbc],
  ["client_ip_address", "IP", userData.client_ip_address],
  ["client_user_agent", "UA", userData.client_user_agent],
];
for (const [k, d, v] of fields) {
  const present = Array.isArray(v) ? v.length > 0 : !!v;
  console.log(`  ${present ? "✓" : "✗"} ${k.padEnd(20)} ${d}`);
}

const matchKeyCount = ["em", "ph", "fn", "ln", "ct", "st", "zp", "country", "external_id"].filter((k) => userData[k]).length;
console.log(`\nHashed PII fields: ${matchKeyCount} of 9`);
console.log(`external_ids count: ${userData.external_id?.length ?? 0}`);
console.log(`fbc source: ${bestFbc ? "cart_attr or visitor row or synthesized" : "missing"}`);

// Also check visitor_events around order time
console.log(`\n─── visitor_events around this order's IP/UA ───`);
const orderTs = new Date(order.processed_at).getTime();
const lo = new Date(orderTs - 30 * 60 * 1000).toISOString();
const hi = new Date(orderTs + 5 * 60 * 1000).toISOString();
const { data: vEvents } = await sb
  .from("visitor_events")
  .select("event_name, occurred_at, fbp, fbc, ip, ua, visitor_id")
  .eq("store_id", SHOP)
  .eq("ip", order.client_details.browser_ip)
  .gte("occurred_at", lo)
  .lte("occurred_at", hi)
  .order("occurred_at", { ascending: true });
console.log(`  visitor_events with same IP in ±30 min window: ${vEvents?.length ?? 0}`);
for (const e of (vEvents ?? []).slice(0, 10)) {
  console.log(`    ${e.occurred_at}  ${e.event_name.padEnd(18)} v=${e.visitor_id.slice(0, 8)}…`);
}
