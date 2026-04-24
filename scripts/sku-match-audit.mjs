import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import { parseOrderDetail } from '../app/lib/cogs.server.js';

const SHOP = 'the-trendy-homes-pk.myshopify.com';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    q.select('tracking_number, order_detail').eq('store_id', SHOP)
  ),
  fetchAll('product_costs', q =>
    q.select('sku, unit_cost, product_title, variant_title').eq('store_id', SHOP)
  ),
]);

const skuCosts = costs.filter(c => c.sku && c.sku.trim());
const skuSet = new Set(skuCosts.map(c => c.sku.trim().toLowerCase()));

console.log(`Orders: ${orders.length}`);
console.log(`product_costs rows: ${costs.length}`);
console.log(`  with non-empty sku: ${skuCosts.length}`);
console.log(`  distinct SKUs: ${skuSet.size}`);

const skuInName = /(?:^|[\s\-])([A-Za-z]{1,4}-?\d{2,6}[A-Za-z0-9]*)\s*$/;

let ordersAllItemsHaveSku = 0;
let ordersAllSkusFound = 0;
let ordersAnySkuFound = 0;
let totalItems = 0;
let itemsWithSku = 0;
let itemsSkuMatched = 0;

const missSkuSamples = [];
const noSkuSamples = [];

for (const o of orders) {
  const items = parseOrderDetail(o.order_detail || '');
  if (!items.length) continue;

  let itemSkuCount = 0;
  let itemMatchCount = 0;

  for (const it of items) {
    totalItems++;
    const m = it.name.match(skuInName);
    if (m) {
      itemsWithSku++;
      itemSkuCount++;
      const sku = m[1].trim().toLowerCase();
      if (skuSet.has(sku)) {
        itemsSkuMatched++;
        itemMatchCount++;
      } else if (missSkuSamples.length < 10) {
        missSkuSamples.push({ name: it.name, extracted: sku });
      }
    } else if (noSkuSamples.length < 10) {
      noSkuSamples.push(it.name);
    }
  }

  if (itemSkuCount === items.length) ordersAllItemsHaveSku++;
  if (itemMatchCount > 0) ordersAnySkuFound++;
  if (itemMatchCount === items.length && items.length > 0) ordersAllSkusFound++;
}

console.log(`\n--- ITEM-LEVEL ---`);
console.log(`Total line items parsed: ${totalItems}`);
console.log(`  with extractable SKU tail: ${itemsWithSku}  (${((itemsWithSku/totalItems)*100).toFixed(1)}%)`);
console.log(`  SKU found in product_costs : ${itemsSkuMatched}  (${((itemsSkuMatched/totalItems)*100).toFixed(1)}%)`);

console.log(`\n--- ORDER-LEVEL ---`);
console.log(`Orders where EVERY item carries a SKU tail: ${ordersAllItemsHaveSku}`);
console.log(`Orders where EVERY item's SKU resolves    : ${ordersAllSkusFound}   ← fully matchable via SKU`);
console.log(`Orders with at least one SKU match        : ${ordersAnySkuFound}`);

console.log(`\n--- SAMPLE: SKU extracted but not in product_costs ---`);
for (const s of missSkuSamples) console.log(`  [${s.extracted}]  from  "${s.name}"`);

console.log(`\n--- SAMPLE: no SKU tail found ---`);
for (const n of noSkuSamples) console.log(`  "${n}"`);

console.log(`\n--- SAMPLE product_costs.sku values ---`);
for (const c of skuCosts.slice(0, 15)) {
  console.log(`  "${c.sku}"  ${c.product_title} / ${c.variant_title}  (${c.unit_cost})`);
}
