// Last 20 Shopify orders for Trendy → cross-reference CAPI fire status.
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

const pad = (s, n) => String(s ?? "").padEnd(n);
const head = (s) => console.log("\n" + "═".repeat(95) + "\n " + s + "\n" + "═".repeat(95));

// Get Shopify token
const { data: sess } = await sb.from("shopify_sessions").select("accessToken").eq("shop", SHOP).eq("isOnline", false);
const token = sess?.[0]?.accessToken;
if (!token) { console.error("No Shopify offline session"); process.exit(1); }

// Pull last 20 orders
const url = `https://${SHOP}/admin/api/2025-10/orders.json?` +
  new URLSearchParams({ status: "any", limit: "20", order: "created_at desc", fields: "id,name,created_at,processed_at,total_price,currency,financial_status,cancelled_at,email,phone,billing_address,note_attributes,landing_site,referring_site,customer" });
const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
if (!res.ok) { console.error("Shopify err", res.status, await res.text()); process.exit(1); }
const { orders } = await res.json();

console.log(`Pulled ${orders.length} most recent Shopify orders for ${SHOP}`);

// Pull CAPI Purchase events whose event_id matches each order
const orderIds = orders.map((o) => String(o.id));
const eventIds = orderIds.map((id) => `purchase:${SHOP}:${id}`);
const { data: capi } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, http_status, sent_at, error_msg, match_keys, emq")
  .eq("store_id", SHOP)
  .in("event_id", eventIds)
  .order("sent_at", { ascending: true });

const capiByEvent = {};
for (const r of capi ?? []) {
  capiByEvent[r.event_id] ??= [];
  capiByEvent[r.event_id].push(r);
}

// Pull order_attribution for these
const { data: attr } = await sb
  .from("order_attribution")
  .select("shopify_order_id, channel, capi_sent_at, visitor_id, utm_source, first_touch_url, attributed_at")
  .eq("store_id", SHOP)
  .in("shopify_order_id", orderIds);
const attrById = {};
for (const a of attr ?? []) attrById[a.shopify_order_id] = a;

// Pull capi_retries to see if any are stuck
const retryEventIds = eventIds;
const { data: retries } = await sb
  .from("capi_retries")
  .select("event_id, attempt_count, last_error, next_attempt_at")
  .eq("store_id", SHOP)
  .in("event_id", retryEventIds);
const retryByEvent = {};
for (const r of retries ?? []) retryByEvent[r.event_id] = r;

head("Per-order CAPI status (most recent first)");
console.log(`${pad("name", 8)} ${pad("created_at (UTC)", 26)} ${pad("total", 8)} ${pad("fin", 6)} ${pad("CAPI fires", 11)} ${pad("attr.channel", 16)} ${pad("vid", 4)} ${pad("attr.capi_sent_at", 26)} retry?`);
let firedOK = 0, missing = 0, retrying = 0;
for (const o of orders) {
  const evId = `purchase:${SHOP}:${o.id}`;
  const fires = capiByEvent[evId] ?? [];
  const sentCount = fires.filter((f) => f.status === "sent").length;
  const a = attrById[String(o.id)];
  const retry = retryByEvent[evId];
  const fireStr = `${sentCount}/${fires.length}sent`;
  console.log(
    `${pad(o.name, 8)} ${pad(o.created_at, 26)} ${pad(o.total_price, 8)} ${pad(o.financial_status, 6)} ${pad(fireStr, 11)} ${pad(a?.channel ?? "—", 16)} ${pad(a?.visitor_id ? "y" : "n", 4)} ${pad(a?.capi_sent_at ?? "—", 26)} ${retry ? `att=${retry.attempt_count} ${retry.last_error?.slice(0, 30)}` : "—"}`
  );
  if (sentCount > 0) firedOK++;
  else if (retry) retrying++;
  else missing++;
}

head("Summary");
console.log(`  Fired CAPI successfully (≥1 sent):  ${firedOK}/${orders.length}`);
console.log(`  In retry queue:                      ${retrying}/${orders.length}`);
console.log(`  No fire, no retry (lost):            ${missing}/${orders.length}`);

// What did the most recent successful Purchase fire actually contain?
head("Sample CAPI payload — most recent successful Purchase (match_keys)");
const recentSent = (capi ?? []).filter((r) => r.status === "sent").sort((a, b) => b.sent_at.localeCompare(a.sent_at))[0];
if (recentSent) {
  console.log(`event_id: ${recentSent.event_id}`);
  console.log(`sent_at:  ${recentSent.sent_at}`);
  console.log(`emq:      ${recentSent.emq}`);
  console.log(`match_keys present: ${JSON.stringify(recentSent.match_keys, null, 2)}`);
}

// How about a recent PageView? compare match_keys
head("Sample CAPI payload — most recent PageView (match_keys)");
const { data: pvSample } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, sent_at, emq, match_keys")
  .eq("store_id", SHOP)
  .eq("event_name", "PageView")
  .eq("status", "sent")
  .order("sent_at", { ascending: false })
  .limit(3);
for (const p of pvSample ?? []) {
  console.log(`---`);
  console.log(`event_id: ${p.event_id}`);
  console.log(`sent_at:  ${p.sent_at}`);
  console.log(`emq:      ${p.emq}`);
  console.log(`match_keys: ${JSON.stringify(p.match_keys, null, 2)}`);
}

head("Sample CAPI payload — most recent ViewContent");
const { data: vcSample } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, sent_at, emq, match_keys")
  .eq("store_id", SHOP)
  .eq("event_name", "ViewContent")
  .eq("status", "sent")
  .order("sent_at", { ascending: false })
  .limit(2);
for (const p of vcSample ?? []) {
  console.log(`---`);
  console.log(`event_id: ${p.event_id}`);
  console.log(`emq:      ${p.emq}`);
  console.log(`match_keys: ${JSON.stringify(p.match_keys, null, 2)}`);
}

head("Sample CAPI payload — most recent AddToCart");
const { data: atcSample } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, sent_at, emq, match_keys")
  .eq("store_id", SHOP)
  .eq("event_name", "AddToCart")
  .eq("status", "sent")
  .order("sent_at", { ascending: false })
  .limit(2);
for (const p of atcSample ?? []) {
  console.log(`---`);
  console.log(`event_id: ${p.event_id}`);
  console.log(`emq:      ${p.emq}`);
  console.log(`match_keys: ${JSON.stringify(p.match_keys, null, 2)}`);
}
