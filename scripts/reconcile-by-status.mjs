// Break sales/COGS down by delivery status to figure out exactly what
// the dashboard is summing.
import { readFileSync } from 'node:fs';
import { parseOrderDetail } from '../app/lib/cogs.server.js';
import { manualUnitCost } from './manual-cogs-fn.mjs';

const orders = JSON.parse(readFileSync('scripts/_data_orders_6mo.json', 'utf8'));
const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04'];

function bucket(o) {
  if (o.is_delivered)  return 'delivered';
  if (o.is_returned)   return 'returned';
  if (o.is_in_transit) return 'inTransit';
  return 'other';
}

const buckets = ['delivered', 'returned', 'inTransit', 'other'];
const rs = {};
for (const m of months) {
  rs[m] = {};
  for (const b of buckets) rs[m][b] = { n: 0, sales: 0, manual: 0, db: 0 };
}

for (const o of orders) {
  const m = o.transaction_date.slice(0, 7);
  if (!rs[m]) continue;
  const b = bucket(o);
  const items = parseOrderDetail(o.order_detail || '');
  let cogs = 0;
  for (const it of items) cogs += manualUnitCost(it.name).unit_cost * it.quantity;
  rs[m][b].n     += 1;
  rs[m][b].sales += Number(o.invoice_payment) || 0;
  rs[m][b].manual+= cogs;
  rs[m][b].db    += Number(o.cogs_total) || 0;
}

const fmt = n => String(n.toLocaleString()).padStart(11);

console.log('Per-month per-status breakdown.\n');
console.log('Month   Status     |  N  |   Sales (inv) |  ManualCOGS |    DB COGS');
console.log('--------|-----------|-----|---------------|-------------|------------');
for (const m of months) {
  for (const b of buckets) {
    const r = rs[m][b];
    if (!r.n) continue;
    console.log(
      `${m} ${b.padEnd(10)}| ${String(r.n).padStart(3)} | ${fmt(r.sales)} | ${fmt(r.manual)} | ${fmt(r.db)}`
    );
  }
  console.log('--------|-----------|-----|---------------|-------------|------------');
}

console.log('\n=== Summed views to test against dashboard ===');
const dash = {
  '2025-12': { sales: 778700, cogs: 567451, orders: 221 },
  '2026-01': { sales: 506615, cogs: 374053, orders: 119 },
  '2026-02': { sales: 1046826, cogs: 632792, orders: 279 },
  '2026-03': { sales: 1014219, cogs: 542284, orders: 265 },
};
for (const [m, d] of Object.entries(dash)) {
  const del = rs[m].delivered;
  const ret = rs[m].returned;
  const dPlusR = del.n + ret.n;
  console.log(`\n${m}  dashboard: orders=${d.orders} sales=${d.sales.toLocaleString()} cogs=${d.cogs.toLocaleString()}`);
  console.log(`  delivered only:        n=${del.n} sales=${del.sales.toLocaleString()} manualCogs=${del.manual.toLocaleString()} dbCogs=${del.db.toLocaleString()}`);
  console.log(`  delivered + returned:  n=${dPlusR} sales=${(del.sales + ret.sales).toLocaleString()} manualCogs=${(del.manual + ret.manual).toLocaleString()} dbCogs=${(del.db + ret.db).toLocaleString()}`);
}
