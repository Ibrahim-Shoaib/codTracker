import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const { data: rows, error } = await supabase
  .from('ad_spend')
  .select('store_id, source')
  .order('store_id');

if (error) { console.error(error); process.exit(1); }

const byKey = new Map();
for (const r of rows) {
  const k = `${r.store_id} :: ${r.source ?? 'NULL'}`;
  byKey.set(k, (byKey.get(k) ?? 0) + 1);
}
for (const [k, c] of byKey) console.log(`${k}  -> ${c} rows`);
