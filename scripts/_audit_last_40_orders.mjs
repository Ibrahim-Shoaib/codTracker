// Per-order audit, last 40 Shopify orders for Trendy Homes.
// For each order, verify:
//   - CAPI Purchase fired (order_attribution.capi_sent_at OR capi_delivery_log)
//   - Visitor row exists and has identity (em/ph/fn/ln/ct/zp/country)
//   - fbc full vs truncated
//   - Channel attributed correctly
//   - Order is alive vs voided/cancelled (money loss flag)
//   - Checkout events fired (IC/AddPaymentInfo present in logs)
//
// Outputs:
//   - Per-order line: pass/warn/fail per category
//   - Aggregate health: success rate, identity coverage, money-loss count

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
await sb.rpc("set_app_store", { store: SHOP });

const head = (s) => console.log("\n" + "═".repeat(110) + "\n " + s + "\n" + "═".repeat(110));
const sub = (s) => console.log("\n── " + s + " ──");
const pad = (s, n) => String(s ?? "").padEnd(n);
const fmt = (n) => Number(n ?? 0).toLocaleString();

// 1. Pull Shopify offline session token
const { data: sess } = await sb.from("shopify_sessions")
  .select("accessToken")
  .eq("shop", SHOP)
  .eq("isOnline", false);
const token = sess?.[0]?.accessToken;
if (!token) { console.error("No Shopify offline session"); process.exit(1); }

// 2. Pull last 40 Shopify orders
const url = `https://${SHOP}/admin/api/2025-10/orders.json?` +
  new URLSearchParams({
    status: "any",
    limit: "40",
    order: "created_at desc",
    fields: "id,name,created_at,processed_at,cancelled_at,total_price,currency,financial_status,fulfillment_status,email,phone,customer,billing_address,shipping_address,landing_site,note_attributes",
  });
const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
if (!res.ok) { console.error("Shopify err", res.status, await res.text()); process.exit(1); }
const { orders } = await res.json();

head(`AD TRACKING AUDIT — ${SHOP}`);
console.log(`Fetched ${orders.length} most recent Shopify orders`);
console.log(`Now (UTC): ${new Date().toISOString()}`);

const orderIds = orders.map((o) => String(o.id));
const eventIds = orderIds.map((id) => `purchase:${SHOP}:${id}`);

// 3. Pull capi_delivery_log Purchase rows
const { data: capiLog } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, http_status, sent_at, error_msg, match_keys, emq")
  .eq("store_id", SHOP)
  .in("event_id", eventIds);
const capiByEvent = {};
for (const r of capiLog ?? []) {
  capiByEvent[r.event_id] ??= [];
  capiByEvent[r.event_id].push(r);
}

// 4. Pull order_attribution
const { data: attrRows } = await sb
  .from("order_attribution")
  .select("shopify_order_id, channel, capi_sent_at, visitor_id, utm_source, utm_medium, utm_campaign, first_touch_url, attributed_at")
  .eq("store_id", SHOP)
  .in("shopify_order_id", orderIds);
const attrById = {};
for (const a of attrRows ?? []) attrById[a.shopify_order_id] = a;

// 5. Pull visitor rows for visitor_ids referenced
const visitorIds = [...new Set((attrRows ?? []).map((a) => a.visitor_id).filter(Boolean))];
const { data: visitors } = visitorIds.length
  ? await sb.from("visitors")
      .select("visitor_id, em_hash, ph_hash, fn_hash, ln_hash, ct_hash, st_hash, zp_hash, country_hash, latest_fbp, latest_fbc, fbc_history, last_seen_at")
      .eq("store_id", SHOP)
      .in("visitor_id", visitorIds)
  : { data: [] };
const visitorById = {};
for (const v of visitors ?? []) visitorById[v.visitor_id] = v;

// 6. Pull capi_retries (anything stuck?)
const { data: retries } = await sb
  .from("capi_retries")
  .select("event_id, attempt_count, last_error, next_attempt_at")
  .eq("store_id", SHOP)
  .in("event_id", eventIds);
const retryByEvent = {};
for (const r of retries ?? []) retryByEvent[r.event_id] = r;

// 7. Pull PostEx orders for cross-check (not all Shopify orders make it to PostEx — drop rate matters)
const { data: postexOrders } = await sb
  .from("orders")
  .select("order_ref_number, transaction_status, is_delivered, is_returned, is_in_transit, invoice_payment, transaction_date")
  .eq("store_id", SHOP)
  .in("order_ref_number", orders.map((o) => o.name?.replace(/^#/, "")).filter(Boolean));
const postexByRef = {};
for (const p of postexOrders ?? []) postexByRef[p.order_ref_number] = p;

// ── Per-order analysis ──
head("PER-ORDER REPORT");

let lostMoney = []; // orders where CAPI may not have credited
let voided = [];
let identityWeak = []; // orders whose visitor row has < 4 PII fields
let fbcTruncated = []; // orders that fired with synthesized fbc < 100 chars
let healthyCount = 0;
let allFlags = { capi: 0, identity: 0, fbc: 0, channel: 0, alive: 0 };

for (const o of orders) {
  const evId = `purchase:${SHOP}:${o.id}`;
  const fires = capiByEvent[evId] ?? [];
  const sentFires = fires.filter((f) => f.status === "sent");
  const attr = attrById[String(o.id)];
  const retry = retryByEvent[evId];
  const visitor = attr?.visitor_id ? visitorById[attr.visitor_id] : null;

  // FLAG 1: CAPI fired?
  const capiFired = !!attr?.capi_sent_at || sentFires.length > 0;

  // FLAG 2: identity fields on visitor row
  let identityCount = 0;
  if (visitor) {
    if (visitor.em_hash) identityCount++;
    if (visitor.ph_hash) identityCount++;
    if (visitor.fn_hash) identityCount++;
    if (visitor.ln_hash) identityCount++;
    if (visitor.ct_hash) identityCount++;
    if (visitor.st_hash) identityCount++;
    if (visitor.zp_hash) identityCount++;
    if (visitor.country_hash) identityCount++;
  }
  // Or check the actual capi log payload's match_keys for this order
  const richestFire = sentFires.sort((a, b) => (b.match_keys?.length ?? 0) - (a.match_keys?.length ?? 0))[0];
  const fireMatchKeys = richestFire?.match_keys ?? [];
  const fireIdentityCount = fireMatchKeys.filter((k) => ["em", "ph", "fn", "ln", "ct", "st", "zp", "country"].includes(k)).length;

  // FLAG 3: fbc check
  const fbcInPayload = fireMatchKeys.includes("fbc");
  const fbcSource = visitor?.latest_fbc;
  const fbcLen = fbcSource ? fbcSource.length : 0;
  const fbcTruncatedFlag = fbcInPayload && fbcLen > 0 && fbcLen < 80;

  // FLAG 4: channel attribution
  const channelAttributed = !!attr?.channel;
  const isPaidChannel = attr?.channel === "facebook_ads" || attr?.channel === "instagram_ads";

  // FLAG 5: order is alive (not voided/cancelled)
  const isVoided = o.financial_status === "voided" || !!o.cancelled_at;

  // Aggregate flags
  if (capiFired) allFlags.capi++;
  if (fireIdentityCount >= 4) allFlags.identity++;
  if (!fbcTruncatedFlag && fbcInPayload) allFlags.fbc++;
  if (channelAttributed) allFlags.channel++;
  if (!isVoided) allFlags.alive++;

  // Categorize
  if (!capiFired) lostMoney.push({ ...o, reason: "CAPI never fired" });
  if (isVoided && capiFired) voided.push(o);
  if (capiFired && fireIdentityCount < 4 && isPaidChannel) identityWeak.push({ ...o, identityCount: fireIdentityCount });
  if (fbcTruncatedFlag) fbcTruncated.push({ ...o, fbcLen });

  // Pretty print
  const status =
    !capiFired ? "❌ NO CAPI" :
    isVoided ? "⚠ VOIDED " :
    fireIdentityCount < 3 && isPaidChannel ? "⚠ LOW PII" :
    "✅ HEALTHY";
  if (status === "✅ HEALTHY") healthyCount++;

  const line = [
    pad(o.name, 7),
    pad(o.created_at?.slice(0, 19).replace("T", " "), 20),
    pad(o.financial_status ?? "?", 8),
    pad(`${fmt(o.total_price)} ${o.currency}`, 14),
    pad(attr?.channel ?? "—", 16),
    pad(`PII=${fireIdentityCount}/8`, 9),
    pad(`fbc=${fbcInPayload ? `y(${fbcLen})` : "n"}`, 11),
    pad(retry ? `RETRY x${retry.attempt_count}` : "", 12),
    status,
  ].join(" ");
  console.log(line);
}

head("AGGREGATE HEALTH (out of " + orders.length + " orders)");
const pct = (n) => `${((n / orders.length) * 100).toFixed(0)}%`;
console.log(`  CAPI fired:                    ${allFlags.capi}/${orders.length} (${pct(allFlags.capi)})`);
console.log(`  Strong identity (≥4 PII keys): ${allFlags.identity}/${orders.length} (${pct(allFlags.identity)})`);
console.log(`  fbc present + full length:     ${allFlags.fbc}/${orders.length} (${pct(allFlags.fbc)})`);
console.log(`  Channel attributed:            ${allFlags.channel}/${orders.length} (${pct(allFlags.channel)})`);
console.log(`  Alive (not voided/cancelled):  ${allFlags.alive}/${orders.length} (${pct(allFlags.alive)})`);
console.log(`  All-green health:              ${healthyCount}/${orders.length} (${pct(healthyCount)})`);

if (lostMoney.length) {
  sub(`⚠ ORDERS WITH NO CAPI FIRE — Meta cannot credit these: ${lostMoney.length}`);
  for (const o of lostMoney) console.log(`  ${o.name} ${o.created_at} ${fmt(o.total_price)} ${o.currency}`);
}

if (voided.length) {
  sub(`⚠ VOIDED orders that already fired Purchase to Meta — Meta still counts them as conversions: ${voided.length}`);
  for (const o of voided) console.log(`  ${o.name} ${o.created_at} voided=${o.cancelled_at} ${fmt(o.total_price)} ${o.currency}`);
  console.log(`  → This is the orders/cancelled handler we didn't deploy. Each of these is "ad-spend wasted on a non-conversion".`);
}

if (identityWeak.length) {
  sub(`⚠ Paid-channel orders with LOW identity coverage (<4 PII keys): ${identityWeak.length}`);
  for (const o of identityWeak) console.log(`  ${o.name} ${o.created_at} ${fmt(o.total_price)} channel=${attrById[String(o.id)]?.channel} keys=${o.identityCount}`);
  console.log(`  → These conversions are credited but with weak match probability.`);
}

if (fbcTruncated.length) {
  sub(`⚠ Orders with truncated fbc (<80 chars) — Meta Diagnostic 1 candidates: ${fbcTruncated.length}`);
  for (const o of fbcTruncated) console.log(`  ${o.name} fbc length=${o.fbcLen}`);
  console.log(`  → Fix #1 demoted synthesized fbc, but these may have fired BEFORE the Railway deploy picks up.`);
}

// ── Recent activity sanity check ──
head("RECENT INFRASTRUCTURE HEALTH");

// Pixel connection
const { data: pix } = await sb.from("meta_pixel_connections").select("status, last_event_sent_at, dataset_id").eq("store_id", SHOP).single();
const minSinceLastEvent = pix ? (Date.now() - new Date(pix.last_event_sent_at).getTime()) / 60000 : null;
console.log(`  Pixel status:           ${pix?.status} (dataset=${pix?.dataset_id})`);
console.log(`  Last CAPI event:        ${pix?.last_event_sent_at} (${minSinceLastEvent?.toFixed(0)} min ago)`);
if (minSinceLastEvent > 60) console.log(`  ⚠ No CAPI events fired in ${minSinceLastEvent.toFixed(0)} min — pipeline may be stalled`);

// Retry queue
const { count: retryCount } = await sb.from("capi_retries").select("*", { count: "exact", head: true }).eq("store_id", SHOP);
console.log(`  Pending CAPI retries:   ${retryCount ?? 0}`);

// Recent EMQ
const { data: recentEmq } = await sb
  .from("emq_snapshots")
  .select("captured_at, overall_emq, per_event")
  .eq("store_id", SHOP)
  .order("captured_at", { ascending: false })
  .limit(3);
sub("Recent EMQ snapshots");
for (const e of recentEmq ?? []) {
  console.log(`  ${e.captured_at}  overall=${e.overall_emq}  ${JSON.stringify(e.per_event)}`);
}

// Last 24h CAPI mix
const since24 = new Date(Date.now() - 86400000).toISOString();
const { data: log24 } = await sb
  .from("capi_delivery_log")
  .select("event_name, status")
  .eq("store_id", SHOP)
  .gte("sent_at", since24);
const dist24 = {};
for (const r of log24 ?? []) {
  dist24[r.event_name] ??= { sent: 0, failed: 0 };
  dist24[r.event_name][r.status === "sent" ? "sent" : "failed"]++;
}
sub("CAPI delivery last 24h");
for (const [k, v] of Object.entries(dist24)) console.log(`  ${pad(k, 22)} sent=${v.sent} failed=${v.failed}`);

// Visitor identity coverage in last 24h
sub("Visitor row PII coverage (visitors active in last 24h)");
const { data: recentVisitors } = await sb
  .from("visitors")
  .select("em_hash, ph_hash, fn_hash, ln_hash, ct_hash, country_hash")
  .eq("store_id", SHOP)
  .gte("last_seen_at", since24);
let cnt = recentVisitors?.length ?? 0;
let withEm = 0, withPh = 0, withFn = 0, withLn = 0, withCt = 0, withCountry = 0;
for (const v of recentVisitors ?? []) {
  if (v.em_hash) withEm++;
  if (v.ph_hash) withPh++;
  if (v.fn_hash) withFn++;
  if (v.ln_hash) withLn++;
  if (v.ct_hash) withCt++;
  if (v.country_hash) withCountry++;
}
const vp = (n) => cnt ? `${((n/cnt)*100).toFixed(0)}%` : "—";
console.log(`  Total: ${cnt}`);
console.log(`  em_hash:   ${withEm}/${cnt} (${vp(withEm)})  ← Fix #2 verification (was 0% before)`);
console.log(`  ph_hash:   ${withPh}/${cnt} (${vp(withPh)})`);
console.log(`  fn_hash:   ${withFn}/${cnt} (${vp(withFn)})`);
console.log(`  ln_hash:   ${withLn}/${cnt} (${vp(withLn)})`);
console.log(`  ct_hash:   ${withCt}/${cnt} (${vp(withCt)})`);
console.log(`  country:   ${withCountry}/${cnt} (${vp(withCountry)})`);
