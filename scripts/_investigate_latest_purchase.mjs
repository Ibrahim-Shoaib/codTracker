// Thorough investigation of the most recent order: webhook delivery, CAPI
// fire, identity coverage, visitor stitching, and external_id rollout
// confirmation.
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../app/lib/crypto.server.js";

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
const sToken = sessions[0].accessToken;

// ─── 1. Pull the latest order from Shopify ──────────────────────────────
console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(" 1. LATEST ORDER (Shopify Admin API)");
console.log("═══════════════════════════════════════════════════════════════════════════");

const oRes = await fetch(
  `https://${SHOP}/admin/api/2025-01/orders.json?` +
    new URLSearchParams({
      status: "any",
      limit: "1",
      fields:
        "id,name,created_at,processed_at,total_price,currency,financial_status,fulfillment_status,note_attributes,landing_site,referring_site,client_details,customer,source_name,line_items",
    }),
  { headers: { "X-Shopify-Access-Token": sToken } }
);
const { orders } = await oRes.json();
if (!orders?.length) {
  console.log("No orders found.");
  process.exit(1);
}
const order = orders[0];
const orderIdStr = String(order.id);
const orderAgeSec = Math.floor((Date.now() - new Date(order.created_at).getTime()) / 1000);

console.log(`  Name:          ${order.name}`);
console.log(`  ID:            ${order.id}`);
console.log(`  Created:       ${order.created_at}  (${orderAgeSec}s ago)`);
console.log(`  Processed:     ${order.processed_at}`);
console.log(`  Source:        ${order.source_name}`);
console.log(`  Total:         ${order.total_price} ${order.currency}`);
console.log(`  Financial:     ${order.financial_status}`);
console.log(`  Customer:      id=${order.customer?.id ?? "(null)"}  email=${order.customer?.email ?? "(null)"}`);
console.log(`  Landing site:  ${order.landing_site ?? "(null)"}`);
console.log(`  Referring:     ${order.referring_site ?? "(null)"}`);
console.log(`  Browser IP:    ${order.client_details?.browser_ip ?? "(null)"}`);
console.log(`  User-agent:    ${(order.client_details?.user_agent ?? "(null)").slice(0, 80)}`);
console.log(`  Line items:    ${order.line_items?.length ?? 0}`);

console.log(`\n  note_attributes (${order.note_attributes?.length ?? 0}):`);
const attrMap = {};
for (const a of order.note_attributes ?? []) {
  const name = a.name ?? a.key;
  attrMap[name] = a.value;
  const v = String(a.value ?? "").length > 90 ? String(a.value).slice(0, 87) + "..." : a.value;
  console.log(`    ${name?.padEnd(28)} = ${v}`);
}

// ─── 2. Critical attribute checks (post-deploy validation) ───────────────
console.log("\n═══════════════════════════════════════════════════════════════════════════");
console.log(" 2. CART-ATTRIBUTE IDENTITY (validates today's deploy)");
console.log("═══════════════════════════════════════════════════════════════════════════");
const checks = [
  ["_fbp", "Browser ID cookie"],
  ["_fbc", "FB click ID cookie"],
  ["_fbclid", "Raw fbclid"],
  ["_client_ua", "User agent"],
  ["_cod_visitor_id", "Cross-session visitor ID — KEY CHECK for today's deploy"],
  ["_cod_event_id", "Pre-stamped event_id (browser-side dedup)"],
];
for (const [key, desc] of checks) {
  const present = key in attrMap;
  const symbol = present ? "✓" : "✗";
  const value = present ? attrMap[key] : "(missing)";
  const valDisplay = String(value).length > 60 ? String(value).slice(0, 57) + "..." : value;
  console.log(`  ${symbol} ${key.padEnd(20)} = ${valDisplay}  ${desc}`);
}
const visitorIdAttr = attrMap["_cod_visitor_id"];

// ─── 3. Did our app fire a Purchase CAPI for this order? ─────────────────
console.log("\n═══════════════════════════════════════════════════════════════════════════");
console.log(" 3. CAPI DELIVERY (our server's record)");
console.log("═══════════════════════════════════════════════════════════════════════════");
const expectedEventId = `purchase:${SHOP}:${orderIdStr}`;
const { data: log } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, status, http_status, error_msg, trace_id, sent_at")
  .eq("store_id", SHOP)
  .eq("event_id", expectedEventId)
  .order("sent_at", { ascending: true });

console.log(`  Expected event_id: ${expectedEventId}`);
console.log(`  Rows in delivery log: ${log?.length ?? 0}`);
if ((log?.length ?? 0) === 0) {
  console.log(`\n  ⚠ NO CAPI fire recorded for this order. Possible causes:`);
  console.log(`    • Webhook hasn't been delivered yet (very recent — Shopify can take 5-30s)`);
  console.log(`    • Webhook hit our server but errored before logging`);
  console.log(`    • Order created via a non-webhook-eligible channel`);
} else {
  for (const r of log) {
    const ageMs = Date.now() - new Date(r.sent_at).getTime();
    console.log(`    ${r.sent_at}  ${r.status}  HTTP ${r.http_status ?? "-"}  trace=${(r.trace_id ?? "").slice(0, 16)}  age=${(ageMs / 1000).toFixed(1)}s`);
    if (r.error_msg) console.log(`      error: ${r.error_msg}`);
  }
}

// ─── 4. Pending retries (in case it failed) ──────────────────────────────
console.log("\n─── capi_retries pending for this order ───");
const { data: retries } = await sb
  .from("capi_retries")
  .select("event_id, attempts, next_attempt_at, last_error, created_at")
  .eq("store_id", SHOP)
  .ilike("event_id", `%${orderIdStr}%`);
if ((retries?.length ?? 0) === 0) {
  console.log("  (none)");
} else {
  for (const r of retries) console.log(`  ${JSON.stringify(r)}`);
}

// ─── 5. Visitor row enrichment ───────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════════════════════════");
console.log(" 4. VISITOR ROW (cross-session stitching)");
console.log("═══════════════════════════════════════════════════════════════════════════");
if (visitorIdAttr) {
  const { data: visitor } = await sb
    .from("visitors")
    .select("*")
    .eq("store_id", SHOP)
    .eq("visitor_id", visitorIdAttr)
    .maybeSingle();
  if (!visitor) {
    console.log(`  ⚠ visitor_id "${visitorIdAttr}" was on the order but no visitor row exists.`);
  } else {
    console.log(`  visitor_id:        ${visitor.visitor_id}`);
    console.log(`  first_seen_at:     ${visitor.first_seen_at}`);
    console.log(`  last_seen_at:      ${visitor.last_seen_at}`);
    const seenSecs = (new Date(visitor.last_seen_at) - new Date(visitor.first_seen_at)) / 1000;
    console.log(`  session-span:      ${(seenSecs / 60).toFixed(1)} min`);
    console.log(`  em_hash:           ${visitor.em_hash ? "✓" : "✗"}`);
    console.log(`  ph_hash:           ${visitor.ph_hash ? "✓" : "✗"}`);
    console.log(`  fn/ln:             ${visitor.fn_hash ? "✓" : "✗"}/${visitor.ln_hash ? "✓" : "✗"}`);
    console.log(`  external_id_hash:  ${visitor.external_id_hash ? "✓" : "✗"}`);
    console.log(`  latest_fbp:        ${visitor.latest_fbp ?? "(null)"}`);
    console.log(`  latest_fbc:        ${(visitor.latest_fbc ?? "(null)").slice(0, 60)}`);
    console.log(`  latest_ip:         ${visitor.latest_ip ?? "(null)"}`);
    console.log(`  fbc_history:       ${(visitor.fbc_history ?? []).length} entries`);

    // Per-event breadcrumbs from this visitor
    const { data: events } = await sb
      .from("visitor_events")
      .select("event_name, occurred_at, fbp, fbc, utm_source, utm_campaign")
      .eq("store_id", SHOP)
      .eq("visitor_id", visitorIdAttr)
      .order("occurred_at", { ascending: true });
    console.log(`\n  visitor_events trail (${events?.length ?? 0} rows):`);
    for (const e of events ?? []) {
      console.log(
        `    ${e.occurred_at}  ${e.event_name.padEnd(18)} fbp=${!!e.fbp} fbc=${!!e.fbc} utm=${e.utm_source ?? "-"}/${e.utm_campaign ?? "-"}`
      );
    }
  }
} else {
  console.log(`  ⚠ No _cod_visitor_id on the order — cross-session enrichment can't run.`);
  console.log(`    Will check if the customer.id matches any visitor row instead.`);
  if (order.customer?.id) {
    const customerIdHash = await import("node:crypto").then((c) =>
      c.createHash("sha256").update(String(order.customer.id), "utf8").digest("hex")
    );
    const { data: matches } = await sb
      .from("visitors")
      .select("visitor_id, em_hash, last_seen_at")
      .eq("store_id", SHOP)
      .eq("external_id_hash", customerIdHash);
    console.log(`    Visitor rows with external_id_hash matching customer.id ${order.customer.id}: ${matches?.length ?? 0}`);
    for (const m of matches ?? []) console.log(`      ${JSON.stringify(m)}`);
  }
}

// ─── 6. Meta's stats — has Meta seen this Purchase yet? ──────────────────
console.log("\n═══════════════════════════════════════════════════════════════════════════");
console.log(" 5. META'S VIEW (stats endpoint)");
console.log("═══════════════════════════════════════════════════════════════════════════");
const { data: conn } = await sb
  .from("meta_pixel_connections")
  .select("dataset_id, bisu_token")
  .eq("store_id", SHOP)
  .single();
const token = decryptSecret(conn.bisu_token);
const ds = conn.dataset_id;

// Fetch latest hourly bucket for Purchase
const eventRes = await fetch(
  `https://graph.facebook.com/v24.0/${ds}/stats?` +
    new URLSearchParams({ access_token: token, aggregation: "event" })
);
const eventJson = await eventRes.json();

const orderHourBucket = new Date(order.created_at);
orderHourBucket.setUTCMinutes(0, 0, 0);
const orderBucketIso = orderHourBucket.toISOString().replace(".000Z", "+0000");

let metaPurchases = 0;
const buckets = eventJson.data ?? [];
const matchBucket = buckets.find((b) => b.start_time === orderBucketIso);
if (matchBucket) {
  for (const row of matchBucket.data ?? []) {
    if (row.value === "Purchase") metaPurchases = Number(row.count ?? 0);
  }
}
console.log(`  Order's hour bucket (UTC): ${orderBucketIso}`);
console.log(`  Purchase events Meta saw in that bucket: ${metaPurchases}`);
if (metaPurchases === 0) {
  console.log(`  (Meta's stats endpoint has 30-60 min processing delay. Re-run later.)`);
}

// match_keys for Purchase in that bucket
const mkRes = await fetch(
  `https://graph.facebook.com/v24.0/${ds}/stats?` +
    new URLSearchParams({ access_token: token, aggregation: "match_keys" })
);
const mkJson = await mkRes.json();
const mkBucket = (mkJson.data ?? []).find((b) => b.start_time === orderBucketIso);
if (mkBucket) {
  console.log(`\n  Match keys Meta extracted for that bucket's events:`);
  for (const row of mkBucket.data ?? []) {
    console.log(`    ${(row.event ?? "?").padEnd(20)} ${(row.value ?? "?").padEnd(20)} count=${row.count}`);
  }
}

// ─── 7. Final verdict ────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════════════════════════");
console.log(" 6. VERDICT");
console.log("═══════════════════════════════════════════════════════════════════════════");
const fired = (log?.length ?? 0) > 0;
const allSent = (log ?? []).every((r) => r.status === "sent");
const hasVisitorId = !!visitorIdAttr;
const hasFbp = "_fbp" in attrMap;

console.log(`  ${fired ? "✓" : "✗"} CAPI fire recorded for ${order.name}`);
console.log(`  ${allSent ? "✓" : "✗"} All fires successful (status=sent)`);
console.log(`  ${hasVisitorId ? "✓" : "✗"} _cod_visitor_id present in cart attributes`);
console.log(`  ${hasFbp ? "✓" : "✗"} _fbp present in cart attributes`);

if (!fired) {
  console.log(`\n  → Wait 30-60s and re-run; webhook may still be in-flight.`);
}
if (!hasVisitorId) {
  console.log(`\n  ⚠ _cod_visitor_id MISSING. Today's deploy may not be reaching this storefront.`);
  console.log(`    Possible causes:`);
  console.log(`      1. Theme app embed not enabled — check Online Store → Themes → Customize → App embeds`);
  console.log(`      2. Deploy didn't propagate to storefront cache (force-refresh storefront in browser)`);
  console.log(`      3. Visitor blocks third-party fetches (Brave/strict privacy mode)`);
  console.log(`      4. Bug in identity-relay.js's ensureVisitorId() flow — needs inspection`);
}
