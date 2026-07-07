// Verify whether the orders table actually contains the data needed to link
// each PostEx order to its Shopify counterpart (so we could enrich with
// variant_ids).
//
// What we need: order_ref_number must be populated, in a format that matches
// Shopify's `name` field (Shopify uses "#1234" style, we strip the # so we
// store "1234"). Empty / null / weird values would break the variant_id plan.
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SHOP = 'the-trendy-homes-pk.myshopify.com';

// 1. Count orders with vs without order_ref_number
const { count: total } = await supabase
  .from('orders').select('*', { count: 'exact', head: true })
  .eq('store_id', SHOP);

const { count: hasRef } = await supabase
  .from('orders').select('*', { count: 'exact', head: true })
  .eq('store_id', SHOP)
  .not('order_ref_number', 'is', null);

const { count: missingRef } = await supabase
  .from('orders').select('*', { count: 'exact', head: true })
  .eq('store_id', SHOP)
  .is('order_ref_number', null);

console.log(`Total orders for ${SHOP}: ${total}`);
console.log(`  with order_ref_number: ${hasRef}  (${(100 * hasRef / total).toFixed(1)}%)`);
console.log(`  null  order_ref_number: ${missingRef}  (${(100 * missingRef / total).toFixed(1)}%)`);

// 2. Sample some order_ref_number values to check format
const { data: sample } = await supabase
  .from('orders')
  .select('tracking_number, order_ref_number, order_detail, transaction_date')
  .eq('store_id', SHOP)
  .not('order_ref_number', 'is', null)
  .order('transaction_date', { ascending: false })
  .limit(20);

console.log(`\nSample of order_ref_number values (newest 20):`);
for (const r of sample ?? []) {
  console.log(`  ref=${String(r.order_ref_number).padEnd(20)}  tracking=${r.tracking_number}  date=${r.transaction_date?.slice(0,10)}`);
}

// 3. Look at oldest orders (where Shopify history may be gone)
const { data: oldest } = await supabase
  .from('orders')
  .select('tracking_number, order_ref_number, order_detail, transaction_date')
  .eq('store_id', SHOP)
  .not('order_ref_number', 'is', null)
  .order('transaction_date', { ascending: true })
  .limit(10);

console.log(`\nSample of OLDEST 10:`);
for (const r of oldest ?? []) {
  console.log(`  ref=${String(r.order_ref_number).padEnd(20)}  tracking=${r.tracking_number}  date=${r.transaction_date?.slice(0,10)}`);
}

// 4. Patterns: are refs always numeric? Or do they include letters / non-Shopify prefixes?
const { data: allRefs } = await supabase
  .from('orders')
  .select('order_ref_number')
  .eq('store_id', SHOP)
  .not('order_ref_number', 'is', null);

const refs = (allRefs ?? []).map(r => String(r.order_ref_number));
const numeric = refs.filter(r => /^\d+$/.test(r)).length;
const startsHash = refs.filter(r => r.startsWith('#')).length;
const hasLetters = refs.filter(r => /[A-Za-z]/.test(r)).length;
const empty = refs.filter(r => r.trim() === '').length;
const lengths = {};
for (const r of refs) {
  const k = r.length;
  lengths[k] = (lengths[k] || 0) + 1;
}

console.log(`\nFormat breakdown of ${refs.length} non-null refs:`);
console.log(`  Pure numeric (Shopify-style):  ${numeric}  (${(100*numeric/refs.length).toFixed(1)}%)`);
console.log(`  Still has leading #:           ${startsHash}`);
console.log(`  Contains letters:              ${hasLetters}`);
console.log(`  Empty string:                  ${empty}`);
console.log(`  Length distribution:`, lengths);

// 5. Date range — Shopify Admin API returns orders for the lifetime of the
// merchant's app install. If our oldest orders pre-date the install, those
// won't be fetchable from Shopify even with a perfect ref.
const { data: dates } = await supabase
  .from('orders')
  .select('transaction_date')
  .eq('store_id', SHOP)
  .order('transaction_date', { ascending: true })
  .limit(1);
const oldestDate = dates?.[0]?.transaction_date;

const { data: dates2 } = await supabase
  .from('orders')
  .select('transaction_date')
  .eq('store_id', SHOP)
  .order('transaction_date', { ascending: false })
  .limit(1);
const newestDate = dates2?.[0]?.transaction_date;

console.log(`\nOrder date range: ${oldestDate?.slice(0,10)}  →  ${newestDate?.slice(0,10)}`);

// 6. Check Shopify install date (when did this store connect us?)
const { data: store } = await supabase
  .from('stores')
  .select('store_id, installed_at, created_at, last_postex_sync_at')
  .eq('store_id', SHOP)
  .single();
console.log(`\nStore record:`, store);

// 7. Are there ANY duplicate refs? (would break our 1-to-1 join with Shopify)
const refCounts = new Map();
for (const r of refs) refCounts.set(r, (refCounts.get(r) || 0) + 1);
const dupes = [...refCounts.entries()].filter(([_, c]) => c > 1);
console.log(`\nDuplicate order_ref_number values: ${dupes.length}`);
if (dupes.length) {
  console.log('  Examples:', dupes.slice(0, 10));
}
