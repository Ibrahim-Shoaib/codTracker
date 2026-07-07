// Comprehensive identity coverage analysis: what Meta sees per event, what
// we send, and where the gaps are.
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../app/lib/crypto.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
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

// 1. What MATCH KEYS does Meta see, aggregated across last 24h of buckets?
console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(" META'S VIEW — match_keys aggregation (last ~24h)");
console.log("═══════════════════════════════════════════════════════════════════════════");
const matchKeysRes = await fetch(
  `https://graph.facebook.com/v24.0/${ds}/stats?` +
    new URLSearchParams({ access_token: token, aggregation: "match_keys" })
);
const matchKeysJson = await matchKeysRes.json();

// Get total events per event_name in same window (for coverage %)
const totalsRes = await fetch(
  `https://graph.facebook.com/v24.0/${ds}/stats?` +
    new URLSearchParams({ access_token: token, aggregation: "event" })
);
const totalsJson = await totalsRes.json();

// Aggregate match_keys across all hourly buckets per event
const keyTally = new Map(); // event → Map(key → count)
for (const bucket of matchKeysJson.data ?? []) {
  for (const row of bucket.data ?? []) {
    const ev = row.event;
    const key = row.value;
    const cnt = Number(row.count ?? 0);
    if (!keyTally.has(ev)) keyTally.set(ev, new Map());
    const m = keyTally.get(ev);
    m.set(key, (m.get(key) ?? 0) + cnt);
  }
}

// Aggregate event totals
const eventTotals = new Map();
for (const bucket of totalsJson.data ?? []) {
  for (const row of bucket.data ?? []) {
    const ev = row.value;
    const cnt = Number(row.count ?? 0);
    eventTotals.set(ev, (eventTotals.get(ev) ?? 0) + cnt);
  }
}

console.log(
  `\n${"event".padEnd(18)} ${"total".padStart(6)}  match-key coverage`
);
console.log("─".repeat(85));
for (const [ev, total] of [...eventTotals.entries()].sort(
  (a, b) => b[1] - a[1]
)) {
  const keys = keyTally.get(ev) ?? new Map();
  const formatted = [...keys.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => `${k}=${c}(${((100 * c) / total).toFixed(0)}%)`)
    .join("  ");
  console.log(`${ev.padEnd(18)} ${String(total).padStart(6)}  ${formatted}`);
}

// 2. What WE STORE for visitors (corroborates what we're sending)
console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
console.log(" OUR DB — visitor identity hash coverage");
console.log("═══════════════════════════════════════════════════════════════════════════");
const { data: visitors } = await sb
  .from("visitors")
  .select(
    "em_hash, ph_hash, fn_hash, ln_hash, ct_hash, st_hash, zp_hash, country_hash, external_id_hash, latest_fbp, latest_fbc, latest_ip, latest_ua"
  )
  .eq("store_id", SHOP);
const n = visitors.length;
const cov = {
  em: 0, ph: 0, fn: 0, ln: 0, ct: 0, st: 0, zp: 0, country: 0,
  external_id: 0, fbp: 0, fbc: 0, ip: 0, ua: 0,
};
for (const v of visitors) {
  if (v.em_hash) cov.em++;
  if (v.ph_hash) cov.ph++;
  if (v.fn_hash) cov.fn++;
  if (v.ln_hash) cov.ln++;
  if (v.ct_hash) cov.ct++;
  if (v.st_hash) cov.st++;
  if (v.zp_hash) cov.zp++;
  if (v.country_hash) cov.country++;
  if (v.external_id_hash) cov.external_id++;
  if (v.latest_fbp) cov.fbp++;
  if (v.latest_fbc) cov.fbc++;
  if (v.latest_ip) cov.ip++;
  if (v.latest_ua) cov.ua++;
}
console.log(`Total visitors stored: ${n}`);
for (const [k, c] of Object.entries(cov)) {
  const pct = ((100 * c) / Math.max(1, n)).toFixed(1);
  console.log(`  ${k.padEnd(15)} ${String(c).padStart(4)}/${n}  (${pct}%)`);
}

// 3. What % of Purchase events get the cross-session enrichment vs only what was on the order
console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
console.log(" PURCHASE webhook — visitor cross-session enrichment effect");
console.log("═══════════════════════════════════════════════════════════════════════════");
const { data: purchases } = await sb
  .from("capi_delivery_log")
  .select("event_id, sent_at")
  .eq("store_id", SHOP)
  .eq("event_name", "Purchase");
console.log(`Total Purchase event rows in capi_delivery_log: ${purchases.length}`);
console.log(`(Purchase event_id format = purchase:shop:order_id — deterministic)`);

// 4. event_source — browser vs server split
console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
console.log(" Browser vs Server event split (last ~24h, Meta's view)");
console.log("═══════════════════════════════════════════════════════════════════════════");
const sourceRes = await fetch(
  `https://graph.facebook.com/v24.0/${ds}/stats?` +
    new URLSearchParams({ access_token: token, aggregation: "event_source" })
);
const sourceJson = await sourceRes.json();
const sourceTally = { BROWSER: 0, SERVER: 0 };
for (const bucket of sourceJson.data ?? []) {
  for (const row of bucket.data ?? []) {
    sourceTally[row.value] = (sourceTally[row.value] ?? 0) + Number(row.count ?? 0);
  }
}
const tot = (sourceTally.BROWSER ?? 0) + (sourceTally.SERVER ?? 0);
console.log(`  BROWSER: ${sourceTally.BROWSER ?? 0}  (${((100 * (sourceTally.BROWSER ?? 0)) / tot).toFixed(1)}%)`);
console.log(`  SERVER:  ${sourceTally.SERVER ?? 0}  (${((100 * (sourceTally.SERVER ?? 0)) / tot).toFixed(1)}%)`);

// 5. Is the visitor_id ever flowing through to the Purchase event as external_id?
//    Sample 5 most-recent orders' note_attributes (if Shopify mirrors them anywhere we can read).
//    We don't have orders cached locally; this is just to confirm the cart-attr key name expected.
console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
console.log(" Cart-attribute identity flow (server-side webhook reads)");
console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(`
Identity keys read from order.note_attributes by extractIdentityFromOrder:
  - _fbp / fbp
  - _fbc / fbc
  - _fbclid / fbclid
  - _client_ua / client_ua
  - _cod_event_id / event_id  (used to dedup with Web Pixel)
  - _cod_visitor_id           (used for visitor row lookup, NOT passed to Meta)

Customer identity from extractCustomerIdentity (used in webhook handler):
  - email = order.email | customer.email
  - phone = order.phone | customer.phone | shipping.phone
  - firstName/lastName = customer | shipping fallback
  - city/state/zip/country = shipping_address
  - externalId = customer.id   ← Shopify customer id (NOT our visitor_id)

KEY GAP IDENTIFIED:
  Storefront beacons could send visitor_id as external_id (we mint a stable
  UUID per browser at /apps/tracking/config). Currently we DON'T — external_id
  is only set when a logged-in customer's id is staged from Liquid AM, which
  only fires for ~10-20% of traffic.

  The Purchase webhook uses Shopify customer.id, which is a different
  identifier than what storefront events use. So Meta cannot link a visitor's
  pre-purchase browse history to their conversion via external_id.
`);
