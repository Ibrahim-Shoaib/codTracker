// Why are 9278-9297 missing? Are they in PostEx at all? Or in Shopify only?
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const STORE = 'the-trendy-homes-pk.myshopify.com';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Get the store's PostEx token
const { data: store } = await sb.from('stores').select('postex_token').eq('store_id', STORE).single();
const TOKEN = store.postex_token;
const BASE = 'https://api.postex.pk/services/integration/api/order';

// 1. Pull PostEx for ALL of 2026 (much wider than 60d) to verify the gap is real in PostEx
console.log('[1] Full PostEx pull, 2025-10-01 → today');
const url = `${BASE}/v1/get-all-order?orderStatusId=0&startDate=2025-10-01&endDate=2026-04-28`;
const res = await fetch(url, { headers: { token: TOKEN } });
console.log('  HTTP', res.status, res.statusText);
const j = await res.json();
const raw = (j.dist || []).map(it => it.trackingResponse ?? it);
console.log(`  total returned: ${raw.length}`);

// Count orders by ref pattern
let nullRef = 0, oneRef = 0, hashRef = 0, otherRef = 0;
const refCounts = new Map();
for (const o of raw) {
  const ref = o.orderRefNumber;
  if (ref == null) nullRef++;
  else if (ref === '1' || ref === '#1') oneRef++;
  else if (typeof ref === 'string' && ref.startsWith('#')) hashRef++;
  else otherRef++;
  refCounts.set(ref, (refCounts.get(ref) || 0) + 1);
}
console.log(`  null orderRefNumber:    ${nullRef}`);
console.log(`  '1' or '#1':            ${oneRef}`);
console.log(`  starts with '#':        ${hashRef}`);
console.log(`  other (no '#' prefix):  ${otherRef}`);

// Look specifically for 9278-9297 in PostEx
console.log('\n[2] Are 9278-9297 anywhere in PostEx (this date window)?');
const wanted = new Set();
for (let i = 9278; i <= 9297; i++) wanted.add(String(i));
const found = raw.filter(o => {
  const r = (o.orderRefNumber || '').replace(/^#/, '');
  return wanted.has(r);
});
console.log(`  found: ${found.length}/20`);
if (found.length) {
  console.table(found.map(o => ({
    ref: (o.orderRefNumber || '').replace(/^#/, ''),
    tn: o.trackingNumber,
    date: o.transactionDate,
    status: o.transactionStatus,
  })));
}

// 3. What are ALL the distinct numeric refs in PostEx for this store?
console.log('\n[3] All distinct numeric refs in PostEx (sorted desc, top 40)');
const numericRefs = [...new Set(raw
  .map(o => (o.orderRefNumber || '').replace(/^#/, ''))
  .filter(r => /^\d+$/.test(r))
  .map(Number))]
  .sort((a, b) => b - a);
console.log('  count distinct numeric:', numericRefs.length);
console.log('  top 40:', numericRefs.slice(0, 40).join(', '));
console.log('  range:', numericRefs[numericRefs.length - 1], '→', numericRefs[0]);

// 4. In Supabase, what does the distribution of order_ref_number = '1' look like?
console.log('\n[4] In Supabase, how many orders have order_ref_number = "1" (placeholder)?');
const { count: oneCount } = await sb
  .from('orders')
  .select('*', { count: 'exact', head: true })
  .eq('store_id', STORE)
  .eq('order_ref_number', '1');
console.log('  count:', oneCount);

// 5. Recent "1" orders — could they be the missing 9278-9297 in disguise?
console.log('\n[5] Recent Supabase orders with order_ref_number = "1" since 2026-04-06');
const { data: oneRows } = await sb
  .from('orders')
  .select('tracking_number, order_ref_number, transaction_date, transaction_status, customer_name, items, invoice_payment')
  .eq('store_id', STORE)
  .eq('order_ref_number', '1')
  .gte('transaction_date', '2026-04-06')
  .order('transaction_date', { ascending: true });
console.table(oneRows);

// 6. What's the "items" / order_detail look like for these — gives a clue if they're real orders
console.log('\n[6] Sample order_detail of a recent "1" order');
if (oneRows?.length) {
  const sample = oneRows[oneRows.length - 1];
  const { data: detail } = await sb
    .from('orders')
    .select('*')
    .eq('store_id', STORE)
    .eq('tracking_number', sample.tracking_number)
    .single();
  console.log(JSON.stringify(detail, null, 2));
}
