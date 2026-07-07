// Apply the explicit one-by-one decisions to every order, compute COGS per
// month and per status. Print full audit so anyone can verify each pick.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseOrderDetail } from '../app/lib/cogs.server.js';
import { decisions, decisionMap } from './onebyone-decisions.mjs';

const orders = JSON.parse(readFileSync('scripts/_data_orders_6mo.json', 'utf8'));
const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04'];

// 1) Sanity check: every line item across 6 months has a decision row.
const allItems = new Set();
for (const o of orders) {
  for (const it of parseOrderDetail(o.order_detail || '')) {
    allItems.add(it.name);
  }
}
const missing = [...allItems].filter(n => !decisionMap.has(n));
const unused  = decisions.filter(d => !allItems.has(d.n)).map(d => d.n);

console.log(`Decisions: ${decisions.length}`);
console.log(`Unique line items in 6mo orders: ${allItems.size}`);
console.log(`Decisions WITHOUT a matching line item (typos / extras): ${unused.length}`);
console.log(`Line items WITHOUT a decision (BUG): ${missing.length}`);
if (missing.length) {
  console.log('  Missing:', missing);
}

// 2) Per-month, per-status COGS using the one-by-one table.
function bucket(o) {
  if (o.is_delivered)  return 'delivered';
  if (o.is_returned)   return 'returned';
  if (o.is_in_transit) return 'inTransit';
  return 'other';
}
const buckets = ['delivered', 'returned', 'inTransit', 'other'];
const rs = {};
for (const m of months) { rs[m] = {}; for (const b of buckets) rs[m][b] = { n: 0, sales: 0, cogs: 0 }; }

let unmatchedItemCount = 0;
for (const o of orders) {
  const m = o.transaction_date.slice(0, 7);
  if (!rs[m]) continue;
  const b = bucket(o);
  let cogs = 0;
  for (const it of parseOrderDetail(o.order_detail || '')) {
    const d = decisionMap.get(it.name);
    if (!d) continue;
    if (d.c === 0) unmatchedItemCount++;
    cogs += d.c * it.quantity;
  }
  rs[m][b].n     += 1;
  rs[m][b].sales += Number(o.invoice_payment) || 0;
  rs[m][b].cogs  += cogs;
}

console.log(`\nLine items with cost=0 (NA/return/Mega Offer/plush blanket): ${unmatchedItemCount}`);

const fmt = n => String(Math.round(n).toLocaleString()).padStart(13);

console.log('\n=== ONE-BY-ONE COGS by month, by delivery status ===');
console.log('Month   Status     |  N  |   Sales (inv) |  Hand-matched COGS');
console.log('--------|-----------|-----|---------------|-------------------');
for (const m of months) {
  for (const b of buckets) {
    const r = rs[m][b];
    if (!r.n) continue;
    console.log(`${m} ${b.padEnd(10)}| ${String(r.n).padStart(3)} | ${fmt(r.sales)} | ${fmt(r.cogs)}`);
  }
  console.log('--------|-----------|-----|---------------|-------------------');
}

// 3) Roll-up: delivered-only and delivered+returned (the dashboard uses delivered for sales).
console.log('\n=== Roll-up by month ===');
console.log('Month   | Delivered N | Delivered Sales | Delivered COGS | Del+Returned N | Del+Ret COGS | All COGS (incl. transit)');
console.log('--------|-------------|-----------------|----------------|----------------|--------------|-------------------------');
for (const m of months) {
  const d = rs[m].delivered, r = rs[m].returned, t = rs[m].inTransit;
  const allCogs = d.cogs + r.cogs + t.cogs;
  console.log(
    `${m} |   ${String(d.n).padStart(7)}   | ${fmt(d.sales)}   | ${fmt(d.cogs)} |    ${String(d.n + r.n).padStart(7)}     | ${fmt(d.cogs + r.cogs)} | ${fmt(allCogs)}`
  );
}

// 4) Write the full per-decision audit (so user can spot-check picks)
const auditLines = ['# One-by-one match audit', `# Total decisions: ${decisions.length}`, ''];
auditLines.push('cost   | line item                                                                  | picked from product_costs                | note');
auditLines.push('-------|----------------------------------------------------------------------------|------------------------------------------|------');
for (const d of decisions.sort((a, b) => b.c - a.c || a.n.localeCompare(b.n))) {
  auditLines.push(
    `${String(d.c).padStart(6)} | ${d.n.padEnd(74).slice(0, 74)} | ${(d.pick ?? '').padEnd(40).slice(0, 40)} | ${d.note ?? ''}`
  );
}
writeFileSync('scripts/_onebyone_audit.txt', auditLines.join('\n'));
console.log('\nFull audit table → scripts/_onebyone_audit.txt');
