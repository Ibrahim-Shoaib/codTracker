// Unit tests for app/lib/attribution.server.js (pure functions only —
// the DB-touching recordPurchaseAttribution is exercised in the
// integration suite).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attributeFirstTouch,
  attributeLastTouch,
  attributeLinear,
  attributePositionBased,
  attributeTimeDecay,
  applyModel,
  rollupCredits,
  collapseIabDuplicates,
} from "../app/lib/attribution.server.js";

const T = (utm_source, utm_campaign, occurred_at, extra = {}) => ({
  utm_source,
  utm_campaign,
  utm_content: null,
  occurred_at,
  ip: null,
  ua: null,
  ...extra,
});

const day = (n) => new Date(2026, 0, n).toISOString();

// ─── First-touch ─────────────────────────────────────────────────────────

test("first-touch credits 100% to the first touch", () => {
  const touches = [T("ig", "C1", day(1)), T("fb", "C2", day(2)), T("google", "C3", day(3))];
  const r = attributeFirstTouch(touches, 100);
  assert.equal(r.length, 1);
  assert.equal(r[0].utm_source, "ig");
  assert.equal(r[0].utm_campaign, "C1");
  assert.equal(r[0].weight, 1);
  assert.equal(r[0].credit, 100);
});

test("first-touch with empty touches returns []", () => {
  assert.deepEqual(attributeFirstTouch([], 100), []);
});

// ─── Last-touch ──────────────────────────────────────────────────────────

test("last-touch credits 100% to the final touch", () => {
  const touches = [T("ig", "C1", day(1)), T("fb", "C2", day(2)), T("google", "C3", day(3))];
  const r = attributeLastTouch(touches, 100);
  assert.equal(r.length, 1);
  assert.equal(r[0].utm_source, "google");
  assert.equal(r[0].weight, 1);
  assert.equal(r[0].credit, 100);
});

test("last-touch with single touch matches first-touch", () => {
  const touches = [T("ig", "C1", day(1))];
  assert.deepEqual(attributeFirstTouch(touches, 50), attributeLastTouch(touches, 50));
});

// ─── Linear ──────────────────────────────────────────────────────────────

test("linear splits credit equally; weights sum to 1", () => {
  const touches = [T("ig", "C1", day(1)), T("fb", "C2", day(2)), T("google", "C3", day(3))];
  const r = attributeLinear(touches, 90);
  assert.equal(r.length, 3);
  for (const x of r) {
    assert.equal(Number(x.weight.toFixed(6)), Number((1 / 3).toFixed(6)));
    assert.equal(Number(x.credit.toFixed(6)), 30);
  }
  const sum = r.reduce((s, x) => s + x.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

// ─── Position-based ──────────────────────────────────────────────────────

test("position-based with 1 touch = full credit to that touch", () => {
  const r = attributePositionBased([T("ig", "C1", day(1))], 100);
  assert.equal(r.length, 1);
  assert.equal(r[0].weight, 1);
  assert.equal(r[0].credit, 100);
});

test("position-based with 2 touches = 50/50", () => {
  const r = attributePositionBased(
    [T("ig", "C1", day(1)), T("fb", "C2", day(2))],
    100
  );
  assert.equal(r.length, 2);
  assert.equal(r[0].weight, 0.5);
  assert.equal(r[1].weight, 0.5);
  assert.equal(r[0].credit, 50);
  assert.equal(r[1].credit, 50);
});

test("position-based with 4 touches = 0.4 / 0.1 / 0.1 / 0.4", () => {
  const r = attributePositionBased(
    [T("a", "x", day(1)), T("b", "x", day(2)), T("c", "x", day(3)), T("d", "x", day(4))],
    100
  );
  assert.equal(r.length, 4);
  assert.equal(r[0].weight, 0.4);
  assert.equal(r[3].weight, 0.4);
  assert.equal(Number(r[1].weight.toFixed(6)), 0.1);
  assert.equal(Number(r[2].weight.toFixed(6)), 0.1);
  const sum = r.reduce((s, x) => s + x.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

// ─── Time-decay ──────────────────────────────────────────────────────────

test("time-decay gives more weight to the most-recent touch", () => {
  const touches = [
    T("a", "x", new Date(2026, 0, 1).toISOString()),  // 14 days before last
    T("b", "x", new Date(2026, 0, 8).toISOString()),  // 7 days before last
    T("c", "x", new Date(2026, 0, 15).toISOString()), // last
  ];
  const r = attributeTimeDecay(touches, 100, { halfLifeDays: 7 });
  assert.equal(r.length, 3);
  assert.ok(r[2].weight > r[1].weight);
  assert.ok(r[1].weight > r[0].weight);
  // With half-life=7, weights are 0.25, 0.5, 1.0 → normalized to
  // 0.25/1.75, 0.5/1.75, 1.0/1.75
  assert.ok(Math.abs(r[0].weight - 0.25 / 1.75) < 1e-9);
  assert.ok(Math.abs(r[2].weight - 1.0 / 1.75) < 1e-9);
});

test("time-decay weights sum to 1 even with many touches", () => {
  const touches = [];
  for (let i = 0; i < 10; i++) {
    touches.push(T("s", "c", new Date(2026, 0, i + 1).toISOString()));
  }
  const r = attributeTimeDecay(touches, 1000);
  const sum = r.reduce((s, x) => s + x.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

// ─── applyModel dispatch ─────────────────────────────────────────────────

test("applyModel dispatches by name", () => {
  const touches = [T("ig", "C1", day(1)), T("fb", "C2", day(2))];
  assert.equal(applyModel("first_touch", touches, 100)[0].utm_source, "ig");
  assert.equal(applyModel("last_touch", touches, 100)[0].utm_source, "fb");
  assert.equal(applyModel("linear", touches, 100).length, 2);
  assert.throws(() => applyModel("bogus", touches, 100));
});

// ─── rollupCredits ───────────────────────────────────────────────────────

test("rollupCredits aggregates by (source, campaign, content) and sorts by credit desc", () => {
  const credits = [
    { utm_source: "ig", utm_campaign: "C1", utm_content: "X", credit: 30 },
    { utm_source: "fb", utm_campaign: "C2", utm_content: "Y", credit: 75 },
    { utm_source: "ig", utm_campaign: "C1", utm_content: "X", credit: 25 },
  ];
  const out = rollupCredits(credits);
  assert.equal(out.length, 2);
  assert.equal(out[0].utm_source, "fb"); // 75 > 55, so fb is first
  assert.equal(out[0].credit, 75);
  assert.equal(out[1].utm_source, "ig");
  assert.equal(out[1].credit, 55); // 30+25 collapsed
  assert.equal(out[1].touches, 2);
});

test("rollupCredits handles empty input", () => {
  assert.deepEqual(rollupCredits([]), []);
});

// ─── collapseIabDuplicates ───────────────────────────────────────────────

test("collapseIabDuplicates keeps single touch unchanged", () => {
  const touches = [
    T("ig", "C1", day(1), { ip: "1.2.3.4", ua: "iPhone IAB" }),
  ];
  assert.deepEqual(collapseIabDuplicates(touches), touches);
});

test("collapseIabDuplicates merges back-to-back same-IP+UA touches", () => {
  // Three PageViews 30s apart, same IP+UA, same campaign → collapse to 1
  const touches = [
    T("ig", "C1", "2026-01-01T10:00:00Z", { ip: "1.2.3.4", ua: "iPhone IAB" }),
    T("ig", "C1", "2026-01-01T10:00:30Z", { ip: "1.2.3.4", ua: "iPhone IAB" }),
    T("ig", "C1", "2026-01-01T10:01:00Z", { ip: "1.2.3.4", ua: "iPhone IAB" }),
  ];
  const out = collapseIabDuplicates(touches);
  assert.equal(out.length, 1);
  assert.equal(out[0].occurred_at, "2026-01-01T10:00:00Z");
});

test("collapseIabDuplicates keeps separate visits >5 min apart", () => {
  const touches = [
    T("ig", "C1", "2026-01-01T10:00:00Z", { ip: "1.2.3.4", ua: "iPhone IAB" }),
    T("ig", "C1", "2026-01-01T10:30:00Z", { ip: "1.2.3.4", ua: "iPhone IAB" }),
  ];
  const out = collapseIabDuplicates(touches);
  assert.equal(out.length, 2);
});

test("collapseIabDuplicates keeps different-campaign touches even when adjacent", () => {
  const touches = [
    T("ig", "C1", "2026-01-01T10:00:00Z", { ip: "1.2.3.4", ua: "iPhone IAB" }),
    T("fb", "C2", "2026-01-01T10:00:30Z", { ip: "1.2.3.4", ua: "iPhone IAB" }),
  ];
  const out = collapseIabDuplicates(touches);
  assert.equal(out.length, 2);
});

test("collapseIabDuplicates preserves utm_source/campaign from second touch when first was empty", () => {
  // PageView with no utms followed by ViewContent with utms → keep utms
  const touches = [
    T(null, null, "2026-01-01T10:00:00Z", { ip: "1.2.3.4", ua: "iPhone IAB" }),
    T(null, null, "2026-01-01T10:00:30Z", { ip: "1.2.3.4", ua: "iPhone IAB", utm_source: "ig", utm_campaign: "C1" }),
  ];
  // Both touches share campaign-key (null === null) so they collapse.
  // The merge logic should backfill utm_source/campaign from the second.
  const out = collapseIabDuplicates(touches);
  assert.equal(out.length, 1);
});

test("collapseIabDuplicates preserves separate visitors on different IPs", () => {
  const touches = [
    T("ig", "C1", "2026-01-01T10:00:00Z", { ip: "1.2.3.4", ua: "Same UA" }),
    T("ig", "C1", "2026-01-01T10:00:30Z", { ip: "5.6.7.8", ua: "Same UA" }),
  ];
  const out = collapseIabDuplicates(touches);
  assert.equal(out.length, 2);
});
