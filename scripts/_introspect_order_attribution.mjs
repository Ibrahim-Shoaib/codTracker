// Confirm order_attribution shape + constraints + check whether capi_sent_at
// already exists from a prior migration I'm not aware of.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Sample one row to see all columns
const { data } = await sb.from("order_attribution").select("*").limit(1);
console.log("order_attribution columns:");
if (data?.[0]) {
  for (const k of Object.keys(data[0])) console.log(`  ${k}`);
} else {
  console.log("  (no rows)");
}

// Try selecting capi_sent_at to see if it exists
const probe = await sb.from("order_attribution").select("capi_sent_at").limit(1);
console.log("\ncapi_sent_at column exists?", probe.error ? "NO — " + probe.error.message.slice(0, 80) : "YES");

// Pull all 7 of today's rows + their event_id presence in capi_delivery_log
const PKT_OFFSET_MS = 5 * 3600 * 1000;
const todayPkt = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
const startUtc = new Date(`${todayPkt}T00:00:00Z`).getTime() - PKT_OFFSET_MS;
const startIso = new Date(startUtc).toISOString();
const endIso = new Date(startUtc + 24 * 3600 * 1000).toISOString();

const SHOP = "the-trendy-homes-pk.myshopify.com";
const { data: today } = await sb
  .from("order_attribution")
  .select("shopify_order_id, channel, attributed_at")
  .eq("store_id", SHOP)
  .gte("attributed_at", startIso)
  .lt("attributed_at", endIso);
console.log(`\nToday attribution rows: ${today?.length ?? 0}`);

const eventIds = (today ?? []).map((r) => `purchase:${SHOP}:${r.shopify_order_id}`);
const { data: logs } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, sent_at")
  .eq("store_id", SHOP)
  .eq("event_name", "Purchase")
  .in("event_id", eventIds);
const sentMap = new Map();
for (const l of logs ?? []) {
  if (l.status === "sent") {
    if (!sentMap.has(l.event_id) || l.sent_at < sentMap.get(l.event_id)) {
      sentMap.set(l.event_id, l.sent_at);
    }
  }
}
console.log("\nPer-order sent-evidence cross-check:");
for (const r of today ?? []) {
  const eid = `purchase:${SHOP}:${r.shopify_order_id}`;
  const evidence = sentMap.get(eid);
  console.log(`  order ${r.shopify_order_id} | channel=${r.channel} | sent log: ${evidence ?? "✗ MISSING (trimmed or never sent)"}`);
}
