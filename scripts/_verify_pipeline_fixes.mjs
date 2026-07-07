// Post-deploy verification for the 3 shipped fixes + the pixel deploy.
// Run it NOW (baseline) and again a few hours AFTER `shopify app deploy`
// + a handful of fresh orders. It prints PASS / WATCH per invariant and
// is safe to run repeatedly (read-only).
//
//   node scripts/_verify_pipeline_fixes.mjs
//
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const SHOP = 'the-trendy-homes-pk.myshopify.com';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
await sb.rpc('set_app_store', { store: SHOP });
const now = new Date();
console.log(`=== PIPELINE FIX VERIFICATION @ ${now.toISOString()} ===\n`);

function fbclidLen(fbc) {
  if (typeof fbc !== 'string') return null;
  const m = fbc.match(/^fb\.1\.\d+\.(.+)$/);
  return m ? m[1].length : null;
}

// ── FIX 2 — buyer PII now persists onto visitor rows ────────────────────
// Baseline today: 0. After deploy + new orders this must climb (every
// Purchase with a recovered visitor writes em/ph back).
const { count: emCnt } = await sb.from('visitors').select('*', { count: 'exact', head: true })
  .eq('store_id', SHOP).not('em_hash', 'is', null);
const { count: phCnt } = await sb.from('visitors').select('*', { count: 'exact', head: true })
  .eq('store_id', SHOP).not('ph_hash', 'is', null);
const { data: emNew } = await sb.from('visitors').select('visitor_id,last_seen_at')
  .eq('store_id', SHOP).not('em_hash', 'is', null).order('last_seen_at', { ascending: false }).limit(1);
console.log('[FIX 2] visitor rows with em_hash:', emCnt, '| ph_hash:', phCnt,
  '| newest:', emNew?.[0]?.last_seen_at ?? '(none yet)');
console.log(emCnt > 0
  ? '         PASS — buyer PII is being written back to visitor rows.'
  : '         WATCH — still 0. Expected until the new webhook code is LIVE (Railway redeploy) and ≥1 new order lands.');

// ── FIX 1 — no modified/truncated fbclid on the wire ────────────────────
// We can't read sent payloads, but we can check the fbc that WOULD be sent
// (visitor.latest_fbc) for the last 25 Meta-attributed orders, and confirm
// none is the ~91-char Shopify-truncated form. Also: capi_retries must be
// clean (a 400 from Meta for bad fbc would land there).
const { data: at } = await sb.from('order_attribution')
  .select('shopify_order_id,visitor_id,channel,capi_sent_at,attributed_at')
  .eq('store_id', SHOP).neq('channel', 'direct_organic')
  .order('attributed_at', { ascending: false }).limit(25);
let trunc = 0, full = 0, noFbc = 0;
for (const a of at ?? []) {
  if (!a.visitor_id) { noFbc++; continue; }
  const v = (await sb.from('visitors').select('latest_fbc').eq('store_id', SHOP)
    .eq('visitor_id', a.visitor_id).maybeSingle()).data;
  const L = fbclidLen(v?.latest_fbc);
  if (L == null) noFbc++;
  else if (L <= 100) trunc++;            // Shopify truncates landing_site to ~91
  else full++;
}
const { count: retryCnt } = await sb.from('capi_retries').select('*', { count: 'exact', head: true }).eq('store_id', SHOP);
console.log(`\n[FIX 1] last 25 Meta orders — visitor fbc: full=${full} truncated(≤100)=${trunc} none=${noFbc}`);
console.log(`         capi_retries backlog: ${retryCnt ?? 0}`);
console.log(trunc === 0
  ? '         PASS — no truncated fbclid would be sent (omitted instead per Meta guidance).'
  : `         NOTE — ${trunc} visitor rows hold a truncated fbc; pickBestFbc still sends it ONLY if it is a real cookie value. Confirm Meta "modified fbclid" diagnostic clears within 3 days of deploy.`);
console.log('         ACTION — open Events Manager → New Trendy → Diagnostics; the "modified fbclid value in fbc parameter" error should drop off ~3 days after the Railway deploy.');

// ── FIX 3 — PageView event_id prefix unified ────────────────────────────
// New PageView delivery-log rows must use the "page_viewed:" prefix.
// "pageview:" rows are pre-deploy; once the theme asset is republished
// only "page_viewed:" should appear for fresh rows.
const { data: pv } = await sb.from('capi_delivery_log')
  .select('event_id,sent_at').eq('store_id', SHOP).eq('event_name', 'PageView')
  .order('sent_at', { ascending: false }).limit(50);
const pref = {};
for (const r of pv ?? []) { const p = (r.event_id || '').split(':')[0]; pref[p] = (pref[p] ?? 0) + 1; }
const newest = pv?.[0];
console.log(`\n[FIX 3] last 50 PageView event_id prefixes:`, pref, `| newest sent_at: ${newest?.sent_at}`);
console.log((newest && newest.event_id.startsWith('page_viewed:'))
  ? '         PASS — newest PageView uses unified "page_viewed:" prefix (theme asset republished).'
  : '         WATCH — newest still "pageview:". Expected until the theme app embed asset is redeployed/CDN-refreshed.');

// ── Overall health (regression guard) ───────────────────────────────────
const { data: emq } = await sb.from('emq_snapshots').select('captured_at,overall_emq,per_event')
  .eq('store_id', SHOP).order('captured_at', { ascending: false }).limit(4);
console.log('\n[HEALTH] EMQ proxy trend (browse events should rise as em/ph populate):');
for (const e of emq ?? []) console.log('  ', e.captured_at?.slice(0, 10), 'overall', e.overall_emq, JSON.stringify(e.per_event));
const { data: conn } = await sb.from('meta_pixel_connections')
  .select('status,last_event_sent_at').eq('store_id', SHOP).maybeSingle();
console.log('[HEALTH] connection:', conn?.status, '| last_event_sent_at:', conn?.last_event_sent_at,
  '(should be minutes-fresh — pipeline alive)');

console.log('\nRe-run after deploy + a few orders. Expected deltas:');
console.log('  FIX2 em_hash count: 0 -> >0   FIX3 newest PageView: page_viewed:   FIX1 retries stays 0 + Meta diagnostic clears in ~3d');
