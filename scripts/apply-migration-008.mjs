// Apply migration 008 (stores.meta_sync_error) and verify.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) { console.error('SUPABASE_DATABASE_URL missing'); process.exit(1); }

const sql = readFileSync('supabase/migrations/008_meta_sync_error.sql', 'utf8');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log('--- Applying migration 008 ---');
await client.query(sql);
console.log('Migration applied.\n');

const checks = [
  {
    label: 'stores.meta_sync_error column exists (text, nullable)',
    sql: `SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_name = 'stores' AND column_name = 'meta_sync_error'`,
    pass: r => r.rows.length === 1
              && r.rows[0].data_type === 'text'
              && r.rows[0].is_nullable === 'YES',
  },
  {
    label: 'No existing stores were modified (meta_sync_error defaults to NULL)',
    sql: `SELECT COUNT(*)::int AS non_null FROM stores WHERE meta_sync_error IS NOT NULL`,
    pass: r => Number(r.rows[0].non_null) === 0,
  },
];

let allPassed = true;
for (const c of checks) {
  const r = await client.query(c.sql);
  const ok = c.pass(r);
  if (!ok) allPassed = false;
  console.log(`  ${ok ? '✓' : '✗'} ${c.label}`);
  if (!ok) console.log(`     got:`, r.rows);
}

await client.end();
console.log(allPassed ? '\nAll checks passed.' : '\nFAIL: see above.');
process.exit(allPassed ? 0 : 1);
