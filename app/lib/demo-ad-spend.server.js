// Demo-store-only: zero out pool ad_spend until the demo merchant connects
// their own Meta Ads account.
//
// Demo stores share a fabricated pool that includes synthetic ad_spend rows.
// Showing those numbers to a merchant who hasn't connected Meta is misleading
// — they'd see a "you spent X on ads" figure for ads they never ran. Until
// the merchant goes through the Meta OAuth on their own row, we zero ad_spend
// (and recompute every field that derived from it) so the dashboard reflects
// the merchant's actual ad-connection state, not the pool's.
//
// This helper is a strict no-op for non-demo stores and for demo stores that
// HAVE connected Meta. Real-store math is never touched.

export function shouldHideDemoAdSpend(storeRow) {
  if (!storeRow) return false;
  if (!storeRow.is_demo) return false;
  // Connected = a token exists. Token expiry isn't considered here — an
  // expired token still means the merchant onboarded a real ad account at
  // some point, which is more meaningful to surface than zero.
  return !storeRow.meta_access_token;
}

// Mutates a get_dashboard_stats row to zero ad_spend and recompute the
// dependent fields when the demo-mask condition holds. Returns the row
// either way; null/undefined input is passed through unchanged.
export function maskDemoAdSpend(stat, storeRow) {
  if (!stat) return stat;
  if (!shouldHideDemoAdSpend(storeRow)) return stat;

  const adSpend = Number(stat.ad_spend ?? 0);
  const sales = Number(stat.sales ?? 0);
  const cogs = Number(stat.cogs ?? 0);
  const deliveryCost = Number(stat.delivery_cost ?? 0);
  const newNetProfit = Number(stat.net_profit ?? 0) + adSpend;

  stat.ad_spend = 0;
  stat.net_profit = round2(newNetProfit);
  // Ratios that divide by ad_spend are now undefined → render as N/A.
  stat.roas = null;
  stat.poas = null;
  stat.cac = null;
  // Margin and ROI shift because net_profit changed.
  stat.margin_pct = sales === 0 ? null : round4(newNetProfit / sales);
  const roiDenom = cogs + deliveryCost; // ad_spend is now 0
  stat.roi_pct = roiDenom === 0 ? null : round4(newNetProfit / roiDenom);
  return stat;
}

// Mutates a get_trend_series row (per-bucket) to zero ad_spend and
// recompute total_cost / net_profit. Same conditions as above.
export function maskDemoAdSpendForTrendPoint(point, storeRow) {
  if (!point) return point;
  if (!shouldHideDemoAdSpend(storeRow)) return point;
  const adSpend = Number(point.ad_spend ?? 0);
  if (adSpend === 0) return point;
  point.ad_spend = 0;
  point.total_cost = round2(Number(point.total_cost ?? 0) - adSpend);
  point.net_profit = round2(Number(point.net_profit ?? 0) + adSpend);
  return point;
}

function round2(n) {
  if (n == null) return null;
  return Math.round(n * 100) / 100;
}
function round4(n) {
  if (n == null) return null;
  return Math.round(n * 10000) / 10000;
}
