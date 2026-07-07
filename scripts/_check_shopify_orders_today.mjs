// Pull today's Shopify orders directly from the Admin API to compare against
// what our CAPI relay fired. Identifies exactly which orders our webhook
// missed, if any.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Get the offline access token from Shopify session storage
const { data: sessions } = await sb
  .from("shopify_sessions")
  .select("shop, accessToken, isOnline, scope, expires")
  .eq("shop", SHOP)
  .eq("isOnline", false);

if (!sessions?.length) {
  console.error("No offline session found for", SHOP);
  process.exit(1);
}
const session = sessions[0];
console.log(`Using offline session — scope: ${session.scope}`);

// PKT today
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const todayPktDate = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
const startUtc = new Date(`${todayPktDate}T00:00:00Z`).getTime() - PKT_OFFSET_MS;
const startIso = new Date(startUtc).toISOString();

console.log(`\nFetching orders created since ${startIso} (= ${todayPktDate} 00:00 PKT)...`);

const url = `https://${SHOP}/admin/api/2025-01/orders.json?` +
  new URLSearchParams({
    created_at_min: startIso,
    status: "any",
    limit: "100",
    fields: "id,name,created_at,processed_at,total_price,financial_status,fulfillment_status,note_attributes,customer,source_name",
  });

const res = await fetch(url, {
  headers: { "X-Shopify-Access-Token": session.accessToken },
});

if (!res.ok) {
  console.error(`Shopify API ${res.status}:`, await res.text());
  process.exit(1);
}

const { orders } = await res.json();
console.log(`\n═══════════════════════════════════════════════════════════════════════════`);
console.log(` Today's Shopify orders for ${SHOP}`);
console.log(`═══════════════════════════════════════════════════════════════════════════`);
console.log(`Total orders today (PKT): ${orders.length}\n`);

// Pull our CAPI fires for cross-reference
const { data: ourFires } = await sb
  .from("capi_delivery_log")
  .select("event_id, sent_at")
  .eq("store_id", SHOP)
  .eq("event_name", "Purchase")
  .gte("sent_at", startIso);

const firedOrderIds = new Set();
for (const r of ourFires ?? []) {
  const m = r.event_id.match(/purchase:[^:]+:(.+)$/);
  if (m) firedOrderIds.add(m[1]);
}

console.log(`${"order".padEnd(15)} ${"created (UTC)".padEnd(28)} ${"source".padEnd(20)} ${"price".padStart(8)}  CAPI fired?  notes`);
console.log("─".repeat(110));

for (const o of orders) {
  const orderIdStr = String(o.id);
  const fired = firedOrderIds.has(orderIdStr);
  const visitorAttr = (o.note_attributes ?? []).find((a) => a.name === "_cod_visitor_id" || a.key === "_cod_visitor_id");
  const fbpAttr = (o.note_attributes ?? []).find((a) => a.name === "_fbp" || a.key === "_fbp");
  const fbcAttr = (o.note_attributes ?? []).find((a) => a.name === "_fbc" || a.key === "_fbc");

  const noteParts = [];
  if (!fired) noteParts.push("⚠ MISSED");
  if (!visitorAttr) noteParts.push("no visitor_id");
  if (!fbpAttr) noteParts.push("no fbp");
  if (!fbcAttr) noteParts.push("no fbc");
  if (o.source_name) noteParts.push(`src=${o.source_name}`);

  console.log(
    `${o.name.padEnd(15)} ${o.created_at.padEnd(28)} ${(o.source_name ?? "?").padEnd(20)} ${(o.total_price ?? "?").padStart(8)}  ${fired ? "✓        " : "✗ MISSED"}    ${noteParts.join(", ")}`
  );
}

console.log("\n─── Gap summary ───");
const total = orders.length;
const fired = orders.filter((o) => firedOrderIds.has(String(o.id))).length;
const missed = total - fired;
console.log(`  Total Shopify orders today:    ${total}`);
console.log(`  Our CAPI fired Purchase for:   ${fired}`);
console.log(`  Missed:                        ${missed}`);

if (missed > 0) {
  console.log(`\n  ⚠ ${missed} orders did not generate a CAPI Purchase event from our app.`);
  console.log(`  Possible causes:`);
  console.log(`    1. Webhook subscription missing/broken — check Shopify webhook delivery in Notifications → Webhooks`);
  console.log(`    2. Source channel not webhook-eligible (POS, draft orders, manual orders)`);
  console.log(`    3. Webhook delivered but our handler errored — check Railway logs`);
  console.log(`    4. Order created before our app was installed/connected`);
}
