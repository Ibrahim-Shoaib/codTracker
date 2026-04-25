import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const { data: stores, error: storesErr } = await supabase
  .from('stores')
  .select('store_id, meta_access_token, meta_ad_account_id, meta_token_expires_at, last_meta_sync_at')
  .not('meta_access_token', 'is', null);

if (storesErr) { console.error('stores query failed:', storesErr); process.exit(1); }

console.log('--- Connected Meta stores ---');
for (const s of stores) {
  console.log({
    store_id: s.store_id,
    ad_account: s.meta_ad_account_id,
    token_expires_at: s.meta_token_expires_at,
    last_meta_sync_at: s.last_meta_sync_at,
    token_present: !!s.meta_access_token,
  });
}

for (const s of stores) {
  const { data: rows, error } = await supabase
    .from('ad_spend')
    .select('spend_date, amount, source, updated_at')
    .eq('store_id', s.store_id)
    .order('spend_date', { ascending: true });
  if (error) { console.error('ad_spend query failed:', error); continue; }

  const byMonth = new Map();
  let earliest = null, latest = null;
  for (const r of rows) {
    const key = r.spend_date.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + Number(r.amount ?? 0));
    if (!earliest || r.spend_date < earliest) earliest = r.spend_date;
    if (!latest || r.spend_date > latest) latest = r.spend_date;
  }

  console.log(`\n--- ad_spend for ${s.store_id} ---`);
  console.log(`rows=${rows.length}  range=${earliest} .. ${latest}`);
  const months = [...byMonth.keys()].sort();
  for (const m of months) {
    console.log(`  ${m}  total=${byMonth.get(m).toFixed(2)}`);
  }

  // Per-day list for the suspect window: 2025-09-01 .. 2025-12-31
  const suspect = rows.filter(r => r.spend_date >= '2025-09-01' && r.spend_date <= '2025-12-31');
  console.log(`\n  suspect-window rows (Sep–Dec 2025): ${suspect.length}`);
  // Print which dates are MISSING in the suspect window
  const present = new Set(suspect.map(r => r.spend_date));
  const missing = [];
  for (let d = new Date('2025-09-01'); d <= new Date('2025-12-31'); d.setUTCDate(d.getUTCDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
    if (!present.has(ds)) missing.push(ds);
  }
  console.log(`  missing dates in window: ${missing.length}`);
  if (missing.length) console.log(`    first..last missing: ${missing[0]} .. ${missing[missing.length - 1]}`);
}
