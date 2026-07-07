// One-shot investigation: why does the-trendy-homes-pk.myshopify.com have orders
// in Supabase only up to order_ref_number 9277 when PostEx has 9299?
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const STORE_ID = 'the-trendy-homes-pk.myshopify.com';
const TOKEN = process.env.POSTEX_API_TOKEN;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sb = createClient(SUPA_URL, SUPA_KEY);
const BASE = 'https://api.postex.pk/services/integration/api/order';

console.log('='.repeat(70));
console.log('STORE:', STORE_ID);
console.log('TODAY:', new Date().toISOString().slice(0, 10));
console.log('='.repeat(70));

// 1. Look up the store row to verify token + last-sync timestamps + flags
console.log('\n[1] STORE ROW IN SUPABASE');
const { data: storeRow, error: storeErr } = await sb
  .from('stores')
  .select('*')
  .eq('store_id', STORE_ID)
  .single();
if (storeErr) { console.error('Error:', storeErr); }
else {
  for (const [k, v] of Object.entries(storeRow)) {
    if (k === 'postex_token') {
      console.log(`  ${k}: ${v ? `${String(v).slice(0,10)}…(len=${String(v).length})` : 'NULL'}`);
    } else {
      console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
  }
}

// 2. Latest orders in Supabase
console.log('\n[2] LATEST 10 ORDERS IN SUPABASE for this store (by transaction_date desc)');
const { data: latestByDate } = await sb
  .from('orders')
  .select('order_ref_number, tracking_number, transaction_date, transaction_status, updated_at')
  .eq('store_id', STORE_ID)
  .order('transaction_date', { ascending: false })
  .limit(10);
console.table(latestByDate);

console.log('\n[3] HIGHEST 10 order_ref_numbers IN SUPABASE for this store');
// order_ref_number is text but lexicographically sortable for these IDs
const { data: latestByRef } = await sb
  .from('orders')
  .select('order_ref_number, tracking_number, transaction_date, transaction_status, updated_at')
  .eq('store_id', STORE_ID)
  .order('order_ref_number', { ascending: false })
  .limit(10);
console.table(latestByRef);

console.log('\n[4] OLDEST + COUNT in Supabase for this store');
const { count } = await sb
  .from('orders')
  .select('*', { count: 'exact', head: true })
  .eq('store_id', STORE_ID);
console.log('  total orders rows:', count);
const { data: oldest } = await sb
  .from('orders')
  .select('order_ref_number, transaction_date')
  .eq('store_id', STORE_ID)
  .order('transaction_date', { ascending: true })
  .limit(3);
console.table(oldest);

// 3. Pull last 60 days from PostEx using THIS store's token
const tokenToUse = storeRow?.postex_token || TOKEN;
console.log('\n[5] PULLING POSTEX LAST 60 DAYS (using store-row token if present)');
const today = new Date();
const ymd = (d) => d.toISOString().slice(0, 10);
const end = ymd(today);
const startD = new Date(today); startD.setUTCDate(startD.getUTCDate() - 60);
const start = ymd(startD);
console.log(`  range: ${start} → ${end}`);

const url = `${BASE}/v1/get-all-order?orderStatusId=0&startDate=${start}&endDate=${end}`;
const res = await fetch(url, { headers: { token: tokenToUse } });
console.log('  HTTP status:', res.status, res.statusText);
let raw = [];
if (res.ok) {
  const j = await res.json();
  raw = (j.dist || []).map(it => it.trackingResponse ?? it);
  console.log(`  PostEx returned ${raw.length} orders for this 60-day window`);
} else {
  const txt = await res.text().catch(() => '');
  console.log('  Body:', txt.slice(0, 500));
}

// 4. Sort, show extremes
if (raw.length) {
  const refs = raw.map(o => ({
    ref: (o.orderRefNumber || '').replace(/^#/, ''),
    tn: o.trackingNumber,
    date: o.transactionDate,
    status: o.transactionStatus,
  })).filter(r => r.ref);
  refs.sort((a, b) => Number(b.ref) - Number(a.ref));
  console.log('\n[6] TOP 10 PostEx orders (highest ref, last 60 days)');
  console.table(refs.slice(0, 10));
  console.log('\n[7] BOTTOM 5 PostEx orders (lowest ref in window)');
  console.table(refs.slice(-5));

  // 5. Compare which PostEx refs are MISSING from Supabase
  const dbRefs = new Set((latestByRef || []).map(r => r.order_ref_number));
  const allDbRefs = new Set();
  // Pull every ref for this store (one shot, may be large; paginate)
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('orders')
      .select('order_ref_number')
      .eq('store_id', STORE_ID)
      .range(from, from + 999);
    if (error) { console.error(error); break; }
    if (!data?.length) break;
    for (const r of data) allDbRefs.add(r.order_ref_number);
    if (data.length < 1000) break;
  }
  console.log(`\n[8] Total distinct refs in Supabase for store: ${allDbRefs.size}`);
  const missing = refs.filter(r => !allDbRefs.has(r.ref));
  console.log(`[9] PostEx refs MISSING from Supabase (last 60d): ${missing.length}`);
  console.table(missing.slice(0, 25));
}
