import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SHOP = 'the-trendy-homes-pk.myshopify.com';

// Properly paginate to get ALL refs
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

const all = await fetchAll(() =>
  supabase
    .from('orders')
    .select('order_ref_number, transaction_date, is_delivered, is_returned, is_in_transit')
    .eq('store_id', SHOP)
);

console.log(`Fetched ${all.length} order rows total\n`);

// Bucket by ref pattern
const placeholder = all.filter(r => r.order_ref_number === '1');
const looksReal   = all.filter(r => r.order_ref_number && r.order_ref_number !== '1');

console.log(`Refs that are exactly "1" (likely placeholder): ${placeholder.length}  (${(100*placeholder.length/all.length).toFixed(1)}%)`);
console.log(`Refs that look real:                            ${looksReal.length}  (${(100*looksReal.length/all.length).toFixed(1)}%)`);

// Among the placeholders — how many are recent vs old?
const byMonth = {};
for (const r of placeholder) {
  const m = r.transaction_date?.slice(0, 7) ?? 'unknown';
  byMonth[m] = (byMonth[m] || 0) + 1;
}
console.log(`\nPlaceholder "1" refs per month:`);
for (const m of Object.keys(byMonth).sort()) {
  console.log(`  ${m}: ${byMonth[m]}`);
}

// Among real refs, distribution by month
const realByMonth = {};
for (const r of looksReal) {
  const m = r.transaction_date?.slice(0, 7) ?? 'unknown';
  realByMonth[m] = (realByMonth[m] || 0) + 1;
}
console.log(`\nReal-looking refs per month:`);
for (const m of Object.keys(realByMonth).sort()) {
  console.log(`  ${m}: ${realByMonth[m]}`);
}

// Per-month: how many orders TOTAL vs how many would be linkable to Shopify?
const totalByMonth = {};
for (const r of all) {
  const m = r.transaction_date?.slice(0, 7) ?? 'unknown';
  totalByMonth[m] = (totalByMonth[m] || 0) + 1;
}

console.log(`\n--- LINKABILITY per month (last 6 months) ---`);
const months = ['2025-11','2025-12','2026-01','2026-02','2026-03','2026-04'];
console.log(`Month     | Total | Real ref | Placeholder | % Linkable`);
console.log(`----------|-------|----------|-------------|------------`);
for (const m of months) {
  const t = totalByMonth[m] || 0;
  const real = realByMonth[m] || 0;
  const ph = byMonth[m] || 0;
  const pct = t ? (100 * real / t).toFixed(1) : '0.0';
  console.log(`${m}   | ${String(t).padStart(5)} |  ${String(real).padStart(5)}   |   ${String(ph).padStart(5)}     |   ${pct}%`);
}

// Are there duplicates among the real-looking refs (same Shopify order shipped
// as 2 PostEx packages)? That would still be linkable, just with the same line
// items applied to both.
const realRefCounts = new Map();
for (const r of looksReal) {
  const k = r.order_ref_number;
  realRefCounts.set(k, (realRefCounts.get(k) || 0) + 1);
}
const realDupes = [...realRefCounts.entries()].filter(([_,c]) => c > 1);
console.log(`\nDuplicate real refs: ${realDupes.length} unique refs appearing more than once`);
console.log(`  (these are presumably one Shopify order shipped as multiple PostEx packages)`);
if (realDupes.length) {
  console.log('  Examples:', realDupes.slice(0, 5));
}
