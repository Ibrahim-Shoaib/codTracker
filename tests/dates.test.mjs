// Unit tests for the pure functions in app/lib/dates.server.js. Every
// dashboard period boundary flows through these — cheap to pin down.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getPriorEqualLengthRange,
  formatPKTDate,
  getMonthlyChunks,
} from "../app/lib/dates.server.js";

test("getPriorEqualLengthRange: single day → previous day", () => {
  assert.deepEqual(getPriorEqualLengthRange("2026-07-07", "2026-07-07"), {
    from: "2026-07-06",
    to: "2026-07-06",
  });
});

test("getPriorEqualLengthRange: 30-day window → immediately preceding 30 days", () => {
  assert.deepEqual(getPriorEqualLengthRange("2026-06-08", "2026-07-07"), {
    from: "2026-05-09",
    to: "2026-06-07",
  });
});

test("getPriorEqualLengthRange: crosses month and year boundaries", () => {
  assert.deepEqual(getPriorEqualLengthRange("2026-01-01", "2026-01-31"), {
    from: "2025-12-01",
    to: "2025-12-31",
  });
});

test("formatPKTDate: UTC evening rolls into next PKT day", () => {
  // 2026-03-01T20:30 UTC = 2026-03-02T01:30 PKT
  assert.equal(formatPKTDate(new Date("2026-03-01T20:30:00Z")), "2026-03-02");
});

test("formatPKTDate: UTC morning stays same PKT day", () => {
  assert.equal(formatPKTDate(new Date("2026-03-01T05:00:00Z")), "2026-03-01");
});

test("getMonthlyChunks: spans full months and caps the last at today", () => {
  const chunks = getMonthlyChunks("2026-01-15");
  assert.equal(chunks[0].start, "2026-01-01");
  assert.equal(chunks[0].end, "2026-01-31");
  // February 2026 is not a leap year… 2026 % 4 = 2 → 28 days.
  assert.equal(chunks[1].start, "2026-02-01");
  assert.equal(chunks[1].end, "2026-02-28");
  const last = chunks[chunks.length - 1];
  // Last chunk never extends past today (PKT).
  assert.ok(last.end <= formatPKTDate(new Date(Date.now() + 5 * 3600 * 1000)));
});
