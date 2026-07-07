import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const SHOP = 'the-trendy-homes-pk.myshopify.com';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
await sb.rpc('set_app_store', { store: SHOP });

// 1. Real column names on capi_delivery_log + emq_snapshots
const { data: cdl } = await sb.from('capi_delivery_log').select('*').eq('store_id', SHOP).limit(1);
console.log('capi_delivery_log columns:', cdl?.[0] ? Object.keys(cdl[0]) : '(no rows)');
const { data: emq } = await sb.from('emq_snapshots').select('*').eq('store_id', SHOP).limit(1);
console.log('emq_snapshots columns:', emq?.[0] ? Object.keys(emq[0]) : '(no rows for shop)');
const { data: emqAny } = await sb.from('emq_snapshots').select('*').limit(1);
console.log('emq_snapshots columns (any shop):', emqAny?.[0] ? Object.keys(emqAny[0]) : '(table empty)');

// 2. Total capi_delivery_log rows for shop + min/max of the real ts column + status spread
const { count: cdlCount } = await sb.from('capi_delivery_log').select('*', { count: 'exact', head: true }).eq('store_id', SHOP);
console.log('\ncapi_delivery_log total rows for shop:', cdlCount, '(per-shop cap is 500)');
const tsCol = cdl?.[0] && ('sent_at' in cdl[0] ? 'sent_at' : 'logged_at' in cdl[0] ? 'logged_at' : 'created_at' in cdl[0] ? 'created_at' : Object.keys(cdl[0]).find(k=>/_at$/.test(k)));
console.log('detected timestamp column:', tsCol);
const { data: ext } = await sb.from('capi_delivery_log').select(`${tsCol},event_name,status`).eq('store_id', SHOP).order(tsCol, { ascending: true }).limit(1);
const { data: ext2 } = await sb.from('capi_delivery_log').select(`${tsCol},event_name,status`).eq('store_id', SHOP).order(tsCol, { ascending: false }).limit(1);
console.log('oldest log row:', ext?.[0], ' newest log row:', ext2?.[0]);

// status spread across the whole (capped) log
const { data: spreadRows } = await sb.from('capi_delivery_log').select('event_name,status').eq('store_id', SHOP).limit(600);
const spread = {};
for (const r of spreadRows ?? []) { const k=`${r.event_name}/${r.status}`; spread[k]=(spread[k]??0)+1; }
console.log('status spread across capped log:', spread);

// 3. The 4 no-log Purchase orders: confirm attribution.capi_sent_at + no retry + not in log at all
const ids = ['7673271484732','7673470648636','7674165952828','7674177814844'];
const evIds = ids.map(i=>`purchase:${SHOP}:${i}`);
const { data: at } = await sb.from('order_attribution').select('shopify_order_id,capi_sent_at,channel').in('shopify_order_id', ids).eq('store_id', SHOP);
const { data: lg } = await sb.from('capi_delivery_log').select('event_id,status').in('event_id', evIds).eq('store_id', SHOP);
const { data: rt } = await sb.from('capi_retries').select('event_id,attempts,last_error').in('event_id', evIds).eq('store_id', SHOP);
console.log('\n4 oldest orders — attribution.capi_sent_at:', at);
console.log('4 oldest orders — any capi_delivery_log row:', lg, '(empty = evicted by 500-cap, expected)');
console.log('4 oldest orders — any capi_retries row:', rt, '(empty = no failed delivery pending)');

// 4. Does ANY visitor row for this shop carry hashed em/ph? (identity-capture beacon health)
const { count: vTotal } = await sb.from('visitors').select('*', { count:'exact', head:true }).eq('store_id', SHOP);
const { count: vEm } = await sb.from('visitors').select('*', { count:'exact', head:true }).eq('store_id', SHOP).not('em_hash','is',null);
const { count: vPh } = await sb.from('visitors').select('*', { count:'exact', head:true }).eq('store_id', SHOP).not('ph_hash','is',null);
const { count: vFbc } = await sb.from('visitors').select('*', { count:'exact', head:true }).eq('store_id', SHOP).not('latest_fbc','is',null);
console.log('\nvisitors total:', vTotal, '| with em_hash:', vEm, '| with ph_hash:', vPh, '| with latest_fbc:', vFbc);

// 5. visitor_events: are checkout/identity events ever recorded? (last 24h, all event_names)
const since = new Date(Date.now()-24*3600*1000).toISOString();
const { data: vevCols } = await sb.from('visitor_events').select('*').eq('store_id', SHOP).limit(1);
console.log('visitor_events columns:', vevCols?.[0] ? Object.keys(vevCols[0]) : '(no rows)');
const vevTs = vevCols?.[0] && ('occurred_at' in vevCols[0] ? 'occurred_at' : 'created_at' in vevCols[0] ? 'created_at' : Object.keys(vevCols[0]).find(k=>/_at$/.test(k)));
const { data: vev } = await sb.from('visitor_events').select('event_name').eq('store_id', SHOP).gte(vevTs, since).limit(5000);
const vagg={}; for (const e of vev??[]) vagg[e.event_name]=(vagg[e.event_name]??0)+1;
console.log(`visitor_events last 24h by name (ts col=${vevTs}):`, vagg);

// 6. capi_delivery_log today using the REAL ts column
const startUtc = new Date(Date.UTC(new Date(Date.now()+5*3600e3).getUTCFullYear(), new Date(Date.now()+5*3600e3).getUTCMonth(), new Date(Date.now()+5*3600e3).getUTCDate())-5*3600e3).toISOString();
const { data: todayLog } = await sb.from('capi_delivery_log').select(`event_name,status`).eq('store_id', SHOP).gte(tsCol, startUtc).limit(600);
const tagg={}; for (const r of todayLog??[]) { const k=`${r.event_name}/${r.status}`; tagg[k]=(tagg[k]??0)+1; }
console.log(`\ncapi_delivery_log TODAY (PKT, ts col=${tsCol}) by name/status:`, tagg);
