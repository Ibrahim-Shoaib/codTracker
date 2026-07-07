// May 2026 partnership analysis. Pulls EVERY Shopify order since May 1
// (including unfulfilled ones — those count as in-pipeline). Applies the
// historical 3-month delivery/return rates and unit economics from Dec
// 2024–Feb 2025 to project realistic monthly P&L.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const { data: sessions } = await sb.from("shopify_sessions").select("accessToken").eq("shop", SHOP).eq("isOnline", false);
const accessToken = sessions[0].accessToken;

// ─── 1. Pull EVERY Shopify order since May 1 ────────────────────────────────
async function fetchAllOrders(sinceIso) {
  const orders = [];
  let url = `https://${SHOP}/admin/api/2025-01/orders.json?` +
    new URLSearchParams({ created_at_min: sinceIso, status: "any", limit: "250" });
  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
    const body = await res.json();
    orders.push(...(body.orders ?? []));
    // Pagination via Link header
    const link = res.headers.get("link") ?? "";
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return orders;
}

const mayStart = "2026-05-01T00:00:00+05:00";
const orders = await fetchAllOrders(mayStart);

// Filter out cancelled and draft orders for the in-pipeline calc.
const validOrders = orders.filter((o) => o.financial_status !== "voided" && o.cancelled_at == null && o.source_name !== "shopify_draft_order");

// ─── 2. Calculate Shopify-side revenue pipeline ─────────────────────────────
const totalOrderValue = validOrders.reduce((s, o) => s + Number(o.total_price ?? 0), 0);
const ordersByDay = new Map();
for (const o of validOrders) {
  const day = (o.processed_at ?? o.created_at).slice(0, 10);
  if (!ordersByDay.has(day)) ordersByDay.set(day, { count: 0, value: 0 });
  const d = ordersByDay.get(day);
  d.count++;
  d.value += Number(o.total_price ?? 0);
}

console.log("═══════════════════════════════════════════════════════════════════════════");
console.log("  TRENDY HOMES — MAY 2026 PARTNERSHIP ANALYSIS");
console.log("  the-trendy-homes-pk · PKR · Today: " + new Date().toISOString().slice(0,10));
console.log("═══════════════════════════════════════════════════════════════════════════\n");

console.log(`─── MAY ORDER PIPELINE (ALL Shopify orders since May 1) ───\n`);
console.log(`  Total orders placed:        ${validOrders.length}`);
console.log(`  Total order value:          ${totalOrderValue.toLocaleString()} PKR (in-pipeline)`);
console.log(`  Days elapsed:               9 (May 1 → May 9)`);
console.log(`  Pace:                       ${(validOrders.length / 9).toFixed(1)} orders/day, ${Math.round(totalOrderValue / 9).toLocaleString()} PKR/day\n`);

console.log(`  Daily breakdown:`);
const sortedDays = [...ordersByDay.keys()].sort();
for (const d of sortedDays) {
  const x = ordersByDay.get(d);
  console.log(`    ${d}  ${String(x.count).padStart(3)} orders  ${x.value.toLocaleString().padStart(10)} PKR`);
}

// ─── 3. May ad spend ────────────────────────────────────────────────────────
const { data: adRows } = await sb
  .from("ad_spend")
  .select("spend_date, amount")
  .eq("store_id", SHOP)
  .gte("spend_date", "2026-05-01")
  .order("spend_date", { ascending: true });

const adTotal = (adRows ?? []).reduce((s, a) => s + Number(a.amount), 0);
console.log(`\n─── MAY AD SPEND ───\n`);
console.log(`  Days reported:              ${adRows?.length ?? 0}`);
console.log(`  Total ad spend May:         ${adTotal.toLocaleString()} PKR`);
console.log(`  Avg daily ad spend:         ${Math.round(adTotal / 9).toLocaleString()} PKR/day`);

console.log(`\n  Daily ad spend:`);
for (const a of adRows ?? []) {
  console.log(`    ${a.spend_date}  ${Number(a.amount).toLocaleString().padStart(10)} PKR`);
}

// ─── 4. Apply 3-month historical rates (Dec 2024, Jan 2025, Feb 2025) ──────
// Computed earlier:
//   Dec: 210/(210+62)=77.2% delivery, 22.8% return
//   Jan: 186/(186+56)=76.9% delivery, 23.1% return
//   Feb: 163/(163+70)=69.9% delivery, 30.1% return
//   Average: ~74.7% delivery, ~25.3% return (using settled orders only)
const HIST_DELIVERY_RATE = 0.747;
const HIST_RETURN_RATE = 0.253;

// Unit-economics ratios from Feb 2025 (most recent month):
//   COGS / sales           = 637/879 = 72.5%
//   Delivery cost / sales  =  80/879 =  9.1%  (delivered + returned, both legs)
//   Return loss is captured separately — for delivered orders we don't lose
//   on returns; for returned orders we lose delivery+reversal+15% of COGS
//   (sellable_returns_pct=85 by default).
const COGS_RATIO = 0.725;
const DELIVERY_COST_RATIO = 0.091;
const SELLABLE_RETURNS_PCT = 0.85;

console.log(`\n─── PROJECTION USING HISTORICAL RATES (Dec 24 – Feb 25 average) ───\n`);
console.log(`  Delivery rate:              ${(HIST_DELIVERY_RATE * 100).toFixed(1)}%`);
console.log(`  Return rate:                ${(HIST_RETURN_RATE * 100).toFixed(1)}%`);
console.log(`  COGS / sales:               ${(COGS_RATIO * 100).toFixed(1)}%`);
console.log(`  Delivery cost / sales:      ${(DELIVERY_COST_RATIO * 100).toFixed(1)}%`);
console.log(`  Sellable return %:          ${(SELLABLE_RETURNS_PCT * 100).toFixed(0)}%`);

// Project: of the in-pipeline value, how much will deliver vs return?
const expectedDeliveredSales = totalOrderValue * HIST_DELIVERY_RATE;
const expectedReturnedValue = totalOrderValue * HIST_RETURN_RATE;
const expectedCOGSDelivered = expectedDeliveredSales * COGS_RATIO;
const expectedCOGSReturned = expectedReturnedValue * COGS_RATIO;
// Delivery cost: paid for delivered + returned (both legs included in 9.1%)
const expectedDeliveryCost = (expectedDeliveredSales + expectedReturnedValue) * DELIVERY_COST_RATIO;
// Return loss: 15% of COGS on returned orders (unsellable portion) + delivery cost on returned
const returnUnsellableCOGSLoss = expectedCOGSReturned * (1 - SELLABLE_RETURNS_PCT);
const grossMargin = expectedDeliveredSales - expectedCOGSDelivered - expectedDeliveryCost - returnUnsellableCOGSLoss;

console.log(`\n  PROJECTED OUTCOMES from in-pipeline ${totalOrderValue.toLocaleString()} PKR:\n`);
console.log(`    Expected delivered sales:    ${Math.round(expectedDeliveredSales).toLocaleString().padStart(12)} PKR (${(HIST_DELIVERY_RATE * 100).toFixed(0)}%)`);
console.log(`    Expected returned value:     ${Math.round(expectedReturnedValue).toLocaleString().padStart(12)} PKR (${(HIST_RETURN_RATE * 100).toFixed(0)}%, no revenue)`);
console.log(`    less COGS (delivered):       ${Math.round(expectedCOGSDelivered).toLocaleString().padStart(12)} PKR`);
console.log(`    less delivery cost (both):   ${Math.round(expectedDeliveryCost).toLocaleString().padStart(12)} PKR`);
console.log(`    less unsellable COGS (15%):  ${Math.round(returnUnsellableCOGSLoss).toLocaleString().padStart(12)} PKR`);
console.log(`    ─────────────────────────────────────────────`);
console.log(`    Gross margin:                ${Math.round(grossMargin).toLocaleString().padStart(12)} PKR  (${((grossMargin / expectedDeliveredSales) * 100).toFixed(1)}% of delivered sales)`);
console.log(`    less ad spend (May to date): ${adTotal.toLocaleString().padStart(12)} PKR`);
console.log(`    Contribution margin:         ${Math.round(grossMargin - adTotal).toLocaleString().padStart(12)} PKR`);

// Pro-rate overhead (9 days of 120k/month)
const PRORATED_OVERHEAD = 120000 * (9 / 30);
console.log(`    less prorated overhead:      ${Math.round(PRORATED_OVERHEAD).toLocaleString().padStart(12)} PKR (9/30 of 120k/mo)`);
console.log(`    ─────────────────────────────────────────────`);
const may9DayProfit = grossMargin - adTotal - PRORATED_OVERHEAD;
console.log(`    Net 9-day P&L:               ${Math.round(may9DayProfit).toLocaleString().padStart(12)} PKR`);

// ─── 5. ANNUALIZED PROJECTION ────────────────────────────────────────────────
console.log(`\n─── ANNUALIZED PROJECTION (May daily run-rate × 365) ───\n`);
const annualScale = 365 / 9;
const annualSales = expectedDeliveredSales * annualScale;
const annualGrossMargin = grossMargin * annualScale;
const annualAdSpend = adTotal * annualScale;
const annualOverhead = 120000 * 12;
const annualNet = annualGrossMargin - annualAdSpend - annualOverhead;

console.log(`  Projected annual delivered sales:  ${Math.round(annualSales).toLocaleString().padStart(15)} PKR`);
console.log(`  Projected annual gross margin:     ${Math.round(annualGrossMargin).toLocaleString().padStart(15)} PKR`);
console.log(`  Projected annual ad spend:         ${Math.round(annualAdSpend).toLocaleString().padStart(15)} PKR`);
console.log(`  Annual fixed overhead:             ${annualOverhead.toLocaleString().padStart(15)} PKR (120k × 12)`);
console.log(`  ─────────────────────────────────────────────────────`);
console.log(`  Projected annual net profit:       ${Math.round(annualNet).toLocaleString().padStart(15)} PKR`);
console.log(`  Projected monthly net profit:      ${Math.round(annualNet / 12).toLocaleString().padStart(15)} PKR`);

// ─── 6. PARTNERSHIP DECISION FRAME ──────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════════════════════════════════════`);
console.log(`  PARTNERSHIP ECONOMICS (using May 2026 actual run-rate)`);
console.log(`═══════════════════════════════════════════════════════════════════════════\n`);
console.log(`  Buy-in:                             300,000 PKR for 50%`);
console.log(`  Implied store valuation:            600,000 PKR\n`);

const yourMonthlyShare = (annualNet / 12) * 0.5;
const yourAnnualShare = annualNet * 0.5;
console.log(`  Your projected 50% share:`);
console.log(`    Monthly:                          ${Math.round(yourMonthlyShare).toLocaleString().padStart(12)} PKR`);
console.log(`    Annual:                           ${Math.round(yourAnnualShare).toLocaleString().padStart(12)} PKR`);

console.log(``);
if (yourMonthlyShare > 0) {
  const paybackMonths = 300000 / yourMonthlyShare;
  console.log(`  Payback on 300k:                    ${paybackMonths.toFixed(1)} months`);
  const peMultiple = 600000 / annualNet;
  console.log(`  Implied P/E multiple:               ${peMultiple.toFixed(2)}x annual profit`);
  console.log(`    Reference: Pakistani SMB ecom typically trades 1.5–3x earnings`);
  console.log(`    < 1.5x = cheap   ·  1.5–3x = fair   ·  > 4x = expensive`);
} else {
  console.log(`  Payback period:                     ∞  — annualized P&L is negative at this run-rate`);
}

// ─── 7. SENSITIVITY: what if delivery rate slips ─────────────────────────────
console.log(`\n─── SENSITIVITY: How does net change with delivery rate? ───\n`);
console.log(`  Delivery │ Annual Net Profit │ Your 50% Annual │ 300k Payback`);
console.log(`  ─────────┼──────────────────┼────────────────┼──────────────`);
for (const rate of [0.65, 0.70, 0.747, 0.80, 0.85]) {
  const eds = totalOrderValue * rate;
  const erv = totalOrderValue * (1 - rate);
  const cgsD = eds * COGS_RATIO;
  const cgsR = erv * COGS_RATIO;
  const dCost = (eds + erv) * DELIVERY_COST_RATIO;
  const rLoss = cgsR * (1 - SELLABLE_RETURNS_PCT);
  const gm = eds - cgsD - dCost - rLoss;
  const annNet = (gm - adTotal) * annualScale - 120000 * 12;
  const yourShare = annNet * 0.5 / 12;
  const payback = yourShare > 0 ? (300000 / yourShare).toFixed(1) + " mo" : "∞";
  console.log(`   ${(rate * 100).toFixed(1).padStart(5)}%   │ ${Math.round(annNet).toLocaleString().padStart(15)}  │ ${Math.round(annNet * 0.5).toLocaleString().padStart(13)}  │  ${payback.padStart(10)}`);
}
