// Source-Adapter pattern for the dashboard's data layer.
//
// The dashboard (app/routes/app._index.tsx) used to call the
// get_dashboard_stats RPC directly. That hard-bound it to the PostEx
// orders table — fine for Pakistani COD merchants, breaks for
// merchants without a courier integration.
//
// Adapters wrap the source-specific fetch behind a single interface:
//
//   getDashboardStats(periods, monthlyExp, perOrderExp)
//      → { today: <stat>, yesterday: <stat>, mtd: <stat>, lastMonth: <stat> }
//   capabilities()
//      → { showPipelinePills, showCityLoss, returnsLabel, returnsUnit }
//
// where <stat> shape exactly matches get_dashboard_stats RPC output:
//   sales, orders, units, returns, in_transit, delivery_cost,
//   reversal_cost, tax, cogs, ad_spend, expenses, gross_profit,
//   net_profit, return_loss, roas, poas, cac, aov, margin_pct,
//   roi_pct, refund_pct, in_transit_value
//
// Dashboard loader dispatches via getStatsAdapter(store, session) and
// calls the same methods regardless of mode. Components branch on the
// adapter's capabilities() result, not on the raw mode string — keeps
// UI mode-agnostic and lets us add more sources (TikTok Shop, Amazon)
// without touching components.

import { getSupabaseForStore } from "./supabase.server.js";
import { allocateExpenses } from "./expense-alloc.server.js";

// ─── Public dispatch ──────────────────────────────────────────────────────

export async function getStatsAdapter(store, session) {
  if (store.ingest_mode === "shopify_direct") {
    return new ShopifyDirectAdapter(store, session);
  }
  return new PostExAdapter(store);
}

// ─── PostExAdapter — wraps the existing RPC path ─────────────────────────
//
// Pure delegation to get_dashboard_stats / get_city_breakdown / etc.
// No behavior change for current PostEx merchants — the dashboard just
// goes through one extra layer of indirection.

class PostExAdapter {
  constructor(store) {
    this.store = store;
  }

  capabilities() {
    return {
      mode: "postex",
      showPipelinePills: true,
      showCityLoss: true,
      returnsLabel: "Returns",
      returnsUnit: "count",
    };
  }

  async getDashboardStats({ periods, expenseStoreId }) {
    const supabase = await getSupabaseForStore(this.store.store_id);
    const out = {};
    await Promise.all(
      Object.entries(periods).map(async ([key, range]) => {
        const { data } = await supabase.rpc("get_dashboard_stats", {
          p_store_id: this.store.store_id,
          p_from_date: range.from,
          p_to_date: range.to,
          p_expense_store_id: expenseStoreId ?? this.store.store_id,
        });
        out[key] = data?.[0] ?? null;
      })
    );
    return out;
  }
}

// ─── ShopifyDirectAdapter — live Shopify Admin API ───────────────────────
//
// For merchants without a courier integration. Pulls orders from
// Shopify directly, computes the same stats shape on the fly. Single
// broad-range fetch (lastMonth.from → today.to) is cached for 60s
// and used to compute every period via in-memory filtering — much
// cheaper than 8 separate API calls.

const SHOPIFY_API_VERSION = "2025-01";
const CACHE_TTL_MS = 60_000;

// Module-level caches. Map<cacheKey, { fetchedAt, value }>.
const _orderCache = new Map();
const _ancillaryCache = new Map(); // cogs maps + ad_spend by day

function pruneCache(map) {
  const now = Date.now();
  for (const [k, v] of map) {
    if (now - v.fetchedAt > CACHE_TTL_MS) map.delete(k);
  }
}
function pruneOrderCache() {
  pruneCache(_orderCache);
}

class ShopifyDirectAdapter {
  constructor(store, session) {
    this.store = store;
    this.session = session;
  }

  capabilities() {
    return {
      mode: "shopify_direct",
      showPipelinePills: false,   // no in-transit / unfulfilled pills (no courier)
      showCityLoss: false,        // city-by-returns analysis hidden
      returnsLabel: "Refunded",   // KPI card label
      returnsUnit: "money",       // value is a money amount, not a count
    };
  }

  async getDashboardStats({ periods, expenses: expenseRows = [] }) {
    const ranges = Object.values(periods);
    if (!ranges.length) return {};

    // Span the widest covered range so a single fetch + filter covers
    // all four periods. This is the key efficiency win.
    const widest = {
      from: ranges.reduce((a, r) => (r.from < a ? r.from : a), ranges[0].from),
      to:   ranges.reduce((a, r) => (r.to   > a ? r.to   : a), ranges[0].to),
    };

    const orders = await this._fetchOrders(widest.from, widest.to);

    // Pre-compute COGS map once: variant_id → unit_cost. Same source
    // as the PostEx mode (product_costs table written from the COGS
    // settings page).
    const costsMap = await this._loadCostsMap();

    // Pre-fetch ad_spend rows for the full window (Meta cron writes
    // them regardless of ingest_mode, in store currency).
    const adSpendByDay = await this._loadAdSpend(widest.from, widest.to);

    const out = {};
    for (const [key, range] of Object.entries(periods)) {
      const inRange = orders.filter(
        (o) => o.created_at_iso >= range.from && o.created_at_iso < range.toExclusive
      );
      const adSpend = sumAdSpend(adSpendByDay, range.from, range.toExclusive);
      // Expenses use the one shared allocator (mirrors the SQL RPC), so
      // shopify_direct net profit matches what the PostEx path would show.
      out[key] = computeStats({
        orders: inRange,
        costsMap,
        adSpend,
        expenseRows,
        rangeFromIso: range.from,
        rangeToIso: range.toExclusive,
        expRangeFrom: range.from,
        expRangeTo: range.to,
      });
    }
    return out;
  }

  // Pull raw orders for [from, to). Uses REST orders.json with cursor
  // pagination via Link header. Cached for 60s on (shop, from, to).
  async _fetchOrders(fromDate, toDate) {
    const cacheKey = `${this.store.store_id}:${fromDate}:${toDate}`;
    pruneOrderCache();
    const cached = _orderCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.orders;
    }

    const accessToken = this.session?.accessToken;
    if (!accessToken) {
      throw new Error("ShopifyDirectAdapter: no session accessToken");
    }
    const fields = [
      "id",
      "name",
      "created_at",
      "processed_at",
      "financial_status",
      "fulfillment_status",
      "total_price",
      "total_price_set",
      "current_total_price_set",
      "total_tax_set",
      "total_refunded_set",
      "currency",
      "presentment_currency",
      "line_items",
      "refunds",
    ].join(",");

    const out = [];
    let url =
      `https://${this.store.store_id}/admin/api/${SHOPIFY_API_VERSION}/orders.json?` +
      new URLSearchParams({
        status: "any",
        created_at_min: fromDate,
        created_at_max: toDate,
        limit: "250",
        fields,
      });

    for (let page = 0; page < 50 && url; page++) {
      const res = await fetch(url, {
        headers: { "X-Shopify-Access-Token": accessToken },
      });
      if (!res.ok) {
        throw new Error(
          `ShopifyDirectAdapter: orders fetch HTTP ${res.status} for ${fromDate}–${toDate}`
        );
      }
      const { orders } = await res.json();
      for (const o of orders ?? []) {
        out.push(normalizeOrder(o));
      }
      const link = res.headers.get("link") ?? "";
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }

    _orderCache.set(cacheKey, { fetchedAt: Date.now(), orders: out });
    return out;
  }

  async _loadCostsMap() {
    const cacheKey = `costs:${this.store.store_id}`;
    pruneCache(_ancillaryCache);
    const cached = _ancillaryCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.value;
    }
    const supabase = await getSupabaseForStore(this.store.store_id);
    const { data } = await supabase
      .from("product_costs")
      .select("shopify_variant_id, unit_cost")
      .eq("store_id", this.store.store_id);
    const map = new Map();
    for (const r of data ?? []) {
      map.set(String(r.shopify_variant_id), Number(r.unit_cost ?? 0));
    }
    _ancillaryCache.set(cacheKey, { fetchedAt: Date.now(), value: map });
    return map;
  }

  async _loadAdSpend(fromDate, toDate) {
    const cacheKey = `adspend:${this.store.store_id}:${fromDate}:${toDate}`;
    pruneCache(_ancillaryCache);
    const cached = _ancillaryCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.value;
    }
    const supabase = await getSupabaseForStore(this.store.store_id);
    const { data } = await supabase
      .from("ad_spend")
      .select("spend_date, amount")
      .eq("store_id", this.store.store_id)
      .gte("spend_date", fromDate)
      .lt("spend_date", toDate);
    const map = new Map();
    for (const r of data ?? []) {
      map.set(String(r.spend_date), Number(r.amount ?? 0));
    }
    _ancillaryCache.set(cacheKey, { fetchedAt: Date.now(), value: map });
    return map;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

// Convert a Shopify order's raw timestamp to ISO date string (YYYY-MM-DD)
// in PKT for filter comparisons. PKT is UTC+5; for non-PKR stores this
// approximation slightly skews period boundaries (a 23:59 UTC order on
// Jan 31 lands in Jan in their timezone but Feb in PKT). Acceptable for
// dashboard buckets — exact PKT semantics matter for COD merchants who
// the rest of this codebase serves; international merchants will accept
// the same convention.
function normalizeOrder(o) {
  const createdAtMs = new Date(o.created_at).getTime();
  const pktDate = new Date(createdAtMs + 5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return {
    id: String(o.id),
    name: o.name,
    created_at: o.created_at,
    created_at_iso: pktDate,
    processed_at: o.processed_at,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
    // Shop-money: pre-converted to base currency by Shopify at checkout.
    // This is the right field for aggregation in stores.currency.
    sales_amount: shopMoney(o.total_price_set) ?? Number(o.total_price ?? 0),
    tax_amount: shopMoney(o.total_tax_set) ?? 0,
    refunded_amount: shopMoney(o.total_refunded_set) ?? 0,
    line_items: (o.line_items ?? []).map((li) => ({
      variant_id: li.variant_id != null ? String(li.variant_id) : null,
      product_id: li.product_id != null ? String(li.product_id) : null,
      quantity: Number(li.quantity ?? 0),
    })),
    refunds: (o.refunds ?? []).map((r) => ({
      id: String(r.id),
      processed_at: r.processed_at ?? r.created_at,
      processed_at_iso: r.processed_at
        ? new Date(new Date(r.processed_at).getTime() + 5 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10)
        : null,
      // Sum refund_line_items + transactions for total refund value.
      // Shopify's refunds[].transactions[].amount is the actual money
      // moved; refund_line_items + adjustments don't always show.
      transaction_amount: (r.transactions ?? [])
        .filter((t) => t.kind === "refund" && t.status === "success")
        .reduce((s, t) => s + Number(t.amount ?? 0), 0),
    })),
  };
}

function shopMoney(set) {
  if (!set) return null;
  const v = set?.shop_money?.amount;
  return v != null ? Number(v) : null;
}

function countNonRefundedOrders(orders) {
  return orders.filter((o) => o.financial_status !== "refunded" && o.financial_status !== "voided").length;
}

function sumAdSpend(byDay, fromIso, toExclusiveIso) {
  let total = 0;
  for (const [date, amt] of byDay) {
    if (date >= fromIso && date < toExclusiveIso) total += amt;
  }
  return total;
}

function daysBetween(fromIso, toExclusiveIso) {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toExclusiveIso}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((b - a) / (24 * 60 * 60 * 1000)));
}

// Compute the get_dashboard_stats output shape from a list of orders.
// Refund timing semantic (Stripe convention):
//   - Sales = sum of order.sales_amount for orders created in period
//   - Refunded = sum of refund.transaction_amount for refunds whose
//     processed_at falls in period (regardless of order creation date).
//   - Net sales = sales - refunded
function computeStats({ orders, costsMap, adSpend, expenses, expenseRows, rangeFromIso, rangeToIso, expRangeFrom, expRangeTo }) {
  let grossSales = 0;
  let units = 0;
  let cogs = 0;
  let tax = 0;
  let nonRefundedCount = 0;

  for (const o of orders) {
    grossSales += o.sales_amount;
    tax += o.tax_amount;
    if (o.financial_status !== "refunded" && o.financial_status !== "voided") {
      nonRefundedCount++;
    }
    for (const li of o.line_items) {
      units += li.quantity;
      const unitCost = li.variant_id ? costsMap.get(li.variant_id) ?? 0 : 0;
      cogs += unitCost * li.quantity;
    }
  }

  // Refunds processed inside the period — note: these may be against
  // orders created before the period, but the financial impact lands
  // on the period the refund happened in.
  let refundedAmount = 0;
  let refundCount = 0;
  for (const o of orders) {
    for (const r of o.refunds) {
      if (
        r.processed_at_iso &&
        r.processed_at_iso >= rangeFromIso &&
        r.processed_at_iso < rangeToIso
      ) {
        refundedAmount += r.transaction_amount;
        refundCount++;
      }
    }
  }

  const sales = grossSales - refundedAmount;
  const deliveryCost = 0;       // no courier integration
  const reversalCost = 0;
  const grossProfit = sales - deliveryCost - reversalCost - tax - cogs;

  // Resolve expenses: prefer the shared segment allocator (rows + range);
  // fall back to a pre-computed numeric for the pure unit tests.
  let expenseBreakdown = [];
  let expenseTotal;
  if (Array.isArray(expenseRows)) {
    const a = allocateExpenses(expenseRows, expRangeFrom, expRangeTo, {
      delivered: nonRefundedCount,
      adSpend,
      sales,
    });
    expenseTotal = a.total;
    expenseBreakdown = a.breakdown;
  } else {
    expenseTotal = Number(expenses ?? 0);
  }
  const netProfit = grossProfit - adSpend - expenseTotal;

  const safeDiv = (a, b) => (b === 0 || b == null ? null : a / b);

  // Match get_dashboard_stats RPC null-semantics so the adapter is a
  // drop-in replacement: ratios that depend on a zero denominator OR
  // a zero ad_spend numerator return NULL, EXCEPT refund_pct which
  // returns 0 (not null) when there are no orders. Keeps "N/A" vs
  // "0%" rendering identical between modes.
  const cac = adSpend === 0 || nonRefundedCount === 0 ? null : adSpend / nonRefundedCount;
  const refundPct =
    grossSales === 0 ? 0 : refundedAmount / grossSales;

  return {
    sales: round2(sales),
    orders: nonRefundedCount,
    units,
    returns: refundCount,                 // count of refunds in period
    in_transit: 0,
    delivery_cost: 0,
    reversal_cost: 0,
    tax: round2(tax),
    cogs: round2(cogs),
    ad_spend: round2(adSpend),
    expenses: round2(expenseTotal),
    _expenseBreakdown: expenseBreakdown,
    gross_profit: round2(grossProfit),
    net_profit: round2(netProfit),
    return_loss: round2(refundedAmount),  // refunded money (used by BreakEvenSection's "cost per return" tile, relabeled in UI)
    roas: roundN(safeDiv(sales, adSpend), 2),
    poas: roundN(safeDiv(netProfit, adSpend), 2),
    cac: roundN(cac, 2),
    aov: roundN(safeDiv(sales, nonRefundedCount), 2),
    margin_pct: roundN(safeDiv(netProfit, sales), 4),
    roi_pct: roundN(safeDiv(netProfit, cogs + adSpend + deliveryCost), 4),
    refund_pct: roundN(refundPct, 4),
    in_transit_value: 0,
  };
}

function round2(n) {
  if (n == null) return null;
  return Math.round(n * 100) / 100;
}
function roundN(n, dp) {
  if (n == null) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

// Test helpers — exported so the unit suite can exercise pure functions
// without spinning up Supabase.
export const __test__ = {
  computeStats,
  normalizeOrder,
  countNonRefundedOrders,
  sumAdSpend,
  daysBetween,
};
