import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import {
  parseOrderDetail,
  buildCostIndex,
  computeCOGS,
} from '../app/lib/cogs.server.js';

const SHOP = 'the-trendy-homes-pk.myshopify.com';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function fetchAll(table, build) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(supabase.from(table)).range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

const [orders, costs] = await Promise.all([
  fetchAll('orders', q =>
    q.select('tracking_number, order_detail, cogs_matched, cogs_total, is_delivered, is_returned')
     .eq('store_id', SHOP)
  ),
  fetchAll('product_costs', q =>
    q.select('product_title, variant_title, unit_cost, sku').eq('store_id', SHOP)
  ),
]);

console.log(`Store: ${SHOP}`);
console.log(`Orders fetched: ${orders.length}`);
console.log(`product_costs rows: ${costs.length}`);

const index = buildCostIndex(costs);

let dbUnmatched = 0;
const counts = { sku: 0, exact: 0, fuzzy: 0, none: 0 };
const unmatchedSamples = [];
const fuzzySamples = [];

for (const o of orders) {
  if (o.cogs_matched === false) dbUnmatched++;

  const { source, cogsTotal } = computeCOGS(o.order_detail || '', index);
  counts[source]++;

  if (source === 'none' && unmatchedSamples.length < 10) {
    unmatchedSamples.push({ tn: o.tracking_number, detail: o.order_detail });
  }
  if (source === 'fuzzy' && fuzzySamples.length < 20) {
    fuzzySamples.push({ tn: o.tracking_number, detail: o.order_detail, cogsTotal });
  }
}

console.log(`\n--- BEFORE (current DB state) ---`);
console.log(`cogs_matched = false: ${dbUnmatched}`);

console.log(`\n--- AFTER (3-tier matcher recompute) ---`);
console.log(`  sku   : ${counts.sku}   (tier 1)`);
console.log(`  exact : ${counts.exact} (tier 2)`);
console.log(`  fuzzy : ${counts.fuzzy} (tier 3 — shown to merchant for review)`);
console.log(`  none  : ${counts.none}  (still unmatched)`);
console.log(`  ----`);
console.log(`  total matched: ${counts.sku + counts.exact + counts.fuzzy}`);
console.log(`  Δ matched vs DB: ${(counts.sku + counts.exact + counts.fuzzy) - (orders.length - dbUnmatched)}`);

console.log(`\n--- SAMPLE: fuzzy matches (sanity-check before they go live) ---`);
for (const s of fuzzySamples) {
  console.log(`  [${s.cogsTotal}]  ${s.detail}`);
}

console.log(`\n--- SAMPLE: still unmatched ---`);
for (const s of unmatchedSamples) {
  console.log(`  ${s.detail}`);
}
