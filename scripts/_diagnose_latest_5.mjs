// Pull the 5 latest Shopify orders and run a full ad-tracking diagnostic on
// each: cart attrs, identity recovery tier, CAPI delivery, attribution row.
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

// Latest 5 orders by created_at desc
const r = await fetch(
  `https://${SHOP}/admin/api/2025-01/orders.json?limit=5&status=any&order=created_at%20desc`,
  { headers: { "X-Shopify-Access-Token": accessToken } }
);
const { orders } = await r.json();

console.log(`Pulled ${orders.length} latest orders\n`);
console.log("═══════════════════════════════════════════════════════════════════════════");

const summary = [];

for (const order of orders) {
  console.log(`\n═══ ${order.name} (id=${order.id}) — ${order.created_at} ═══`);
  console.log(`  Total: ${order.total_price} ${order.currency}  ·  source: ${order.source_name}  ·  customer: ${order.customer?.email ?? "(no email)"} / ${order.phone ?? order.customer?.phone ?? "(no phone)"}`);

  // ── Browser environment
  const ua = order.client_details?.user_agent ?? "";
  const ip = order.client_details?.browser_ip ?? "—";
  const referring = order.referring_site ?? "—";
  const isInstagramIab = /\bInstagram\b/.test(ua) || /IABMV\//.test(ua);
  const isFacebookIab = /FB_IAB|FBAV/.test(ua);
  const browserType = isInstagramIab ? "Instagram IAB" : isFacebookIab ? "Facebook IAB" : "Regular browser";
  console.log(`  Browser:  ${browserType}  ·  IP=${ip}  ·  ref=${referring}`);

  // ── Cart attrs
  const targetKeys = ["_cod_visitor_id", "_fbp", "_fbc", "_fbclid", "_cod_event_id", "_client_ua"];
  const attrPresent = {};
  for (const k of targetKeys) {
    const a = (order.note_attributes ?? []).find((x) => x.name === k || x.key === k);
    attrPresent[k] = a?.value ?? null;
  }
  const cartAttrCount = Object.values(attrPresent).filter((v) => v !== null).length;
  console.log(`  Cart attrs: ${cartAttrCount}/6 present  [${Object.entries(attrPresent).map(([k, v]) => `${k.replace("_", "")}=${v ? "✓" : "✗"}`).join(", ")}]`);

  // ── Reconstruct CAPI payload (mirroring webhook handler)
  const identityHints = extractIdentityFromOrder(order);
  const customer = extractCustomerIdentity(order);

  let visitor = null;
  let recoveredVisitorId = identityHints.visitorId;
  let lookupSource = null;
  if (recoveredVisitorId) {
    visitor = await getVisitor({ storeId: SHOP, visitorId: recoveredVisitorId });
    lookupSource = "cart_attribute";
  } else if (identityHints.fbclid) {
    visitor = await findVisitorByFbclid({ storeId: SHOP, fbclid: identityHints.fbclid });
    if (visitor) { recoveredVisitorId = visitor.visitor_id; lookupSource = "fbclid"; }
  }
  if (!visitor && identityHints.clientIp && identityHints.clientUa) {
    visitor = await findRecentVisitorByIpUa({
      storeId: SHOP,
      ip: identityHints.clientIp,
      ua: identityHints.clientUa,
      referenceTime: order.processed_at ?? order.created_at,
      windowMinutes: 60,
    });
    if (visitor) { recoveredVisitorId = visitor.visitor_id; lookupSource = "ip_ua"; }
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

  const tier = recoveredVisitorId
    ? `Tier ${lookupSource === "cart_attribute" ? 1 : lookupSource === "fbclid" ? 2 : 3} (${lookupSource})`
    : (identityHints.fbc ? "Tier 2 (URL fbclid → synthesized fbc)" : "Tier 4 (PII only)");
  console.log(`  Identity recovery: ${tier}`);

  const matchKeys = Object.keys(userData);
  const hasFbp = !!userData.fbp;
  const hasFbc = !!userData.fbc;
  const hasEm = !!userData.em;
  console.log(`  CAPI user_data keys (${matchKeys.length}): [${matchKeys.join(", ")}]`);
  console.log(`  fbp sent? ${hasFbp ? "✓" : "✗"}  ·  fbc sent? ${hasFbc ? "✓" : "✗"}  ·  email sent? ${hasEm ? "✓" : "✗"}`);

  // ── CAPI delivery log
  const eventId = `purchase:${SHOP}:${order.id}`;
  const { data: log } = await sb
    .from("capi_delivery_log")
    .select("event_name, status, http_status, error_msg, sent_at")
    .eq("store_id", SHOP)
    .eq("event_id", eventId)
    .order("sent_at", { ascending: false });
  const ok = log?.every((l) => l.status === "sent" && l.http_status === 200);
  if (!log?.length) {
    console.log(`  CAPI: ✗ NO ROW for event_id ${eventId}`);
  } else {
    console.log(`  CAPI: ${ok ? "✓" : "✗"} ${log.length} entries, all ${ok ? "200 OK" : "with issues"}`);
  }

  // ── Retries
  const { data: retries } = await sb.from("capi_retries").select("event_id").eq("store_id", SHOP).eq("event_id", eventId);
  const retryCount = retries?.length ?? 0;

  // ── Order attribution
  const { data: attr } = await sb
    .from("order_attribution")
    .select("channel, utm_source, visitor_id")
    .eq("store_id", SHOP)
    .eq("shopify_order_id", String(order.id))
    .maybeSingle();
  console.log(`  Channel: ${attr?.channel ?? "✗ no row"}${attr?.utm_source ? ` (utm=${attr.utm_source})` : ""}  ·  retries: ${retryCount === 0 ? "✓ none" : `⚠ ${retryCount}`}`);

  // Per-order verdict
  const verdict = {
    name: order.name,
    capiOk: !!log?.length && ok,
    fbpSent: hasFbp,
    fbcSent: hasFbc,
    cartAttrsCount: cartAttrCount,
    matchKeys: matchKeys.length,
    channel: attr?.channel ?? null,
    retries: retryCount,
    iab: isInstagramIab || isFacebookIab,
    tier,
  };
  summary.push(verdict);
}

// ── Final summary table
console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
console.log("                          SUMMARY — last 5 orders");
console.log("═══════════════════════════════════════════════════════════════════════════\n");
console.log("  Order  │ Browser  │ CAPI │ fbp │ fbc │ Cart attrs │ user_data keys │ Channel       │ Retries");
console.log("  ───────┼──────────┼──────┼─────┼─────┼────────────┼────────────────┼───────────────┼────────");
for (const v of summary) {
  console.log(
    `  ${v.name.padEnd(6)} │ ${(v.iab ? "IAB" : "Regular").padEnd(8)} │ ${(v.capiOk ? "✓" : "✗").padEnd(4)} │  ${v.fbpSent ? "✓" : "✗"}  │  ${v.fbcSent ? "✓" : "✗"}  │  ${String(v.cartAttrsCount).padStart(2)}/6      │      ${String(v.matchKeys).padStart(2)}        │ ${(v.channel ?? "—").padEnd(13)} │ ${v.retries === 0 ? "✓" : "⚠ " + v.retries}`
  );
}

const allCAPIOk = summary.every((v) => v.capiOk);
const allHaveFbc = summary.every((v) => v.fbcSent);
const allClassified = summary.every((v) => v.channel && v.channel !== null);
const noRetries = summary.every((v) => v.retries === 0);
const fbpSentCount = summary.filter((v) => v.fbpSent).length;
const cartAttrsRecovered = summary.filter((v) => v.cartAttrsCount > 0).length;

console.log("\n  Aggregate health:");
console.log(`    All CAPI fired & 200 OK:     ${allCAPIOk ? "✓" : "✗"}`);
console.log(`    All have fbc:                ${allHaveFbc ? "✓" : "✗"}`);
console.log(`    fbp sent on:                 ${fbpSentCount}/${summary.length}`);
console.log(`    Cart attrs survived on:      ${cartAttrsRecovered}/${summary.length} ${cartAttrsRecovered > 0 ? "← keepalive fix may be helping" : ""}`);
console.log(`    All channel-classified:      ${allClassified ? "✓" : "✗"}`);
console.log(`    No retries pending:          ${noRetries ? "✓" : "✗"}`);
