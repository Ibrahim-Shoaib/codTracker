// ============================================================
// COGS matcher
// ============================================================
//
// PRIMARY PATH — variant_id direct join (~91% of orders for stores using
//   Shopify checkout). Each order has `line_items` populated by the Shopify
//   enrichment job. COGS is summed deterministically from
//   product_costs.shopify_variant_id with no fuzzy logic. Tagged 'variant_id'.
//
//   Line items are resolved PER ITEM: items whose variant_id has a cost row
//   are priced exactly, and only the unknown remainder is estimated (product
//   join → text tiers → price anchor). A single uncosted variant no longer
//   drags the whole order onto the text matcher.
//
// FALLBACK PATH — per-item waterfall. For orders with no line_items
//   (DM/WhatsApp manual bookings, pre-install orders, or Shopify orders that
//   couldn't be linked) and line items with no usable variant_id (typed
//   draft-order items, deleted variants). Tiers, in order:
//
//     0. Product join — line item's product_id matches product_costs rows
//                       (repairs deleted/re-created variants). Unique row or
//                       variant-title pin → 'exact'; else family median →
//                       'sibling_avg'.
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
//     4. Sibling avg  — base title matches a known family exactly; median of
//                       the family. Tagged 'sibling_avg'.
//     4b. Token family — all (≥80%) of the item's name tokens appear in a
//                       cost row's tokens (1-char typo tolerance on longer
//                       tokens). Median of the best-scoring group. Catches
//                       shorthand like "OFF-WHITE BEDSPREAD SET" against
//                       "OFF-WHITE QUILTED BEDSPREAD SET(flower) - King".
//                       Tagged 'sibling_avg'.
//     5a. Price anchor — unit_cost ≈ selling price × the store's observed
//                       cost/revenue ratio (median over variant_id-matched
//                       orders, see deriveCostRatio). Uses the line item's
//                       own price when enriched, else the order's per-unit
//                       average (invoice_payment / units). Clamped to the
//                       catalog's cost range. Tagged 'fallback_avg'.
//     5b. Product median — median of per-PRODUCT median costs. Robust to
//                       bundle products with hundreds of variant rows that
//                       used to skew the old per-row store median.
//                       Tagged 'fallback_avg'.
//
// Source tags are unchanged (orders.cogs_match_source CHECK constraint):
// new tiers reuse 'sibling_avg' / 'fallback_avg' so no migration is needed.
// An order's source is the WEAKEST tier across its line items.
// ============================================================

const FUZZY_MIN = 0.90;
const FUZZY_GAP = 0.10;

// Token-family: fraction of the query's tokens that must appear in a cost
// row before the family median is trusted.
const TOKEN_FAMILY_MIN = 0.8;

// Tiers 4/5 are estimates — require at least this many cost rows in the
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

// Query/candidate token sets for the token-family tier. Single-character
// fragments ("a", "x") carry no signal and are dropped.
function tokenSet(s) {
  return new Set(tokens(s).filter(t => t.length >= 2));
}

// Token equality with 1-edit tolerance on longer tokens, so common listing
// typos ("TOWET" vs "TOWEL") still land in the right family.
function tokenMatches(q, candidateSet) {
  if (candidateSet.has(q)) return true;
  if (q.length < 5) return false;
  for (const t of candidateSet) {
    if (Math.abs(t.length - q.length) <= 1 && levenshtein(q, t) <= 1) return true;
  }
  return false;
}

// Fraction of query tokens found in the candidate's token set. Adjacent
// query tokens are also tried merged ("BED SPREAD" matches a catalog's
// "BEDSPREAD") — spacing inconsistencies are endemic in typed order lines.
function tokenContainment(qTokens, candidateSet) {
  if (!qTokens.length) return 0;
  let hit = 0;
  for (let i = 0; i < qTokens.length; i++) {
    if (tokenMatches(qTokens[i], candidateSet)) { hit++; continue; }
    if (i + 1 < qTokens.length && candidateSet.has(qTokens[i] + qTokens[i + 1])) {
      hit += 2;
      i++;
    }
  }
  return hit / qTokens.length;
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
// Cost ratio (price anchor input)
// ------------------------------------------------------------
//
// Median cogs/revenue ratio observed on this store's variant_id-matched
// orders. Dimensionless, so it works in any store currency. Returns null
// when there aren't enough clean samples to trust — callers must treat null
// as "anchor unavailable" and fall through to the product median.
export function deriveCostRatio(ratios, { minSamples = 5 } = {}) {
  const clean = (ratios ?? []).filter(r => Number.isFinite(r) && r > 0.05 && r < 1.5);
  if (clean.length < minSamples) return null;
  return Math.min(0.9, Math.max(0.1, median(clean)));
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
//     byProductId        Map<product_id, [variant…]>   — tier 0 (product join)
//     familyVariants     Map<strippedBase, [variant…]> — tier 4 input
//     fuzzyCandidates    Array<{key, variant, baseStripped, tokenSet}>
//     productMedianCost  number — median of per-product medians (tier 5b)
//     storeMedianCost    number — legacy per-row median (kept for reference)
//     minUnitCost/maxUnitCost — price-anchor clamp bounds
//     hasCosts           boolean
//   }
export function buildCostIndex(costs) {
  const bySku = new Map();
  const byExact = new Map();
  const byVariantTitle = new Map();
  const byBaseTitle = new Map();
  const byProductId = new Map();
  const familyVariants = new Map();
  const fuzzyCandidates = [];
  const allUnitCosts = [];
  const perProductCosts = new Map(); // product key → [unit_cost…]

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

    // Tier 0 index: product join. Repairs orders whose variant was deleted
    // and re-created in Shopify (new variant_id, same product_id).
    const pid = c.shopify_product_id != null ? String(c.shopify_product_id) : null;
    if (pid) {
      if (!byProductId.has(pid)) byProductId.set(pid, []);
      byProductId.get(pid).push(variant);
    }

    // Per-product cost pools for the tier-5b product median. Keyed on
    // product_id when present, else the normalized title, so bundle products
    // with hundreds of variant rows count once, not hundreds of times.
    const productKey = pid ?? title;
    if (!perProductCosts.has(productKey)) perProductCosts.set(productKey, []);
    perProductCosts.get(productKey).push(unit_cost);

    const baseStripped = stripParenSuffix(c.product_title);
    if (!familyVariants.has(baseStripped)) familyVariants.set(baseStripped, []);
    familyVariants.get(baseStripped).push(variant);

    fuzzyCandidates.push({
      key: fullKey,
      title,
      varTitle,
      variant,
      baseStripped,
      tokenSet: tokenSet(fullKey),
    });
  }

  const storeMedianCost = median(allUnitCosts);
  const productMedianCost = median(
    [...perProductCosts.values()].map(costsOfProduct => median(costsOfProduct)),
  );
  const positiveCosts = allUnitCosts.filter(c => c > 0);
  const minUnitCost = positiveCosts.length ? Math.min(...positiveCosts) : 0;
  const maxUnitCost = positiveCosts.length ? Math.max(...positiveCosts) : 0;

  return {
    bySku,
    byExact,
    byVariantTitle,
    byBaseTitle,
    byProductId,
    familyVariants,
    fuzzyCandidates,
    storeMedianCost,
    productMedianCost,
    minUnitCost,
    maxUnitCost,
    hasCosts,
    costCount: rows.length,
  };
}

// ------------------------------------------------------------
// Estimation helpers (tier 5)
// ------------------------------------------------------------

// Keep price-anchored estimates inside a sane multiple of the catalog's own
// cost range — a mis-parsed quantity or bundle invoice shouldn't produce a
// unit cost wildly outside anything the store has ever entered.
function clampEstimate(est, index) {
  const hi = index.maxUnitCost > 0 ? index.maxUnitCost * 1.5 : est;
  const lo = index.minUnitCost > 0 ? index.minUnitCost * 0.5 : 0;
  return Math.max(lo, Math.min(hi, est));
}

// anchor: { costRatio, perUnitPrice } | null. itemPrice: line item's own
// selling price when the enrichment stored it, else null.
function estimateUnknown(itemPrice, index, anchor) {
  const ratio = anchor?.costRatio ?? null;
  const price =
    Number(itemPrice) > 0 ? Number(itemPrice)
    : Number(anchor?.perUnitPrice) > 0 ? Number(anchor.perUnitPrice)
    : null;
  if (ratio != null && price != null) {
    return { source: 'fallback_avg', unit_cost: clampEstimate(price * ratio, index) };
  }
  return { source: 'fallback_avg', unit_cost: index.productMedianCost };
}

// ------------------------------------------------------------
// Per-line resolution (text tiers)
// ------------------------------------------------------------

function resolveItem(item, index, anchor = null) {
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

  const estimatesAllowed = index.hasCosts && index.costCount >= FALLBACK_MIN_COSTS;

  // --- Tier 4: sibling-family average ---
  // When the user's base title matches a known family in costs (e.g. our item
  // says "OFF-WHITE QUILTED BEDSPREAD SET - King" and the store has the
  // (lines)/(flower)/(check) siblings all under that base), use the median
  // cost of the family. Safe when siblings have similar costs; flagged as
  // sibling_avg so the merchant can review.
  if (estimatesAllowed) {
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

    // --- Tier 4b: token family ---
    // Shorthand and truncated names ("OFF-WHITE BEDSPREAD SET",
    // "NAVY QUILTED BEDSPREAD SET") rarely survive tiers 2-4, but their
    // tokens are almost always a subset of the real listing's tokens.
    // Score every cost row by the fraction of query tokens it contains
    // (with 1-edit typo tolerance) and take the median of the best group.
    // Query tokens come from the sku-stripped base so a trailing "- BS-005"
    // can't dilute the containment score.
    const q = [...tokenSet(baseNoSku)].length >= 2
      ? [...tokenSet(baseNoSku)]
      : [...tokenSet(item.name)];
    if (q.length >= 2) {
      let bestScore = 0;
      const scored = [];
      for (const cand of index.fuzzyCandidates) {
        const score = tokenContainment(q, cand.tokenSet);
        if (score > bestScore) bestScore = score;
        scored.push({ score, cand });
      }
      if (bestScore >= TOKEN_FAMILY_MIN) {
        const group = scored
          .filter(x => x.score === bestScore)
          .map(x => x.cand.variant.unit_cost);
        return { source: 'sibling_avg', unit_cost: median(group) };
      }
    }

    // --- Tier 5: price anchor → product median ---
    return estimateUnknown(item.price, index, anchor);
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

function sourceForRank(rank) {
  return Object.keys(SOURCE_RANK).find(k => SOURCE_RANK[k] === rank);
}

export function computeCOGS(orderDetail, index, anchor = null) {
  const items = parseOrderDetail(orderDetail);
  if (!items.length) {
    return { cogsTotal: 0, allMatched: true, source: 'exact' };
  }

  let cogsTotal = 0;
  let worstRank = SOURCE_RANK.sku;
  let anyUnmatched = false;

  for (const item of items) {
    const res = resolveItem(item, index, anchor);
    if (res.source === 'none') {
      anyUnmatched = true;
    } else {
      cogsTotal += res.unit_cost * item.quantity;
    }
    worstRank = Math.min(worstRank, SOURCE_RANK[res.source]);
  }

  const source = anyUnmatched ? 'none' : sourceForRank(worstRank);

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

// Legacy enrichment wrote String(null) === 'null' for draft-order items with
// no variant. Treat those (and empty strings) as "no variant id".
function normalizeVariantId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return !s || s === 'null' || s === 'undefined' ? null : s;
}

// Tier 0: resolve an unknown-variant line item through its product_id.
// Repairs variants that were deleted and re-created in Shopify — the cost
// row survives under the same product_id.
function resolveByProduct(item, index) {
  const pid = item?.product_id != null ? String(item.product_id) : null;
  if (!pid) return null;
  const rows = index.byProductId.get(pid);
  if (!rows?.length) return null;
  if (rows.length === 1) {
    return { source: 'exact', unit_cost: rows[0].unit_cost };
  }
  // Multiple costed variants under this product — pin by variant title when
  // the item name carries it ("PRODUCT - King"), else take the family median.
  const n = normalize(item.name ?? '');
  if (n) {
    // First try the name's own " - " variant segment as an exact title match —
    // substring checks would false-hit single-letter sizes ("S" is inside
    // "Summer"). Descriptive multi-char titles may still match by containment.
    const seg = splitVariant(item.name).variant;
    const segN = seg ? normalize(seg) : null;
    let hits = segN
      ? rows.filter(r => r.variant_title && normalize(r.variant_title) === segN)
      : [];
    if (hits.length !== 1) {
      hits = rows.filter(r => {
        if (!r.variant_title || r.variant_title === 'Default Title') return false;
        const vt = normalize(r.variant_title);
        return vt.length >= 3 && n.includes(vt);
      });
    }
    if (hits.length === 1) {
      return { source: 'exact', unit_cost: hits[0].unit_cost };
    }
  }
  return { source: 'sibling_avg', unit_cost: median(rows.map(r => r.unit_cost)) };
}

// Resolves COGS for an order. line_items shape (both are supported):
//   legacy:   [{ variant_id: "123", quantity: 1 }, ...]
//   enriched: [{ variant_id, product_id, quantity, name, price }, ...]
//
// `anchor` ({ costRatio, perUnitPrice } | null) feeds the tier-5 price
// estimate for items nothing else can resolve. Callers that can't derive an
// anchor may pass null — estimation degrades to the product median.
//
// Returns { cogsTotal, allMatched, source }. `source` is 'variant_id' when
// every line item resolved through the direct join, otherwise the weakest
// tier used across items.
export function computeCOGSFromOrder(order, costsByVariantId, textIndex, anchor = null) {
  const lineItems = Array.isArray(order?.line_items) ? order.line_items : null;

  if (lineItems && lineItems.length > 0) {
    // Legacy enrichment stored only { variant_id, quantity }. When an
    // unknown-variant item carries none of the per-item signals (name,
    // product_id, price), the courier's order_detail text is strictly more
    // informative — resolve the whole order through the text matcher, as the
    // pre-per-item behavior did.
    const isKnown = it => {
      const vid = normalizeVariantId(it?.variant_id);
      return vid != null && costsByVariantId.has(vid);
    };
    const unknownWithoutSignals = lineItems.some(it =>
      !isKnown(it)
      && !(typeof it?.name === 'string' && it.name.trim())
      && it?.product_id == null
      && !(Number(it?.price) > 0),
    );
    const allKnown = lineItems.every(isKnown);
    if (!allKnown && unknownWithoutSignals && order?.order_detail?.trim()) {
      return computeCOGS(order.order_detail, textIndex, anchor);
    }

    const estimatesAllowed =
      textIndex.hasCosts && textIndex.costCount >= FALLBACK_MIN_COSTS;

    let cogsTotal = 0;
    let worstRank = SOURCE_RANK.variant_id;
    let anyUnmatched = false;

    for (const it of lineItems) {
      const qty = Number(it?.quantity ?? 0) || 0;
      const vid = normalizeVariantId(it?.variant_id);

      let res;
      if (vid != null && costsByVariantId.has(vid)) {
        res = { source: 'variant_id', unit_cost: Number(costsByVariantId.get(vid)) || 0 };
      } else {
        // Unknown variant — per-item waterfall: product join → text tiers →
        // price anchor. Known items in the same order keep their exact costs.
        res = resolveByProduct(it, textIndex);
        if (!res && typeof it?.name === 'string' && it.name.trim()) {
          res = resolveItem(
            { name: it.name, quantity: qty, price: it.price },
            textIndex,
            anchor,
          );
        }
        if (!res) {
          res = estimatesAllowed
            ? estimateUnknown(it?.price, textIndex, anchor)
            : { source: 'none', unit_cost: 0 };
        }
      }

      if (res.source === 'none') {
        anyUnmatched = true;
      } else {
        cogsTotal += res.unit_cost * qty;
      }
      worstRank = Math.min(worstRank, SOURCE_RANK[res.source]);
    }

    // Orders whose every item resolved (even partially estimated) are
    // reported with their weakest tier; text fallback below is only for
    // orders with no line_items at all.
    const source = anyUnmatched ? 'none' : sourceForRank(worstRank);
    return { cogsTotal, allMatched: !anyUnmatched, source };
  }

  return computeCOGS(order?.order_detail ?? '', textIndex, anchor);
}
