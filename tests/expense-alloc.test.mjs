import { test } from "node:test";
import assert from "node:assert/strict";
import { monthStartsInRange, allocateExpenses } from "../app/lib/expense-alloc.server.js";

// These pin the JS allocator to the SQL allocator (migration 025). If the
// SQL "count of 1st-of-months within [from,to], intersected with the
// effective window" rule ever changes, both must change together.

test("monthStartsInRange: counts 1st-of-months within an inclusive range", () => {
  assert.deepEqual(monthStartsInRange("2026-04-16", "2026-05-15"), ["2026-05-01"]);
  assert.deepEqual(monthStartsInRange("2026-05-01", "2026-05-15"), ["2026-05-01"]);
  assert.deepEqual(monthStartsInRange("2026-05-05", "2026-05-11"), []); // no 1st in window
  assert.deepEqual(
    monthStartsInRange("2026-01-01", "2026-05-15"),
    ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"]
  );
});

test("fixed unbounded == amount × month count (legacy behavior preserved)", () => {
  const rows = [{ name: "Rent", kind: "fixed", amount: 55000, effective_from: null, effective_to: null }];
  assert.equal(allocateExpenses(rows, "2026-05-01", "2026-05-15").total, 55000);
  assert.equal(allocateExpenses(rows, "2026-01-01", "2026-05-15").total, 55000 * 5);
  assert.equal(allocateExpenses(rows, "2026-05-05", "2026-05-11").total, 0); // mid-month, no 1st
});

test("fixed honors effective_from (starts mid-range)", () => {
  const rows = [{ name: "RentMay", kind: "fixed", amount: 20000, effective_from: "2026-05-01", effective_to: null }];
  // Jan–May: only May 1 is >= effective_from -> 1 month
  assert.equal(allocateExpenses(rows, "2026-01-01", "2026-05-15").total, 20000);
  // April only: not active yet
  assert.equal(allocateExpenses(rows, "2026-04-01", "2026-04-30").total, 0);
});

test("fixed honors effective_to (stopped after a month)", () => {
  const rows = [{ name: "Old", kind: "fixed", amount: 1000, effective_from: null, effective_to: "2026-04-01" }];
  assert.equal(allocateExpenses(rows, "2026-04-01", "2026-04-30").total, 1000); // April still active
  assert.equal(allocateExpenses(rows, "2026-05-01", "2026-05-15").total, 0);    // May not active
});

test("variable expense = several fixed segments, summed across the range", () => {
  const rows = [
    { name: "Ship", kind: "fixed", is_variable: true, amount: 40000, effective_from: "2026-04-01", effective_to: "2026-04-01" },
    { name: "Ship", kind: "fixed", is_variable: true, amount: 38000, effective_from: "2026-05-01", effective_to: null },
  ];
  assert.equal(allocateExpenses(rows, "2026-01-01", "2026-05-15").total, 78000);
  assert.equal(allocateExpenses(rows, "2026-04-01", "2026-04-30").total, 40000);
  assert.equal(allocateExpenses(rows, "2026-05-01", "2026-05-15").total, 38000);
});

test("per_order = amount × delivered, gated by window overlap", () => {
  const rows = [{ name: "Pack", kind: "per_order", amount: 100, effective_from: null, effective_to: null }];
  assert.equal(
    allocateExpenses(rows, "2026-05-01", "2026-05-15", { delivered: 204 }).total,
    20400
  );
  const windowed = [{ name: "Pack", kind: "per_order", amount: 100, effective_from: "2026-06-01", effective_to: null }];
  assert.equal(
    allocateExpenses(windowed, "2026-05-01", "2026-05-15", { delivered: 204 }).total,
    0
  );
});

test("percent applies to its chosen base, even with no 1st-of-month", () => {
  const rows = [
    { name: "PayFee", kind: "percent", pct_base: "ad_spend",  amount: 2.5, effective_from: null, effective_to: null },
    { name: "Gateway", kind: "percent", pct_base: "net_sales", amount: 1,   effective_from: null, effective_to: null },
  ];
  const r = allocateExpenses(rows, "2026-05-05", "2026-05-11", { adSpend: 21896.83, sales: 100000 });
  assert.equal(Math.round(r.total * 100) / 100, Math.round((0.025 * 21896.83 + 0.01 * 100000) * 100) / 100);
});

test("breakdown rows always sum to total; estimated flag for unconfirmed variable months", () => {
  const rows = [
    { name: "Rent", kind: "fixed", amount: 15000, effective_from: null, effective_to: null },
    { name: "Ship", kind: "fixed", is_variable: true, amount: 40000, effective_from: "2026-04-01", effective_to: null },
    { name: "Fee",  kind: "percent", pct_base: "ad_spend", amount: 2, effective_from: null, effective_to: null },
  ];
  const r = allocateExpenses(rows, "2026-01-01", "2026-05-15", { adSpend: 1000 });
  const sum = r.breakdown.reduce((s, b) => s + b.value, 0);
  assert.equal(sum, r.total);
  const ship = r.breakdown.find((b) => b.name === "Ship");
  // viewing months after the segment's start, open-ended, variable -> estimated
  assert.equal(ship.estimated, true);
});
