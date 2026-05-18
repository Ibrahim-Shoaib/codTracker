import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeImpact } from "../app/lib/expense-impact.server.js";

// summarizeImpact only folds breakdown rows into buckets — it must never
// re-derive amounts (the allocator already did that). These pin the fold
// rule + the "skip inactive, keep estimates" filter that mirrors DetailPanel.

test("empty / nullish input → all zeros", () => {
  assert.deepEqual(summarizeImpact([]), {
    total: 0, fixed: 0, perOrder: 0, percent: 0, anyEstimated: false, count: 0,
  });
  assert.deepEqual(summarizeImpact(null), {
    total: 0, fixed: 0, perOrder: 0, percent: 0, anyEstimated: false, count: 0,
  });
});

test("buckets by kind and totals; total == sum of buckets", () => {
  const rows = [
    { kind: "fixed",     value: 120000, estimated: false },
    { kind: "per_order", value: 44500,  estimated: false },
    { kind: "percent",   value: 20000,  estimated: false },
  ];
  const r = summarizeImpact(rows);
  assert.equal(r.fixed, 120000);
  assert.equal(r.perOrder, 44500);
  assert.equal(r.percent, 20000);
  assert.equal(r.total, 184500);
  assert.equal(r.total, r.fixed + r.perOrder + r.percent);
  assert.equal(r.count, 3);
  assert.equal(r.anyEstimated, false);
});

test("zero, non-estimated rows are skipped (inactive this period)", () => {
  const rows = [
    { kind: "fixed",     value: 50000, estimated: false },
    { kind: "per_order", value: 0,     estimated: false }, // no deliveries yet
  ];
  const r = summarizeImpact(rows);
  assert.equal(r.total, 50000);
  assert.equal(r.perOrder, 0);
  assert.equal(r.count, 1);
});

test("estimated rows are kept and flag the summary, even at zero", () => {
  const rows = [
    { kind: "fixed", value: 0, estimated: true },
    { kind: "fixed", value: 75000, estimated: true },
  ];
  const r = summarizeImpact(rows);
  assert.equal(r.anyEstimated, true);
  assert.equal(r.fixed, 75000);
  assert.equal(r.total, 75000);
  assert.equal(r.count, 2);
});

test("non-numeric / missing value coerces to 0 without throwing", () => {
  const rows = [
    { kind: "fixed", value: "30000", estimated: false },
    { kind: "percent", value: undefined, estimated: true },
  ];
  const r = summarizeImpact(rows);
  assert.equal(r.fixed, 30000);
  assert.equal(r.percent, 0);
  assert.equal(r.anyEstimated, true);
});
