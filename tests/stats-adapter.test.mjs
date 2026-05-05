// Unit tests for app/lib/stats-adapter.server.js — pure functions.
// (DB / Shopify-API integration is exercised in
// scripts/_test_shopify_direct_adapter.mjs against the live Trendy
// Homes store.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../app/lib/stats-adapter.server.js";

const { computeStats, normalizeOrder, countNonRefundedOrders, sumAdSpend, daysBetween } = __test__;

// ─── normalizeOrder ──────────────────────────────────────────────────────

test("normalizeOrder reads shop_money for sales (currency-correct)", () => {
  const o = normalizeOrder({
    id: 1,
    name: "#1001",
    created_at: "2026-05-05T12:00:00Z",
    financial_status: "paid",
    total_price: "100.00",
    presentment_currency: "EUR",
    total_price_set: { shop_money: { amount: "108.50", currency_code: "USD" } },
    line_items: [{ variant_id: 99, quantity: 2 }],
    refunds: [],
  });
  assert.equal(o.sales_amount, 108.5); // base currency, not presentment
  assert.equal(o.line_items[0].quantity, 2);
});

test("normalizeOrder falls back to total_price when total_price_set absent", () => {
  const o = normalizeOrder({
    id: 1,
    created_at: "2026-05-05T12:00:00Z",
    total_price: "50.00",
    line_items: [],
    refunds: [],
  });
  assert.equal(o.sales_amount, 50);
});

test("normalizeOrder extracts refund.transaction_amount from successful refund transactions", () => {
  const o = normalizeOrder({
    id: 1,
    created_at: "2026-05-05T12:00:00Z",
    total_price: "100",
    line_items: [],
    refunds: [
      {
        id: 9,
        processed_at: "2026-05-06T10:00:00Z",
        transactions: [
          { kind: "refund", status: "success", amount: "30.00" },
          { kind: "refund", status: "failure", amount: "20.00" },
          { kind: "capture", status: "success", amount: "100.00" },
        ],
      },
    ],
  });
  assert.equal(o.refunds.length, 1);
  assert.equal(o.refunds[0].transaction_amount, 30);
});

test("normalizeOrder uses PKT for date bucketing (UTC+5)", () => {
  // 22:30 UTC on May 5 = 03:30 PKT on May 6
  const o = normalizeOrder({
    id: 1,
    created_at: "2026-05-05T22:30:00Z",
    total_price: "100",
    line_items: [],
    refunds: [],
  });
  assert.equal(o.created_at_iso, "2026-05-06");
});

// ─── countNonRefundedOrders ──────────────────────────────────────────────

test("countNonRefundedOrders excludes refunded and voided", () => {
  const orders = [
    { financial_status: "paid" },
    { financial_status: "paid" },
    { financial_status: "refunded" },
    { financial_status: "voided" },
    { financial_status: "partially_refunded" },
    { financial_status: "pending" },
  ];
  assert.equal(countNonRefundedOrders(orders), 4);
});

// ─── sumAdSpend ──────────────────────────────────────────────────────────

test("sumAdSpend sums entries within [from, to)", () => {
  const map = new Map([
    ["2026-05-01", 100],
    ["2026-05-02", 200],
    ["2026-05-03", 50],
    ["2026-05-04", 999], // out of range
  ]);
  assert.equal(sumAdSpend(map, "2026-05-01", "2026-05-04"), 350);
});

test("sumAdSpend with empty map returns 0", () => {
  assert.equal(sumAdSpend(new Map(), "2026-05-01", "2026-05-04"), 0);
});

// ─── daysBetween ─────────────────────────────────────────────────────────

test("daysBetween returns inclusive day count", () => {
  assert.equal(daysBetween("2026-05-01", "2026-05-04"), 3);
});

test("daysBetween clamps minimum to 1 (avoids div-by-zero in proration)", () => {
  assert.equal(daysBetween("2026-05-01", "2026-05-01"), 1);
});

// ─── computeStats — empty period ─────────────────────────────────────────

test("computeStats with no orders produces zeros, not nulls", () => {
  const s = computeStats({
    orders: [],
    costsMap: new Map(),
    adSpend: 0,
    expenses: 0,
    rangeFromIso: "2026-05-05",
    rangeToIso: "2026-05-06",
  });
  assert.equal(s.sales, 0);
  assert.equal(s.orders, 0);
  assert.equal(s.units, 0);
  assert.equal(s.returns, 0);
  assert.equal(s.cogs, 0);
  assert.equal(s.gross_profit, 0);
  assert.equal(s.net_profit, 0);
  // Ratios with zero denominator are null (division-by-zero rule).
  assert.equal(s.roas, null);
  assert.equal(s.cac, null);
  assert.equal(s.aov, null);
});

// ─── computeStats — single happy-path order ──────────────────────────────

test("computeStats: one $100 paid order, $20 spend, $5 expenses", () => {
  const order = {
    id: "1",
    created_at_iso: "2026-05-05",
    financial_status: "paid",
    sales_amount: 100,
    tax_amount: 0,
    refunded_amount: 0,
    line_items: [{ variant_id: "v1", product_id: "p1", quantity: 2 }],
    refunds: [],
  };
  const costsMap = new Map([["v1", 15]]); // $15/unit, 2 units → $30 COGS
  const s = computeStats({
    orders: [order],
    costsMap,
    adSpend: 20,
    expenses: 5,
    rangeFromIso: "2026-05-05",
    rangeToIso: "2026-05-06",
  });
  assert.equal(s.sales, 100);
  assert.equal(s.orders, 1);
  assert.equal(s.units, 2);
  assert.equal(s.cogs, 30);
  assert.equal(s.gross_profit, 100 - 0 - 0 - 0 - 30); // sales - delivery - reversal - tax - cogs
  assert.equal(s.net_profit, 70 - 20 - 5);
  assert.equal(s.roas, 5); // 100 / 20
  assert.equal(s.cac, 20); // 20 / 1
  assert.equal(s.aov, 100); // 100 / 1
  assert.equal(s.delivery_cost, 0);
  assert.equal(s.in_transit, 0);
});

// ─── computeStats — refund handling ──────────────────────────────────────

test("computeStats: refund processed in period reduces sales and increments returns", () => {
  const order = {
    id: "1",
    created_at_iso: "2026-05-05",
    financial_status: "partially_refunded",
    sales_amount: 100,
    tax_amount: 0,
    line_items: [{ variant_id: "v1", quantity: 1 }],
    refunds: [
      {
        id: "r1",
        processed_at_iso: "2026-05-05",
        transaction_amount: 30,
      },
    ],
  };
  const s = computeStats({
    orders: [order],
    costsMap: new Map([["v1", 10]]),
    adSpend: 0,
    expenses: 0,
    rangeFromIso: "2026-05-05",
    rangeToIso: "2026-05-06",
  });
  assert.equal(s.sales, 70);            // 100 - 30 refund
  assert.equal(s.returns, 1);
  assert.equal(s.return_loss, 30);
  assert.equal(s.refund_pct, 0.3);      // 30/100 (not %, fraction — UI formats)
});

test("computeStats: refund processed OUTSIDE period does not affect period stats", () => {
  const order = {
    id: "1",
    created_at_iso: "2026-05-05",
    financial_status: "partially_refunded",
    sales_amount: 100,
    tax_amount: 0,
    line_items: [],
    refunds: [
      { id: "r1", processed_at_iso: "2026-05-10", transaction_amount: 30 }, // future refund
    ],
  };
  const s = computeStats({
    orders: [order],
    costsMap: new Map(),
    adSpend: 0,
    expenses: 0,
    rangeFromIso: "2026-05-05",
    rangeToIso: "2026-05-06",
  });
  assert.equal(s.sales, 100);
  assert.equal(s.returns, 0);
  assert.equal(s.return_loss, 0);
});

// ─── computeStats — ROI with zero spend ──────────────────────────────────

test("computeStats: ROAS is null when ad_spend is 0 (no division by zero)", () => {
  const order = {
    id: "1",
    created_at_iso: "2026-05-05",
    financial_status: "paid",
    sales_amount: 100,
    tax_amount: 0,
    line_items: [],
    refunds: [],
  };
  const s = computeStats({
    orders: [order],
    costsMap: new Map(),
    adSpend: 0,
    expenses: 0,
    rangeFromIso: "2026-05-05",
    rangeToIso: "2026-05-06",
  });
  assert.equal(s.roas, null);
  assert.equal(s.poas, null);
  assert.equal(s.cac, null);
});

// ─── computeStats — multiple orders, mixed financial_status ──────────────

test("computeStats: mixed orders aggregate correctly", () => {
  const orders = [
    { id:"1", created_at_iso:"2026-05-05", financial_status:"paid",     sales_amount: 100, tax_amount: 0, line_items: [{variant_id:"v1",quantity:1}], refunds: [] },
    { id:"2", created_at_iso:"2026-05-05", financial_status:"paid",     sales_amount: 200, tax_amount: 0, line_items: [{variant_id:"v2",quantity:3}], refunds: [] },
    { id:"3", created_at_iso:"2026-05-05", financial_status:"refunded", sales_amount: 50,  tax_amount: 0, line_items: [{variant_id:"v1",quantity:1}], refunds: [{processed_at_iso:"2026-05-05", transaction_amount:50}] },
  ];
  const costs = new Map([["v1", 10], ["v2", 30]]);
  const s = computeStats({
    orders, costsMap: costs, adSpend: 60, expenses: 0,
    rangeFromIso: "2026-05-05", rangeToIso: "2026-05-06",
  });
  assert.equal(s.sales, 300); // 100 + 200 + 50 - 50 refund
  assert.equal(s.orders, 2);  // refunded one excluded
  assert.equal(s.units, 5);   // 1 + 3 + 1
  // COGS includes ALL orders' line items (we paid for the goods even
  // when refunded — same convention as PostEx orders.cogs_total).
  assert.equal(s.cogs, 110);  // 1×10 + 3×30 + 1×10
  assert.equal(s.returns, 1);
  assert.equal(s.return_loss, 50);
});
