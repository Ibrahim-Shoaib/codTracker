// May 2026 profit projection for Trendy Homes — order count + value pulled from
// Shopify Admin API (NOT the PostEx orders table). 35% return rate, no store expenses.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SHOP = 'the-trendy-homes-pk.myshopify.com';
const RETURN_RATE = 0.35;
const SELLABLE_RETURNS_PCT = 85; // unsellable share = 15%

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

// 1. Get Shopify offline access token
const { data: sessions } = await sb.from('shopify_sessions').select('accessToken').eq('shop', SHOP).eq('isOnline', false);
const accessToken = sessions?.[0]?.accessToken;
if (!accessToken) { console.error('No offline session'); process.exit(1); }

// 2. Pull every Shopify order since May 1 PKT
async function fetchAllOrders(sinceIso) {
  const orders = [];
  let url = `https://${SHOP}/admin/api/2025-10/orders.json?` +
    new URLSearchParams({ created_at_min: sinceIso, status: 'any', limit: '250' });
  while (url) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': accessToken } });
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
    const body = await res.json();
    orders.push(...(body.orders ?? []));
    const link = res.headers.get('link') ?? '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return orders;
}

const mayStartIso = '2026-05-01T00:00:00+05:00';
const allOrders = await fetchAllOrders(mayStartIso);

// 3. Bucketing: May only (created_at in PKT-May)
const inMay = allOrders.filter(o => {
  const t = new Date(o.created_at).getTime();
  return t >= Date.parse('2026-05-01T00:00:00+05:00') && t < Date.parse('2026-06-01T00:00:00+05:00');
});

const cancelled = inMay.filter(o => o.cancelled_at);
const live      = inMay.filter(o => !o.cancelled_at);

console.log(`Shopify orders pulled (since May 1): ${allOrders.length}`);
console.log(`  In May (PKT)            : ${inMay.length}`);
console.log(`  Cancelled               : ${cancelled.length}`);
console.log(`  Live (non-cancelled)    : ${live.length}\n`);

// 4. Order value (use total_price; what the customer would pay)
const sumTotal = (arr) => arr.reduce((s, o) => s + Number(o.total_price ?? 0), 0);
const totalAllValue  = sumTotal(inMay);
const totalLiveValue = sumTotal(live);
const aovAll  = inMay.length ? totalAllValue / inMay.length : 0;
const aovLive = live.length ? totalLiveValue / live.length : 0;

console.log(`AOV (all orders incl. cancelled): ${aovAll.toFixed(0)} PKR`);
console.log(`AOV (live only)                 : ${aovLive.toFixed(0)} PKR\n`);

// 5. COGS — match each order's line_items.variant_id against product_costs
const variantIds = new Set();
for (const o of inMay) for (const li of (o.line_items ?? [])) if (li.variant_id) variantIds.add(String(li.variant_id));

const { data: pcRows } = await sb.from('product_costs')
  .select('shopify_variant_id, unit_cost').eq('store_id', SHOP);
const costByVariant = new Map();
for (const r of (pcRows ?? [])) costByVariant.set(String(r.shopify_variant_id), Number(r.unit_cost) || 0);

let storeAvgCost = 0;
{
  const valid = (pcRows ?? []).map(r => Number(r.unit_cost)).filter(v => v > 0);
  storeAvgCost = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
}

function orderCogs(order) {
  let total = 0;
  for (const li of (order.line_items ?? [])) {
    const unit = costByVariant.get(String(li.variant_id)) || storeAvgCost;
    total += unit * Number(li.quantity || 1);
  }
  return total;
}
const totalCogsAll  = inMay.reduce((s, o) => s + orderCogs(o), 0);
const totalCogsLive = live.reduce((s, o) => s + orderCogs(o), 0);
const cogsPerOrderAll  = inMay.length ? totalCogsAll / inMay.length : 0;
const cogsPerOrderLive = live.length ? totalCogsLive / live.length : 0;

console.log(`COGS / order (all orders): ${cogsPerOrderAll.toFixed(0)} PKR`);
console.log(`COGS / order (live only) : ${cogsPerOrderLive.toFixed(0)} PKR\n`);

// 6. PostEx fee unit economics — historical from the orders table
async function pageAll(b) {
  const out = [];
  for (let f=0;;f+=1000){const{data,error}=await b().range(f,f+999); if(error)throw error; if(!data?.length)break; out.push(...data); if(data.length<1000)break;}
  return out;
}
await sb.rpc('set_app_store', { store: SHOP });
const histDelivered = await pageAll(()=>sb.from('orders')
  .select('transaction_fee, transaction_tax').eq('store_id', SHOP).eq('is_delivered', true));
const histReturned = await pageAll(()=>sb.from('orders')
  .select('reversal_fee, reversal_tax').eq('store_id', SHOP).eq('is_returned', true));
const avg = (a,k) => a.length ? a.reduce((s,x)=>s+Number(x[k]||0),0)/a.length : 0;
const fwdCostPerOrder = avg(histDelivered, 'transaction_fee') + avg(histDelivered, 'transaction_tax');
const revCostPerReturn = avg(histReturned, 'reversal_fee') + avg(histReturned, 'reversal_tax');

console.log(`Forward delivery cost / delivered (hist, ${histDelivered.length}): ${fwdCostPerOrder.toFixed(0)} PKR`);
console.log(`Reversal cost / returned (hist, ${histReturned.length})         : ${revCostPerReturn.toFixed(0)} PKR\n`);

// 7. May ad spend
const { data: adRows } = await sb.from('ad_spend')
  .select('spend_date, amount').eq('store_id', SHOP)
  .gte('spend_date', '2026-05-01').lte('spend_date', '2026-05-31');
const adSpend = (adRows ?? []).reduce((s, r) => s + Number(r.amount || 0), 0);

// 8. Two projections — (a) all orders incl. cancelled, (b) live only
function projectScenario(label, count, totalValue, totalCogs) {
  const D = count * (1 - RETURN_RATE);
  const R = count * RETURN_RATE;
  const Sales       = D * (count ? totalValue / count : 0);   // = totalValue * (1-RETURN_RATE)
  const COGSdel     = D * (count ? totalCogs / count : 0);
  const COGSret     = R * (count ? totalCogs / count : 0) * (1 - SELLABLE_RETURNS_PCT/100);
  const COGS        = COGSdel + COGSret;
  const FwdCost     = D * fwdCostPerOrder;
  const RetCost     = R * revCostPerReturn;
  const Net         = Sales - COGS - FwdCost - RetCost - adSpend;
  console.log(`─── ${label} ───`);
  console.log(`  Orders                : ${count}`);
  console.log(`  Projected delivered   : ${D.toFixed(1)}`);
  console.log(`  Projected returned    : ${R.toFixed(1)}`);
  console.log(`  Sales                 : ${Sales.toFixed(0)} PKR`);
  console.log(`  COGS (del + 15% of ret): -${COGS.toFixed(0)}`);
  console.log(`  Forward delivery      : -${FwdCost.toFixed(0)}`);
  console.log(`  Reversal/return cost  : -${RetCost.toFixed(0)}`);
  console.log(`  Ad spend (actual May) : -${adSpend.toFixed(0)}`);
  console.log(`  ────────────────────────────────────────`);
  console.log(`  NET PROFIT (no expenses): ${Net.toFixed(0)} PKR\n`);
}

projectScenario('Scenario A: all Shopify orders (incl. cancelled)', inMay.length, totalAllValue, totalCogsAll);
projectScenario('Scenario B: live orders only (excl. cancelled)',   live.length,  totalLiveValue, totalCogsLive);
