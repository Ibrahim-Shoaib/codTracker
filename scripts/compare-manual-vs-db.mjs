import { readFileSync } from 'node:fs';

const orders = JSON.parse(readFileSync('scripts/_data_orders_6mo.json', 'utf8'));
const manual = JSON.parse(readFileSync('scripts/_manual_cogs_result.json', 'utf8'));

const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04'];

const dbByMonth = {};
const sourceByMonth = {};
for (const m of months) {
  dbByMonth[m] = { sum: 0, n: 0 };
  sourceByMonth[m] = {};
}

for (const o of orders) {
  const m = o.transaction_date.slice(0, 7);
  if (!dbByMonth[m]) continue;
  dbByMonth[m].sum += Number(o.cogs_total) || 0;
  dbByMonth[m].n   += 1;
  const src = o.cogs_match_source || 'unknown';
  sourceByMonth[m][src] = (sourceByMonth[m][src] || 0) + 1;
}

console.log('============================================================');
console.log('MANUAL vs CURRENT DB cogs_total — past 6 months');
console.log('============================================================\n');
console.log('Month     | Orders |    Manual COGS |        DB COGS |        Δ (DB − Manual)');
console.log('----------|--------|----------------|----------------|------------------------');
let totMan = 0, totDb = 0;
for (const m of months) {
  const manTot = manual[m].cogsTotal;
  const dbTot  = dbByMonth[m].sum;
  totMan += manTot; totDb += dbTot;
  const delta = dbTot - manTot;
  const sign = delta > 0 ? '+' : '';
  console.log(
    `${m}   |  ${String(manual[m].orderCount).padStart(4)}  | ${String(manTot.toLocaleString()).padStart(14)} | ${String(dbTot.toLocaleString()).padStart(14)} | ${sign}${delta.toLocaleString()}`
  );
}
console.log('----------|--------|----------------|----------------|------------------------');
console.log(`TOTAL     |        | ${String(totMan.toLocaleString()).padStart(14)} | ${String(totDb.toLocaleString()).padStart(14)} | ${(totDb - totMan > 0 ? '+' : '')}${(totDb - totMan).toLocaleString()}`);

console.log('\n--- DB cogs_match_source distribution per month ---');
for (const m of months) {
  const parts = Object.entries(sourceByMonth[m]).map(([k, v]) => `${k}=${v}`).join('  ');
  console.log(`  ${m}:  ${parts}`);
}
