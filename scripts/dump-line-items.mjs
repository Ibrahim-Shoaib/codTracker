import { readFileSync, writeFileSync } from 'node:fs';
import { parseOrderDetail } from '../app/lib/cogs.server.js';

const orders = JSON.parse(readFileSync('scripts/_data_orders_6mo.json', 'utf8'));
const costs  = JSON.parse(readFileSync('scripts/_data_product_costs.json', 'utf8'));

// Per-month list of unique parsed line items with counts.
// Key = `${qty}::${name}` so we keep the qty distinct (a 2-pack vs a single).
const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04'];
const lineByMonth = Object.fromEntries(months.map(m => [m, new Map()]));

// Also: every unique (qty, name) across the whole 6 months -> total occurrences
const allUnique = new Map();

for (const o of orders) {
  const m = o.transaction_date.slice(0, 7);
  if (!lineByMonth[m]) continue;
  const items = parseOrderDetail(o.order_detail || '');
  for (const it of items) {
    const key = `${it.quantity}::${it.name}`;
    lineByMonth[m].set(key, (lineByMonth[m].get(key) || 0) + 1);
    allUnique.set(key, (allUnique.get(key) || 0) + 1);
  }
}

// Output a single, human-scannable text file
const lines = [];
lines.push('================ UNIQUE LINE ITEMS ACROSS 6 MONTHS ================');
lines.push(`Total unique (qty, name) keys: ${allUnique.size}\n`);
const sorted = [...allUnique.entries()].sort((a, b) => b[1] - a[1]);
for (const [key, c] of sorted) {
  const [qty, name] = key.split('::');
  lines.push(`  ${String(c).padStart(4)}× | qty=${qty} | ${name}`);
}

lines.push('\n================ UNIQUE LINE ITEMS PER MONTH ================');
for (const m of months) {
  const map = lineByMonth[m];
  lines.push(`\n--- ${m} (${[...map.values()].reduce((a, b) => a + b, 0)} line-item occurrences across ${map.size} unique) ---`);
  const ms = [...map.entries()].sort((a, b) => b[1] - a[1]);
  for (const [key, c] of ms) {
    const [qty, name] = key.split('::');
    lines.push(`  ${String(c).padStart(4)}× | qty=${qty} | ${name}`);
  }
}

writeFileSync('scripts/_unique_line_items.txt', lines.join('\n'));
console.log(`Wrote scripts/_unique_line_items.txt (${lines.length} lines, ${allUnique.size} unique keys)`);

// Also dump the product_costs in a flat readable form
const cl = [];
cl.push('================ PRODUCT_COSTS (505 rows) ================');
const sortedCosts = [...costs].sort((a, b) =>
  (a.product_title ?? '').localeCompare(b.product_title ?? '') ||
  (a.variant_title ?? '').localeCompare(b.variant_title ?? '')
);
for (const c of sortedCosts) {
  cl.push(`  cost=${String(c.unit_cost).padStart(6)}  sku=${(c.sku ?? '').padEnd(10)}  ${c.product_title}  |  ${c.variant_title}`);
}
writeFileSync('scripts/_product_costs.txt', cl.join('\n'));
console.log(`Wrote scripts/_product_costs.txt`);
