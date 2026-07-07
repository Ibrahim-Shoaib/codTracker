// Unit tests for app/lib/dates.server.js — per-store timezone day boundaries.
//
// Two guarantees:
//   1. Asia/Karachi output is byte-identical to the old fixed +5h PKT logic
//      (regression guard — Pakistan stores must not shift).
//   2. Europe/London boundaries land on London-local midnight in BOTH GMT and
//      BST (DST-correct), which the old fixed-offset code could never do.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getToday, getYesterday, getMTD, getLastMonth, formatDate, dayStartUTC,
} from "../app/lib/dates.server.js";

// ── Reference implementation of the OLD +5h PKT logic ────────────────────────
const PKT = 5 * 3600 * 1000;
const nowPKT = () => new Date(Date.now() + PKT);
const oldSod = (p) =>
  new Date(Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), p.getUTCDate(), 0, 0, 0, 0) - PKT);
const oldEod = (p) =>
  new Date(Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), p.getUTCDate(), 23, 59, 59, 999) - PKT);

test("getToday(Asia/Karachi) matches the legacy +5h PKT boundaries exactly", () => {
  const now = nowPKT();
  const t = getToday("Asia/Karachi");
  assert.equal(t.start.getTime(), oldSod(now).getTime());
  assert.equal(t.end.getTime(), oldEod(now).getTime());
});

test("getYesterday(Asia/Karachi) matches the legacy +5h PKT boundaries exactly", () => {
  const y = new Date(nowPKT().getTime() - 24 * 3600 * 1000);
  const t = getYesterday("Asia/Karachi");
  assert.equal(t.start.getTime(), oldSod(y).getTime());
  assert.equal(t.end.getTime(), oldEod(y).getTime());
});

// ── Helper: the wall-clock time a UTC instant reads as, in a given zone ──────
function wallClock(dateUTC, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(dateUTC).map((x) => [x.type, x.value])
  );
  return `${p.hour}:${p.minute}`;
}
function localDateStr(dateUTC, tz) {
  return formatDate(dateUTC, tz);
}

test("getToday(Europe/London) start is London-local midnight (GMT + BST)", () => {
  // We can't fake "now", but whatever today is, the start must read 00:00 in
  // London and the end must read 23:59 — true in either GMT or BST.
  const t = getToday("Europe/London");
  assert.equal(wallClock(t.start, "Europe/London"), "00:00");
  assert.equal(wallClock(t.end, "Europe/London"), "23:59");
  // start and end are the same London calendar day
  assert.equal(localDateStr(t.start, "Europe/London"), localDateStr(t.end, "Europe/London"));
});

test("dayStartUTC is DST-correct for London: GMT day = UTC midnight, BST day = 23:00Z prev", () => {
  // 2026-01-15 is GMT (offset 0): local midnight == 00:00Z same day.
  assert.equal(dayStartUTC("2026-01-15", "Europe/London").toISOString(), "2026-01-15T00:00:00.000Z");
  // 2026-07-15 is BST (offset +1): local midnight == 23:00Z the previous day.
  assert.equal(dayStartUTC("2026-07-15", "Europe/London").toISOString(), "2026-07-14T23:00:00.000Z");
  // Karachi (no DST): always 19:00Z the previous day.
  assert.equal(dayStartUTC("2026-07-15", "Asia/Karachi").toISOString(), "2026-07-14T19:00:00.000Z");
});

test("getMTD / getLastMonth (London) start on the 1st at London midnight", () => {
  const mtd = getMTD("Europe/London");
  assert.equal(wallClock(mtd.start, "Europe/London"), "00:00");
  assert.equal(localDateStr(mtd.start, "Europe/London").slice(8), "01");
  const lm = getLastMonth("Europe/London");
  assert.equal(localDateStr(lm.start, "Europe/London").slice(8), "01");
  assert.equal(wallClock(lm.start, "Europe/London"), "00:00");
  assert.equal(wallClock(lm.end, "Europe/London"), "23:59");
});

test("formatDate round-trips a local-midnight instant back to its own date", () => {
  const d = dayStartUTC("2026-03-29", "Europe/London"); // BST spring-forward day
  assert.equal(formatDate(d, "Europe/London"), "2026-03-29");
});
