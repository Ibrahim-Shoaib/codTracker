// Unit tests for pickBestFbc — the only pure function in visitors.server.js.
// The DB-touching exports (upsertVisitor, findVisitorByFbclid, etc.) are
// covered by the smoke-script in scripts/_test_cross_session_visitors.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBestFbc } from "../app/lib/visitors.server.js";

const REAL_FBC = "fb.1.1700000000000.PAZXh0bgNhZW0BMABhZGlkAas2JXIBL1JzcnRjBmFwcF9pZA8xMjQwMjQ1NzQyODc0MTQAAad_ysQy4dlQKb8";
const SYNTH_FBC = "fb.1.1700000000000.PAZXh0bgNhZW0BMABhZGlkAas2JW1MWdJzcnRjBmFwcF9pZA"; // truncated fbclid
const VISITOR_FBC = "fb.1.1699000000000.IwYW9leARzUL1leHRuA2FlbQEwAGFkaWQBqzclj8WcUnNydGMGYXBwX2lk";

test("pickBestFbc tier 1: cart_attribute wins when source=cart_attribute", () => {
  const r = pickBestFbc({
    cartAttrFbc: REAL_FBC,
    cartAttrFbcSource: "cart_attribute",
    visitor: { latest_fbc: VISITOR_FBC },
  });
  assert.equal(r.fbc, REAL_FBC);
  assert.equal(r.source, "cart_attribute");
});

test("pickBestFbc tier 2: visitor.latest_fbc wins over synthesized cart fbc", () => {
  // This is the Diagnostic-1 fix — synthesized fbc has truncated fbclid,
  // visitor row has the full one from a prior browser cookie read.
  const r = pickBestFbc({
    cartAttrFbc: SYNTH_FBC,
    cartAttrFbcSource: "synthesized_from_landing_site",
    visitor: { latest_fbc: VISITOR_FBC },
  });
  assert.equal(r.fbc, VISITOR_FBC);
  assert.equal(r.source, "visitor_latest");
});

test("pickBestFbc tier 3: visitor.fbc_history when latest_fbc is missing", () => {
  const r = pickBestFbc({
    cartAttrFbc: null,
    cartAttrFbcSource: null,
    visitor: {
      latest_fbc: null,
      fbc_history: [{ value: "old.fbc.1" }, { value: VISITOR_FBC }],
    },
  });
  assert.equal(r.fbc, VISITOR_FBC); // latest entry wins
  assert.equal(r.source, "visitor_history");
});

test("pickBestFbc NEVER returns a synthesized fbc, even as last resort", () => {
  // Meta CAPI invariant: a `synthesized_from_landing_site` fbc carries a
  // Shopify-truncated fbclid. Meta's "modified fbclid value in fbc
  // parameter" diagnostic fires on that, and Meta scores an omitted fbc
  // better than a modified one. So with no genuine cookie fbc anywhere,
  // we must omit fbc (null) — NOT fall back to the truncated synth value.
  const r = pickBestFbc({
    cartAttrFbc: SYNTH_FBC,
    cartAttrFbcSource: "synthesized_from_landing_site",
    visitor: null,
  });
  assert.equal(r.fbc, null);
  assert.equal(r.source, null);
});

test("pickBestFbc never emits synth even when visitor exists without fbc", () => {
  // Visitor row found but it has no fbc of its own; the only fbc on hand
  // is the synthesized/truncated one. Still must omit, not send modified.
  const r = pickBestFbc({
    cartAttrFbc: SYNTH_FBC,
    cartAttrFbcSource: "synthesized_from_landing_site",
    visitor: { latest_fbc: null, fbc_history: [] },
  });
  assert.equal(r.fbc, null);
  assert.equal(r.source, null);
});

test("pickBestFbc still prefers a genuine visitor fbc over a synth cart fbc", () => {
  // Regression guard for the original Diagnostic-1 fix: synth present but a
  // real prior cookie value exists on the visitor row — send the real one.
  const r = pickBestFbc({
    cartAttrFbc: SYNTH_FBC,
    cartAttrFbcSource: "synthesized_from_landing_site",
    visitor: { latest_fbc: VISITOR_FBC },
  });
  assert.equal(r.fbc, VISITOR_FBC);
  assert.equal(r.source, "visitor_latest");
});

test("pickBestFbc returns null/null when nothing available", () => {
  const r = pickBestFbc({ cartAttrFbc: null, visitor: null });
  assert.equal(r.fbc, null);
  assert.equal(r.source, null);
});

test("pickBestFbc backward compat: omitted source treats cartAttrFbc as cart_attribute", () => {
  // Old call sites (scripts, _test_cross_session_visitors.mjs) don't pass
  // cartAttrFbcSource — they should still work as before.
  const r = pickBestFbc({
    cartAttrFbc: REAL_FBC,
    visitor: { latest_fbc: VISITOR_FBC },
  });
  assert.equal(r.fbc, REAL_FBC);
  assert.equal(r.source, "cart_attribute");
});

test("pickBestFbc skips empty fbc_history entries", () => {
  const r = pickBestFbc({
    cartAttrFbc: null,
    visitor: { latest_fbc: null, fbc_history: [{ value: "" }] },
  });
  // Empty value entry shouldn't be returned, fall through to null
  assert.equal(r.fbc, null);
});
