// Unit tests for app/lib/cogs.server.js — the COGS matcher.
//
// The scenarios mirror real failure modes observed in production data
// (the-trendy-homes-pk June 2026 audit):
//   - variants missing from product_costs (new/re-created products)
//   - draft-order line items with no variant_id at all (typed names, typos)
//   - bundle products with hundreds of identical-cost variant rows skewing
//     the old per-row store median
//   - orders where ONE unknown variant used to drag the whole order onto the
//     text matcher, discarding the known variants' exact costs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOrderDetail,
  buildCostIndex,
  buildCostsByVariantId,
  computeCOGS,
  computeCOGSFromOrder,
  deriveCostRatio,
} from "../app/lib/cogs.server.js";

// ── Fixture catalog ──────────────────────────────────────────────────────────
// Modeled on the trendy-homes shape: a big bundle family (many rows, high
// cost) plus cheaper single-variant products that actually dominate sales.
function bundleRows(n, cost = 5580) {
  return Array.from({ length: n }, (_, i) => ({
    shopify_variant_id: `9000${i}`,
    shopify_product_id: "800",
    sku: "",
    product_title: "Bedspread Bundle (b)",
    variant_title: `Color${i} / Color${(i + 1) % n} / Offwhite`,
    unit_cost: cost,
  }));
}

const CATALOG = [
  { shopify_variant_id: "101", shopify_product_id: "1", sku: "BS-001", product_title: "NAVY QUILTED BEDSPREAD SET(flower)", variant_title: "King", unit_cost: 1860 },
  { shopify_variant_id: "102", shopify_product_id: "2", sku: "",       product_title: "OFF-WHITE QUILTED BEDSPREAD SET(lines)", variant_title: "King", unit_cost: 1860 },
  { shopify_variant_id: "103", shopify_product_id: "3", sku: "",       product_title: "TEAL QUILTED BEDSPREAD SET(flower)", variant_title: "King", unit_cost: 1860 },
  { shopify_variant_id: "104", shopify_product_id: "4", sku: "",       product_title: "STRIPED NAVY BED SHEET SET", variant_title: "King", unit_cost: 1200 },
  { shopify_variant_id: "105", shopify_product_id: "5", sku: "",       product_title: "EMBROIDERED TOWEL SET", variant_title: "Default Title", unit_cost: 850 },
  { shopify_variant_id: "106", shopify_product_id: "6", sku: "",       product_title: "Mattress Topper", variant_title: "Default Title", unit_cost: 3200 },
  { shopify_variant_id: "107", shopify_product_id: "7", sku: "",       product_title: "Black Pajama Set", variant_title: "Small to Medium", unit_cost: 1500 },
  { shopify_variant_id: "108", shopify_product_id: "7", sku: "",       product_title: "Black Pajama Set", variant_title: "Large to extra large", unit_cost: 1500 },
  ...bundleRows(40),
];

const INDEX = buildCostIndex(CATALOG);
const BY_VID = buildCostsByVariantId(CATALOG);

// ── parseOrderDetail ─────────────────────────────────────────────────────────

test("parseOrderDetail handles bracketed, quantified and bare forms", () => {
  assert.deepEqual(parseOrderDetail("[ 2 x Product A ][ Product B ]"), [
    { quantity: 2, name: "Product A" },
    { quantity: 1, name: "Product B" },
  ]);
  assert.deepEqual(parseOrderDetail("Bare Product"), [{ quantity: 1, name: "Bare Product" }]);
  assert.deepEqual(parseOrderDetail("  "), []);
});

// ── strong tiers (regression: unchanged behavior) ────────────────────────────

test("tier 1: unique SKU match", () => {
  const { cogsTotal, source } = computeCOGS("[ 1 x Anything - BS-001 ]", INDEX);
  assert.equal(cogsTotal, 1860);
  assert.equal(source, "sku");
});

test("tier 2: exact title + variant match", () => {
  const { cogsTotal, source } = computeCOGS("[ 1 x Mattress Topper ]", INDEX);
  assert.equal(cogsTotal, 3200);
  assert.equal(source, "exact");
});

test("variant path: all variants known → exact sum, source variant_id", () => {
  const order = {
    order_detail: "[ irrelevant ]",
    line_items: [
      { variant_id: "101", quantity: 2 },
      { variant_id: "104", quantity: 1 },
    ],
  };
  const r = computeCOGSFromOrder(order, BY_VID, INDEX);
  assert.equal(r.cogsTotal, 2 * 1860 + 1200);
  assert.equal(r.source, "variant_id");
  assert.equal(r.allMatched, true);
});

// ── token family (new tier 4b) ───────────────────────────────────────────────

test("token family: shorthand name resolves to the right family median", () => {
  // "NAVY QUILTED BEDSPREAD SET" has no exact/fuzzy match (real rows carry
  // "(flower)"/"(lines)" suffixes) — token containment finds them.
  const { cogsTotal, source } = computeCOGS("[ 1 x NAVY QUILTED BEDSPREAD SET ]", INDEX);
  assert.equal(cogsTotal, 1860);
  assert.equal(source, "sibling_avg");
});

test("1-char typo still lands (TOWET → TOWEL) — fuzzy or token family", () => {
  const { cogsTotal, source } = computeCOGS("[ 1 x EMBROIDERED TOWET SET ]", INDEX);
  assert.equal(cogsTotal, 850);
  assert.ok(["fuzzy", "sibling_avg"].includes(source), `source was ${source}`);
});

test("token family: typo tolerance when fuzzy is family-blocked", () => {
  // Fuzzy skips candidates whose base title has >1 sibling. Add a sibling to
  // the towel family so tier 3 is blocked and the token tier must catch it.
  const idx = buildCostIndex([
    ...CATALOG,
    { shopify_variant_id: "109", shopify_product_id: "5", sku: "", product_title: "EMBROIDERED TOWEL SET", variant_title: "Large", unit_cost: 850 },
  ]);
  const { cogsTotal, source } = computeCOGS("[ 1 x EMBROIDERED TOWET SET ]", idx);
  assert.equal(cogsTotal, 850);
  assert.equal(source, "sibling_avg");
});

test("token family: paren size suffix tolerated (pajama S-M)", () => {
  const { cogsTotal, source } = computeCOGS("[ 1 x Black pajama set (S-M) ]", INDEX);
  assert.equal(cogsTotal, 1500);
  assert.equal(source, "sibling_avg");
});

test("token family: split words merge (BED SPREAD → BEDSPREAD)", () => {
  const { cogsTotal, source } = computeCOGS("[ 1 x OFF-WHITE QUILTED BED SPREAD SET (lines) ]", INDEX);
  assert.equal(cogsTotal, 1860);
  assert.equal(source, "sibling_avg");
});

test("token family: trailing SKU tail doesn't dilute the score", () => {
  const { cogsTotal, source } = computeCOGS("[ 1 x OFF-WHITE QUILTED BEDSPREAD SET - King - XY-999 ]", INDEX);
  assert.equal(cogsTotal, 1860);
  assert.equal(source, "sibling_avg");
});

test("token family: refuses single-token and low-overlap queries", () => {
  // Single meaningful token → not enough signal; falls to tier 5 median.
  const single = computeCOGS("[ 1 x Bedspread ]", INDEX);
  assert.equal(single.source, "fallback_avg");
  // Alien name shares <80% tokens with anything → tier 5.
  const alien = computeCOGS("[ 1 x Ceramic Dinner Plate Set ]", INDEX);
  assert.equal(alien.source, "fallback_avg");
});

// ── tier 5b: product median beats per-row median ─────────────────────────────

test("fallback uses per-product median, immune to bundle row-count skew", () => {
  // Old behavior: per-row median over (40×5580 + 8 cheap rows) = 5580.
  // Product median: products cost {1860,1860,1860,1200,850,3200,1500,5580}
  // → median 1680. The catalog's typical PRODUCT, not typical ROW.
  assert.ok(INDEX.storeMedianCost === 5580, `row median is ${INDEX.storeMedianCost}`);
  assert.ok(
    INDEX.productMedianCost < 2000,
    `product median should be ~1680, got ${INDEX.productMedianCost}`,
  );
  const { cogsTotal, source } = computeCOGS("[ 1 x Ceramic Dinner Plate Set ]", INDEX);
  assert.equal(source, "fallback_avg");
  assert.equal(cogsTotal, INDEX.productMedianCost);
});

// ── tier 5a: price anchor ────────────────────────────────────────────────────

test("price anchor: unmatched item estimated from its own price × ratio", () => {
  const order = {
    order_detail: "",
    line_items: [{ variant_id: null, product_id: null, quantity: 1, name: "Ceramic Dinner Plate Set", price: 3799 }],
  };
  const r = computeCOGSFromOrder(order, BY_VID, INDEX, { costRatio: 0.5, perUnitPrice: null });
  assert.equal(r.source, "fallback_avg");
  assert.equal(r.cogsTotal, 3799 * 0.5);
});

test("price anchor: per-unit order anchor used when item price missing", () => {
  const r = computeCOGS("[ 2 x Ceramic Dinner Plate Set ]", INDEX, {
    costRatio: 0.5,
    perUnitPrice: 3000,
  });
  assert.equal(r.source, "fallback_avg");
  assert.equal(r.cogsTotal, 2 * 3000 * 0.5);
});

test("price anchor: estimates clamped to the catalog's cost range", () => {
  // 100,000 × 0.5 would be 50,000 — way past any real cost. Clamp to 1.5×max.
  const high = computeCOGS("[ 1 x Ceramic Dinner Plate Set ]", INDEX, {
    costRatio: 0.5, perUnitPrice: 100000,
  });
  assert.equal(high.cogsTotal, INDEX.maxUnitCost * 1.5);
  // 100 × 0.5 = 50 — below half the cheapest cost. Clamp to 0.5×min.
  const low = computeCOGS("[ 1 x Ceramic Dinner Plate Set ]", INDEX, {
    costRatio: 0.5, perUnitPrice: 100,
  });
  assert.equal(low.cogsTotal, INDEX.minUnitCost * 0.5);
});

test("no anchor → product median, never zero when costs exist", () => {
  const r = computeCOGS("[ 1 x Ceramic Dinner Plate Set ]", INDEX, null);
  assert.equal(r.source, "fallback_avg");
  assert.ok(r.cogsTotal > 0);
});

// ── deriveCostRatio ──────────────────────────────────────────────────────────

test("deriveCostRatio: median of clean samples, clamped, min-sample gated", () => {
  assert.equal(deriveCostRatio([0.5, 0.6, 0.55, 0.52, 0.58]), 0.55);
  // outliers (negative, zero, >1.5 — refunds, data glitches) are discarded
  assert.equal(deriveCostRatio([0.5, 0.6, 0.55, 0.52, 0.58, -4, 0, 9]), 0.55);
  // fewer than 5 clean samples → null (anchor unavailable)
  assert.equal(deriveCostRatio([0.5, 0.6]), null);
  assert.equal(deriveCostRatio(null), null);
  // extreme-but-valid medians clamp into [0.1, 0.9]
  assert.equal(deriveCostRatio([1.4, 1.4, 1.4, 1.4, 1.4]), 0.9);
  assert.equal(deriveCostRatio([0.06, 0.06, 0.06, 0.06, 0.06]), 0.1);
});

// ── per-item hybrid (the all-or-nothing fix) ─────────────────────────────────

test("hybrid: one unknown variant no longer drags known items to text tiers", () => {
  const order = {
    order_detail: "[ 1 x NAVY QUILTED BEDSPREAD SET(flower) - King ][ 1 x Mystery Item ]",
    line_items: [
      { variant_id: "101", quantity: 1 },                                     // known: 1860
      { variant_id: null, product_id: null, quantity: 1, name: "Mystery Item", price: 2000 }, // unknown
    ],
  };
  const r = computeCOGSFromOrder(order, BY_VID, INDEX, { costRatio: 0.5, perUnitPrice: null });
  // known item exact (1860) + unknown estimated (2000 × 0.5, but floored at 0.5×min=425 — 1000 is inside range)
  assert.equal(r.cogsTotal, 1860 + 1000);
  assert.equal(r.source, "fallback_avg"); // weakest tier across items
  assert.equal(r.allMatched, true);
});

test("product join: deleted/re-created variant repaired via product_id", () => {
  const order = {
    order_detail: "",
    line_items: [
      // variant_id 999 has no cost row, but product 1 does → its cost.
      { variant_id: "999", product_id: "1", quantity: 1, name: "NAVY QUILTED BEDSPREAD SET(flower)", price: null },
    ],
  };
  const r = computeCOGSFromOrder(order, BY_VID, INDEX);
  assert.equal(r.cogsTotal, 1860);
  assert.equal(r.source, "exact");
});

test("product join: multi-variant product pins by variant title in the name", () => {
  const order = {
    order_detail: "",
    line_items: [
      { variant_id: "999", product_id: "7", quantity: 1, name: "Black Pajama Set - Small to Medium", price: null },
    ],
  };
  const r = computeCOGSFromOrder(order, BY_VID, INDEX);
  assert.equal(r.cogsTotal, 1500);
  assert.equal(r.source, "exact");
});

test("legacy skinny line_items ('null' variant, no name) fall back to order_detail text", () => {
  const order = {
    order_detail: "[ 1 x NAVY QUILTED BEDSPREAD SET ]",
    line_items: [{ variant_id: "null", quantity: 1 }], // String(null) legacy shape
  };
  const r = computeCOGSFromOrder(order, BY_VID, INDEX);
  assert.equal(r.cogsTotal, 1860);       // token family via text
  assert.equal(r.source, "sibling_avg");
});

test("no line_items at all → text matcher on order_detail", () => {
  const r = computeCOGSFromOrder(
    { order_detail: "[ 1 x STRIPED NAVY BED SHEET SET - King ]", line_items: null },
    BY_VID,
    INDEX,
  );
  assert.equal(r.cogsTotal, 1200);
});

// ── safety gates ─────────────────────────────────────────────────────────────

test("stores with <3 cost rows never get estimates (source none, cost 0)", () => {
  const tinyIndex = buildCostIndex([CATALOG[0]]);
  const r = computeCOGS("[ 1 x Unknown Product ]", tinyIndex);
  assert.equal(r.source, "none");
  assert.equal(r.cogsTotal, 0);
  assert.equal(r.allMatched, false);
});

test("empty catalog → none, and empty order_detail stays matched-true", () => {
  const emptyIndex = buildCostIndex([]);
  assert.equal(computeCOGS("[ 1 x Whatever ]", emptyIndex).source, "none");
  assert.deepEqual(computeCOGS("", INDEX), { cogsTotal: 0, allMatched: true, source: "exact" });
});

// ── cross-store generality ───────────────────────────────────────────────────
// The matcher must carry no assumptions from any one merchant: different
// product domains, price scales, currencies, catalog sizes.

test("generality: SKU-driven electronics store (USD price scale)", () => {
  const idx = buildCostIndex([
    { shopify_variant_id: "1", shopify_product_id: "p1", sku: "IPH-15-BLK", product_title: "iPhone 15 Case", variant_title: "Black", unit_cost: 3.2 },
    { shopify_variant_id: "2", shopify_product_id: "p1", sku: "IPH-15-RED", product_title: "iPhone 15 Case", variant_title: "Red", unit_cost: 3.2 },
    { shopify_variant_id: "3", shopify_product_id: "p2", sku: "CBL-USBC-2M", product_title: "USB-C Cable 2m", variant_title: "Default Title", unit_cost: 1.1 },
    { shopify_variant_id: "4", shopify_product_id: "p3", sku: "CHG-65W", product_title: "GaN Charger 65W", variant_title: "Default Title", unit_cost: 8.4 },
  ]);
  // SKU tier
  assert.equal(computeCOGS("[ 1 x Case thing - IPH-15-RED ]", idx).cogsTotal, 3.2);
  // typed shorthand → token family
  const r = computeCOGS("[ 2 x iphone 15 case ]", idx);
  assert.equal(r.cogsTotal, 2 * 3.2);
  // price anchor scales to cents-level costs, clamped inside catalog range
  const est = computeCOGS("[ 1 x Mystery Gadget ]", idx, { costRatio: 0.3, perUnitPrice: 12 });
  assert.equal(est.cogsTotal, 12 * 0.3);
});

test("generality: fashion store with size variants and re-created variant", () => {
  const idx = buildCostIndex([
    { shopify_variant_id: "10", shopify_product_id: "d1", sku: "", product_title: "Linen Summer Dress", variant_title: "S", unit_cost: 900 },
    { shopify_variant_id: "11", shopify_product_id: "d1", sku: "", product_title: "Linen Summer Dress", variant_title: "M", unit_cost: 900 },
    { shopify_variant_id: "12", shopify_product_id: "d1", sku: "", product_title: "Linen Summer Dress", variant_title: "L", unit_cost: 950 },
  ]);
  const byVid = buildCostsByVariantId([
    { shopify_variant_id: "10", unit_cost: 900 },
    { shopify_variant_id: "11", unit_cost: 900 },
    { shopify_variant_id: "12", unit_cost: 950 },
  ]);
  // deleted + re-created variant (id 99 unknown) repaired through product_id,
  // pinned to the right size via the item name
  const r = computeCOGSFromOrder({
    order_detail: "",
    line_items: [{ variant_id: "99", product_id: "d1", quantity: 1, name: "Linen Summer Dress - L", price: null }],
  }, byVid, idx);
  assert.equal(r.cogsTotal, 950);
  assert.equal(r.source, "exact");
  // no size in the name → family median, not a wrong guess
  const r2 = computeCOGSFromOrder({
    order_detail: "",
    line_items: [{ variant_id: "99", product_id: "d1", quantity: 1, name: "Linen Summer Dress", price: null }],
  }, byVid, idx);
  assert.equal(r2.cogsTotal, 900);
  assert.equal(r2.source, "sibling_avg");
});

test("generality: brand-new store with 1 cost row never fabricates estimates", () => {
  const idx = buildCostIndex([
    { shopify_variant_id: "1", shopify_product_id: "p", sku: "", product_title: "Only Product", variant_title: "Default Title", unit_cost: 100 },
  ]);
  // the one real product still matches exactly…
  assert.equal(computeCOGS("[ 1 x Only Product ]", idx).cogsTotal, 100);
  // …but unknowns stay at none/0 rather than smearing one cost store-wide
  const unknown = computeCOGS("[ 1 x Something Else ]", idx, { costRatio: 0.5, perUnitPrice: 500 });
  assert.equal(unknown.source, "none");
  assert.equal(unknown.cogsTotal, 0);
});

test("generality: uniform-cost catalog — every fallback equals that cost", () => {
  const idx = buildCostIndex(
    Array.from({ length: 10 }, (_, i) => ({
      shopify_variant_id: String(i), shopify_product_id: String(i), sku: "",
      product_title: `Product ${i}`, variant_title: "Default Title", unit_cost: 250,
    })),
  );
  assert.equal(computeCOGS("[ 1 x Nonexistent ]", idx).cogsTotal, 250);
});

test("generality: zero-cost rows don't poison clamps or medians", () => {
  const idx = buildCostIndex([
    { shopify_variant_id: "1", shopify_product_id: "1", sku: "", product_title: "Freebie Sticker", variant_title: "Default Title", unit_cost: 0 },
    { shopify_variant_id: "2", shopify_product_id: "2", sku: "", product_title: "Real Product A", variant_title: "Default Title", unit_cost: 400 },
    { shopify_variant_id: "3", shopify_product_id: "3", sku: "", product_title: "Real Product B", variant_title: "Default Title", unit_cost: 600 },
  ]);
  assert.equal(idx.minUnitCost, 400); // 0 excluded from clamp bounds
  const est = computeCOGS("[ 1 x Unknown Thing ]", idx, { costRatio: 0.5, perUnitPrice: 1000 });
  assert.equal(est.cogsTotal, 500);   // inside [200, 900] clamp window
});

test("quantity and price edge cases don't produce NaN", () => {
  const order = {
    order_detail: "",
    line_items: [
      { variant_id: "101", quantity: null },
      { variant_id: null, product_id: null, quantity: 2, name: "", price: "not-a-number" },
    ],
  };
  const r = computeCOGSFromOrder(order, BY_VID, INDEX, { costRatio: 0.5, perUnitPrice: null });
  assert.ok(Number.isFinite(r.cogsTotal), `cogsTotal is ${r.cogsTotal}`);
});
