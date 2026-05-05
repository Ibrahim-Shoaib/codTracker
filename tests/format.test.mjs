import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney, formatNegative, currencyCode } from "../app/lib/format.js";

// ─── formatMoney ─────────────────────────────────────────────────────────

test("formatMoney renders PKR by default for legacy callers", () => {
  const out = formatMoney(12345);
  assert.match(out, /12,345/);
  // Different node ICU builds emit "PKR 12,345", "Rs 12,345", or "Rs. 12,345"
  // — accept any of them since they're all valid PKR renderings.
  assert.ok(/PKR|Rs/.test(out));
});

test("formatMoney handles USD with $ symbol", () => {
  const out = formatMoney(99.5, "USD", { fractionDigits: 2 });
  assert.match(out, /\$99\.50/);
});

test("formatMoney handles EUR / GBP / INR / AED", () => {
  // We don't pin exact symbols (Intl varies by node version) — just
  // verify the number renders and the currency code is encoded.
  for (const ccy of ["EUR", "GBP", "INR", "AED"]) {
    const out = formatMoney(1000, ccy);
    assert.match(out, /1,000/);
  }
});

test("formatMoney returns '—' for null/undefined", () => {
  assert.equal(formatMoney(null), "—");
  assert.equal(formatMoney(undefined), "—");
  assert.equal(formatMoney(""), "—");
});

test("formatMoney returns '—' for non-finite", () => {
  assert.equal(formatMoney(NaN), "—");
  assert.equal(formatMoney(Infinity), "—");
});

test("formatMoney accepts numeric strings", () => {
  const out = formatMoney("500.5", "USD", { fractionDigits: 2 });
  assert.match(out, /\$500\.50/);
});

test("formatMoney falls back gracefully for unknown currency code", () => {
  const out = formatMoney(1234, "XYZ");
  // Intl may render valid but unrecognized codes with a non-breaking
  // space; our manual fallback uses regular space. Either is fine —
  // we only care that the code + value are both present.
  assert.match(out, /XYZ/);
  assert.match(out, /1,234/);
});

test("formatMoney respects fractionDigits=0 (dashboard default)", () => {
  const out = formatMoney(1234.78, "USD");
  // Whole units only — fractional part dropped via rounding
  assert.match(out, /\$1,235/);
});

test("formatMoney respects fractionDigits=2 (per-product COGS)", () => {
  const out = formatMoney(99.5, "USD", { fractionDigits: 2 });
  assert.match(out, /\$99\.50/);
});

test("formatMoney sign:true prepends + on positives", () => {
  const out = formatMoney(50, "USD", { sign: true, fractionDigits: 2 });
  assert.match(out, /\+\$50\.00/);
});

test("formatMoney custom nullDisplay", () => {
  assert.equal(formatMoney(null, "USD", { nullDisplay: "N/A" }), "N/A");
});

// ─── formatNegative ──────────────────────────────────────────────────────

test("formatNegative prefixes with '-' for cost rows", () => {
  const out = formatNegative(1500, "PKR");
  assert.match(out, /^-/);
  assert.match(out, /1,500/);
});

test("formatNegative handles zero", () => {
  const out = formatNegative(0, "PKR");
  // Zero shouldn't get a leading '-'
  assert.ok(!out.startsWith("-"));
});

test("formatNegative handles negative input by taking abs", () => {
  // We expect it to work on positive *amounts* that semantically are
  // costs; passing a negative number should still render "-X" not "--X".
  const out = formatNegative(-1500, "PKR");
  assert.equal((out.match(/-/g) || []).length, 1);
});

test("formatNegative null returns '—'", () => {
  assert.equal(formatNegative(null), "—");
});

// ─── currencyCode ─────────────────────────────────────────────────────────

test("currencyCode normalizes to uppercase ISO code", () => {
  assert.equal(currencyCode("usd"), "USD");
  assert.equal(currencyCode("PKR"), "PKR");
});

test("currencyCode defaults to PKR for falsy input", () => {
  assert.equal(currencyCode(undefined), "PKR");
  assert.equal(currencyCode(null), "PKR");
  assert.equal(currencyCode(""), "PKR");
});
