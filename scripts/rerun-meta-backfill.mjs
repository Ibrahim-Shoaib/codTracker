// Re-runs the Meta historical backfill with the fixed paginating fetchDailySpend.
// Safe-by-design:
//   1. Pre-flight: aborts unless Meta returns a valid /me response (avoids walking the
//      whole window only to log "API access blocked" 50 times).
//   2. Snapshot: writes the existing ad_spend rows to a timestamped JSON before any write.
//   3. Upsert semantics: existing meta rows have correct values (page-1 of each chunk),
//      so re-upserting reproduces identical numbers; only previously-missing days are
//      inserted.
//   4. Report: prints monthly totals and per-month row counts before vs. after.

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { runMetaHistoricalBackfill } from '../app/lib/backfill.server.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const targetStore = process.argv[2] ?? null;

const { data: stores, error: storesErr } = await supabase
  .from('stores')
  .select('store_id, meta_access_token, meta_ad_account_id')
  .not('meta_access_token', 'is', null);
if (storesErr) { console.error(storesErr); process.exit(1); }

const candidates = targetStore
  ? stores.filter(s => s.store_id === targetStore)
  : stores;

if (!candidates.length) {
  console.error('No stores match. Pass a store_id as argv[2] to target one.');
  process.exit(1);
}

for (const s of candidates) {
  console.log(`\n=================================================================`);
  console.log(`Store: ${s.store_id}   ad_account: ${s.meta_ad_account_id}`);
  console.log(`=================================================================`);

  // 1. Pre-flight: confirm Meta app is not blocked before doing any work.
  const probe = await fetch(
    `https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(s.meta_access_token)}`,
  );
  const probeBody = await probe.json().catch(() => ({}));
  if (!probe.ok) {
    console.error(`Pre-flight FAILED: HTTP ${probe.status}`, probeBody);
    console.error('Skipping this store. Resolve Meta access (Developer Console / app review / token) and re-run.');
    continue;
  }
  console.log(`Pre-flight OK: /me ->`, probeBody);

  // 2. Snapshot existing rows.
  const { data: before, error: beforeErr } = await supabase
    .from('ad_spend')
    .select('*')
    .eq('store_id', s.store_id)
    .order('spend_date', { ascending: true });
  if (beforeErr) { console.error('snapshot failed:', beforeErr); continue; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = 'scripts/backups';
  mkdirSync(backupDir, { recursive: true });
  const backupPath = `${backupDir}/ad_spend_${s.store_id}_${stamp}.json`;
  writeFileSync(backupPath, JSON.stringify(before, null, 2));
  console.log(`Snapshot: ${before.length} rows -> ${backupPath}`);

  const monthSummary = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const k = r.spend_date.slice(0, 7);
      const cur = m.get(k) ?? { count: 0, total: 0 };
      cur.count++;
      cur.total += Number(r.amount ?? 0);
      m.set(k, cur);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  };

  console.log(`\nBefore (monthly):`);
  for (const [m, v] of monthSummary(before)) {
    console.log(`  ${m}  rows=${String(v.count).padStart(2)}  total=${v.total.toFixed(2)}`);
  }

  // 3. Run the fixed backfill.
  console.log(`\nRunning fixed runMetaHistoricalBackfill...`);
  await runMetaHistoricalBackfill({
    store_id: s.store_id,
    access_token: s.meta_access_token,
    ad_account_id: s.meta_ad_account_id,
  });

  // 4. Re-query and report deltas.
  const { data: after } = await supabase
    .from('ad_spend')
    .select('*')
    .eq('store_id', s.store_id)
    .order('spend_date', { ascending: true });

  console.log(`\nAfter (monthly):`);
  const beforeByMonth = new Map(monthSummary(before));
  for (const [m, v] of monthSummary(after)) {
    const b = beforeByMonth.get(m);
    const dRows = b ? v.count - b.count : v.count;
    const dTotal = b ? v.total - b.total : v.total;
    const sign = (n) => (n > 0 ? `+${n}` : String(n));
    console.log(
      `  ${m}  rows=${String(v.count).padStart(2)} (${sign(dRows)})  total=${v.total.toFixed(2)} (${sign(dTotal.toFixed(2))})`,
    );
  }
  console.log(`\nTotal rows: ${before.length} -> ${after.length}`);
}

console.log('\nDone.');
