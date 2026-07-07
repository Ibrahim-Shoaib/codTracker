// Probe what data we actually have so we can recommend dashboard sections
// grounded in real attributes, not just schema.
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function box(title) {
  console.log('\n' + '═'.repeat(72));
  console.log(' ' + title);
  console.log('═'.repeat(72));
}

// 1) Stores — how many merchants, how mature
box('STORES');
const { data: stores } = await supabase
  .from('stores')
  .select('store_id, onboarding_complete, sellable_returns_pct, last_postex_sync_at, created_at, meta_access_token');
console.log(`Total stores: ${stores?.length}`);
for (const s of stores ?? []) {
  console.log(`  ${s.store_id.padEnd(45)}  onboarded=${s.onboarding_complete}  meta=${!!s.meta_access_token}  sellable=${s.sellable_returns_pct}`);
}

// Pick the most active store for downstream probes
const SHOP = stores?.[0]?.store_id;
if (!SHOP) { console.log('No store, aborting'); process.exit(0); }
box(`USING STORE: ${SHOP}`);

// 2) Orders — full column list + sample
box('ORDERS — schema + sample');
const { data: oneOrder } = await supabase.from('orders').select('*').eq('store_id', SHOP).limit(1);
const cols = Object.keys(oneOrder?.[0] ?? {}).sort();
console.log(`Columns (${cols.length}):`);
console.log('  ' + cols.join(', '));

const sample = oneOrder?.[0];
if (sample) {
  console.log('\nSample row:');
  for (const k of cols) {
    let v = sample[k];
    if (typeof v === 'string' && v.length > 80) v = v.slice(0, 77) + '…';
    if (v && typeof v === 'object') v = JSON.stringify(v).slice(0, 120);
    console.log(`  ${k.padEnd(30)} ${String(v)}`);
  }
}

// 3) Total orders + status distribution
box('ORDER STATUS DISTRIBUTION');
const { count: totalOrders } = await supabase
  .from('orders').select('*', { count: 'exact', head: true }).eq('store_id', SHOP);
console.log(`Total orders: ${totalOrders?.toLocaleString()}`);

const { data: statusDist } = await supabase
  .from('orders')
  .select('transaction_status')
  .eq('store_id', SHOP)
  .limit(50000);
const statusCounts = {};
for (const r of statusDist ?? []) {
  statusCounts[r.transaction_status] = (statusCounts[r.transaction_status] ?? 0) + 1;
}
console.log('\ntransaction_status:');
Object.entries(statusCounts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
  console.log(`  ${(k ?? 'NULL').padEnd(30)} ${v.toLocaleString()}`));

// 4) Date range
box('DATE RANGE');
const { data: oldest } = await supabase
  .from('orders').select('transaction_date').eq('store_id', SHOP)
  .order('transaction_date', { ascending: true }).limit(1);
const { data: newest } = await supabase
  .from('orders').select('transaction_date').eq('store_id', SHOP)
  .order('transaction_date', { ascending: false }).limit(1);
console.log(`Oldest: ${oldest?.[0]?.transaction_date}`);
console.log(`Newest: ${newest?.[0]?.transaction_date}`);

// 5) Cities distribution
box('TOP CITIES BY VOLUME');
const { data: cityRows } = await supabase
  .from('orders').select('city_name').eq('store_id', SHOP).limit(50000);
const cityCounts = {};
for (const r of cityRows ?? []) {
  const c = (r.city_name ?? 'Unknown').trim();
  cityCounts[c] = (cityCounts[c] ?? 0) + 1;
}
const cityList = Object.entries(cityCounts).sort((a, b) => b[1] - a[1]);
console.log(`Distinct cities: ${cityList.length}`);
console.log('Top 15:');
cityList.slice(0, 15).forEach(([c, n]) => console.log(`  ${c.padEnd(30)} ${n.toLocaleString()}`));

// 6) AOV / sales / cogs sanity
box('FINANCIAL SAMPLE (last 30d delivered)');
const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
const { data: recentDelivered } = await supabase
  .from('orders')
  .select('invoice_payment, items, cogs_total, transaction_fee, transaction_tax, reversal_fee, reversal_tax, is_delivered, is_returned, is_in_transit, transaction_date')
  .eq('store_id', SHOP)
  .gte('transaction_date', cutoff.toISOString())
  .limit(50000);

let dCount = 0, rCount = 0, tCount = 0;
let salesSum = 0, cogsSum = 0, shipFwdSum = 0, shipRevSum = 0, taxSum = 0, unitsSum = 0;
for (const o of recentDelivered ?? []) {
  if (o.is_delivered) {
    dCount++;
    salesSum += Number(o.invoice_payment ?? 0);
    cogsSum  += Number(o.cogs_total ?? 0);
    unitsSum += Number(o.items ?? 0);
  } else if (o.is_returned) rCount++;
  else if (o.is_in_transit) tCount++;
  shipFwdSum += Number(o.transaction_fee ?? 0);
  shipRevSum += Number(o.reversal_fee ?? 0);
  taxSum     += Number(o.transaction_tax ?? 0) + Number(o.reversal_tax ?? 0);
}
console.log(`Delivered: ${dCount}  Returned: ${rCount}  In transit: ${tCount}`);
console.log(`Sales:     PKR ${Math.round(salesSum).toLocaleString()}`);
console.log(`COGS:      PKR ${Math.round(cogsSum).toLocaleString()}`);
console.log(`Forward shipping: PKR ${Math.round(shipFwdSum).toLocaleString()}`);
console.log(`Reverse shipping: PKR ${Math.round(shipRevSum).toLocaleString()}`);
console.log(`Tax:              PKR ${Math.round(taxSum).toLocaleString()}`);
console.log(`AOV: PKR ${dCount > 0 ? Math.round(salesSum / dCount).toLocaleString() : 'N/A'}`);
console.log(`Avg units/order: ${dCount > 0 ? (unitsSum / dCount).toFixed(2) : 'N/A'}`);
console.log(`Return rate: ${(dCount + rCount) > 0 ? ((rCount / (dCount + rCount)) * 100).toFixed(1) + '%' : 'N/A'}`);

// 7) Line items table — what dimensions are available for product-level analysis
box('LINE_ITEMS — schema + sample');
const { data: oneLI } = await supabase.from('line_items').select('*').limit(1);
const liCols = Object.keys(oneLI?.[0] ?? {}).sort();
console.log(`Columns (${liCols.length}): ${liCols.join(', ')}`);
const { count: liCount } = await supabase
  .from('line_items').select('*', { count: 'exact', head: true });
console.log(`Total rows (all stores): ${liCount?.toLocaleString()}`);

// 8) Product costs (variant-level COGS reference)
box('PRODUCT_COSTS — schema + sample');
const { data: onePC } = await supabase.from('product_costs').select('*').eq('store_id', SHOP).limit(1);
const pcCols = Object.keys(onePC?.[0] ?? {}).sort();
console.log(`Columns: ${pcCols.join(', ')}`);
const { count: pcCount } = await supabase
  .from('product_costs').select('*', { count: 'exact', head: true }).eq('store_id', SHOP);
console.log(`Rows for store: ${pcCount}`);
console.log('Sample:', JSON.stringify(onePC?.[0], null, 2));

// 9) Ad spend
box('AD_SPEND — schema + recent');
const { data: oneAS } = await supabase.from('ad_spend').select('*').eq('store_id', SHOP).limit(1);
console.log(`Columns: ${Object.keys(oneAS?.[0] ?? {}).sort().join(', ')}`);
console.log('Sample:', JSON.stringify(oneAS?.[0], null, 2));
const { data: recentAS } = await supabase
  .from('ad_spend').select('spend_date, amount, currency').eq('store_id', SHOP)
  .order('spend_date', { ascending: false }).limit(10);
console.log('Last 10 spend rows:');
recentAS?.forEach(r => console.log(`  ${r.spend_date}  ${r.currency ?? ''} ${r.amount}`));

// 10) Daily snapshots — exists?
box('DAILY_SNAPSHOTS');
const { data: oneSnap, error: snapErr } = await supabase
  .from('daily_snapshots').select('*').limit(1);
if (snapErr) console.log('Error:', snapErr.message);
else {
  console.log(`Columns: ${Object.keys(oneSnap?.[0] ?? {}).sort().join(', ')}`);
  const { count: snapCount } = await supabase
    .from('daily_snapshots').select('*', { count: 'exact', head: true });
  console.log(`Total snapshots: ${snapCount}`);
  console.log('Sample:', JSON.stringify(oneSnap?.[0], null, 2));
}

// 11) Store_expenses — what merchants are tracking
box('STORE_EXPENSES (per-merchant custom expenses)');
const { data: expRows } = await supabase
  .from('store_expenses').select('store_id, name, amount, type, created_at');
console.log(`Total expense rows: ${expRows?.length}`);
const byStore = {};
for (const e of expRows ?? []) {
  byStore[e.store_id] = byStore[e.store_id] ?? [];
  byStore[e.store_id].push(`${e.type}:${e.name}=${e.amount}`);
}
for (const [s, list] of Object.entries(byStore)) {
  console.log(`  ${s}:`);
  list.forEach(x => console.log(`    ${x}`));
}

// 12) Payment methods — Pakistan-specific signal
box('PAYMENT METHODS (cod vs prepaid)');
// Look for any payment-method-like field in the order sample
const paymentLike = cols.filter(c => /pay|method|cod|prepaid/i.test(c));
console.log('Order columns matching pay/method/cod/prepaid:', paymentLike.join(', ') || 'NONE');

// 13) raw_metadata / line items composition
box('RAW METADATA SHAPE');
const { data: oneRaw } = await supabase
  .from('orders').select('raw_metadata').eq('store_id', SHOP)
  .not('raw_metadata', 'is', null).limit(1);
if (oneRaw?.[0]?.raw_metadata) {
  console.log('raw_metadata top-level keys:',
    Object.keys(oneRaw[0].raw_metadata).join(', '));
}

console.log('\n=== DONE ===');
