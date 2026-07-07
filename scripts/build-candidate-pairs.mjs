// For every unique line item across 6 months, list the top 5 product_costs
// candidates by token-overlap score. Output a workbook I can step through.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseOrderDetail } from '../app/lib/cogs.server.js';

const orders = JSON.parse(readFileSync('scripts/_data_orders_6mo.json', 'utf8'));
const costs  = JSON.parse(readFileSync('scripts/_data_product_costs.json', 'utf8'));

function tok(s) {
  return new Set((s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean));
}

function score(aTok, bTok) {
  let inter = 0;
  for (const t of aTok) if (bTok.has(t)) inter++;
  const denom = Math.max(aTok.size, bTok.size, 1);
  return inter / denom;
}

const costRows = costs.map(c => ({
  ...c,
  fullText: `${c.product_title ?? ''} ${c.variant_title ?? ''}`,
  tokens: tok(`${c.product_title ?? ''} ${c.variant_title ?? ''}`),
}));

// Collect every unique (qty, name) line item with total occurrence + months
const uniq = new Map();
for (const o of orders) {
  const m = o.transaction_date.slice(0, 7);
  const items = parseOrderDetail(o.order_detail || '');
  for (const it of items) {
    const key = `${it.quantity}|||${it.name}`;
    if (!uniq.has(key)) uniq.set(key, { qty: it.quantity, name: it.name, count: 0, months: new Map() });
    const u = uniq.get(key);
    u.count++;
    u.months.set(m, (u.months.get(m) || 0) + 1);
  }
}

const all = [...uniq.values()].sort((a, b) => b.count - a.count);

const out = [];
for (const u of all) {
  const qTok = tok(u.name);
  const ranked = costRows
    .map(c => ({ row: c, sc: score(qTok, c.tokens) }))
    .filter(x => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 6);

  out.push({
    qty: u.qty,
    name: u.name,
    occurrences: u.count,
    monthsSeen: Object.fromEntries(u.months),
    candidates: ranked.map(r => ({
      score: +r.sc.toFixed(2),
      cost: r.row.unit_cost,
      product_title: r.row.product_title,
      variant_title: r.row.variant_title,
      sku: r.row.sku,
    })),
  });
}

writeFileSync('scripts/_pairs_workbook.json', JSON.stringify(out, null, 2));

// Also a compact text view I can scan
const lines = [];
for (const u of out) {
  lines.push(`\n[${u.occurrences}× qty=${u.qty}] ${u.name}`);
  if (u.candidates.length === 0) {
    lines.push('   (no candidates)');
    continue;
  }
  for (const c of u.candidates) {
    lines.push(`   ${c.score.toFixed(2)}  cost=${String(c.cost).padStart(5)}  ${c.product_title}  |  ${c.variant_title}`);
  }
}
writeFileSync('scripts/_pairs_workbook.txt', lines.join('\n'));

console.log(`Built workbook for ${all.length} unique line items.`);
console.log('See scripts/_pairs_workbook.txt and .json');
