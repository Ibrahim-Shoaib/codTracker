// Paginated snapshot of cogs source distribution + total cogs sum.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SHOP = 'the-trendy-homes-pk.myshopify.com';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const all = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from('orders')
    .select('cogs_match_source, cogs_total')
    .eq('store_id', SHOP)
    .range(from, from + 999);
  if (error) throw error;
  if (!data?.length) break;
  all.push(...data);
  if (data.length < 1000) break;
}

const counts = {};
let totalCogs = 0;
let totalCogsDelivered = 0;
for (const r of all) {
  counts[r.cogs_match_source ?? 'NULL'] = (counts[r.cogs_match_source ?? 'NULL'] || 0) + 1;
  totalCogs += Number(r.cogs_total) || 0;
}

console.log(`Total orders for ${SHOP}: ${all.length}`);
console.log(`Total cogs sum (all orders, all statuses): ${Math.round(totalCogs).toLocaleString()} PKR`);
console.log('\nBy cogs_match_source:');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(15)} ${v}`);
}

// Also: delivered-only sum (matches dashboard scope)
const { data: del } = await supabase
  .from('orders')
  .select('cogs_total')
  .eq('store_id', SHOP)
  .eq('is_delivered', true)
  .limit(50000);
// Need pagination for delivered too
const allDel = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from('orders')
    .select('cogs_total')
    .eq('store_id', SHOP)
    .eq('is_delivered', true)
    .range(from, from + 999);
  if (error) throw error;
  if (!data?.length) break;
  allDel.push(...data);
  if (data.length < 1000) break;
}
let delCogs = 0;
for (const r of allDel) delCogs += Number(r.cogs_total) || 0;
console.log(`\nDelivered-only cogs sum: ${Math.round(delCogs).toLocaleString()} PKR  (across ${allDel.length} delivered orders)`);
