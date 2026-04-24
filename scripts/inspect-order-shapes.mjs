import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const SHOP = 'the-trendy-homes-pk.myshopify.com';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 1) Look at one full order row so we know every field PostEx gave us
const { data: sample } = await supabase
  .from('orders')
  .select('*')
  .eq('store_id', SHOP)
  .limit(1);

console.log('=== orders row keys ===');
console.log(Object.keys(sample?.[0] ?? {}).sort().join('\n'));

console.log('\n=== sample row (truncated) ===');
if (sample?.[0]) {
  const row = { ...sample[0] };
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 200) row[k] = v.slice(0, 200) + '…';
  }
  console.log(JSON.stringify(row, null, 2));
}

// 2) How often is shopify_order_id populated?
const { count: totalOrders } = await supabase
  .from('orders').select('*', { count: 'exact', head: true }).eq('store_id', SHOP);
const { count: withShopId } = await supabase
  .from('orders').select('*', { count: 'exact', head: true }).eq('store_id', SHOP)
  .not('shopify_order_id', 'is', null);
const { count: withRaw } = await supabase
  .from('orders').select('*', { count: 'exact', head: true }).eq('store_id', SHOP)
  .not('raw_metadata', 'is', null);

console.log(`\nTotal orders:              ${totalOrders}`);
console.log(`With shopify_order_id set: ${withShopId}`);
console.log(`With raw_metadata set:     ${withRaw}`);

// 3) product_costs sample (to confirm what linking keys we have)
const { data: costSample } = await supabase
  .from('product_costs').select('*').eq('store_id', SHOP).limit(1);
console.log('\n=== product_costs row keys ===');
console.log(Object.keys(costSample?.[0] ?? {}).sort().join('\n'));
console.log('\nsample:', costSample?.[0]);

// 4) Does PostEx return richer info via a per-order detail endpoint?
// Try GET /v1/get-order-details or similar — inspect one via their open endpoint.
const { data: storeRow } = await supabase
  .from('stores').select('postex_token').eq('store_id', SHOP).single();

if (storeRow?.postex_token) {
  const tn = sample?.[0]?.tracking_number;
  console.log(`\nProbing PostEx detail endpoint for tracking=${tn} …`);

  const endpoints = [
    `https://api.postex.pk/services/integration/api/order/v1/track-order/${tn}`,
    `https://api.postex.pk/services/integration/api/order/v1/get-order/${tn}`,
    `https://api.postex.pk/services/integration/api/order/v1/get-order-details/${tn}`,
    `https://api.postex.pk/services/integration/api/order/v2/get-order/${tn}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: { token: storeRow.postex_token } });
      const text = await res.text();
      console.log(`\n${res.status}  ${url}`);
      console.log(text.slice(0, 800));
    } catch (e) {
      console.log(`\n!!  ${url}  ${e.message}`);
    }
  }
}
