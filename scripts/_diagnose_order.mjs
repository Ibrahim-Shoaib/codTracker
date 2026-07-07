// Generic order diagnostic — pass the Shopify order name (e.g. "#9387") via
// ORDER env var. Reports CAPI delivery, identity recovery path, and IAB
// detection from the User-Agent.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const ORDER_NAME = process.env.ORDER || "#9387";

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

// Pull last 10 orders so we don't miss it on a long day.
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const todayPktDate = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
const startUtc = new Date(`${todayPktDate}T00:00:00Z`).getTime() - PKT_OFFSET_MS;
const startIso = new Date(startUtc).toISOString();

const r = await fetch(
  `https://${SHOP}/admin/api/2025-01/orders.json?` +
    new URLSearchParams({ created_at_min: startIso, status: "any", limit: "20" }),
  { headers: { "X-Shopify-Access-Token": accessToken } }
);
const { orders } = await r.json();
const o = orders.find((x) => x.name === ORDER_NAME);
if (!o) {
  console.error(`Order ${ORDER_NAME} not in latest 20 orders. Names found: ${orders.map((x) => x.name).join(", ")}`);
  process.exit(1);
}

console.log(`═══ ${o.name} (id=${o.id}) ═══`);
console.log(`  created_at:       ${o.created_at}`);
console.log(`  total_price:      ${o.total_price} ${o.currency}`);
console.log(`  source_name:      ${o.source_name}`);
console.log(`  financial_status: ${o.financial_status}`);
console.log(`  customer:         ${o.customer?.email ?? "(no email)"} / ${o.phone ?? o.customer?.phone ?? "(no phone)"}`);

console.log(`\n═══ Browser environment ═══`);
const ua = o.client_details?.user_agent ?? "";
const ip = o.client_details?.browser_ip ?? "";
console.log(`  IP:           ${ip}`);
console.log(`  referring:    ${o.referring_site ?? "(none)"}`);
console.log(`  UA:           ${ua}`);
const isInstagramIab = /\bInstagram\b/.test(ua) || /IABMV\//.test(ua);
const isFacebookIab = /FB_IAB|FBAV/.test(ua);
const isIab = isInstagramIab || isFacebookIab;
if (isInstagramIab) console.log(`  → Instagram in-app browser (IAB) — expect missing _fbp/_cod_visitor_id`);
else if (isFacebookIab) console.log(`  → Facebook in-app browser (IAB) — expect missing _fbp/_cod_visitor_id`);
else console.log(`  → Regular mobile/desktop browser — cart attrs should write normally`);

console.log(`\n═══ Cart attributes (note_attributes) ═══`);
const targetKeys = ["_cod_visitor_id", "_fbp", "_fbc", "_fbclid", "_cod_event_id", "_client_ua"];
const attrPresent = {};
for (const k of targetKeys) {
  const a = (o.note_attributes ?? []).find((x) => x.name === k || x.key === k);
  attrPresent[k] = a?.value ?? null;
  console.log(`  ${k.padEnd(20)} ${a?.value ? `✓ "${String(a.value).slice(0, 60)}${String(a.value).length > 60 ? "..." : ""}"` : "✗ missing"}`);
}

console.log(`\n═══ Identity recovery tier ═══`);
const cartAttrsAny = Object.values(attrPresent).some((v) => v !== null);
const fbclidInUrl = (o.landing_site || "").includes("fbclid=");
let tier;
if (cartAttrsAny) tier = "1 — cart attributes (best)";
else if (fbclidInUrl) tier = "2 — fbclid from landing_site URL → synthesized fbc";
else tier = "3 — IP+UA+recency match, or hashed PII only";
console.log(`  Active tier:  ${tier}`);
console.log(`  landing_site has fbclid: ${fbclidInUrl ? "yes" : "no"}`);
if (!cartAttrsAny && fbclidInUrl) console.log(`  → fbc will be synthesized from URL — Meta attribution still works`);

console.log(`\n═══ CAPI delivery log ═══`);
const expectedEventId = `purchase:${SHOP}:${o.id}`;
const { data: log } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, status, http_status, error_msg, trace_id, sent_at")
  .eq("store_id", SHOP)
  .eq("event_id", expectedEventId)
  .order("sent_at", { ascending: false });
if (!log?.length) {
  console.log(`  ✗ NO ROW for event_id ${expectedEventId}`);
} else {
  for (const row of log) {
    const ok = row.status === "sent" && row.http_status === 200;
    console.log(`  ${ok ? "✓" : "✗"} ${row.event_name.padEnd(10)} status=${row.status} http=${row.http_status} trace=${row.trace_id ?? "—"} ${row.sent_at}`);
  }
}

console.log(`\n═══ Retries (should be empty) ═══`);
const { data: retries } = await sb
  .from("capi_retries")
  .select("event_id, attempts, last_error")
  .eq("store_id", SHOP)
  .eq("event_id", expectedEventId);
console.log(retries?.length ? `  ⚠ ${retries.length} pending` : `  ✓ none`);

console.log(`\n═══ order_attribution row ═══`);
const { data: attr } = await sb
  .from("order_attribution")
  .select("channel, visitor_id, utm_source, utm_campaign")
  .eq("store_id", SHOP)
  .eq("shopify_order_id", String(o.id))
  .maybeSingle();
if (!attr) console.log(`  ✗ no row`);
else console.log(`  channel: ${attr.channel}  visitor_id: ${attr.visitor_id ?? "(none)"}  utm_source: ${attr.utm_source ?? "(none)"}`);

console.log(`\n═══ Verdict ═══`);
const sent = log?.some((r) => r.event_name === "Purchase" && r.status === "sent");
console.log(`  CAPI sent (200):           ${sent ? "✓" : "✗"}`);
console.log(`  No retries pending:        ${!retries?.length ? "✓" : "✗"}`);
console.log(`  order_attribution row:     ${attr ? "✓" : "✗"}`);
console.log(`  Identity quality:          ${cartAttrsAny ? "FULL" : isIab ? "PARTIAL (IAB-blocked, fbc synthesized)" : "PARTIAL (no fbc anywhere)"}`);
