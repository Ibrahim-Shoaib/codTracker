// One-time migration: cleanup stale Booked + repair mis-flagged terminal rows
// for the-trendy-homes-pk.myshopify.com (the only store currently in DB).
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { cancelStaleBooked } from '../app/lib/stale-orders.server.js';

const STORE = 'the-trendy-homes-pk.myshopify.com';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function snapshot(label) {
  const counts = {};
  for (const [k, q] of [
    ['total',                sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE)],
    ['delivered',            sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).eq('is_delivered', true)],
    ['returned',             sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).eq('is_returned', true)],
    ['in_transit',           sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).eq('is_in_transit', true)],
    ['no_flag (terminal cancelled)', sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).eq('is_delivered', false).eq('is_returned', false).eq('is_in_transit', false)],
    ['transaction_status=Booked',     sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).eq('transaction_status', 'Booked')],
    ['transaction_status=Cancelled',  sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).eq('transaction_status', 'Cancelled')],
    ['transaction_status=Unbooked',   sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).eq('transaction_status', 'Unbooked')],
    ['transaction_status=Transferred',sb.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', STORE).eq('transaction_status', 'Transferred')],
  ]) {
    const { count } = await q;
    counts[k] = count;
  }
  console.log(`\n=== ${label} ===`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(38)} ${v}`);
  return counts;
}

const before = await snapshot('BEFORE');

console.log('\n--- Running cancelStaleBooked ---');
const result = await cancelStaleBooked(sb, STORE);
console.log('Result:', result);

const after = await snapshot('AFTER');

console.log('\n=== DELTA ===');
for (const k of Object.keys(before)) {
  if (before[k] !== after[k]) console.log(`  ${k.padEnd(38)} ${before[k]} → ${after[k]}`);
}
