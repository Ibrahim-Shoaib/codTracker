// Forensic measurement — NO speculation. Measures fbc truncation/case,
// event_id dedup correctness, EMQ trend, active client paths.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const SHOP = 'the-trendy-homes-pk.myshopify.com';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
await sb.rpc('set_app_store', { store: SHOP });
const d3 = new Date(Date.now() - 3 * 864e5).toISOString();

function fbcParts(fbc) {
  // fb.1.<ts>.<fbclid>
  if (typeof fbc !== 'string') return null;
  const m = fbc.match(/^fb\.1\.(\d+)\.(.+)$/);
  if (!m) return { malformed: true, raw: fbc.slice(0, 30) };
  return { ts: m[1], fbclid: m[2], fbclidLen: m[2].length, hasUpper: /[A-Z]/.test(m[2]) };
}

// ── 1. fbc forensics from visitor rows (the value pickBestFbc tier-2 sends) ──
const { data: vs } = await sb.from('visitors')
  .select('visitor_id,latest_fbc,fbc_history,last_seen_at')
  .eq('store_id', SHOP).not('latest_fbc', 'is', null)
  .gte('last_seen_at', d3).order('last_seen_at', { ascending: false }).limit(400);
const lens = [], upper = [], malformed = [];
for (const v of vs ?? []) {
  const p = fbcParts(v.latest_fbc);
  if (!p) continue;
  if (p.malformed) { malformed.push(p.raw); continue; }
  lens.push(p.fbclidLen);
  if (p.hasUpper) upper.push(1);
}
lens.sort((a, b) => a - b);
const pct = q => lens.length ? lens[Math.floor(q * (lens.length - 1))] : null;
console.log('=== fbc forensics (visitor.latest_fbc, last 3d, n=' + lens.length + ') ===');
console.log(`fbclid length  min=${lens[0]} p10=${pct(.1)} p50=${pct(.5)} p90=${pct(.9)} max=${lens[lens.length-1]}`);
console.log(`has uppercase chars: ${upper.length}/${lens.length} (Meta fbclids ARE mixed-case; all-lowercase => modified)`);
console.log(`malformed (not fb.1.ts.fbclid): ${malformed.length}`, malformed.slice(0, 3));
// histogram of lengths to spot a truncation cliff (e.g. everything == 91)
const hist = {};
for (const l of lens) { const b = Math.floor(l / 10) * 10; hist[b] = (hist[b] ?? 0) + 1; }
console.log('fbclid-length histogram (bucket=10):', hist);

// ── 2. Compare today's order landing_site fbclid vs the visitor fbc sent ──
const { data: sess } = await sb.from('shopify_sessions').select('accessToken').eq('shop', SHOP).eq('isOnline', false).limit(1);
const tok = sess?.[0]?.accessToken;
const now = new Date(); const pkt = new Date(now.getTime() + 5 * 36e5);
const startIso = new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), pkt.getUTCDate()) - 5 * 36e5).toISOString();
const or = await fetch(`https://${SHOP}/admin/api/2025-10/orders.json?` + new URLSearchParams({ created_at_min: startIso, status: 'any', limit: '50' }), { headers: { 'X-Shopify-Access-Token': tok } });
const { orders } = await or.json();
console.log(`\n=== today's orders: landing_site fbclid len vs visitor fbc len ===`);
for (const o of orders) {
  let lf = null; try { lf = new URL(o.landing_site, 'https://x.com').searchParams.get('fbclid'); } catch {}
  const a = (await sb.from('order_attribution').select('visitor_id').eq('store_id', SHOP).eq('shopify_order_id', String(o.id)).maybeSingle()).data;
  let vfbc = null;
  if (a?.visitor_id) vfbc = (await sb.from('visitors').select('latest_fbc').eq('store_id', SHOP).eq('visitor_id', a.visitor_id).maybeSingle()).data?.latest_fbc;
  const vp = fbcParts(vfbc);
  console.log(`#${o.name}: landing_fbclid_len=${lf ? lf.length : '-'}  visitor_fbclid_len=${vp && !vp.malformed ? vp.fbclidLen : (vfbc ? 'malformed' : 'none')}  ${lf && vp && !vp.malformed ? (vp.fbclid.includes(lf) ? 'visitor⊇landing(GOOD)' : lf.includes(vp.fbclid) ? 'landing⊇visitor(visitor TRUNCATED)' : 'DIVERGE') : ''}`);
}

// ── 3. event_id dedup forensics from capi_delivery_log ──
const { data: dl } = await sb.from('capi_delivery_log').select('event_id,event_name,status,sent_at').eq('store_id', SHOP).limit(600);
const prefixCount = {};
for (const r of dl ?? []) {
  const pref = (r.event_id || '').split(':')[0];
  const k = `${r.event_name}  id-prefix="${pref}"`;
  prefixCount[k] = (prefixCount[k] ?? 0) + 1;
}
console.log('\n=== capi_delivery_log event_id prefixes by event (detects dedup mismatch) ===');
for (const [k, n] of Object.entries(prefixCount).sort()) console.log(`  ${k}: ${n}`);

// ── 4. EMQ trend (per-event, last 7 snapshots) ──
const { data: emq } = await sb.from('emq_snapshots').select('captured_at,overall_emq,per_event').eq('store_id', SHOP).order('captured_at', { ascending: false }).limit(7);
console.log('\n=== EMQ trend ===');
for (const e of emq ?? []) console.log(`${e.captured_at?.slice(0,10)}  overall=${e.overall_emq}  ${JSON.stringify(e.per_event)}`);

// ── 5. capi_retries (failed/pending) ──
const { data: rt, count: rtc } = await sb.from('capi_retries').select('event_name,attempts,last_error', { count: 'exact' }).eq('store_id', SHOP).limit(20);
console.log(`\n=== capi_retries: ${rtc ?? 0} rows ===`); for (const r of rt ?? []) console.log(' ', r);

// ── 6. Did ANY visitor EVER get em_hash/ph_hash? (time-correlate w/ deploy) ──
const { count: emEver } = await sb.from('visitors').select('*', { count: 'exact', head: true }).eq('store_id', SHOP).not('em_hash', 'is', null);
const { data: emNewest } = await sb.from('visitors').select('last_seen_at').eq('store_id', SHOP).not('em_hash','is',null).order('last_seen_at',{ascending:false}).limit(1);
console.log(`\nvisitors with em_hash EVER: ${emEver}  newest: ${emNewest?.[0]?.last_seen_at ?? 'n/a'}`);

// ── 7. ALL-TIME distinct visitor_events names (confirm checkout events never landed) ──
const { data: vn } = await sb.from('visitor_events').select('event_name').eq('store_id', SHOP).limit(10000);
const names = {}; for (const r of vn ?? []) names[r.event_name] = (names[r.event_name] ?? 0) + 1;
console.log('visitor_events distinct event_name (all rows scanned, max 10k):', names);
