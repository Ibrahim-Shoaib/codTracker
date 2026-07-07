// Research script: Supabase state + Postex onboarding for the-trendy-homes-pk.myshopify.com
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const STORE = 'the-trendy-homes-pk.myshopify.com';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function pageAll(builderFn) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await builderFn().range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// ---- 1. Store record ----
const { data: store } = await sb.from('stores').select('*').eq('store_id', STORE).single();
console.log('=== STORE RECORD ===');
console.log(JSON.stringify({
  ...store,
  postex_token: store?.postex_token ? `${store.postex_token.slice(0, 8)}…(len ${store.postex_token.length})` : null,
  meta_access_token: store?.meta_access_token ? `…(len ${store.meta_access_token.length})` : null,
}, null, 2));

// ---- 2. Counts ----
const counts = {};
for (const [label, q] of [
  ['total', sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE)],
  ['delivered', sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).eq('is_delivered', true)],
  ['returned',  sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).eq('is_returned', true)],
  ['in_transit',sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).eq('is_in_transit', true)],
  ['has_line_items',  sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).not('line_items', 'is', null)],
  ['has_shopify_order_id', sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).not('shopify_order_id', 'is', null)],
  ['cogs_matched_true', sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).eq('cogs_matched', true)],
  ['cogs_matched_false', sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).eq('cogs_matched', false)],
]) {
  const { count } = await q;
  counts[label] = count;
}
console.log('\n=== COUNTS ===');
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(22)} ${v}`);

// ---- 3. Date span ----
const { data: oldest } = await sb.from('orders').select('transaction_date, tracking_number').eq('store_id', STORE).order('transaction_date', { ascending: true }).limit(1);
const { data: newest } = await sb.from('orders').select('transaction_date, tracking_number').eq('store_id', STORE).order('transaction_date', { ascending: false }).limit(1);
console.log(`oldest               : ${oldest?.[0]?.transaction_date}  (${oldest?.[0]?.tracking_number})`);
console.log(`newest               : ${newest?.[0]?.transaction_date}  (${newest?.[0]?.tracking_number})`);

// ---- column sniff ----
const { data: oneRow } = await sb.from('orders').select('*').eq('store_id', STORE).limit(1);
console.log('\n=== orders table columns (live DB) ===');
console.log(Object.keys(oneRow?.[0] ?? {}).join(', '));

// ---- 4/5/6. Aggregations across all orders (paginated) ----
const allRows = await pageAll(() =>
  sb.from('orders')
    .select('transaction_status, transaction_date, cogs_match_source, cogs_matched, cogs_total, line_items, is_delivered, is_returned, is_in_transit, invoice_payment')
    .eq('store_id', STORE)
);
console.log(`\nFetched ${allRows.length} orders for aggregation.`);

const byStatus = {}, byMonth = {}, matchSource = {};
let sumCogs = 0, withLi = 0, sumPaidDelivered = 0, sumPaidReturned = 0;
for (const r of allRows) {
  const s = r.transaction_status ?? '(null)';
  byStatus[s] = (byStatus[s] || 0) + 1;
  if (r.transaction_date) {
    const m = r.transaction_date.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
  }
  matchSource[r.cogs_match_source] = (matchSource[r.cogs_match_source] || 0) + 1;
  sumCogs += Number(r.cogs_total) || 0;
  if (r.line_items != null) withLi++;
  if (r.is_delivered) sumPaidDelivered += Number(r.invoice_payment) || 0;
  if (r.is_returned)  sumPaidReturned  += Number(r.invoice_payment) || 0;
}

console.log('\n=== BY transaction_status ===');
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(40)} ${v}`);

console.log('\n=== ORDERS BY MONTH (transaction_date) ===');
for (const [m, n] of Object.entries(byMonth).sort()) console.log(`  ${m}  ${n}`);

console.log('\n=== COGS MATCH SOURCE ===');
for (const [k, v] of Object.entries(matchSource).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
console.log(`  sum cogs_total: ${sumCogs.toFixed(2)} PKR`);
console.log(`  rows with line_items populated: ${withLi}`);
console.log(`  GMV (delivered invoice_payment sum): ${sumPaidDelivered.toFixed(2)} PKR`);
console.log(`  Returned invoice_payment sum:      ${sumPaidReturned.toFixed(2)} PKR`);

// ---- 7. product_costs ----
const { count: pcCount } = await sb.from('product_costs').select('*', { count: 'exact', head: true }).eq('store_id', STORE);
const { data: pcSample } = await sb.from('product_costs').select('shopify_variant_id, sku, product_title, variant_title, unit_cost, updated_at').eq('store_id', STORE).order('updated_at', { ascending: false }).limit(5);
console.log(`\nproduct_costs rows: ${pcCount}`);
console.log('Sample (5 most recent):');
for (const r of pcSample ?? []) console.log(`  variant=${r.shopify_variant_id}  sku=${r.sku ?? '-'}  ${r.product_title}/${r.variant_title}  cost=${r.unit_cost}  upd=${r.updated_at?.slice(0,10)}`);

// ---- 8. ad_spend ----
const { count: asCount } = await sb.from('ad_spend').select('*', { count: 'exact', head: true }).eq('store_id', STORE);
const { data: asAll } = await sb.from('ad_spend').select('spend_date, amount').eq('store_id', STORE).order('spend_date', { ascending: true }).range(0, 1000);
let totalSpend = 0;
for (const r of asAll ?? []) totalSpend += Number(r.amount) || 0;
console.log(`\nad_spend rows: ${asCount}  span: ${asAll?.[0]?.spend_date} → ${asAll?.[asAll.length-1]?.spend_date}  total spend: ${totalSpend.toFixed(2)} PKR`);

// ---- 9. store_expenses ----
const { data: exps } = await sb.from('store_expenses').select('*').eq('store_id', STORE);
console.log(`\nstore_expenses rows: ${exps?.length ?? 0}`);
for (const e of exps ?? []) console.log(`  ${e.name}: ${e.amount} [${e.type}]`);

// ---- 10. Sample recent orders (manual print to bypass console.table issue) ----
const { data: sample } = await sb
  .from('orders')
  .select('tracking_number, order_ref_number, transaction_status, invoice_payment, transaction_date, city_name, cogs_total, cogs_match_source, items')
  .eq('store_id', STORE)
  .order('transaction_date', { ascending: false })
  .limit(10);
console.log('\n=== 10 MOST RECENT ORDERS ===');
for (const r of sample ?? []) {
  console.log(`  ${r.transaction_date?.slice(0,10)}  TN=${r.tracking_number}  ref=${r.order_ref_number}  ${r.transaction_status?.padEnd(20)}  paid=${r.invoice_payment}  cogs=${r.cogs_total}(${r.cogs_match_source})  city=${r.city_name}`);
}

// ---- 11. Sample of orders with line_items populated ----
const { data: liSample } = await sb
  .from('orders')
  .select('tracking_number, order_ref_number, line_items')
  .eq('store_id', STORE)
  .not('line_items', 'is', null)
  .order('transaction_date', { ascending: false })
  .limit(3);
console.log('\n=== SAMPLE ORDERS WITH line_items POPULATED ===');
for (const r of liSample ?? []) {
  console.log(`  TN=${r.tracking_number}  ref=${r.order_ref_number}`);
  console.log(`    line_items: ${JSON.stringify(r.line_items).slice(0, 250)}`);
}

// ---- 12. daily_snapshots ----
const { count: snapCount } = await sb.from('daily_snapshots').select('*', { count: 'exact', head: true }).eq('store_id', STORE);
const { data: snapNew } = await sb.from('daily_snapshots').select('*').eq('store_id', STORE).order('snapshot_date', { ascending: false }).limit(3);
console.log(`\ndaily_snapshots rows: ${snapCount}`);
for (const s of snapNew ?? []) {
  console.log(`  ${s.snapshot_date}  sales=${s.total_sales}  orders=${s.total_orders}  returns=${s.total_returns}  net_profit=${s.net_profit}`);
}
