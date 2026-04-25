import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const { data: store } = await supabase
  .from('stores')
  .select('store_id, meta_access_token, meta_ad_account_id')
  .not('meta_access_token', 'is', null)
  .limit(1)
  .single();

if (!store) { console.error('No connected meta store'); process.exit(1); }

const { meta_access_token: token, meta_ad_account_id: ad } = store;
const probes = [
  { label: 'chunk3 default (no limit)', q: { since: '2025-10-28', until: '2025-12-26' }, limit: null },
  { label: 'chunk3 limit=500', q: { since: '2025-10-28', until: '2025-12-26' }, limit: 500 },
  { label: 'chunk1 default (no limit)', q: { since: '2026-02-25', until: '2026-04-25' }, limit: null },
];

for (const p of probes) {
  const params = new URLSearchParams({
    fields: 'spend',
    time_range: JSON.stringify(p.q),
    time_increment: '1',
    level: 'account',
    access_token: token,
  });
  if (p.limit) params.set('limit', String(p.limit));
  const url = `https://graph.facebook.com/v21.0/${ad}/insights?${params}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) { console.log(`${p.label}: HTTP ${res.status}`, json); continue; }
  const rows = json.data ?? [];
  const first = rows[0]?.date_start ?? null;
  const last = rows[rows.length - 1]?.date_start ?? null;
  console.log(`\n${p.label}`);
  console.log(`  rows=${rows.length}  first=${first}  last=${last}`);
  console.log(`  paging.next present? ${json.paging?.next ? 'YES' : 'no'}`);
  if (json.paging?.cursors) console.log(`  cursors=`, json.paging.cursors);
}
