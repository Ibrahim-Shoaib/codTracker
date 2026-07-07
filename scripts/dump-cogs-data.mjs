import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import { writeFileSync } from 'node:fs';

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

// Past 6 months from 2026-04-26 = Nov 2025 -> Apr 2026
const SINCE = '2025-11-01T00:00:00Z';
const UNTIL = '2026-05-01T00:00:00Z';

const [costs, orders] = await Promise.all([
  fetchAll('product_costs', q =>
    q.select('product_title, variant_title, unit_cost, sku, shopify_variant_id')
     .eq('store_id', SHOP)
  ),
  fetchAll('orders', q =>
    q.select('tracking_number, order_ref_number, order_detail, transaction_date, cogs_total, cogs_matched, cogs_match_source, items, invoice_payment, is_delivered, is_returned, is_in_transit, transaction_status')
     .eq('store_id', SHOP)
     .gte('transaction_date', SINCE)
     .lt('transaction_date', UNTIL)
     .order('transaction_date', { ascending: true })
  ),
]);

console.log(`product_costs: ${costs.length}`);
console.log(`orders (Nov 2025 - Apr 2026): ${orders.length}`);

writeFileSync('scripts/_data_product_costs.json', JSON.stringify(costs, null, 2));
writeFileSync('scripts/_data_orders_6mo.json', JSON.stringify(orders, null, 2));

// Also build a per-month summary of unique order_detail strings + counts
const byMonth = {};
for (const o of orders) {
  const m = o.transaction_date.slice(0, 7); // YYYY-MM
  byMonth[m] ??= { count: 0, lines: new Map() };
  byMonth[m].count++;
  const key = (o.order_detail || '').trim();
  byMonth[m].lines.set(key, (byMonth[m].lines.get(key) || 0) + 1);
}

const summary = {};
for (const [m, v] of Object.entries(byMonth)) {
  summary[m] = {
    orderCount: v.count,
    uniqueDetailCount: v.lines.size,
    lines: Object.fromEntries([...v.lines.entries()].sort((a, b) => b[1] - a[1])),
  };
}
writeFileSync('scripts/_data_orders_by_month.json', JSON.stringify(summary, null, 2));

console.log('\nPer-month order count:');
for (const [m, v] of Object.entries(summary)) {
  console.log(`  ${m}: ${v.orderCount} orders, ${v.uniqueDetailCount} unique detail strings`);
}
