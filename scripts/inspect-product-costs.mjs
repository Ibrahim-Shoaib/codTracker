import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const SHOP = 'the-trendy-homes-pk.myshopify.com';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const { count } = await supabase
  .from('product_costs')
  .select('*', { count: 'exact', head: true })
  .eq('store_id', SHOP);

console.log(`Total product_costs rows for ${SHOP}: ${count}`);

// Most-recently-updated rows
const { data: recent, error: recentErr } = await supabase
  .from('product_costs')
  .select('product_title, variant_title, unit_cost, updated_at')
  .eq('store_id', SHOP)
  .order('updated_at', { ascending: false, nullsFirst: false })
  .limit(15);

if (recentErr) console.log('recent err:', recentErr);
console.log(`\nMost recently updated rows (${recent?.length ?? 0}):`);
for (const r of recent ?? []) {
  console.log(`  ${r.updated_at}  ${r.unit_cost}  ${r.product_title} / ${r.variant_title}`);
}

// Rows with unit_cost 0 or null
const { count: zeroCount } = await supabase
  .from('product_costs')
  .select('*', { count: 'exact', head: true })
  .eq('store_id', SHOP)
  .or('unit_cost.is.null,unit_cost.eq.0');

console.log(`\nRows with unit_cost = 0 or NULL: ${zeroCount}`);

// Distinct product_title count
const { data: titles } = await supabase
  .from('product_costs')
  .select('product_title')
  .eq('store_id', SHOP);
const uniqueTitles = new Set((titles ?? []).map(t => t.product_title));
console.log(`Distinct product_title values: ${uniqueTitles.size}`);
