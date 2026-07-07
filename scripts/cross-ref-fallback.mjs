// Crucial cross-check: of the orders currently stuck on fallback_avg/sibling_avg
// (the inflation source), how many have a real Shopify ref vs the "1" placeholder?
//
// If the bad orders are PLACEHOLDERS, my variant_id plan doesn't help them.
// If the bad orders have REAL REFS, my variant_id plan would fix them directly.
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SHOP = 'the-trendy-homes-pk.myshopify.com';

async function fetchAll(builder) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await builder().range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const orders = await fetchAll(() =>
  supabase
    .from('orders')
    .select('order_ref_number, transaction_date, cogs_match_source')
    .eq('store_id', SHOP)
    .gte('transaction_date', '2025-11-01')
    .lt('transaction_date', '2026-05-01')
);

const months = ['2025-11','2025-12','2026-01','2026-02','2026-03','2026-04'];

// Build: per (month, source, refType) → count
const grid = {};
for (const o of orders) {
  const m = o.transaction_date.slice(0, 7);
  const src = o.cogs_match_source || 'unknown';
  const refType = o.order_ref_number === '1' ? 'placeholder' : 'real';
  const key = `${m}|${src}|${refType}`;
  grid[key] = (grid[key] || 0) + 1;
}

const sources = ['exact','sku','sibling_avg','fallback_avg','fuzzy','none'];

console.log('For each month: how each cogs_match_source breaks down by ref type.');
console.log('(real = has a Shopify ref → potentially fixable by variant_id matching)');
console.log('(placeholder = ref="1" → must stay on text matching)\n');

for (const m of months) {
  console.log(`--- ${m} ---`);
  console.log(`source        |  real  |  placeholder  | total`);
  for (const src of sources) {
    const real = grid[`${m}|${src}|real`] || 0;
    const ph   = grid[`${m}|${src}|placeholder`] || 0;
    const tot = real + ph;
    if (!tot) continue;
    console.log(`  ${src.padEnd(12)} |  ${String(real).padStart(4)}  |    ${String(ph).padStart(4)}       | ${tot}`);
  }
}

// Big-picture summary: of the WEAK matches (sibling_avg + fallback_avg + fuzzy + none)
// across all 6 months, what's the real-vs-placeholder split?
let weakReal = 0, weakPh = 0, exactReal = 0, exactPh = 0;
for (const o of orders) {
  const refType = o.order_ref_number === '1' ? 'ph' : 'real';
  const isWeak = ['sibling_avg','fallback_avg','fuzzy','none'].includes(o.cogs_match_source);
  if (isWeak) {
    if (refType === 'real') weakReal++; else weakPh++;
  } else {
    if (refType === 'real') exactReal++; else exactPh++;
  }
}

console.log(`\n=== 6-MONTH SUMMARY ===`);
console.log(`exact/sku matches:`);
console.log(`  with real Shopify ref:    ${exactReal}`);
console.log(`  with placeholder ref="1": ${exactPh}`);
console.log(`weak matches (sibling_avg + fallback_avg + fuzzy + none):`);
console.log(`  with real Shopify ref:    ${weakReal}   ← FIXABLE by variant_id approach`);
console.log(`  with placeholder ref="1": ${weakPh}    ← stuck on text matching forever`);
console.log(`\nOf the inflation source (${weakReal + weakPh} weak orders):`);
console.log(`  variant_id fix would resolve: ${weakReal} (${(100*weakReal/(weakReal+weakPh)).toFixed(1)}%)`);
console.log(`  text matcher still needed:    ${weakPh} (${(100*weakPh/(weakReal+weakPh)).toFixed(1)}%)`);
