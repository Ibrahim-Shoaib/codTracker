// Final partnership analysis with corrected data — paginated through ALL
// orders, ignored fallback_avg COGS contamination, and used real per-variant
// matches as the source of truth. Also looks for seasonality.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
await sb.rpc("set_app_store", { store: SHOP });

// Paginate through ALL orders (Supabase default limit is 1000)
async function fetchAllOrders() {
  const all = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await sb
      .from("orders")
      .select("transaction_date, order_date, invoice_payment, cogs_total, transaction_fee, transaction_tax, reversal_fee, reversal_tax, is_delivered, is_returned, is_in_transit, cogs_match_source")
      .eq("store_id", SHOP)
      .order("transaction_date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

const orders = await fetchAllOrders();
console.log(`Loaded ${orders.length} orders total\n`);

// Group by month using order_date (customer-side date)
const byMonth = new Map();
for (const o of orders) {
  const month = (o.order_date ?? o.transaction_date)?.slice(0, 7);
  if (!month) continue;
  if (!byMonth.has(month)) byMonth.set(month, {
    total: 0, delivered: 0, returned: 0, inTransit: 0,
    deliveredSales: 0, deliveredCOGS: 0, deliveredCOGSAccurate: 0, deliveredOrdersAccurate: 0,
    deliveryCost: 0, returnLoss: 0,
  });
  const m = byMonth.get(month);
  m.total++;
  if (o.is_delivered) {
    m.delivered++;
    m.deliveredSales += Number(o.invoice_payment || 0);
    m.deliveredCOGS += Number(o.cogs_total || 0);
    if (o.cogs_match_source === "variant_id" || o.cogs_match_source === "exact" || o.cogs_match_source === "sku") {
      m.deliveredCOGSAccurate += Number(o.cogs_total || 0);
      m.deliveredOrdersAccurate++;
    }
    m.deliveryCost += Number(o.transaction_fee || 0) + Number(o.transaction_tax || 0);
  } else if (o.is_returned) {
    m.returned++;
    m.deliveryCost += Number(o.transaction_fee || 0) + Number(o.transaction_tax || 0) + Number(o.reversal_fee || 0) + Number(o.reversal_tax || 0);
  } else if (o.is_in_transit) {
    m.inTransit++;
  }
}

// Pull ad spend by month
const { data: adSpend } = await sb.from("ad_spend").select("spend_date, amount").eq("store_id", SHOP);
const adByMonth = new Map();
for (const a of adSpend ?? []) {
  const m = a.spend_date?.slice(0, 7);
  if (!m) continue;
  adByMonth.set(m, (adByMonth.get(m) ?? 0) + Number(a.amount));
}

console.log("─── MONTHLY OPERATING HISTORY (with CORRECTED COGS) ───\n");
console.log("  Month     │ Orders │ Delivered │ Returned │ In-transit │ Sales (PKR) │ True COGS%* │ Ad Spend  │ ROAS");
console.log("  ──────────┼────────┼───────────┼──────────┼────────────┼─────────────┼─────────────┼───────────┼─────");
const monthList = [...byMonth.keys()].sort().slice(-18);
for (const m of monthList) {
  const x = byMonth.get(m);
  const accurateRev = x.deliveredOrdersAccurate ? x.deliveredCOGSAccurate / (x.deliveredCOGSAccurate / 0.5) * x.deliveredSales : 0;
  // Better: compute true COGS% only from accurate-match orders' aggregate
  // We don't have per-order rev for accurate subset stored, so approximate:
  // accurateCOGS / (accurateCOGS / accurateRevenueOfAccurateOrders) — too noisy
  // Instead: pull from raw orders directly
  // Skip computing here; report aggregates separately below.
  const ad = adByMonth.get(m) ?? 0;
  const roas = ad > 0 ? (x.deliveredSales / ad).toFixed(2) : "—";
  console.log(
    `  ${m.padEnd(9)} │ ${String(x.total).padStart(6)} │ ${String(x.delivered).padStart(9)} │ ${String(x.returned).padStart(8)} │ ${String(x.inTransit).padStart(10)} │ ${x.deliveredSales.toLocaleString().padStart(11)} │ ${(x.deliveredOrdersAccurate ? "see below" : "(no accurate data)").padStart(11)} │ ${ad.toLocaleString().padStart(9)} │ ${roas.padStart(4)}`
  );
}

// Real COGS ratio from accurate-match orders only, per month
console.log("\n─── TRUE COGS% from accurate matches only (variant_id + exact + sku) ───\n");
console.log("  Month     │ Accurate orders │ Σ Revenue (PKR) │ Σ COGS (PKR) │ True COGS%");
console.log("  ──────────┼─────────────────┼────────────────┼─────────────┼──────────");
for (const m of monthList) {
  const accOrders = orders.filter((o) => {
    const mm = (o.order_date ?? o.transaction_date)?.slice(0, 7);
    return mm === m && o.is_delivered && (o.cogs_match_source === "variant_id" || o.cogs_match_source === "exact" || o.cogs_match_source === "sku");
  });
  if (accOrders.length === 0) {
    console.log(`  ${m.padEnd(9)} │ ${"0".padStart(15)} │ ${"—".padStart(14)} │ ${"—".padStart(11)} │ ${"—".padStart(8)}`);
    continue;
  }
  const rev = accOrders.reduce((s, o) => s + Number(o.invoice_payment || 0), 0);
  const cogs = accOrders.reduce((s, o) => s + Number(o.cogs_total || 0), 0);
  const ratio = ((cogs / rev) * 100).toFixed(1) + "%";
  console.log(`  ${m.padEnd(9)} │ ${String(accOrders.length).padStart(15)} │ ${rev.toLocaleString().padStart(14)} │ ${cogs.toLocaleString().padStart(11)} │ ${ratio.padStart(8)}`);
}

// Headline number: weighted true COGS for last 6 months
const last6 = monthList.slice(-6);
const last6Accurate = orders.filter((o) => {
  const m = (o.order_date ?? o.transaction_date)?.slice(0, 7);
  return last6.includes(m) && o.is_delivered && (o.cogs_match_source === "variant_id" || o.cogs_match_source === "exact" || o.cogs_match_source === "sku");
});
const last6Rev = last6Accurate.reduce((s, o) => s + Number(o.invoice_payment || 0), 0);
const last6COGS = last6Accurate.reduce((s, o) => s + Number(o.cogs_total || 0), 0);
const trueCOGSPct = last6Rev ? (last6COGS / last6Rev) * 100 : 0;
console.log(`\n  Last 6 months weighted true COGS%: ${trueCOGSPct.toFixed(1)}%  (across ${last6Accurate.length} accurately-matched delivered orders)`);

// SEASONALITY CHECK — is May really the slow season?
console.log("\n─── SEASONALITY ANALYSIS (orders by calendar month) ───\n");
const byCalMonth = new Map();
for (const o of orders) {
  const month = (o.order_date ?? o.transaction_date)?.slice(5, 7);
  if (!month) continue;
  byCalMonth.set(month, (byCalMonth.get(month) ?? 0) + 1);
}
console.log("  Cal-month │ Total orders (all years)");
console.log("  ──────────┼───────────────────────");
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
for (let i = 1; i <= 12; i++) {
  const mm = String(i).padStart(2, "0");
  const cnt = byCalMonth.get(mm) ?? 0;
  console.log(`  ${monthNames[i - 1]} (${mm})  │ ${String(cnt).padStart(6)}`);
}

// FINAL PARTNERSHIP MATH using last-6-months true COGS
console.log("\n═══ PARTNERSHIP MATH (corrected) ═══\n");

// Pull May 2026 actual Shopify pipeline (already computed elsewhere)
const { data: sessions } = await sb.from("shopify_sessions").select("accessToken").eq("shop", SHOP).eq("isOnline", false);
const accessToken = sessions[0].accessToken;
async function fetchAllShopifyOrders(sinceIso) {
  const all = [];
  let url = `https://${SHOP}/admin/api/2025-01/orders.json?` + new URLSearchParams({ created_at_min: sinceIso, status: "any", limit: "250" });
  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
    const body = await res.json();
    all.push(...(body.orders ?? []));
    const link = res.headers.get("link") ?? "";
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return all;
}
const mayOrders = (await fetchAllShopifyOrders("2026-05-01T00:00:00+05:00")).filter(
  (o) => o.financial_status !== "voided" && !o.cancelled_at && o.source_name !== "shopify_draft_order"
);
const mayPipeline = mayOrders.reduce((s, o) => s + Number(o.total_price ?? 0), 0);

const { data: mayAd } = await sb.from("ad_spend").select("amount").eq("store_id", SHOP).gte("spend_date", "2026-05-01");
const mayAdTotal = (mayAd ?? []).reduce((s, a) => s + Number(a.amount), 0);

// Compute historical delivery rate from settled orders in last 6 months
let settled = 0, deliveredSettled = 0;
for (const m of last6) {
  const x = byMonth.get(m);
  if (!x) continue;
  settled += x.delivered + x.returned;
  deliveredSettled += x.delivered;
}
const deliveryRate = settled ? deliveredSettled / settled : 0.75;

console.log(`  Inputs:`);
console.log(`    May 2026 Shopify pipeline:     ${mayPipeline.toLocaleString().padStart(12)} PKR (${mayOrders.length} orders, 9 days)`);
console.log(`    May 2026 ad spend:             ${mayAdTotal.toLocaleString().padStart(12)} PKR`);
console.log(`    Last-6-months delivery rate:   ${(deliveryRate * 100).toFixed(1)}% (${deliveredSettled}/${settled} settled)`);
console.log(`    Last-6-months true COGS:       ${trueCOGSPct.toFixed(1)}% (variant_id matches)`);
console.log(`    Delivery cost ratio:           9% (historical avg)`);
console.log(`    Fixed overhead:                120,000 PKR/month`);

const expDelivered = mayPipeline * deliveryRate;
const expReturned = mayPipeline * (1 - deliveryRate);
const cogsDelivered = expDelivered * (trueCOGSPct / 100);
const cogsReturned = expReturned * (trueCOGSPct / 100);
const dCost = (expDelivered + expReturned) * 0.09;
const unsellable = cogsReturned * 0.15;
const grossMargin = expDelivered - cogsDelivered - dCost - unsellable;
const contribution = grossMargin - mayAdTotal;
const dailyContribution = contribution / 9;
const monthlyContribution = dailyContribution * 30;
const monthlyNet = monthlyContribution - 120000;
const annualNet = monthlyNet * 12;

console.log(`\n  May 9-day projection:`);
console.log(`    Expected delivered sales:      ${Math.round(expDelivered).toLocaleString().padStart(12)} PKR`);
console.log(`    less COGS at ${trueCOGSPct.toFixed(1)}%:           ${Math.round(cogsDelivered).toLocaleString().padStart(12)} PKR`);
console.log(`    less delivery cost:            ${Math.round(dCost).toLocaleString().padStart(12)} PKR`);
console.log(`    less unsellable returns:       ${Math.round(unsellable).toLocaleString().padStart(12)} PKR`);
console.log(`    Gross margin:                  ${Math.round(grossMargin).toLocaleString().padStart(12)} PKR  (${((grossMargin / expDelivered) * 100).toFixed(1)}% of delivered sales)`);
console.log(`    less ad spend:                 ${mayAdTotal.toLocaleString().padStart(12)} PKR`);
console.log(`    Contribution margin (9 days):  ${Math.round(contribution).toLocaleString().padStart(12)} PKR`);
console.log(`    Pro-rated to month (×30/9):    ${Math.round(monthlyContribution).toLocaleString().padStart(12)} PKR`);
console.log(`    less fixed overhead:           ${"120,000".padStart(12)} PKR`);
console.log(`    ─────────────────────────────────────────`);
console.log(`    Monthly net profit:            ${Math.round(monthlyNet).toLocaleString().padStart(12)} PKR`);
console.log(`    Annualized (×12):              ${Math.round(annualNet).toLocaleString().padStart(12)} PKR`);

console.log(`\n  Partnership economics:`);
console.log(`    Buy-in for 50%:                300,000 PKR`);
const yourShareMonthly = monthlyNet * 0.5;
console.log(`    Your share monthly:            ${Math.round(yourShareMonthly).toLocaleString().padStart(12)} PKR`);
console.log(`    Your share annually:           ${Math.round(yourShareMonthly * 12).toLocaleString().padStart(12)} PKR`);
if (yourShareMonthly > 0) {
  console.log(`    Payback on 300k:               ${(300000 / yourShareMonthly).toFixed(1)} months`);
  console.log(`    Implied P/E multiple:          ${(600000 / annualNet).toFixed(2)}x`);
} else {
  console.log(`    Payback:                       ∞ (currently unprofitable)`);
}

// What if we use March 2026 (the strong month) instead?
console.log(`\n─── ALTERNATE SCENARIO: using March 2026 (peak month) as baseline ───\n`);
const march = byMonth.get("2026-03");
if (march) {
  const marchAd = adByMonth.get("2026-03") ?? 0;
  const marchAccurate = orders.filter((o) => (o.order_date ?? o.transaction_date)?.slice(0, 7) === "2026-03" && o.is_delivered && (o.cogs_match_source === "variant_id" || o.cogs_match_source === "exact"));
  const marchAccurateRev = marchAccurate.reduce((s, o) => s + Number(o.invoice_payment || 0), 0);
  const marchAccurateCOGS = marchAccurate.reduce((s, o) => s + Number(o.cogs_total || 0), 0);
  const marchTrueCOGS = marchAccurateRev ? (marchAccurateCOGS / marchAccurateRev) * 100 : trueCOGSPct;
  const marchDeliveredSales = march.deliveredSales;
  // Apply true COGS uniformly
  const marchAdjGross = marchDeliveredSales * (1 - marchTrueCOGS / 100 - 0.09);  // approx
  const marchNet = marchAdjGross - marchAd - 120000;
  console.log(`    March 2026 delivered sales:    ${marchDeliveredSales.toLocaleString().padStart(12)} PKR`);
  console.log(`    March true COGS%:              ${marchTrueCOGS.toFixed(1)}%`);
  console.log(`    March ad spend:                ${marchAd.toLocaleString().padStart(12)} PKR`);
  console.log(`    Adjusted gross margin:         ${Math.round(marchAdjGross).toLocaleString().padStart(12)} PKR`);
  console.log(`    Net (after ads + overhead):    ${Math.round(marchNet).toLocaleString().padStart(12)} PKR`);
  if (marchNet > 0) {
    const marchAnnualized = marchNet * 12;
    console.log(`    Annualized at March pace:      ${Math.round(marchAnnualized).toLocaleString().padStart(12)} PKR`);
    console.log(`    Your 50% share annual:         ${Math.round(marchAnnualized * 0.5).toLocaleString().padStart(12)} PKR`);
    console.log(`    300k payback at March pace:    ${(300000 / (marchNet * 0.5)).toFixed(1)} months`);
  }
}
