import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const STORE = 'the-trendy-homes-pk.myshopify.com';
await sb.rpc('set_app_store', { store: STORE });

const PKT = 5*3600*1000;
const monthStart = new Date(Date.UTC(2026,4,1) - PKT).toISOString();
const monthEnd   = new Date(Date.UTC(2026,5,1) - PKT).toISOString();

// May "other" bucket
const { data: may } = await sb.from('orders').select('tracking_number, order_ref_number, transaction_status, is_delivered, is_returned, is_in_transit, invoice_payment, transaction_fee, reversal_fee, order_date, transaction_date')
  .eq('store_id', STORE)
  .or(`order_date.gte.${monthStart},and(order_date.is.null,transaction_date.gte.${monthStart})`);
const inMay = (may||[]).filter(o => {
  const eff = o.order_date || o.transaction_date;
  return eff && eff >= monthStart && eff < monthEnd;
});
const other = inMay.filter(o => !o.is_delivered && !o.is_returned && !o.is_in_transit);
console.log(`Other (May): ${other.length}`);
const stat = {};
for (const o of other) stat[o.transaction_status] = (stat[o.transaction_status]||0)+1;
console.log('  status breakdown:', stat);

// Historical reversal averages — all-time returned orders for trendy homes
async function pageAll(b) {
  const out = []; for (let f=0;;f+=1000){const{data,error}=await b().range(f,f+999); if(error)throw error; if(!data?.length)break; out.push(...data); if(data.length<1000)break;} return out;
}
const allReturned = await pageAll(()=>sb.from('orders').select('tracking_number, invoice_payment, transaction_fee, transaction_tax, reversal_fee, reversal_tax, cogs_total').eq('store_id', STORE).eq('is_returned', true));
console.log(`\nAll-time returned: ${allReturned.length}`);
const avg = (a,k)=>a.length?a.reduce((s,x)=>s+Number(x[k]||0),0)/a.length:0;
console.log(`  avg invoice_payment : ${avg(allReturned,'invoice_payment').toFixed(2)}`);
console.log(`  avg transaction_fee : ${avg(allReturned,'transaction_fee').toFixed(2)}`);
console.log(`  avg transaction_tax : ${avg(allReturned,'transaction_tax').toFixed(2)}`);
console.log(`  avg reversal_fee    : ${avg(allReturned,'reversal_fee').toFixed(2)}`);
console.log(`  avg reversal_tax    : ${avg(allReturned,'reversal_tax').toFixed(2)}`);
console.log(`  avg cogs_total      : ${avg(allReturned,'cogs_total').toFixed(2)}`);

const allDelivered = await pageAll(()=>sb.from('orders').select('tracking_number, invoice_payment, transaction_fee, transaction_tax, cogs_total').eq('store_id', STORE).eq('is_delivered', true));
console.log(`\nAll-time delivered: ${allDelivered.length}`);
console.log(`  avg invoice_payment : ${avg(allDelivered,'invoice_payment').toFixed(2)}`);
console.log(`  avg transaction_fee : ${avg(allDelivered,'transaction_fee').toFixed(2)}`);
console.log(`  avg transaction_tax : ${avg(allDelivered,'transaction_tax').toFixed(2)}`);
console.log(`  avg cogs_total      : ${avg(allDelivered,'cogs_total').toFixed(2)}`);
