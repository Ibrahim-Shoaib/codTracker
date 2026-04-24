import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import { parseOrderDetail, buildCostIndex } from '../app/lib/cogs.server.js';

const SHOP = 'the-trendy-homes-pk.myshopify.com';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function fetchAll(table, build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(supabase.from(table)).range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

const [orders, costs] = await Promise.all([
  fetchAll('orders', q =>
    q.select('tracking_number, order_detail, cogs_match_source')
     .eq('store_id', SHOP)
     .eq('cogs_match_source', 'none')
  ),
  fetchAll('product_costs', q =>
    q.select('product_title, variant_title, unit_cost, sku').eq('store_id', SHOP)
  ),
]);

console.log(`Unmatched orders: ${orders.length}`);
console.log(`product_costs rows: ${costs.length}\n`);

const index = buildCostIndex(costs);

// Build quick sets for diagnostic categorization
const costTitles = new Set(
  costs.map(c => (c.product_title || '').toLowerCase().trim())
);
const costTitlesBase = new Set(
  costs.map(c => (c.product_title || '').toLowerCase().replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim())
);

// Aggregate unmatched item names
const nameCount = new Map();
let totalItems = 0;
let itemsWithZeroParse = 0;

for (const o of orders) {
  const items = parseOrderDetail(o.order_detail || '');
  if (!items.length) {
    itemsWithZeroParse++;
    continue;
  }
  for (const it of items) {
    totalItems++;
    const key = it.name;
    nameCount.set(key, (nameCount.get(key) || 0) + it.quantity);
  }
}

console.log(`Total line items in unmatched orders: ${totalItems}`);
console.log(`Orders with empty/unparseable order_detail: ${itemsWithZeroParse}`);
console.log(`Distinct unmatched names: ${nameCount.size}\n`);

// Categorize each distinct unmatched name
const buckets = {
  'Product title not in product_costs at all':       [],
  'Title exists but with a paren suffix we strip':   [],
  'Title has (check) suffix not present in costs':   [],
  'Bundle/multi-variant syntax (slash in variant)':  [],
  'Exact key collides with sibling (fuzzy refused)': [],
  'Other / likely typo':                             [],
};

for (const [name, qty] of nameCount) {
  const lower = name.toLowerCase();

  // Strip " - King", " - King - BS-xxx", trailing empty " -"
  const baseTitle = lower
    .replace(/\s*-\s*$/, '')
    .replace(/\s*-\s*[a-z0-9]+(?:-[a-z0-9]+)*\s*$/i, '') // strip trailing SKU-ish
    .replace(/\s*-\s*king\s*$/, '')
    .replace(/\s*-\s*queen\s*$/, '')
    .replace(/\s*-\s*single\s*$/, '')
    .trim();

  const bareBase = baseTitle.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

  if (/\(check\)/.test(lower)) {
    buckets['Title has (check) suffix not present in costs'].push([name, qty]);
    continue;
  }
  if (/\//.test(lower)) {
    buckets['Bundle/multi-variant syntax (slash in variant)'].push([name, qty]);
    continue;
  }

  // Does the base title exist in any cost row?
  if (costTitles.has(baseTitle) || costTitles.has(bareBase)) {
    // There IS a matching base title but we still missed — most likely a
    // sibling-family disable of fuzzy.
    buckets['Exact key collides with sibling (fuzzy refused)'].push([name, qty]);
    continue;
  }
  if (costTitlesBase.has(bareBase)) {
    buckets['Title exists but with a paren suffix we strip'].push([name, qty]);
    continue;
  }

  // Not in costs at all — is it a typo or a missing product?
  // Heuristic: if any token from the name appears in any cost title, flag as "likely typo",
  // else "genuinely not in costs".
  const nameTokens = new Set(bareBase.split(/\s+/).filter(t => t.length > 3));
  let anyOverlap = false;
  for (const ct of costTitlesBase) {
    for (const t of nameTokens) {
      if (ct.includes(t)) { anyOverlap = true; break; }
    }
    if (anyOverlap) break;
  }

  if (anyOverlap) buckets['Other / likely typo'].push([name, qty]);
  else buckets['Product title not in product_costs at all'].push([name, qty]);
}

console.log('--- CATEGORY BREAKDOWN ---');
for (const [label, entries] of Object.entries(buckets)) {
  const distinct = entries.length;
  const qty = entries.reduce((s, [, q]) => s + q, 0);
  console.log(`\n[${qty} items across ${distinct} distinct names] ${label}`);
  entries.sort((a, b) => b[1] - a[1]);
  for (const [name, q] of entries.slice(0, 8)) {
    console.log(`    ${String(q).padStart(5)}  ${name}`);
  }
  if (entries.length > 8) console.log(`    … and ${entries.length - 8} more`);
}
