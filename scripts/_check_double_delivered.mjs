// Are any Shopify orders (order_ref_number) counted MORE THAN ONCE in Sales?
// This would happen if PostEx has 2+ Delivered rows for the same ref.
// If yes → dashboard overcounts Sales. If no → duplicates only appear in the
// Cancelled bucket (correctly excluded from every KPI).
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SHOP = 'the-trendy-homes-pk.myshopify.com';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
await sb.rpc('set_app_store', { store: SHOP });

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

const rows = await pageAll(() => sb.from('orders')
  .select('order_ref_number, tracking_number, transaction_status, invoice_payment, is_delivered, is_returned, is_in_transit, order_date, transaction_date')
  .eq('store_id', SHOP));

console.log(`Total PostEx rows: ${rows.length}`);

// Group by ref
const byRef = new Map();
for (const r of rows) {
  const ref = r.order_ref_number ?? '(null)';
  if (!byRef.has(ref)) byRef.set(ref, []);
  byRef.get(ref).push(r);
}

// Find refs with multiple DELIVERED rows
const multiDel = [];
const multiRet = [];
const multiIT  = [];
for (const [ref, list] of byRef) {
  const del = list.filter(r => r.is_delivered);
  const ret = list.filter(r => r.is_returned);
  const it  = list.filter(r => r.is_in_transit);
  if (del.length > 1) multiDel.push({ ref, list, del });
  if (ret.length > 1) multiRet.push({ ref, list, ret });
  if (it.length > 1)  multiIT.push({ ref, list, it });
}

console.log(`\n─── Refs with >1 DELIVERED row (DOUBLE-COUNTED IN SALES) ───`);
console.log(`Count: ${multiDel.length}`);
let overcountValue = 0;
for (const g of multiDel.slice(0, 20)) {
  const extra = g.del.slice(1).reduce((s,r)=>s+Number(r.invoice_payment||0),0);
  overcountValue += extra;
  console.log(`  ref=${g.ref}  ${g.del.length} delivered rows, extra=${extra}`);
  for (const r of g.del) {
    console.log(`    tn=${r.tracking_number}  ip=${r.invoice_payment}  ` +
      `bucket=${(r.order_date||r.transaction_date)?.slice(0,10)}`);
  }
}
if (multiDel.length > 20) console.log(`  ... and ${multiDel.length - 20} more`);
console.log(`\n  TOTAL OVERCOUNTED SALES (across ALL time): ${overcountValue.toFixed(0)} PKR`);

console.log(`\n─── Refs with >1 RETURNED row ───`);
console.log(`Count: ${multiRet.length}`);

console.log(`\n─── Refs with >1 IN-TRANSIT row ───`);
console.log(`Count: ${multiIT.length}`);

// Also: total refs with any duplicate row (Cancelled + Delivered, etc)
const anyDup = [...byRef.values()].filter(l => l.length > 1);
console.log(`\n─── Any ref with >1 PostEx row (re-consigned) ───`);
console.log(`Count: ${anyDup.length}`);
