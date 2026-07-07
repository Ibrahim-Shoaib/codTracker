// Per-order ad-tracking + EMQ audit for the-trendy-homes-pk for TODAY (PKT).
// Pulls every order created in today's PKT window, mirrors the webhook's
// identity-recovery pipeline, then scores match-key strength per order and
// cross-checks against capi_delivery_log + order_attribution.
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

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const todayPktDate = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
const startUtcMs = new Date(`${todayPktDate}T00:00:00Z`).getTime() - PKT_OFFSET_MS;
const startIso = new Date(startUtcMs).toISOString();

const { data: sessions } = await sb
  .from("shopify_sessions")
  .select("accessToken")
  .eq("shop", SHOP)
  .eq("isOnline", false);
const accessToken = sessions[0].accessToken;

const url = `https://${SHOP}/admin/api/2025-01/orders.json?` +
  new URLSearchParams({ created_at_min: startIso, status: "any", limit: "100" });
const r = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
const { orders } = await r.json();

console.log(`Today PKT = ${todayPktDate} (UTC start ${startIso})`);
console.log(`Pulled ${orders.length} orders\n`);

// EMQ heuristic — mirrors Meta's published guidance:
//   strong (~+1.5):  em, ph
//   medium (~+1):    fn, ln, fbc, external_id
//   light (~+0.5):   ct, st, zp, country, fbp, client_ip+client_ua
//   E.164 phone:     +3 boost vs local format (already baked into our normalizer
//                    when country is known — so we just credit it)
// Score is capped at 10. This is a *coarse* estimate; the truth is what Events
// Manager → Diagnostics shows for the event.
function estimateEmq(userData, customer) {
  let s = 0;
  const has = (k) => Array.isArray(userData[k]) ? userData[k].length > 0 : !!userData[k];

  if (has("em")) s += 1.5;
  if (has("ph")) {
    s += 1.5;
    // Phone normalization in this codebase prepends dial code when country is
    // present → effectively E.164.
    if (customer.country) s += 0.5;
  }
  if (has("fn")) s += 1.0;
  if (has("ln")) s += 1.0;
  if (has("ct")) s += 0.4;
  if (has("st")) s += 0.3;
  if (has("zp")) s += 0.3;
  if (has("country")) s += 0.3;
  if (has("external_id")) s += 0.6;
  if (has("fbc")) s += 1.0;
  if (has("fbp")) s += 0.5;
  if (has("client_ip_address") && has("client_user_agent")) s += 0.5;
  return Math.min(10, +s.toFixed(1));
}

const summary = [];

for (const order of orders) {
  const ua = order.client_details?.user_agent ?? "";
  const ip = order.client_details?.browser_ip ?? null;
  const referring = order.referring_site ?? "—";
  const isInstagramIab = /\bInstagram\b/.test(ua) || /IABMV\//.test(ua);
  const isFacebookIab = /FB_IAB|FBAV/.test(ua);
  const browserType = isInstagramIab ? "Instagram IAB" : isFacebookIab ? "Facebook IAB" : "Regular";

  const targetKeys = ["_cod_visitor_id", "_fbp", "_fbc", "_fbclid", "_cod_event_id", "_client_ua"];
  const attrPresent = {};
  for (const k of targetKeys) {
    const a = (order.note_attributes ?? []).find((x) => x.name === k || x.key === k);
    attrPresent[k] = a?.value ?? null;
  }
  const cartAttrCount = Object.values(attrPresent).filter((v) => v !== null).length;

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
    ? `T${lookupSource === "cart_attribute" ? 1 : lookupSource === "fbclid" ? 2 : 3} (${lookupSource})`
    : (identityHints.fbc ? "T2 (URL fbclid → synth fbc)" : "T4 (PII only)");

  const eventId = `purchase:${SHOP}:${order.id}`;
  const { data: log } = await sb
    .from("capi_delivery_log")
    .select("status, http_status, error_msg, sent_at")
    .eq("store_id", SHOP)
    .eq("event_id", eventId)
    .order("sent_at", { ascending: false });
  const sentRows = (log ?? []).filter((l) => l.status === "sent");
  const capiOk = sentRows.length > 0;

  const { data: attr } = await sb
    .from("order_attribution")
    .select("channel, utm_source, utm_campaign, visitor_id")
    .eq("store_id", SHOP)
    .eq("shopify_order_id", String(order.id))
    .maybeSingle();

  const matchKeys = Object.keys(userData);
  const emq = estimateEmq(userData, customer);
  const fbclidInUrl = !!(order.landing_site && /[?&]fbclid=/.test(order.landing_site));

  console.log(`═══ ${order.name} (id=${order.id}) — ${order.created_at} ═══`);
  console.log(`  Total: ${order.total_price} ${order.currency}  ·  source: ${order.source_name}`);
  console.log(`  Browser: ${browserType}  ·  IP=${ip ?? "—"}  ·  ref=${referring}`);
  console.log(`  landing_site fbclid: ${fbclidInUrl ? "✓" : "✗"}  ·  cart_attrs ${cartAttrCount}/6`);
  console.log(`  Identity tier: ${tier}`);
  console.log(`  user_data keys (${matchKeys.length}): [${matchKeys.join(", ")}]`);
  console.log(`  fbc=${userData.fbc ? "✓" : "✗"}  fbp=${userData.fbp ? "✓" : "✗"}  em=${userData.em ? "✓" : "✗"}  ph=${userData.ph ? "✓" : "✗"}  ext_id=${userData.external_id ? userData.external_id.length : 0}`);
  console.log(`  Estimated EMQ: ${emq}/10`);
  console.log(`  CAPI: ${capiOk ? `✓ ${sentRows.length} sent rows` : "✗ NOT FIRED"}`);
  console.log(`  Channel: ${attr?.channel ?? "✗ no row"}${attr?.utm_campaign ? ` (utm_campaign=${attr.utm_campaign})` : ""}`);
  console.log("");

  summary.push({
    name: order.name,
    id: order.id,
    source: order.source_name,
    browser: browserType,
    cartAttrCount,
    fbclidInUrl,
    matchKeyCount: matchKeys.length,
    fbc: !!userData.fbc,
    fbp: !!userData.fbp,
    capiOk,
    capiRowCount: sentRows.length,
    emq,
    channel: attr?.channel ?? null,
    tier,
  });
}

console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(`                  SUMMARY — ${summary.length} orders today (${todayPktDate} PKT)`);
console.log("═══════════════════════════════════════════════════════════════════════════\n");
console.log("  Order   │ Browser     │ CAPI │ fbc │ fbp │ Keys │ EMQ  │ Channel        │ Tier");
console.log("  ────────┼─────────────┼──────┼─────┼─────┼──────┼──────┼────────────────┼─────────────");
for (const v of summary) {
  console.log(
    `  ${v.name.padEnd(7)} │ ${v.browser.padEnd(11)} │ ${(v.capiOk ? "✓" : "✗").padEnd(4)} │  ${v.fbc ? "✓" : "✗"}  │  ${v.fbp ? "✓" : "✗"}  │  ${String(v.matchKeyCount).padStart(2)}  │ ${String(v.emq).padStart(4)} │ ${(v.channel ?? "—").padEnd(14)} │ ${v.tier}`
  );
}

const allCapi = summary.every((v) => v.capiOk);
const allFbc = summary.every((v) => v.fbc);
const allChannel = summary.every((v) => v.channel);
const avgEmq = +(summary.reduce((s, v) => s + v.emq, 0) / summary.length).toFixed(1);

console.log(`\n  All CAPI fired:        ${allCapi ? "✓" : "✗"}`);
console.log(`  All have fbc:          ${allFbc ? "✓" : "✗"}`);
console.log(`  All channel-classified: ${allChannel ? "✓" : "✗"}`);
console.log(`  Avg estimated EMQ:     ${avgEmq}/10`);
