// Comprehensive financial analysis for the trendy homes partnership decision.
// Pulls raw data from the orders table to avoid the lag inherent in the
// dashboard RPCs (Shopify orders only enter the dashboard once PostEx
// accepts them — could be days behind).
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

await sb.rpc("set_app_store", { store: SHOP });

function fmt(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function pct(n, total) {
  if (!total) return "—";
  return ((n / total) * 100).toFixed(1) + "%";
}

console.log("═══════════════════════════════════════════════════════════════════════════");
console.log("  TRENDY HOMES — PARTNERSHIP ANALYSIS");
console.log("  the-trendy-homes-pk · Currency: PKR · Today: " + new Date().toISOString().slice(0,10));
console.log("═══════════════════════════════════════════════════════════════════════════\n");

// ─── 1. ALL-TIME DELIVERY PERFORMANCE ────────────────────────────────────────
const { data: orders } = await sb
  .from("orders")
  .select("transaction_date, order_date, invoice_payment, cogs_total, transaction_fee, transaction_tax, reversal_fee, reversal_tax, is_delivered, is_returned, is_in_transit")
  .eq("store_id", SHOP)
  .order("transaction_date", { ascending: true });

console.log("─── ALL-TIME OPERATING HISTORY (PostEx-tracked orders) ───\n");
const total = orders.length;
const delivered = orders.filter(o => o.is_delivered).length;
const returned = orders.filter(o => o.is_returned).length;
const inTransit = orders.filter(o => o.is_in_transit).length;
const totalRevDelivered = orders.filter(o => o.is_delivered).reduce((s, o) => s + Number(o.invoice_payment || 0), 0);
const totalCOGSDelivered = orders.filter(o => o.is_delivered).reduce((s, o) => s + Number(o.cogs_total || 0), 0);
const totalDeliveryCostAll = orders.filter(o => o.is_delivered || o.is_returned).reduce((s, o) => s + Number(o.transaction_fee || 0) + Number(o.transaction_tax || 0) + Number(o.reversal_fee || 0) + Number(o.reversal_tax || 0), 0);
const inTransitValue = orders.filter(o => o.is_in_transit).reduce((s, o) => s + Number(o.invoice_payment || 0), 0);
const firstDate = orders[0]?.transaction_date?.slice(0,10);
const lastDate = orders[orders.length - 1]?.transaction_date?.slice(0,10);

console.log(`  Period covered:           ${firstDate} → ${lastDate}`);
console.log(`  Total orders ever:        ${fmt(total)}`);
console.log(`    Delivered:              ${fmt(delivered)}  (${pct(delivered, total)})`);
console.log(`    Returned:               ${fmt(returned)}  (${pct(returned, total)})`);
console.log(`    Still in transit:       ${fmt(inTransit)}  (${pct(inTransit, total)})`);
console.log(`  All-time delivered sales: ${fmt(totalRevDelivered)} PKR`);
console.log(`  All-time delivered COGS:  ${fmt(totalCOGSDelivered)} PKR  (${pct(totalCOGSDelivered, totalRevDelivered)} of sales)`);
console.log(`  All-time delivery costs:  ${fmt(totalDeliveryCostAll)} PKR  (${pct(totalDeliveryCostAll, totalRevDelivered)} of sales)`);
console.log(`  Currently in pipeline:    ${fmt(inTransitValue)} PKR  (will resolve in next 7 days)`);

// ─── 2. MONTHLY TREND (last 12 months by order_date) ─────────────────────────
console.log("\n─── MONTHLY TREND (by order_date — when customer placed order) ───\n");
console.log("  Month        │ Orders │ Delivered │ Return % │ Sales (PKR) │   COGS    │ Delivery cost");
console.log("  ─────────────┼────────┼───────────┼──────────┼─────────────┼───────────┼──────────────");

const byMonth = new Map();
for (const o of orders) {
  const date = (o.order_date ?? o.transaction_date)?.slice(0, 7);
  if (!date) continue;
  if (!byMonth.has(date)) byMonth.set(date, { total: 0, delivered: 0, returned: 0, sales: 0, cogs: 0, dCost: 0 });
  const m = byMonth.get(date);
  m.total++;
  if (o.is_delivered) {
    m.delivered++;
    m.sales += Number(o.invoice_payment || 0);
    m.cogs += Number(o.cogs_total || 0);
    m.dCost += Number(o.transaction_fee || 0) + Number(o.transaction_tax || 0);
  } else if (o.is_returned) {
    m.returned++;
    m.dCost += Number(o.transaction_fee || 0) + Number(o.transaction_tax || 0) + Number(o.reversal_fee || 0) + Number(o.reversal_tax || 0);
  }
}
const monthsSorted = [...byMonth.keys()].sort();
const recent = monthsSorted.slice(-13);
for (const month of recent) {
  const m = byMonth.get(month);
  const settled = m.delivered + m.returned;
  const returnPct = settled ? (m.returned / settled * 100).toFixed(1) + "%" : "—";
  const dRate = m.total ? (m.delivered / m.total * 100).toFixed(0) + "%" : "—";
  console.log(`  ${month.padEnd(13)} │ ${String(m.total).padStart(6)} │  ${dRate.padStart(4)} ${String(m.delivered).padStart(4)} │  ${returnPct.padStart(6)} │ ${fmt(m.sales).padStart(11)} │ ${fmt(m.cogs).padStart(9)} │ ${fmt(m.dCost).padStart(12)}`);
}

// ─── 3. AD SPEND (all-time) ──────────────────────────────────────────────────
console.log("\n─── AD SPEND HISTORY (last 12 months) ───\n");
const { data: adSpend } = await sb
  .from("ad_spend")
  .select("spend_date, amount")
  .eq("store_id", SHOP)
  .order("spend_date", { ascending: false });

const adByMonth = new Map();
for (const a of adSpend ?? []) {
  const month = a.spend_date?.slice(0, 7);
  if (!month) continue;
  adByMonth.set(month, (adByMonth.get(month) ?? 0) + Number(a.amount || 0));
}
console.log("  Month        │ Ad Spend (PKR) │ Sales (delivered, PKR) │ Implied ROAS");
console.log("  ─────────────┼────────────────┼───────────────────────┼─────────────");
for (const month of recent) {
  const ad = adByMonth.get(month) ?? 0;
  const sales = byMonth.get(month)?.sales ?? 0;
  const roas = ad > 0 ? (sales / ad).toFixed(2) : "—";
  console.log(`  ${month.padEnd(13)} │ ${fmt(ad).padStart(14)} │ ${fmt(sales).padStart(21)} │ ${roas.padStart(11)}`);
}

// ─── 4. REAL MARGIN from delivered orders (last 90 days, settled) ────────────
console.log("\n─── REAL UNIT ECONOMICS (last 90 days, delivered orders only) ───\n");
const since90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0,10);
const recent90 = orders.filter(o => (o.order_date ?? o.transaction_date)?.slice(0,10) >= since90);
const r90Delivered = recent90.filter(o => o.is_delivered);
const r90Returned = recent90.filter(o => o.is_returned);
const r90Sales = r90Delivered.reduce((s, o) => s + Number(o.invoice_payment || 0), 0);
const r90COGS = r90Delivered.reduce((s, o) => s + Number(o.cogs_total || 0), 0);
const r90DeliveryCost = [...r90Delivered, ...r90Returned].reduce((s, o) => s + Number(o.transaction_fee || 0) + Number(o.transaction_tax || 0) + Number(o.reversal_fee || 0) + Number(o.reversal_tax || 0), 0);
const r90AdSpend = (adSpend ?? []).filter(a => a.spend_date >= since90).reduce((s, a) => s + Number(a.amount || 0), 0);
const r90InTransit = recent90.filter(o => o.is_in_transit);
const r90PipelineValue = r90InTransit.reduce((s, o) => s + Number(o.invoice_payment || 0), 0);

const grossMargin = r90Sales - r90COGS - r90DeliveryCost;
const netBeforeOpex = grossMargin - r90AdSpend;

console.log(`  Window:                     last 90 days`);
console.log(`  Orders placed:              ${recent90.length}`);
console.log(`    Delivered:                ${r90Delivered.length} (${pct(r90Delivered.length, recent90.length)})`);
console.log(`    Returned:                 ${r90Returned.length} (${pct(r90Returned.length, recent90.length)})`);
console.log(`    Still in transit:         ${r90InTransit.length}  (worth ${fmt(r90PipelineValue)} PKR if delivered)`);
console.log(``);
console.log(`  Delivered sales:            ${fmt(r90Sales).padStart(12)} PKR`);
console.log(`  COGS:                       ${fmt(r90COGS).padStart(12)} PKR  (${pct(r90COGS, r90Sales)})`);
console.log(`  Delivery + reversal costs:  ${fmt(r90DeliveryCost).padStart(12)} PKR  (${pct(r90DeliveryCost, r90Sales)})`);
console.log(`  Ad spend:                   ${fmt(r90AdSpend).padStart(12)} PKR  (${pct(r90AdSpend, r90Sales)})`);
console.log(`  ─────────────────────────────────────────────`);
console.log(`  Gross margin (pre-ads):     ${fmt(grossMargin).padStart(12)} PKR  (${pct(grossMargin, r90Sales)})`);
console.log(`  Margin after ad spend:      ${fmt(netBeforeOpex).padStart(12)} PKR  (${pct(netBeforeOpex, r90Sales)})`);
const r90ROAS = r90AdSpend > 0 ? (r90Sales / r90AdSpend).toFixed(2) : "N/A";
console.log(`  ROAS:                       ${r90ROAS.padStart(12)}`);
console.log(`  AOV (delivered):            ${fmt(r90Delivered.length ? r90Sales / r90Delivered.length : 0).padStart(12)} PKR`);
const r90DRate = recent90.length ? (r90Delivered.length / (r90Delivered.length + r90Returned.length) * 100) : 0;
console.log(`  Delivery rate (settled):    ${r90DRate.toFixed(1).padStart(11)}%`);

// ─── 5. STORE-WIDE EXPENSES ──────────────────────────────────────────────────
console.log("\n─── OVERHEAD (store_expenses table) ───\n");
const { data: expenses } = await sb
  .from("store_expenses")
  .select("name, amount, type")
  .eq("store_id", SHOP);
let monthlyTotal = 0;
for (const e of expenses ?? []) {
  const a = Number(e.amount);
  if (e.type === "monthly") monthlyTotal += a;
  console.log(`  ${(e.name || "(unnamed)").padEnd(30)} ${fmt(e.amount).padStart(10)} PKR/${e.type === "monthly" ? "month" : "order"}`);
}
console.log(`  ─────────────────────────────────────────────`);
console.log(`  Monthly fixed overhead:     ${fmt(monthlyTotal)} PKR/month`);

// ─── 6. PARTNERSHIP DECISION FRAME ───────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════════════════════════════");
console.log("  PARTNERSHIP ECONOMICS");
console.log("═══════════════════════════════════════════════════════════════════════════\n");

console.log(`  Buy-in:                     300,000 PKR for 50%`);
console.log(`  Implied store valuation:    600,000 PKR\n`);

// Project annualized profit using last 90 days
const r90Days = 90;
const dailyGross = grossMargin / r90Days;
const dailyAdSpend = r90AdSpend / r90Days;
const dailyContrib = (grossMargin - r90AdSpend) / r90Days;  // before fixed overhead
const monthlyContrib = dailyContrib * 30;
const monthlyNet = monthlyContrib - monthlyTotal;

console.log(`  PROJECTED MONTHLY P&L (using last 90d daily averages):`);
console.log(`    Gross margin:             ${fmt(dailyGross * 30).padStart(12)} PKR/month`);
console.log(`    less ad spend:            ${fmt(dailyAdSpend * 30).padStart(12)} PKR/month`);
console.log(`    Contribution margin:      ${fmt(monthlyContrib).padStart(12)} PKR/month`);
console.log(`    less fixed overhead:      ${fmt(monthlyTotal).padStart(12)} PKR/month`);
console.log(`    ─────────────────────────────────`);
console.log(`    Net monthly profit:       ${fmt(monthlyNet).padStart(12)} PKR/month`);

console.log(``);
const annualNet = monthlyNet * 12;
const yourMonthlyShare = monthlyNet * 0.5;
const yourAnnualShare = annualNet * 0.5;
console.log(`  Your 50% share:`);
console.log(`    Monthly:                  ${fmt(yourMonthlyShare).padStart(12)} PKR`);
console.log(`    Annual:                   ${fmt(yourAnnualShare).padStart(12)} PKR`);

console.log(``);
if (yourMonthlyShare > 0) {
  const paybackMonths = 300000 / yourMonthlyShare;
  console.log(`  Payback on 300k:            ${paybackMonths.toFixed(1)} months`);
  const valuationMultiple = 600000 / annualNet;
  console.log(`  Valuation multiple (P/E):   ${valuationMultiple.toFixed(2)}x annual profit  (typical SMB: 1.5–4x)`);
} else {
  console.log(`  Payback on 300k:            INFINITE — store is unprofitable at current run-rate`);
  console.log(`  You'd be paying for 50% of losses.`);
}
