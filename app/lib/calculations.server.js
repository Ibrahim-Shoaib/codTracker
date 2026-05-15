// Pure financial formula functions. No DB calls. All inputs are numbers.
// Return null for ratio metrics when denominator is 0 — UI renders null as "N/A".
// Returning 0 for a ratio when there is no denominator is misleading (e.g. 0 ROAS ≠ no ad spend).

// NOTE: expense allocation now lives in one place — the SQL RPCs
// (migration 025) and its JS mirror app/lib/expense-alloc.server.js.
// The old calcExpenses() pro-rata helper was dead code with a formula
// that contradicted the RPC; removed to keep a single source of truth.

export const calcGrossProfit = (sales, deliveryCost, cogs) =>
  sales - deliveryCost - cogs;

export const calcNetProfit = (gross, adSpend, expenses) =>
  gross - adSpend - expenses;

export const calcROAS = (sales, adSpend) =>
  adSpend === 0 ? null : sales / adSpend;

export const calcPOAS = (net, adSpend) =>
  adSpend === 0 ? null : net / adSpend;

export const calcCAC = (adSpend, orders) =>
  adSpend === 0 || orders === 0 ? null : adSpend / orders;

export const calcAOV = (sales, orders) =>
  orders === 0 ? null : sales / orders;

export const calcMargin = (net, sales) =>
  sales === 0 ? null : (net / sales) * 100;

export const calcROI = (net, cogs, adSpend, deliveryCost) =>
  (cogs + adSpend + deliveryCost) === 0 ? null : (net / (cogs + adSpend + deliveryCost)) * 100;

export const calcRefundPct = (returns, delivered) =>
  (returns + delivered) === 0 ? 0 : (returns / (returns + delivered)) * 100;

export const calcPctChange = (current, prior) =>
  prior === 0 ? null : ((current - prior) / prior) * 100;
