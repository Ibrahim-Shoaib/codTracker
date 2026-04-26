// ============================================================
// COGS matcher
// ============================================================
//
// PRIMARY PATH — variant_id direct join (~91% of orders for stores using
//   Shopify checkout). Each order has `line_items: [{variant_id, quantity}]`
//   populated by the Shopify enrichment job. COGS is summed deterministically
//   from product_costs.shopify_variant_id with no fuzzy logic. Tagged
//   'variant_id'. Used when EVERY variant_id in line_items has a cost row;
//   otherwise the order falls through to the text matcher below.
//
// FALLBACK PATH — 5-tier text waterfall. For orders with no line_items
//   (DM/WhatsApp manual bookings, pre-install orders, or Shopify orders that
//   couldn't be linked) and orders whose line_items contains variants with
//   no cost row yet. Each line item is independently resolved against the
//   store's `product_costs` table using tiers, in order:
//
//     1. SKU          — exact match on product_costs.sku, unique only.
//     2. Exact title  — normalized "product_title - variant_title" lookup,
//                       unique only, with SKU/empty tail stripped. Also tries
//                       a variant-title-only lookup so "Product - ColorA /
//                       ColorB" (bundles) resolve when only the variant half
//                       is unique.
//     3. Fuzzy        — token-sort ratio on normalized names. Committed only
//                       when best >= FUZZY_MIN (0.90) AND beats runner-up by
//                       >= FUZZY_GAP (0.10). Disabled inside sibling families
//                       (same base title, multiple paren-suffixed variants).
//     4. Sibling avg  — when the base product clearly matches a family but the
//                       specific sibling can't be distinguished from text,
//                       use the median cost of the family. Tagged 'sibling_avg'.
//     5. Fallback avg — nothing matched; use the store's median unit_cost.
//                       Tagged 'fallback_avg'.
//
// An order's `cogs_match_source` is the WEAKEST tier across its line items
// (or 'variant_id' if the primary path resolved it cleanly).
// ============================================================

const FUZZY_MIN = 0.90;
const FUZZY_GAP = 0.10;

// Tiers 4 and 5 are estimates — require at least this many cost rows in the
// store before they're allowed, so brand-new stores with 1-2 costs don't get
// meaningless store-wide averages applied to unrelated products.
const FALLBACK_MIN_COSTS = 3;

// ------------------------------------------------------------
// Parsing
// ------------------------------------------------------------
//
// Handles:
//   [ 1 x PRODUCT NAME - VARIANT ]
//   [ 2 PRODUCT NAME ][ PRODUCT NAME ]
//   PRODUCT NAME   (bare string)
export function parseOrderDetail(orderDetail) {
  if (!orderDetail?.trim()) return [];

  const items = [];
  const bracketRe = /\[\s*(\d+)?\s*(?:x\s+)?([^\]]+?)\s*\]/gi;
  let m;
  let anyBracket = false;

  while ((m = bracketRe.exec(orderDetail)) !== null) {
    anyBracket = true;
    const quantity = m[1] ? parseInt(m[1], 10) : 1;
    const name = m[2].trim();
    if (name) items.push({ quantity, name });
  }

  if (!anyBracket) items.push({ quantity: 1, name: orderDetail.trim() });
  return items;
}

// ------------------------------------------------------------
// Normalization helpers
// ------------------------------------------------------------

// Lowercase + collapse whitespace + tighten INSIDE parens only.
// Whitespace AFTER ')' is a real word boundary (e.g., "set(flower) - king"),
// so we deliberately leave it alone.
function normalize(s) {
  return (s ?? '')
    .toLowerCase()
    .replace(/\s+\(/g, '(')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripParenSuffix(s) {
  return normalize(s).replace(/\s*\([^)]*\)\s*$/g, '').trim();
}

// Match and strip a trailing SKU-ish token (e.g., " - BS-005", " - 0").
// Only committed when the token contains a digit or a dash — otherwise it's
// probably a size word like "- King" and we leave it in place.
const TRAILING_SKU_RE = /\s*-\s*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\s*$/;

function stripEmptyTail(s) {
  return s.replace(/\s*-\s*$/, '').trim();
}

function splitSku(name) {
  const cleaned = stripEmptyTail(name);
  const m = cleaned.match(TRAILING_SKU_RE);
  if (!m) return { base: cleaned, sku: null };
  const sku = m[1];
  if (!/\d/.test(sku) && !/-/.test(sku)) return { base: cleaned, sku: null };
  return { base: cleaned.slice(0, m.index).trim(), sku };
}

// Pull the LAST " - " segment off as a potential variant signature.
// "Bedspread Bundle - Offwhite / Beige" → base="Bedspread Bundle", variant="Offwhite / Beige".
function splitVariant(name) {
  const cleaned = stripEmptyTail(name);
  const idx = cleaned.lastIndexOf(' - ');
  if (idx < 0) return { base: cleaned, variant: null };
  return {
    base: cleaned.slice(0, idx).trim(),
    variant: cleaned.slice(idx + 3).trim(),
  };
}

// ------------------------------------------------------------
// Similarity (token-sort ratio via single-row Levenshtein)
// ------------------------------------------------------------

function tokens(s) {
  return normalize(s).split(/[^a-z0-9]+/).filter(Boolean);
}

function tokenSortRatio(a, b) {
  const ta = tokens(a).sort().join(' ');
  const tb = tokens(b).sort().join(' ');
  if (!ta || !tb) return 0;
  if (ta === tb) return 1;
  const dist = levenshtein(ta, tb);
  return 1 - dist / Math.max(ta.length, tb.length);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const v = new Array(n + 1);
  for (let j = 0; j <= n; j++) v[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = v[0];
    v[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = v[j];
      v[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, v[j], v[j - 1]);
      prev = tmp;
    }
  }
  return v[n];
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ------------------------------------------------------------
// Index builder
// ------------------------------------------------------------
//
// Returns:
//   {
//     bySku              Map<sku, [variant…]>          — tier 1
//     byExact            Map<fullKey, [variant…]>      — tier 2a
//     byVariantTitle     Map<variantKey, [variant…]>   — tier 2b (bundles)
//     byBaseTitle        Map<strippedBase, count>      — sibling-count guard
//     familyVariants     Map<strippedBase, [variant…]> — tier 4 input
//     fuzzyCandidates    Array<{key, variant, baseStripped}>
//     storeMedianCost    number                        — tier 5 input
//     hasCosts           boolean                       — gates tiers 4+5
//   }
export function buildCostIndex(costs) {
  const bySku = new Map();
  const byExact = new Map();
  const byVariantTitle = new Map();
  const byBaseTitle = new Map();
  const familyVariants = new Map();
  const fuzzyCandidates = [];
  const allUnitCosts = [];

  const rows = costs ?? [];
  const hasCosts = rows.length >= 1;

  for (const c of rows) {
    const base = stripParenSuffix(c.product_title);
    byBaseTitle.set(base, (byBaseTitle.get(base) || 0) + 1);
  }

  const variantCount = new Map();
  for (const c of rows) {
    const t = normalize(c.product_title);
    variantCount.set(t, (variantCount.get(t) || 0) + 1);
  }

  for (const c of rows) {
    const unit_cost = Number(c.unit_cost) || 0;
    const variant = {
      unit_cost,
      product_title: c.product_title ?? '',
      variant_title: c.variant_title ?? '',
      sku: c.sku ?? '',
    };
    allUnitCosts.push(unit_cost);

    const sku = (c.sku ?? '').trim().toLowerCase();
    if (sku) {
      if (!bySku.has(sku)) bySku.set(sku, []);
      bySku.get(sku).push(variant);
    }

    const title = normalize(c.product_title);
    const varTitle =
      c.variant_title && c.variant_title !== 'Default Title'
        ? normalize(c.variant_title)
        : null;

    const fullKey = varTitle ? `${title} - ${varTitle}` : title;
    if (!byExact.has(fullKey)) byExact.set(fullKey, []);
    byExact.get(fullKey).push(variant);

    if (variantCount.get(title) === 1 && !byExact.has(title)) {
      byExact.set(title, [variant]);
    }

    // Tier 2b index: lookup by variant title alone (for bundle cases where
    // PostEx strips the product's "(a)" suffix but the variant half is unique).
    if (varTitle) {
      if (!byVariantTitle.has(varTitle)) byVariantTitle.set(varTitle, []);
      byVariantTitle.get(varTitle).push(variant);
    }

    const baseStripped = stripParenSuffix(c.product_title);
    if (!familyVariants.has(baseStripped)) familyVariants.set(baseStripped, []);
    familyVariants.get(baseStripped).push(variant);

    fuzzyCandidates.push({
      key: fullKey,
      title,
      varTitle,
      variant,
      baseStripped,
    });
  }

  const storeMedianCost = median(allUnitCosts);

  return {
    bySku,
    byExact,
    byVariantTitle,
    byBaseTitle,
    familyVariants,
    fuzzyCandidates,
    storeMedianCost,
    hasCosts,
    costCount: rows.length,
  };
}

// ------------------------------------------------------------
// Per-line resolution
// ------------------------------------------------------------

function resolveItem(item, index) {
  const { base: baseNoSku, sku } = splitSku(item.name);

  // --- Tier 1: SKU (unique only) ---
  if (sku) {
    const hits = index.bySku.get(sku.toLowerCase());
    if (hits && hits.length === 1) {
      return { source: 'sku', unit_cost: hits[0].unit_cost };
    }
  }

  // --- Tier 2a: exact full-name lookup (unique only) ---
  const keysToTry = new Set([
    normalize(stripEmptyTail(baseNoSku)),
    normalize(stripEmptyTail(item.name)),
  ]);
  for (const k of keysToTry) {
    const hits = index.byExact.get(k);
    if (hits && hits.length === 1) {
      return { source: 'exact', unit_cost: hits[0].unit_cost };
    }
  }

  // --- Tier 2b: variant-title-only lookup (handles bundles) ---
  // "Bedspread Bundle - Offwhite / Beige" → variant "Offwhite / Beige" may
  // uniquely identify the cost row even when the product title was truncated.
  const { variant: rawVariant } = splitVariant(item.name);
  if (rawVariant) {
    const vKey = normalize(rawVariant);
    const vHits = index.byVariantTitle.get(vKey);
    if (vHits && vHits.length === 1) {
      return { source: 'exact', unit_cost: vHits[0].unit_cost };
    }
  }

  // --- Tier 3: fuzzy (skipped entirely inside sibling families) ---
  const queryFull = normalize(stripEmptyTail(item.name));
  const queryBase = normalize(stripEmptyTail(baseNoSku));

  let best = { score: 0, cand: null };
  let runnerScore = 0;

  for (const cand of index.fuzzyCandidates) {
    if ((index.byBaseTitle.get(cand.baseStripped) || 0) > 1) continue;
    const s = Math.max(
      tokenSortRatio(queryFull, cand.key),
      tokenSortRatio(queryBase, cand.key),
    );
    if (s > best.score) {
      runnerScore = best.score;
      best = { score: s, cand };
    } else if (s > runnerScore) {
      runnerScore = s;
    }
  }

  if (best.cand && best.score >= FUZZY_MIN && (best.score - runnerScore) >= FUZZY_GAP) {
    return { source: 'fuzzy', unit_cost: best.cand.variant.unit_cost };
  }

  // --- Tier 4: sibling-family average ---
  // When the user's base title matches a known family in costs (e.g. our item
  // says "OFF-WHITE QUILTED BEDSPREAD SET - King" and the store has the
  // (lines)/(flower)/(check) siblings all under that base), use the median
  // cost of the family. Safe when siblings have similar costs; flagged as
  // sibling_avg so the merchant can review.
  if (index.hasCosts && index.costCount >= FALLBACK_MIN_COSTS) {
    // Strip paren suffixes from whatever form of the query we've got, and
    // also try the pre-" - " half in case the variant suffix threw off the
    // family match (e.g., "OFF-WHITE QUILTED BEDSPREAD SET - King" → family
    // "off-white quilted bedspread set" AND "off-white quilted bedspread set - king").
    const familyKeys = new Set([
      stripParenSuffix(item.name),
      stripParenSuffix(baseNoSku),
      stripParenSuffix(splitVariant(item.name).base),
    ]);
    for (const fk of familyKeys) {
      const fam = index.familyVariants.get(fk);
      if (fam && fam.length >= 2) {
        const cost = median(fam.map(v => v.unit_cost));
        return { source: 'sibling_avg', unit_cost: cost };
      }
    }
  }

  // --- Tier 5: store-median fallback ---
  // Gated on having a reasonable number of cost rows so a brand-new store's
  // single cost doesn't get smeared onto unrelated products.
  if (index.hasCosts && index.costCount >= FALLBACK_MIN_COSTS) {
    return { source: 'fallback_avg', unit_cost: index.storeMedianCost };
  }

  return { source: 'none', unit_cost: 0 };
}

// ------------------------------------------------------------
// Aggregate — per-order source = weakest tier across line items.
// ------------------------------------------------------------

const SOURCE_RANK = {
  none:         0,
  fallback_avg: 1,
  sibling_avg:  2,
  fuzzy:        3,
  exact:        4,
  sku:          5,
  variant_id:   6,   // direct Shopify variant_id join — highest confidence
};

export function computeCOGS(orderDetail, index) {
  const items = parseOrderDetail(orderDetail);
  if (!items.length) {
    return { cogsTotal: 0, allMatched: true, source: 'exact' };
  }

  let cogsTotal = 0;
  let worstRank = SOURCE_RANK.sku;
  let anyUnmatched = false;

  for (const item of items) {
    const res = resolveItem(item, index);
    if (res.source === 'none') {
      anyUnmatched = true;
    } else {
      cogsTotal += res.unit_cost * item.quantity;
    }
    worstRank = Math.min(worstRank, SOURCE_RANK[res.source]);
  }

  const source = anyUnmatched
    ? 'none'
    : Object.keys(SOURCE_RANK).find(k => SOURCE_RANK[k] === worstRank);

  return {
    cogsTotal,
    allMatched: !anyUnmatched,
    source,
  };
}

// ------------------------------------------------------------
// Variant-id direct path
// ------------------------------------------------------------
//
// Builds a Map<shopify_variant_id, unit_cost> from product_costs rows.
// Used by computeCOGSFromOrder when an order has Shopify line_items.
export function buildCostsByVariantId(costs) {
  const map = new Map();
  for (const c of costs ?? []) {
    if (!c.shopify_variant_id) continue;
    map.set(String(c.shopify_variant_id), Number(c.unit_cost) || 0);
  }
  return map;
}

// Resolves COGS for an order using the variant_id direct path when possible,
// falling through to the text matcher otherwise.
//
// `order` must have at least { order_detail, line_items }. line_items shape:
//   [{ variant_id: "123", quantity: 1 }, ...]   or null/undefined
//
// Returns { cogsTotal, allMatched, source }. `source` is 'variant_id' on the
// primary path, otherwise one of the existing text-tier values.
export function computeCOGSFromOrder(order, costsByVariantId, textIndex) {
  const lineItems = Array.isArray(order?.line_items) ? order.line_items : null;

  if (lineItems && lineItems.length > 0) {
    // Every line item must have a cost row, otherwise we'd silently zero
    // out unknown variants. Fall through to text matcher in that case so
    // the order still gets a non-zero estimate (consistent with prior
    // behavior for products missing from the catalog).
    const allKnown = lineItems.every(it => costsByVariantId.has(String(it?.variant_id ?? '')));
    if (allKnown) {
      let cogsTotal = 0;
      for (const it of lineItems) {
        const cost = costsByVariantId.get(String(it.variant_id));
        cogsTotal += Number(cost) * Number(it.quantity ?? 0);
      }
      return { cogsTotal, allMatched: true, source: 'variant_id' };
    }
  }

  return computeCOGS(order?.order_detail ?? '', textIndex);
}
