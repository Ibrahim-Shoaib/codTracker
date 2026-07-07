// Round-2 probe: cancellations, repeat customers, product profitability,
// day-of-week + hour patterns. Pakistan COD specifics.
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const SHOP = 'the-trendy-homes-pk.myshopify.com';

function box(t) { console.log('\n' + '═'.repeat(72) + '\n ' + t + '\n' + '═'.repeat(72)); }

// 1) status × flag matrix — which statuses fall into which is_* bucket
box('STATUS × FLAG MATRIX (last 30k orders)');
const { data: statusRows } = await supabase
  .from('orders')
  .select('transaction_status, is_delivered, is_returned, is_in_transit')
  .eq('store_id', SHOP)
  .limit(30000);
const matrix = {};
for (const r of statusRows ?? []) {
  const flag = r.is_delivered ? 'delivered'
             : r.is_returned ? 'returned'
             : r.is_in_transit ? 'in_transit'
             : 'NONE';
  const key = `${r.transaction_status} → ${flag}`;
  matrix[key] = (matrix[key] ?? 0) + 1;
}
Object.entries(matrix).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
  console.log(`  ${k.padEnd(50)} ${v.toLocaleString()}`));

// 2) Repeat customer rate (group by customer_name across delivered orders)
box('REPEAT CUSTOMER ANALYSIS (ALL TIME, delivered only)');
const { data: custRows } = await supabase
  .from('orders')
  .select('customer_name, invoice_payment, transaction_date')
  .eq('store_id', SHOP)
  .eq('is_delivered', true)
  .limit(50000);
const byCust = {};
for (const r of custRows ?? []) {
  const k = (r.customer_name ?? '').trim().toLowerCase();
  if (!k) continue;
  byCust[k] = byCust[k] ?? { count: 0, sales: 0 };
  byCust[k].count++;
  byCust[k].sales += Number(r.invoice_payment ?? 0);
}
const totalCust = Object.keys(byCust).length;
const repeatCust = Object.values(byCust).filter(c => c.count > 1).length;
const ordersFromRepeat = Object.values(byCust)
  .filter(c => c.count > 1)
  .reduce((s, c) => s + c.count, 0);
const totalDelivered = Object.values(byCust).reduce((s, c) => s + c.count, 0);
console.log(`Distinct customers: ${totalCust.toLocaleString()}`);
console.log(`Repeat customers (≥2 orders): ${repeatCust.toLocaleString()}  (${((repeatCust/totalCust)*100).toFixed(1)}%)`);
console.log(`Orders from repeat: ${ordersFromRepeat.toLocaleString()} of ${totalDelivered.toLocaleString()}  (${((ordersFromRepeat/totalDelivered)*100).toFixed(1)}%)`);
console.log('Top 5 repeat customers:');
Object.entries(byCust).sort((a, b) => b[1].count - a[1].count).slice(0, 5)
  .forEach(([n, c]) => console.log(`  ${n.padEnd(30)} ${c.count} orders, PKR ${Math.round(c.sales).toLocaleString()}`));

// 3) Product-level profitability via line_items JSONB
box('TOP PRODUCTS BY DELIVERED ORDERS (variant rollup)');
const { data: liRows } = await supabase
  .from('orders')
  .select('line_items, invoice_payment, cogs_total, is_delivered, is_returned')
  .eq('store_id', SHOP)
  .or('is_delivered.eq.true,is_returned.eq.true')
  .limit(50000);

const variantStats = {};
for (const r of liRows ?? []) {
  if (!Array.isArray(r.line_items)) continue;
  for (const li of r.line_items) {
    const v = String(li.variant_id ?? '');
    if (!v) continue;
    variantStats[v] = variantStats[v] ?? { delivered: 0, returned: 0, units: 0 };
    if (r.is_delivered) variantStats[v].delivered += Number(li.quantity ?? 1);
    if (r.is_returned)  variantStats[v].returned  += Number(li.quantity ?? 1);
    variantStats[v].units += Number(li.quantity ?? 1);
  }
}
// Join to product_costs for titles
const variantIds = Object.keys(variantStats);
const { data: pcRows } = await supabase
  .from('product_costs')
  .select('shopify_variant_id, product_title, variant_title, unit_cost')
  .eq('store_id', SHOP)
  .in('shopify_variant_id', variantIds.slice(0, 200));
const pcMap = {};
for (const p of pcRows ?? []) pcMap[p.shopify_variant_id] = p;
console.log(`Distinct variants seen: ${variantIds.length}`);
console.log('Top 15 by delivered units:');
Object.entries(variantStats)
  .sort((a, b) => b[1].delivered - a[1].delivered)
  .slice(0, 15)
  .forEach(([v, s]) => {
    const pc = pcMap[v];
    const title = pc ? `${pc.product_title} / ${pc.variant_title}` : '(unknown)';
    console.log(`  ${title.slice(0, 50).padEnd(50)} D=${s.delivered}  R=${s.returned}  cost=${pc?.unit_cost ?? '?'}`);
  });

// 4) Day-of-week pattern (delivered)
box('DAY-OF-WEEK PATTERN (transaction_date, delivered + returned)');
const { data: dowRows } = await supabase
  .from('orders')
  .select('transaction_date, is_delivered, is_returned')
  .eq('store_id', SHOP)
  .or('is_delivered.eq.true,is_returned.eq.true')
  .limit(50000);
const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const dowStats = Array.from({ length: 7 }, () => ({ d: 0, r: 0 }));
for (const r of dowRows ?? []) {
  const d = new Date(r.transaction_date);
  const idx = d.getUTCDay();
  if (r.is_delivered) dowStats[idx].d++;
  if (r.is_returned)  dowStats[idx].r++;
}
dowStats.forEach((s, i) => {
  const total = s.d + s.r;
  const rate  = total > 0 ? ((s.r/total)*100).toFixed(1) : 'N/A';
  console.log(`  ${dow[i]}  delivered=${String(s.d).padStart(4)}  returned=${String(s.r).padStart(3)}  return_rate=${rate}%`);
});

// 5) AOV distribution — to see how concentrated the sales are
box('AOV DISTRIBUTION (delivered orders)');
const { data: aovRows } = await supabase
  .from('orders').select('invoice_payment')
  .eq('store_id', SHOP).eq('is_delivered', true).limit(50000);
const vals = (aovRows ?? []).map(r => Number(r.invoice_payment ?? 0)).sort((a,b)=>a-b);
function pct(arr, p) { return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]; }
console.log(`n=${vals.length}`);
console.log(`Min:    PKR ${vals[0]?.toLocaleString()}`);
console.log(`P10:    PKR ${pct(vals, 0.10)?.toLocaleString()}`);
console.log(`P50:    PKR ${pct(vals, 0.50)?.toLocaleString()}`);
console.log(`P90:    PKR ${pct(vals, 0.90)?.toLocaleString()}`);
console.log(`P99:    PKR ${pct(vals, 0.99)?.toLocaleString()}`);
console.log(`Max:    PKR ${vals[vals.length-1]?.toLocaleString()}`);

// 6) Cancelled orders — wasted ad spend?
box('CANCELLED ORDER ECONOMICS');
const { data: cancelRows } = await supabase
  .from('orders')
  .select('invoice_payment, items, transaction_date, transaction_status, is_delivered, is_returned, is_in_transit')
  .eq('store_id', SHOP)
  .eq('transaction_status', 'Cancelled')
  .limit(10000);
console.log(`Cancelled total: ${cancelRows?.length}`);
const cancelSales = (cancelRows ?? []).reduce((s, r) => s + Number(r.invoice_payment ?? 0), 0);
const cancelDelivered = (cancelRows ?? []).filter(r => r.is_delivered).length;
const cancelReturned  = (cancelRows ?? []).filter(r => r.is_returned).length;
const cancelTransit   = (cancelRows ?? []).filter(r => r.is_in_transit).length;
const cancelNone      = (cancelRows ?? []).filter(r => !r.is_delivered && !r.is_returned && !r.is_in_transit).length;
console.log(`Cancelled invoice value (lost): PKR ${Math.round(cancelSales).toLocaleString()}`);
console.log(`  flag=delivered: ${cancelDelivered}, returned: ${cancelReturned}, in_transit: ${cancelTransit}, none: ${cancelNone}`);

// 7) cogs match sources (for warning banner sizing)
box('COGS MATCH SOURCES');
const { data: matchRows } = await supabase
  .from('orders').select('cogs_match_source')
  .eq('store_id', SHOP).limit(50000);
const matchCounts = {};
for (const r of matchRows ?? []) {
  matchCounts[r.cogs_match_source ?? 'NULL'] = (matchCounts[r.cogs_match_source ?? 'NULL'] ?? 0) + 1;
}
Object.entries(matchCounts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
  console.log(`  ${k.padEnd(20)} ${v.toLocaleString()}`));

// 8) Time-of-day pattern — when do orders come in?
box('HOUR-OF-DAY (delivered, UTC; PKT = UTC+5)');
const hours = Array.from({ length: 24 }, () => 0);
for (const r of liRows ?? []) {
  if (!r.is_delivered) continue;
  // re-pull date — liRows didn't include transaction_date
}
// Use dowRows which has transaction_date
const hourStats = Array.from({ length: 24 }, () => 0);
for (const r of dowRows ?? []) {
  if (!r.is_delivered) continue;
  const h = new Date(r.transaction_date).getUTCHours();
  hourStats[h]++;
}
console.log('Hour (UTC)  delivered_count');
hourStats.forEach((c, h) => console.log(`  ${String(h).padStart(2,'0')}:00  ${'█'.repeat(Math.round(c/Math.max(...hourStats)*40))}  ${c}`));

console.log('\n=== DONE ===');
