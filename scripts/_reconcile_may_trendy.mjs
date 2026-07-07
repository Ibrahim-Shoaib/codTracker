// Reconcile: Shopify shows PKR 873,315 total sales for May.
// Dashboard shows PKR 590,476 delivered sales, PKR 41,489 unfulfilled, PKR 76,980 in transit.
// Where's the rest of the money?
//
// Goal: bucket every Shopify May order into a status category and see what our
// dashboard captures vs what Shopify counts. No fixes here — just diagnosis.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SHOP = 'the-trendy-homes-pk.myshopify.com';
const MAY_START_PKT = '2026-05-01T00:00:00+05:00';
const MAY_END_PKT   = '2026-06-01T00:00:00+05:00';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

// ── 1. Grab store row ──
await sb.rpc('set_app_store', { store: SHOP });
const { data: storeRow } = await sb.from('stores').select('*').eq('store_id', SHOP).single();
console.log(`Store: ${SHOP}`);
console.log(`  Currency: ${storeRow?.currency}`);
console.log(`  Ingest mode: ${storeRow?.ingest_mode}`);
console.log(`  Money format: ${storeRow?.money_format}`);
console.log(`  Is demo: ${storeRow?.is_demo}\n`);

// ── 2. Get Shopify offline token ──
const { data: sessions } = await sb.from('shopify_sessions').select('accessToken').eq('shop', SHOP).eq('isOnline', false);
const accessToken = sessions?.[0]?.accessToken;
if (!accessToken) { console.error('No offline session'); process.exit(1); }

// ── 3. Fetch every Shopify order created in May PKT ──
async function fetchAllOrders(sinceIso, untilIso) {
  const orders = [];
  let url = `https://${SHOP}/admin/api/2025-10/orders.json?` +
    new URLSearchParams({
      created_at_min: sinceIso,
      created_at_max: untilIso,
      status: 'any',
      limit: '250',
      fields: 'id,name,created_at,cancelled_at,cancel_reason,financial_status,fulfillment_status,total_price,current_total_price,subtotal_price,total_discounts,total_tax,total_refunded,refunds,tags,line_items,total_shipping_price_set,gateway'
    });
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

const shopifyOrders = await fetchAllOrders(MAY_START_PKT, MAY_END_PKT);
console.log(`Shopify orders in May PKT: ${shopifyOrders.length}\n`);

const sum = (arr, k) => arr.reduce((s, o) => s + Number(o[k] ?? 0), 0);

// ── 4. Break Shopify orders into buckets ──
const cancelled       = shopifyOrders.filter(o => o.cancelled_at);
const notCancelled    = shopifyOrders.filter(o => !o.cancelled_at);
const fulfilled       = notCancelled.filter(o => o.fulfillment_status === 'fulfilled');
const partiallyFul    = notCancelled.filter(o => o.fulfillment_status === 'partial');
const unfulfilled     = notCancelled.filter(o => !o.fulfillment_status || o.fulfillment_status === null);
const refundedAny     = notCancelled.filter(o => Number(o.total_refunded ?? 0) > 0);

console.log('─── Shopify buckets (May PKT) ───');
console.log(`  Total orders                       : ${shopifyOrders.length}`);
console.log(`  Cancelled                          : ${cancelled.length}   value=${sum(cancelled,'total_price').toFixed(0)}`);
console.log(`  Not cancelled                      : ${notCancelled.length}   value=${sum(notCancelled,'total_price').toFixed(0)}`);
console.log(`    ├─ Fulfilled                     : ${fulfilled.length}   value=${sum(fulfilled,'total_price').toFixed(0)}`);
console.log(`    ├─ Partially fulfilled           : ${partiallyFul.length}   value=${sum(partiallyFul,'total_price').toFixed(0)}`);
console.log(`    └─ Unfulfilled                   : ${unfulfilled.length}   value=${sum(unfulfilled,'total_price').toFixed(0)}`);
console.log(`  Refunded (any amount)              : ${refundedAny.length}   value=${sum(refundedAny,'total_price').toFixed(0)}`);

// Shopify Analytics "total sales" = subtotal - discounts + tax + shipping - refunds (roughly gross_sales)
// Or their gross_sales = SUM(line_item.price * quantity), which is close to subtotal + discounts (pre-discount)
// For a COD shop with mostly discount-free orders, total_price ≈ gross_sales.
// Let's also compute a few candidates:
const totalPriceSum  = sum(shopifyOrders, 'total_price');
const subtotalSum    = sum(shopifyOrders, 'subtotal_price');
const currentTotalSum = sum(shopifyOrders, 'current_total_price'); // total minus refunds

console.log(`\n─── Shopify aggregate candidates (May PKT) ───`);
console.log(`  SUM(total_price)          : ${totalPriceSum.toFixed(0)}`);
console.log(`  SUM(subtotal_price)       : ${subtotalSum.toFixed(0)}`);
console.log(`  SUM(current_total_price)  : ${currentTotalSum.toFixed(0)}  (after refunds)`);

// ── 5. Compare against PostEx orders table for the same period ──
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

// Dashboard uses COALESCE(order_date, transaction_date) so bucket the same way
const pxRows = await pageAll(() => sb.from('orders')
  .select('tracking_number, order_ref_number, transaction_date, order_date, invoice_payment, transaction_status, is_delivered, is_returned, is_in_transit')
  .eq('store_id', SHOP));

const inMayPKT = (iso) => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= Date.parse(MAY_START_PKT) && t < Date.parse(MAY_END_PKT);
};

// Bucket by COALESCE(order_date, transaction_date) — same as dashboard
const pxMay = pxRows.filter(r => inMayPKT(r.order_date || r.transaction_date));

const pxDelivered  = pxMay.filter(r => r.is_delivered);
const pxReturned   = pxMay.filter(r => r.is_returned);
const pxInTransit  = pxMay.filter(r => r.is_in_transit);
const pxOther      = pxMay.filter(r => !r.is_delivered && !r.is_returned && !r.is_in_transit);

const sumIP = (a) => a.reduce((s, r) => s + Number(r.invoice_payment || 0), 0);

console.log(`\n─── PostEx orders bucketed by COALESCE(order_date, transaction_date) in May PKT ───`);
console.log(`  Total PostEx rows in May : ${pxMay.length}`);
console.log(`  Delivered                : ${pxDelivered.length}   invoice_payment=${sumIP(pxDelivered).toFixed(0)}   ← dashboard "Sales"`);
console.log(`  Returned                 : ${pxReturned.length}   invoice_payment=${sumIP(pxReturned).toFixed(0)}   (excluded from Sales)`);
console.log(`  In transit               : ${pxInTransit.length}   invoice_payment=${sumIP(pxInTransit).toFixed(0)}   ← "In Transit" pill`);
console.log(`  Other (no flag)          : ${pxOther.length}   invoice_payment=${sumIP(pxOther).toFixed(0)}`);

console.log(`\n  Grand total (all statuses, all PostEx rows in May): ${sumIP(pxMay).toFixed(0)}`);

// ── 6. Match Shopify orders → PostEx rows and see what's missing ──
// PostEx matches Shopify via order_ref_number = Shopify name (strip #).
const pxByRef = new Map();
for (const r of pxRows) {
  if (r.order_ref_number) pxByRef.set(String(r.order_ref_number).replace(/^#/, ''), r);
}

const shopifyWithPxMatch    = [];
const shopifyWithoutPxMatch = [];
for (const o of shopifyOrders) {
  const ref = String(o.name || '').replace(/^#/, '');
  const px = pxByRef.get(ref);
  if (px) shopifyWithPxMatch.push({ shopify: o, postex: px });
  else shopifyWithoutPxMatch.push(o);
}
console.log(`\n─── Shopify → PostEx match rate ───`);
console.log(`  Matched                : ${shopifyWithPxMatch.length}   value=${sum(shopifyWithPxMatch.map(x=>x.shopify),'total_price').toFixed(0)}`);
console.log(`  Not in PostEx table    : ${shopifyWithoutPxMatch.length}   value=${sum(shopifyWithoutPxMatch,'total_price').toFixed(0)}`);

if (shopifyWithoutPxMatch.length > 0) {
  console.log(`\n  Unmatched Shopify orders (first 20):`);
  for (const o of shopifyWithoutPxMatch.slice(0, 20)) {
    console.log(`    ${o.name}  ${o.created_at.slice(0,10)}  total=${o.total_price}  ` +
      `fulfill=${o.fulfillment_status ?? '-'}  cancelled=${o.cancelled_at ? 'Y':'N'}  ` +
      `financial=${o.financial_status}  gateway=${o.gateway ?? '-'}`);
  }
  if (shopifyWithoutPxMatch.length > 20) console.log(`    ... and ${shopifyWithoutPxMatch.length - 20} more`);
}

// ── 7. What's the diff between Shopify total_price and PostEx invoice_payment per matched order? ──
let matchedShopifyTotal = 0;
let matchedPxIP         = 0;
const bigGaps = [];
for (const { shopify, postex } of shopifyWithPxMatch) {
  const sTotal = Number(shopify.total_price ?? 0);
  const pIP    = Number(postex.invoice_payment ?? 0);
  matchedShopifyTotal += sTotal;
  matchedPxIP         += pIP;
  if (Math.abs(sTotal - pIP) > 100) bigGaps.push({ shopify, postex, sTotal, pIP, diff: sTotal - pIP });
}
console.log(`\n─── Matched pairs: Shopify total_price vs PostEx invoice_payment ───`);
console.log(`  SUM Shopify total_price  : ${matchedShopifyTotal.toFixed(0)}`);
console.log(`  SUM PostEx invoice_pay   : ${matchedPxIP.toFixed(0)}`);
console.log(`  Diff                     : ${(matchedShopifyTotal - matchedPxIP).toFixed(0)}`);
console.log(`  Rows with >100 PKR gap   : ${bigGaps.length}`);
if (bigGaps.length > 0) {
  console.log(`  Sample big-gap rows (first 10, sorted by abs diff):`);
  bigGaps.sort((a,b) => Math.abs(b.diff) - Math.abs(a.diff));
  for (const g of bigGaps.slice(0, 10)) {
    console.log(`    ${g.shopify.name}  shop=${g.sTotal}  px=${g.pIP}  diff=${g.diff.toFixed(0)}  ` +
      `[px_status="${g.postex.transaction_status}"  del=${g.postex.is_delivered}  ret=${g.postex.is_returned}  it=${g.postex.is_in_transit}]`);
  }
}

// ── 8. Final reconciliation table ──
console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
console.log(`║  RECONCILIATION: Shopify May total vs Dashboard Sales           ║`);
console.log(`╚════════════════════════════════════════════════════════════════╝`);
console.log(`Shopify SUM(total_price)                  = ${totalPriceSum.toFixed(0)}`);
console.log(`  - Cancelled (${cancelled.length} orders)              = -${sum(cancelled,'total_price').toFixed(0)}`);
console.log(`  - Refunded portion (SUM total_refunded) = -${sum(shopifyOrders,'total_refunded').toFixed(0)}`);
console.log(`  = Net Shopify (current_total_price)     = ${currentTotalSum.toFixed(0)}`);
console.log(``);
console.log(`Dashboard breakdown (PostEx, bucketed by order_date PKT):`);
console.log(`  Delivered (Sales card)                  = ${sumIP(pxDelivered).toFixed(0)}`);
console.log(`  Returned (excluded, but counted as loss)= ${sumIP(pxReturned).toFixed(0)}`);
console.log(`  In transit (pill)                       = ${sumIP(pxInTransit).toFixed(0)}`);
console.log(`  Other/unflagged                         = ${sumIP(pxOther).toFixed(0)}`);
console.log(`  Total PostEx (rough)                    = ${sumIP(pxMay).toFixed(0)}`);
console.log(``);
console.log(`Shopify not in PostEx at all              = ${sum(shopifyWithoutPxMatch,'total_price').toFixed(0)}   ← Unfulfilled pill covers a portion of this`);
