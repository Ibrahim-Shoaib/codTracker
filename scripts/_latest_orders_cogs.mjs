// What COGS-match source are the latest orders using? Critical for knowing
// whether "fresh" orders match accurately or fall back to averages.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
await sb.rpc("set_app_store", { store: SHOP });

console.log("═══ LATEST 30 ORDERS — COGS match source ═══\n");

const { data: latest } = await sb
  .from("orders")
  .select("transaction_date, order_date, order_ref_number, invoice_payment, cogs_total, cogs_match_source, items, is_delivered, is_returned, is_in_transit")
  .eq("store_id", SHOP)
  .order("transaction_date", { ascending: false })
  .limit(30);

console.log("  Order#  │ Order date         │ Status      │ Items │  Revenue   │   COGS     │ COGS%   │ Match source");
console.log("  ────────┼────────────────────┼─────────────┼───────┼────────────┼────────────┼─────────┼──────────────");
for (const o of latest ?? []) {
  const status = o.is_delivered ? "delivered" : o.is_returned ? "returned" : "in_transit";
  const ratio = o.invoice_payment ? ((o.cogs_total / o.invoice_payment) * 100).toFixed(1) + "%" : "—";
  const date = (o.order_date ?? o.transaction_date)?.slice(0, 19) ?? "—";
  console.log(
    `  #${(o.order_ref_number ?? "—").padEnd(6)} │ ${date.padEnd(18)} │ ${status.padEnd(11)} │ ${String(o.items).padStart(5)} │ ${Number(o.invoice_payment).toLocaleString().padStart(10)} │ ${Number(o.cogs_total).toLocaleString().padStart(10)} │ ${ratio.padStart(7)} │ ${o.cogs_match_source}`
  );
}

console.log("\n═══ Match source counts in latest 30 ═══\n");
const counts = {};
for (const o of latest ?? []) {
  counts[o.cogs_match_source] = (counts[o.cogs_match_source] ?? 0) + 1;
}
for (const [src, n] of Object.entries(counts)) {
  console.log(`  ${src.padEnd(15)} ${n}/${latest.length} (${((n / latest.length) * 100).toFixed(0)}%)`);
}

// Time-bucketed view — match quality over time
console.log("\n═══ MATCH-SOURCE TREND BY MONTH (recent 6 months in DB) ═══\n");
const { data: byMonth } = await sb
  .from("orders")
  .select("transaction_date, order_date, cogs_match_source")
  .eq("store_id", SHOP)
  .order("transaction_date", { ascending: false })
  .limit(2000);

const months = new Map();
for (const o of byMonth ?? []) {
  const m = (o.order_date ?? o.transaction_date)?.slice(0, 7);
  if (!m) continue;
  if (!months.has(m)) months.set(m, {});
  const x = months.get(m);
  x[o.cogs_match_source] = (x[o.cogs_match_source] ?? 0) + 1;
}
const sorted = [...months.keys()].sort().reverse().slice(0, 6).reverse();
console.log("  Month     │ variant_id │ exact │ sibling_avg │ fallback_avg │ total │ accurate %");
console.log("  ──────────┼────────────┼───────┼─────────────┼──────────────┼───────┼───────────");
for (const m of sorted) {
  const x = months.get(m);
  const variant = x.variant_id ?? 0;
  const exact = x.exact ?? 0;
  const sibling = x.sibling_avg ?? 0;
  const fallback = x.fallback_avg ?? 0;
  const total = variant + exact + sibling + fallback;
  const accurate = total ? (((variant + exact) / total) * 100).toFixed(0) + "%" : "—";
  console.log(
    `  ${m.padEnd(9)} │ ${String(variant).padStart(10)} │ ${String(exact).padStart(5)} │ ${String(sibling).padStart(11)} │ ${String(fallback).padStart(12)} │ ${String(total).padStart(5)} │ ${accurate.padStart(9)}`
  );
}
