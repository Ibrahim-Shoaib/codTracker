// May 2026 profit projection for Trendy Homes — assumes all currently-active May orders
// (delivered + returned + in-transit; excludes cancelled/transferred) reach a terminal state
// at a 35% return rate. Excludes store_expenses.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const STORE = 'the-trendy-homes-pk.myshopify.com';
const RETURN_RATE = 0.35;
const SELLABLE_RETURNS_PCT = 85;          // unsellable share = 15%
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
await sb.rpc('set_app_store', { store: STORE });

const PKT = 5*3600*1000;
const fromUTC = new Date(Date.UTC(2026,4,1) - PKT).toISOString();
const toUTC   = new Date(Date.UTC(2026,5,1) - PKT).toISOString();

async function pageAll(b) {
  const out = [];
  for (let f=0;;f+=1000){
    const{data,error}=await b().range(f,f+999);
    if(error) throw error;
    if(!data?.length) break;
    out.push(...data);
    if(data.length<1000) break;
  }
  return out;
}

const orders = await pageAll(()=>sb.from('orders')
  .select('transaction_status, is_delivered, is_returned, is_in_transit, invoice_payment, cogs_total, transaction_fee, transaction_tax, reversal_fee, reversal_tax, transaction_date, order_date')
  .eq('store_id', STORE)
  .or(`order_date.gte.${fromUTC},and(order_date.is.null,transaction_date.gte.${fromUTC})`)
);
const inMay = orders.filter(o => {
  const eff = o.order_date || o.transaction_date;
  return eff && eff >= fromUTC && eff < toUTC;
});

const buckets = { delivered: [], returned: [], in_transit: [], cancelled: [], transferred: [] };
for (const o of inMay) {
  if (o.is_delivered) buckets.delivered.push(o);
  else if (o.is_returned) buckets.returned.push(o);
  else if (o.is_in_transit) buckets.in_transit.push(o);
  else if (o.transaction_status === 'Cancelled') buckets.cancelled.push(o);
  else if (o.transaction_status === 'Transferred') buckets.transferred.push(o);
}

const sum = (arr, k) => arr.reduce((a, x) => a + Number(x[k] || 0), 0);
const avg = (arr, k) => arr.length ? sum(arr, k) / arr.length : 0;

// === May-derived per-order metrics (current pricing / SKU mix) ===
const mayDelivered = buckets.delivered;
const mayAOV       = avg(mayDelivered, 'invoice_payment');
const mayCogs      = avg(mayDelivered.filter(o => Number(o.cogs_total) > 0), 'cogs_total');
const mayFwdCost   = avg(mayDelivered, 'transaction_fee') + avg(mayDelivered, 'transaction_tax');

// === Historical per-return reversal cost (May has 0 returns to sample) ===
const allReturned = await pageAll(()=>sb.from('orders')
  .select('reversal_fee, reversal_tax').eq('store_id', STORE).eq('is_returned', true));
const histRevCost = avg(allReturned, 'reversal_fee') + avg(allReturned, 'reversal_tax');

// === May ad spend so far ===
const { data: spendRows } = await sb.from('ad_spend')
  .select('spend_date, amount').eq('store_id', STORE)
  .gte('spend_date', '2026-05-01').lte('spend_date', '2026-05-31');
const adSpend = (spendRows || []).reduce((a, r) => a + Number(r.amount || 0), 0);

// === Projection (ALL May orders — fulfilled + unfulfilled, including cancelled/transferred) ===
const Active = inMay.length;
const projD  = Active * (1 - RETURN_RATE);
const projR  = Active * RETURN_RATE;

const Sales        = projD * mayAOV;
const COGS         = projD * mayCogs + projR * mayCogs * (1 - SELLABLE_RETURNS_PCT/100);
const ForwardCost  = projD * mayFwdCost;          // PostEx charges no forward fee on returns historically
const ReturnCost   = projR * histRevCost;
const NetExclExp   = Sales - COGS - ForwardCost - ReturnCost - adSpend;

console.log('=== May 2026 — current state ===');
console.log(`  Delivered    : ${buckets.delivered.length}`);
console.log(`  Returned     : ${buckets.returned.length}`);
console.log(`  In-transit   : ${buckets.in_transit.length}`);
console.log(`  Cancelled    : ${buckets.cancelled.length}`);
console.log(`  Transferred  : ${buckets.transferred.length}`);
console.log(`  TOTAL (all May orders, fulfilled + unfulfilled): ${Active}`);

console.log('\n=== Per-order assumptions ===');
console.log(`  AOV (May delivered)        : ${mayAOV.toFixed(0)} PKR`);
console.log(`  COGS / order (May)         : ${mayCogs.toFixed(0)} PKR`);
console.log(`  Forward delivery / delivered: ${mayFwdCost.toFixed(0)} PKR`);
console.log(`  Reversal cost / return (hist over ${allReturned.length} returns): ${histRevCost.toFixed(0)} PKR`);
console.log(`  Sellable returns           : ${SELLABLE_RETURNS_PCT}% (15% of returned COGS = loss)`);

console.log(`\n=== Projection: all ${Active} May orders, 35% return rate ===`);
console.log(`  Projected delivered : ${projD.toFixed(1)}  →  Sales = ${Sales.toFixed(0)}`);
console.log(`  Projected returned  : ${projR.toFixed(1)}`);
console.log(`  COGS (delivered + 15% of returned)    : -${COGS.toFixed(0)}`);
console.log(`  Forward delivery cost                 : -${ForwardCost.toFixed(0)}`);
console.log(`  Reversal cost (cost per return)       : -${ReturnCost.toFixed(0)}`);
console.log(`  Ad spend (actual May to date, ${spendRows?.length||0} days): -${adSpend.toFixed(0)}`);
console.log(`  ─────────────────────────────────────────────────────`);
console.log(`  NET PROFIT (excl. store expenses)     : ${NetExclExp.toFixed(0)} PKR`);
