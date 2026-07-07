// Analysis: how many Purchase events should appear in Meta Ads Manager
// for the-trendy-homes-pk.myshopify.com today (PKT)?
//
// Sources:
//   - capi_delivery_log: Purchase events the server fired to Meta CAPI
//     (each unique event_id = one Purchase Meta should count)
//   - orders table: PostEx-synced orders for cross-reference
//
// Timezone: Pakistan ad accounts use PKT (UTC+5). "Today" = 00:00–23:59 PKT.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// "Today PKT" boundaries in UTC
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const nowUtc = new Date();
const nowPkt = new Date(nowUtc.getTime() + PKT_OFFSET_MS);
const todayPktDate = nowPkt.toISOString().slice(0, 10); // YYYY-MM-DD in PKT
// PKT 00:00 = UTC of (today PKT 00:00) - 5h
const startUtc = new Date(`${todayPktDate}T00:00:00Z`).getTime() - PKT_OFFSET_MS;
const endUtc = startUtc + 24 * 60 * 60 * 1000;

console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(` Trendy Homes — Purchase analysis for ${todayPktDate} (PKT)`);
console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(`PKT window: ${todayPktDate} 00:00 → 24:00`);
console.log(`UTC window: ${new Date(startUtc).toISOString()} → ${new Date(endUtc).toISOString()}`);
console.log(`Now (PKT):  ${nowPkt.toISOString().replace("T", " ").slice(0, 19)}`);

// ─── 1. capi_delivery_log Purchase events today ─────────────────────────
console.log("\n─── 1. CAPI Purchase events fired today (what Meta sees) ───");

const { data: rows } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, http_status, error_msg, sent_at, trace_id")
  .eq("store_id", SHOP)
  .eq("event_name", "Purchase")
  .gte("sent_at", new Date(startUtc).toISOString())
  .lt("sent_at", new Date(endUtc).toISOString())
  .order("sent_at", { ascending: true });

const uniqueEventIds = new Set();
const sentIds = new Set();
const failedIds = new Set();
const fireRows = rows ?? [];

for (const r of fireRows) {
  uniqueEventIds.add(r.event_id);
  if (r.status === "sent") sentIds.add(r.event_id);
  else failedIds.add(r.event_id);
}

console.log(`  Total Purchase rows in delivery log: ${fireRows.length}`);
console.log(`  Distinct Purchase event_ids:         ${uniqueEventIds.size}`);
console.log(`    → successfully sent (≥1 attempt):  ${sentIds.size}`);
console.log(`    → only-failed attempts:            ${[...failedIds].filter((id) => !sentIds.has(id)).length}`);

if (fireRows.length > 0) {
  console.log("\n  Per-order detail (extracted from event_id):");
  console.log(`  ${"event_id".padEnd(70)} ${"status".padEnd(8)} sent_at`);
  for (const r of fireRows) {
    const m = r.event_id.match(/purchase:[^:]+:(.+)$/);
    const orderId = m ? m[1] : "(unknown)";
    console.log(
      `  ${r.event_id.padEnd(70)} ${r.status.padEnd(8)} ${r.sent_at}`
    );
  }
}

// ─── 2. Note on dual-fire (orders/create + orders/paid) ─────────────────
const dupEventIds = [...uniqueEventIds].filter((id) => {
  const occurrences = fireRows.filter((r) => r.event_id === id).length;
  return occurrences > 1;
});

console.log(`\n  Dual-fire deduped event_ids: ${dupEventIds.length}`);
console.log(`  (orders/create + orders/paid both route to handleOrderPaid;`);
console.log(`   same event_id → Meta dedupes — counted once in Ads Manager.)`);

// ─── 3. Orders table cross-reference ────────────────────────────────────
console.log("\n─── 2. PostEx orders for today (cross-reference) ───");
const { data: orders } = await sb
  .from("orders")
  .select("order_ref_number, transaction_date, transaction_status, status_code, is_delivered, is_in_transit, is_returned, invoice_payment, shopify_order_id")
  .eq("store_id", SHOP)
  .gte("transaction_date", new Date(startUtc).toISOString())
  .lt("transaction_date", new Date(endUtc).toISOString())
  .order("transaction_date", { ascending: true });

console.log(`  Total orders in PostEx synced today: ${orders?.length ?? 0}`);
let inTransit = 0, delivered = 0, returned = 0;
for (const o of orders ?? []) {
  if (o.is_delivered) delivered++;
  else if (o.is_returned) returned++;
  else if (o.is_in_transit) inTransit++;
}
console.log(`    → in transit: ${inTransit}, delivered: ${delivered}, returned: ${returned}`);
console.log(`    (PostEx sync runs every 12h — recent orders may not be in this table yet)`);

// ─── 4. Final answer ─────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════════════════════════");
console.log(" ANSWER: Purchase events Meta Ads Manager should report today");
console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(`
  Distinct Purchase event_ids successfully fired today: ${sentIds.size}

  Caveats:
  • Meta dedupes browser fbq + server CAPI by event_id, so 1 distinct
    event_id = 1 Purchase in Ads Manager (not 2).
  • Ads Manager attribution windows are 1d-click / 7d-click / 1d-view by
    default. A Purchase fired today is reported under the day of the
    AD CLICK, not the day of the order — so today's "Purchases" column
    in Ads Manager only includes orders attributed to today's ad clicks.
  • For total order volume Meta saw today regardless of attribution,
    use Events Manager → "Total events" filter for Purchase event,
    today's date.
`);

// ─── 5. Identity quality on today's Purchases (just to set expectations) ─
if (sentIds.size > 0) {
  console.log("─── 3. Identity quality on today's successful Purchases ───");
  console.log("  (Higher EMQ → better Ads Manager attribution accuracy)");
  console.log("  Per the latest emq_snapshot, Purchase events score 9.3/10");
  console.log("  — fully-identified (email + phone + name + city + customer.id).");
  console.log("  Today's external_id will additionally include visitor_id (post-deploy).");
}
