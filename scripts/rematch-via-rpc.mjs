// Drives retroactiveCOGSMatch via the real sync.server.js — exercises the
// full stack end-to-end: buildCostIndex → computeCOGS → apply_cogs_batch RPC.
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import { retroactiveCOGSMatch } from '../app/lib/sync.server.js';

const SHOP = 'the-trendy-homes-pk.myshopify.com';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const started = Date.now();
const result = await retroactiveCOGSMatch(supabase, SHOP);
const elapsedMs = Date.now() - started;

console.log(`Elapsed: ${elapsedMs} ms`);
console.log(result);

// Sanity check: fresh banner counts.
const [{ count: noneCount }, { count: estCount }, { count: total }] = await Promise.all([
  supabase.from('orders').select('id', { count: 'exact', head: true })
    .eq('store_id', SHOP).eq('cogs_match_source', 'none'),
  supabase.from('orders').select('id', { count: 'exact', head: true })
    .eq('store_id', SHOP).in('cogs_match_source', ['fuzzy','sibling_avg','fallback_avg']),
  supabase.from('orders').select('id', { count: 'exact', head: true })
    .eq('store_id', SHOP),
]);

console.log(`\n--- banner state after rematch ---`);
console.log(`  total orders   : ${total}`);
console.log(`  missing (none) : ${noneCount}`);
console.log(`  estimated      : ${estCount}`);
console.log(`  confident      : ${total - noneCount - estCount}`);
