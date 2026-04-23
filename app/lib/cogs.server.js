// Parses PostEx orderDetail string into [{ name, quantity }].
// Handles all observed formats:
//   [ 1 x PRODUCT NAME - VARIANT ]
//   [ 2 PRODUCT NAME ][ PRODUCT NAME ]   (no "x", multiple)
//   PRODUCT NAME                          (bare string, no brackets)
export function parseOrderDetail(orderDetail) {
  if (!orderDetail?.trim()) return [];

  const items = [];
  const bracketRe = /\[\s*(\d+)?\s*(?:x\s+)?([^\]]+?)\s*\]/gi;
  let match;
  let anyBracket = false;

  while ((match = bracketRe.exec(orderDetail)) !== null) {
    anyBracket = true;
    const quantity = match[1] ? parseInt(match[1], 10) : 1;
    const name = match[2].trim();
    if (name) items.push({ quantity, name });
  }

  if (!anyBracket) {
    items.push({ quantity: 1, name: orderDetail.trim() });
  }

  return items;
}

function normalize(name) {
  return name
    .toLowerCase()
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

// Builds a normalized lookup map from product_costs rows.
// Keys: "product_title - variant_title" (full) and "product_title" (short, only when unambiguous).
export function buildCostMap(costs) {
  const map = new Map();
  const variantCount = new Map();

  for (const c of costs ?? []) {
    const title = normalize(c.product_title ?? '');
    variantCount.set(title, (variantCount.get(title) || 0) + 1);
  }

  for (const c of costs ?? []) {
    const unitCost = Number(c.unit_cost);
    const title = normalize(c.product_title ?? '');
    const variant =
      c.variant_title && c.variant_title !== 'Default Title'
        ? normalize(c.variant_title)
        : null;

    if (variant) map.set(`${title} - ${variant}`, unitCost);

    // Short key only when this product has exactly one variant — avoids ambiguous matches
    if (variantCount.get(title) === 1) map.set(title, unitCost);
  }

  return map;
}

// Computes COGS for one order using orderDetail text and a pre-built costMap.
export function computeCOGS(orderDetail, costMap) {
  const items = parseOrderDetail(orderDetail);
  if (!items.length) return { cogsTotal: 0, allMatched: true };

  let cogsTotal = 0;
  let allMatched = true;

  for (const item of items) {
    const key = normalize(item.name);
    const unitCost = costMap.get(key);
    if (unitCost != null) {
      cogsTotal += unitCost * item.quantity;
    } else {
      allMatched = false;
    }
  }

  return { cogsTotal, allMatched };
}
