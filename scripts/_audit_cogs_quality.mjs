// Forensic audit on COGS data quality. Are the matches real (sku/exact),
// guesses (fuzzy/sibling_avg/fallback_avg), or are the unit_cost values
// themselves suspect (e.g., zeros, retail prices, missing entries)?
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
await sb.rpc("set_app_store", { store: SHOP });

console.log("═══ COGS MATCH SOURCE DISTRIBUTION (all orders) ═══\n");

// Group orders by match source
const { data: orders } = await sb
  .from("orders")
  .select("transaction_date, invoice_payment, cogs_total, cogs_matched, cogs_match_source, is_delivered, items")
  .eq("store_id", SHOP);

const bySource = new Map();
for (const o of orders) {
  const src = o.cogs_match_source ?? "(null)";
  if (!bySource.has(src)) bySource.set(src, { count: 0, totalRev: 0, totalCogs: 0 });
  const x = bySource.get(src);
  x.count++;
  x.totalRev += Number(o.invoice_payment || 0);
  x.totalCogs += Number(o.cogs_total || 0);
}

console.log("  Source         │ Orders │ % orders │ Σ Revenue (PKR) │ Σ COGS (PKR) │ COGS / Rev");
console.log("  ───────────────┼────────┼──────────┼────────────────┼─────────────┼──────────");
for (const [src, x] of bySource) {
  const ratio = x.totalRev ? ((x.totalCogs / x.totalRev) * 100).toFixed(1) + "%" : "—";
  console.log(`  ${src.padEnd(14)} │ ${String(x.count).padStart(6)} │ ${((x.count / orders.length) * 100).toFixed(1).padStart(7)}% │ ${x.totalRev.toLocaleString().padStart(14)} │ ${x.totalCogs.toLocaleString().padStart(11)} │ ${ratio.padStart(8)}`);
}

console.log("\n  Match-quality interpretation:");
console.log("    sku           = real (SKU match in product_costs)            BEST");
console.log("    exact         = real (variant title + product title exact)   GOOD");
console.log("    fuzzy         = approximate (token overlap)                  OK");
console.log("    sibling_avg   = guess (avg of other variants of the product) GUESS");
console.log("    fallback_avg  = guess (store-wide average)                   WORST");

// ─── PRODUCT COSTS TABLE INSPECTION ──────────────────────────────────────────
console.log("\n═══ PRODUCT COSTS (product_costs table) ═══\n");
const { data: costs } = await sb
  .from("product_costs")
  .select("shopify_product_id, shopify_variant_id, sku, product_title, variant_title, unit_cost")
  .eq("store_id", SHOP);

const total = costs.length;
const withCost = costs.filter((c) => Number(c.unit_cost) > 0);
const zeroCost = costs.filter((c) => Number(c.unit_cost) === 0 || c.unit_cost == null);
const sumCost = withCost.reduce((s, c) => s + Number(c.unit_cost), 0);
const avgCost = withCost.length ? sumCost / withCost.length : 0;
const minCost = withCost.length ? Math.min(...withCost.map((c) => Number(c.unit_cost))) : 0;
const maxCost = withCost.length ? Math.max(...withCost.map((c) => Number(c.unit_cost))) : 0;
const medCost = withCost.length
  ? [...withCost.map((c) => Number(c.unit_cost))].sort((a, b) => a - b)[Math.floor(withCost.length / 2)]
  : 0;

console.log(`  Total variants:          ${total}`);
console.log(`  With unit_cost > 0:      ${withCost.length} (${((withCost.length / total) * 100).toFixed(1)}%)`);
console.log(`  With zero/null cost:     ${zeroCost.length}`);
console.log(`  Cost statistics (PKR):`);
console.log(`    min:                   ${minCost.toLocaleString()}`);
console.log(`    median:                ${medCost.toLocaleString()}`);
console.log(`    avg:                   ${Math.round(avgCost).toLocaleString()}`);
console.log(`    max:                   ${maxCost.toLocaleString()}`);

console.log(`\n  Sample of 10 random variant costs:`);
const sample = costs.sort(() => Math.random() - 0.5).slice(0, 10);
for (const c of sample) {
  const title = `${c.product_title ?? "?"} / ${c.variant_title ?? "?"}`;
  console.log(`    ${title.slice(0, 60).padEnd(62)} cost=${Number(c.unit_cost).toLocaleString().padStart(8)} PKR  sku=${c.sku ?? "(none)"}`);
}

// ─── CROSS-CHECK: do COGS values look proportionate to invoice_payment? ──────
console.log("\n═══ COST/REVENUE SANITY CHECK ═══\n");
console.log("  Sample of 15 delivered orders with cogs_match_source = sku/exact (should be most accurate):\n");
const accurate = orders
  .filter((o) => o.is_delivered && (o.cogs_match_source === "sku" || o.cogs_match_source === "exact"))
  .slice(0, 15);
console.log("  Order date         │ Items │  Revenue   │   COGS     │ COGS%     │ Source");
console.log("  ───────────────────┼───────┼────────────┼────────────┼───────────┼────────");
for (const o of accurate) {
  const ratio = o.invoice_payment ? ((o.cogs_total / o.invoice_payment) * 100).toFixed(1) + "%" : "—";
  console.log(
    `  ${o.transaction_date?.slice(0, 19).padEnd(18) ?? "—".padEnd(18)} │ ${String(o.items).padStart(5)} │ ${Number(o.invoice_payment).toLocaleString().padStart(10)} │ ${Number(o.cogs_total).toLocaleString().padStart(10)} │ ${ratio.padStart(8)} │ ${o.cogs_match_source}`
  );
}

console.log("\n  Aggregate by match source for DELIVERED orders only:\n");
const deliveredBySource = new Map();
for (const o of orders.filter((o) => o.is_delivered)) {
  const src = o.cogs_match_source ?? "(null)";
  if (!deliveredBySource.has(src)) deliveredBySource.set(src, { count: 0, rev: 0, cogs: 0 });
  const x = deliveredBySource.get(src);
  x.count++;
  x.rev += Number(o.invoice_payment || 0);
  x.cogs += Number(o.cogs_total || 0);
}
console.log("  Source         │ Orders │ Avg COGS%");
console.log("  ───────────────┼────────┼──────────");
for (const [src, x] of deliveredBySource) {
  const ratio = x.rev ? ((x.cogs / x.rev) * 100).toFixed(1) + "%" : "—";
  console.log(`  ${src.padEnd(14)} │ ${String(x.count).padStart(6)} │ ${ratio.padStart(8)}`);
}

// ─── HOW MANY MAY ORDERS WILL ACTUALLY HAVE GOOD COGS WHEN THEY LAND? ────────
console.log("\n═══ FORWARD VIEW: what will May orders' COGS look like? ═══\n");
console.log("  When May orders are picked up by PostEx, our cogs.server.js will try to");
console.log("  match each line item against product_costs in priority: sku → exact →");
console.log("  fuzzy → sibling_avg → fallback_avg. The key question is whether the");
console.log("  product_costs table covers the SKUs being sold today.\n");

// Pull current Shopify products and compare against product_costs
const { data: sessions } = await sb.from("shopify_sessions").select("accessToken").eq("shop", SHOP).eq("isOnline", false);
const accessToken = sessions[0].accessToken;

// Pull active products with variants
const productsUrl = `https://${SHOP}/admin/api/2025-01/products.json?limit=250&status=active&fields=id,title,variants`;
const r = await fetch(productsUrl, { headers: { "X-Shopify-Access-Token": accessToken } });
const { products } = await r.json();
let totalLiveVariants = 0;
let coveredVariants = 0;
const costMap = new Map(costs.map((c) => [String(c.shopify_variant_id), Number(c.unit_cost)]));
for (const p of products ?? []) {
  for (const v of p.variants ?? []) {
    totalLiveVariants++;
    const cost = costMap.get(String(v.id));
    if (cost && cost > 0) coveredVariants++;
  }
}
console.log(`  Active products in Shopify (page 1, ≤250):  ${products?.length ?? 0}`);
console.log(`  Active variants checked:                    ${totalLiveVariants}`);
console.log(`  Variants with cost in product_costs > 0:    ${coveredVariants} (${totalLiveVariants ? ((coveredVariants / totalLiveVariants) * 100).toFixed(1) : 0}%)`);
console.log(`  ${coveredVariants === totalLiveVariants ? "→ Full coverage. New orders should match via SKU/exact." : "→ Coverage gap! Some new orders will fall back to averages."}`);
