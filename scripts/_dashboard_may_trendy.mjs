// Query the dashboard RPC directly for May 2026 PKT window.
// Also dump the "unflagged" (Cancelled/Transferred) PostEx rows so we can see
// whether they're duplicates of live Shopify orders or something else.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SHOP = 'the-trendy-homes-pk.myshopify.com';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

await sb.rpc('set_app_store', { store: SHOP });

// May 2026 PKT window converted to UTC bounds
// May 1 PKT 00:00 = Apr 30 19:00 UTC
// Jun 1 PKT 00:00 = May 31 19:00 UTC
const p_from = '2026-04-30T19:00:00.000Z';
const p_to   = '2026-05-31T19:00:00.000Z';

// Pull store expenses (dashboard sums them for expense allocation)
const { data: exp } = await sb.from('store_expenses').select('*').eq('store_id', SHOP);
const monthlyTotal   = (exp ?? []).filter(e => e.type === 'monthly').reduce((s,r) => s + Number(r.amount||0), 0);
const perOrderTotal  = (exp ?? []).filter(e => e.type === 'per_order').reduce((s,r) => s + Number(r.amount||0), 0);

console.log(`Store expenses: monthly=${monthlyTotal}, per-order=${perOrderTotal}\n`);

const { data: stats, error } = await sb.rpc('get_dashboard_stats', {
  p_store_id: SHOP,
  p_from_date: p_from,
  p_to_date: p_to,
  p_monthly_expenses: monthlyTotal,
  p_per_order_expenses: perOrderTotal,
});
if (error) { console.error(error); process.exit(1); }
console.log('─── Dashboard RPC output for May 2026 PKT ───');
console.log(JSON.stringify(stats?.[0] ?? stats, null, 2));

// Now: what are the 52 unflagged/cancelled rows?
async function pageAll(mk) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await mk().range(f, f + 999);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
const pxRows = await pageAll(() => sb.from('orders')
  .select('tracking_number, order_ref_number, transaction_date, order_date, invoice_payment, transaction_status, is_delivered, is_returned, is_in_transit')
  .eq('store_id', SHOP));

const inMay = (iso) => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= Date.parse('2026-05-01T00:00:00+05:00') && t < Date.parse('2026-06-01T00:00:00+05:00');
};
const pxMay = pxRows.filter(r => inMay(r.order_date || r.transaction_date));
const other = pxMay.filter(r => !r.is_delivered && !r.is_returned && !r.is_in_transit);

console.log(`\n─── PostEx rows in May with NO status flag (${other.length}) ───`);
const byStatus = {};
for (const r of other) {
  const s = r.transaction_status ?? '(null)';
  byStatus[s] = byStatus[s] || { count: 0, sum: 0 };
  byStatus[s].count++;
  byStatus[s].sum += Number(r.invoice_payment ?? 0);
}
console.log('  Breakdown by transaction_status:');
for (const [k, v] of Object.entries(byStatus)) {
  console.log(`    ${k.padEnd(20)}: count=${v.count}   sum(invoice)=${v.sum.toFixed(0)}`);
}

console.log(`\n  Sample (first 15):`);
for (const r of other.slice(0, 15)) {
  console.log(`    ref=${r.order_ref_number}  tn=${r.tracking_number}  ` +
    `bucket_date=${(r.order_date || r.transaction_date)?.slice(0,10)}  ` +
    `status="${r.transaction_status}"  ip=${r.invoice_payment}`);
}

// Look for duplicates on ref
const refCounts = {};
for (const r of pxRows) {
  const ref = r.order_ref_number;
  if (!ref) continue;
  refCounts[ref] = (refCounts[ref] || 0) + 1;
}
const dupRefs = Object.entries(refCounts).filter(([_,c]) => c > 1);
console.log(`\n  Distinct order_ref_numbers with >1 PostEx row: ${dupRefs.length}`);
if (dupRefs.length > 0) {
  console.log(`  Sample (first 10):`);
  for (const [ref, cnt] of dupRefs.slice(0, 10)) {
    const rows = pxRows.filter(r => r.order_ref_number === ref);
    console.log(`    ref=${ref}  ${cnt} rows:`);
    for (const r of rows) {
      console.log(`      tn=${r.tracking_number}  status="${r.transaction_status}"  ip=${r.invoice_payment}  ` +
        `del=${r.is_delivered}  ret=${r.is_returned}  it=${r.is_in_transit}  ` +
        `bucket_date=${(r.order_date || r.transaction_date)?.slice(0,10)}`);
    }
  }
}
