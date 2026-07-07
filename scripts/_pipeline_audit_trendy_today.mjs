// One-off: full ad-tracking pipeline audit for the-trendy-homes-pk, PKT-today.
// Ground truth = Shopify Admin order list (the Purchase webhook's entry point).
// Traces each order: cart attrs -> visitor row -> CAPI delivery -> attribution.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SHOP = 'the-trendy-homes-pk.myshopify.com';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
await sb.rpc('set_app_store', { store: SHOP });

// PKT (UTC+5) "today" window
const now = new Date();
const pkt = new Date(now.getTime() + 5 * 3600 * 1000);
const startUtc = new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), pkt.getUTCDate()) - 5 * 3600 * 1000);
const startIso = startUtc.toISOString();
console.log(`=== AD-TRACKING PIPELINE AUDIT — ${SHOP} ===`);
console.log(`PKT today = ${startIso}  ->  ${now.toISOString()} (now)\n`);

// ── 0. Connection health ────────────────────────────────────────────────
const { data: conn } = await sb.from('meta_pixel_connections').select('*').eq('store_id', SHOP).maybeSingle();
console.log('--- meta_pixel_connections ---');
if (!conn) {
  console.log('NO CONNECTION ROW — CAPI would silently drop.');
} else {
  console.log({
    status: conn.status, status_reason: conn.status_reason,
    dataset_id: conn.dataset_id, web_pixel_id: conn.web_pixel_id,
    has_token: !!conn.bisu_token, last_event_sent_at: conn.last_event_sent_at,
    created_at: conn.created_at,
  });
}

// ── 1. Shopify offline token (same source the reconcile cron uses) ──────
const { data: sess } = await sb.from('shopify_sessions')
  .select('accessToken').eq('shop', SHOP).eq('isOnline', false).limit(1);
const token = sess?.[0]?.accessToken;
if (!token) { console.log('\nNO OFFLINE SESSION — cannot pull Shopify orders. Aborting.'); process.exit(1); }

// ── 2. Pull all Shopify orders created today ────────────────────────────
const url = `https://${SHOP}/admin/api/2025-10/orders.json?` + new URLSearchParams({
  created_at_min: startIso, status: 'any', limit: '250',
});
const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
if (!r.ok) { console.log(`\nShopify ${r.status}: ${(await r.text()).slice(0, 300)}`); process.exit(1); }
const { orders } = await r.json();
console.log(`\n--- Shopify reports ${orders.length} order(s) created today (PKT) ---\n`);

// ── 3. Bulk-fetch pipeline state ────────────────────────────────────────
const orderIds = orders.map(o => String(o.id));
const eventIds = orders.map(o => `purchase:${SHOP}:${o.id}`);

const { data: attribRows } = await sb.from('order_attribution')
  .select('*').eq('store_id', SHOP).in('shopify_order_id', orderIds);
const attribByOrder = new Map((attribRows ?? []).map(a => [String(a.shopify_order_id), a]));

const { data: logRows } = await sb.from('capi_delivery_log')
  .select('*').eq('store_id', SHOP).in('event_id', eventIds);
const logByEvent = new Map();
for (const l of logRows ?? []) {
  // keep best status per event: sent > failed > dropped
  const rank = { sent: 3, failed: 2, dropped: 1 };
  const prev = logByEvent.get(l.event_id);
  if (!prev || (rank[l.status] ?? 0) > (rank[prev.status] ?? 0)) logByEvent.set(l.event_id, l);
}

const { data: retryRows } = await sb.from('capi_retries')
  .select('event_id,event_name,attempts,next_attempt_at,last_error').eq('store_id', SHOP).in('event_id', eventIds);
const retryByEvent = new Map((retryRows ?? []).map(x => [x.event_id, x]));

// visitor ids referenced by attribution
const visitorIds = [...new Set((attribRows ?? []).map(a => a.visitor_id).filter(Boolean))];
let visitorById = new Map();
if (visitorIds.length) {
  const { data: vs } = await sb.from('visitors').select('*').eq('store_id', SHOP).in('visitor_id', visitorIds);
  visitorById = new Map((vs ?? []).map(v => [v.visitor_id, v]));
}

function attr(o, names) {
  const a = o.note_attributes ?? [];
  for (const x of a) if (names.includes(x.name)) return x.value;
  return null;
}
function fbclidFromUrl(u) { try { return new URL(u, 'https://x.com').searchParams.get('fbclid'); } catch { return null; } }

// ── 4. Per-order trace ──────────────────────────────────────────────────
const summary = { total: orders.length, capiSent: 0, capiSentViaLog: 0, capiSentViaAttr: 0,
  capiMissing: 0, capiFailed: 0, capiDropped: 0, capiRetryPending: 0,
  hasAttribRow: 0, fb: 0, ig: 0, direct: 0,
  fbcOnEvent: 0, visitorMatched: 0, hadCartVisitorId: 0, hadLandingFbclid: 0 };

for (const o of orders) {
  const oid = String(o.id);
  const evId = `purchase:${SHOP}:${o.id}`;
  const a = attribByOrder.get(oid);
  const log = logByEvent.get(evId);
  const retry = retryByEvent.get(evId);
  const cartVid = attr(o, ['_cod_visitor_id']);
  const cartFbc = attr(o, ['_fbc', 'fbc']);
  const cartFbp = attr(o, ['_fbp', 'fbp']);
  const cartEvId = attr(o, ['_cod_event_id', 'event_id']);
  const landingFbclid = fbclidFromUrl(o.landing_site);
  const v = a?.visitor_id ? visitorById.get(a.visitor_id) : null;

  const capiSent = (log?.status === 'sent') || !!a?.capi_sent_at;
  if (capiSent) summary.capiSent++;
  if (log?.status === 'sent') summary.capiSentViaLog++;
  if (a?.capi_sent_at) summary.capiSentViaAttr++;
  if (!capiSent && !log) summary.capiMissing++;
  if (log?.status === 'failed') summary.capiFailed++;
  if (log?.status === 'dropped') summary.capiDropped++;
  if (retry) summary.capiRetryPending++;
  if (a) summary.hasAttribRow++;
  if (a?.channel === 'facebook_ads') summary.fb++;
  else if (a?.channel === 'instagram_ads') summary.ig++;
  else if (a?.channel === 'direct_organic') summary.direct++;
  if (cartFbc || v?.latest_fbc || landingFbclid) summary.fbcOnEvent++;
  if (v) summary.visitorMatched++;
  if (cartVid) summary.hadCartVisitorId++;
  if (landingFbclid) summary.hadLandingFbclid++;

  console.log(`#${o.name}  (id ${oid})  ${o.created_at}  ${o.total_price} ${o.currency}  fin=${o.financial_status}`);
  console.log(`  landing_site: ${(o.landing_site ?? '(none)').slice(0, 140)}`);
  console.log(`  cart attrs: visitor_id=${cartVid ? cartVid.slice(0,8)+'…' : '✗'}  _fbc=${cartFbc ? 'present' : '✗'}  _fbp=${cartFbp ? 'present' : '✗'}  _cod_event_id=${cartEvId ?? '✗'}  landing_fbclid=${landingFbclid ? 'present' : '✗'}`);
  if (log) console.log(`  capi_delivery_log: status=${log.status} http=${log.http_status} trace=${log.trace_id ?? '-'} err=${log.error_msg ?? '-'} match_keys=${log.match_keys ? '['+log.match_keys.join(',')+']' : '-'} at=${log.created_at}`);
  else console.log(`  capi_delivery_log: (no row for ${evId})`);
  if (retry) console.log(`  capi_retries: attempts=${retry.attempts} next=${retry.next_attempt_at} err=${retry.last_error}`);
  if (a) console.log(`  order_attribution: channel=${a.channel} utm_source=${a.utm_source ?? '-'} utm_campaign=${a.utm_campaign ?? '-'} visitor_id=${a.visitor_id ? a.visitor_id.slice(0,8)+'…' : '✗'} capi_sent_at=${a.capi_sent_at ?? '✗'} attributed_at=${a.attributed_at}`);
  else console.log(`  order_attribution: (NO ROW — webhook never wrote attribution)`);
  if (v) {
    const hk = ['em_hash','ph_hash','fn_hash','ln_hash','ct_hash','st_hash','zp_hash','country_hash','external_id_hash'].filter(k => v[k]);
    console.log(`  visitor row: latest_fbc=${v.latest_fbc ? 'present' : '✗'} latest_fbp=${v.latest_fbp ? 'present' : '✗'} latest_ip=${v.latest_ip ? 'present' : '✗'} hashed_PII=[${hk.map(k=>k.replace('_hash','')).join(',')}] fbc_hist=${(v.fbc_history?.length)||0} first_seen=${v.first_seen_at} last_seen=${v.last_seen_at}`);
  } else if (a?.visitor_id) {
    console.log(`  visitor row: (attribution references visitor_id ${a.visitor_id.slice(0,8)}… but NO visitors row found)`);
  } else {
    console.log(`  visitor row: (no visitor linked — anonymous / IAB / beacon never created one)`);
  }
  console.log('');
}

// ── 5. Pipeline-wide health today ───────────────────────────────────────
const { count: visTouched } = await sb.from('visitors').select('*', { count: 'exact', head: true })
  .eq('store_id', SHOP).gte('last_seen_at', startIso);
const { data: vevs } = await sb.from('visitor_events').select('event_name')
  .eq('store_id', SHOP).gte('occurred_at', startIso).limit(5000);
const vevByName = {};
for (const e of vevs ?? []) vevByName[e.event_name] = (vevByName[e.event_name] ?? 0) + 1;
const { data: allLogToday } = await sb.from('capi_delivery_log')
  .select('event_name,status').eq('store_id', SHOP).gte('created_at', startIso).limit(5000);
const logAgg = {};
for (const l of allLogToday ?? []) {
  const k = `${l.event_name}/${l.status}`; logAgg[k] = (logAgg[k] ?? 0) + 1;
}
const { data: emq } = await sb.from('emq_snapshots').select('*')
  .eq('store_id', SHOP).order('snapshot_date', { ascending: false }).limit(1);

console.log('=== PIPELINE-WIDE (today, PKT) ===');
console.log(`visitors touched today (last_seen >= start): ${visTouched ?? 'n/a'}`);
console.log(`visitor_events today by type:`, vevByName);
console.log(`capi_delivery_log today (all events) by name/status:`, logAgg);
console.log(`latest emq_snapshot:`, emq?.[0] ? {
  date: emq[0].snapshot_date, overall: emq[0].overall_emq,
  purchase: emq[0].purchase_emq ?? emq[0].event_scores, } : '(none)');

console.log('\n=== SUMMARY ===');
console.log(summary);
