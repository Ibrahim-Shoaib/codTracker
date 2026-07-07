// Unit tests for the pure range helpers in app/lib/dates.server.js.
// (Timezone boundary functions are covered in tests/dates.server.test.mjs;
// this file pins the tz-independent range math.)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getPriorEqualLengthRange,
  formatDate,
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

test("formatDate (Karachi): UTC evening rolls into next local day", () => {
  // 2026-03-01T20:30 UTC = 2026-03-02T01:30 PKT
  assert.equal(formatDate(new Date("2026-03-01T20:30:00Z"), "Asia/Karachi"), "2026-03-02");
});

test("formatDate (Karachi): UTC morning stays same local day", () => {
  assert.equal(formatDate(new Date("2026-03-01T05:00:00Z"), "Asia/Karachi"), "2026-03-01");
});

test("getMonthlyChunks: spans full months and caps the last at today", () => {
  const chunks = getMonthlyChunks("2026-01-15");
  assert.equal(chunks[0].start, "2026-01-01");
  assert.equal(chunks[0].end, "2026-01-31");
  assert.equal(chunks[1].start, "2026-02-01");
  assert.equal(chunks[1].end, "2026-02-28");
  const last = chunks[chunks.length - 1];
  assert.ok(last.end <= formatDate(new Date(Date.now() + 24 * 3600 * 1000), "Asia/Karachi"));
});
