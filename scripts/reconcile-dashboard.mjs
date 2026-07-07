// Reconcile against dashboard — exclude in_transit orders.
// Dashboard fields: "Orders" (completed = delivered + returned), "In Transit" shown separately.
import { readFileSync } from 'node:fs';
import { parseOrderDetail } from '../app/lib/cogs.server.js';

const orders = JSON.parse(readFileSync('scripts/_data_orders_6mo.json', 'utf8'));

// Re-import the manual mapping function. Easiest: dynamic import the module.
const { manualUnitCost } = await (async () => {
  const mod = await import('./manual-cogs-fn.mjs').catch(() => null);
  if (mod) return mod;
  // inline copy not desired — instead, just pull the function out of the script via re-export
  throw new Error('use manual-cogs-fn.mjs');
})();

const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04'];

function bucket(o) {
  if (o.is_delivered) return 'delivered';
  if (o.is_returned)  return 'returned';
  if (o.is_in_transit) return 'inTransit';
  return 'other';
}

const results = {};
for (const m of months) {
  results[m] = {
    completed: { n: 0, sales: 0, manualCogs: 0, dbCogs: 0 },
    inTransit: { n: 0, sales: 0, manualCogs: 0, dbCogs: 0 },
    delivered: { n: 0 },
    returned:  { n: 0 },
    other:     { n: 0 },
  };
}

for (const o of orders) {
  const m = o.transaction_date.slice(0, 7);
  if (!results[m]) continue;
  const b = bucket(o);
  results[m][b].n++;

  const items = parseOrderDetail(o.order_detail || '');
  let cogs = 0;
  for (const it of items) {
    const { unit_cost } = manualUnitCost(it.name);
    cogs += unit_cost * it.quantity;
  }
  const sales = Number(o.invoice_payment) || 0;
  const dbCogs = Number(o.cogs_total) || 0;

  if (b === 'inTransit') {
    results[m].inTransit.sales      += sales;
    results[m].inTransit.manualCogs += cogs;
    results[m].inTransit.dbCogs     += dbCogs;
  } else {
    results[m].completed.n          += 1;
    results[m].completed.sales      += sales;
    results[m].completed.manualCogs += cogs;
    results[m].completed.dbCogs     += dbCogs;
  }
}

console.log('=== Reconciliation: COMPLETED ORDERS ONLY (excluding in-transit) ===\n');
console.log('Month     | Completed | Sales (PKR)   | Manual COGS  | DB COGS      | Δ (DB - Manual)');
console.log('----------|-----------|---------------|--------------|--------------|----------------');
for (const m of months) {
  const c = results[m].completed;
  const delta = c.dbCogs - c.manualCogs;
  console.log(
    `${m}   |    ${String(c.n).padStart(5)}  | ${String(c.sales.toLocaleString()).padStart(13)} | ${String(c.manualCogs.toLocaleString()).padStart(12)} | ${String(c.dbCogs.toLocaleString()).padStart(12)} | ${(delta >= 0 ? '+' : '')}${delta.toLocaleString()}`
  );
}

console.log('\n=== Per-month breakdown ===');
for (const m of months) {
  const r = results[m];
  console.log(`${m}: delivered=${r.delivered.n}  returned=${r.returned.n}  in_transit=${r.inTransit.n}  other=${r.other.n}  TOTAL=${r.completed.n + r.inTransit.n}`);
}
