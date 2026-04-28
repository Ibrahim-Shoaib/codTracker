// Apply migration 009 (stores.meta_ad_account_name) and verify.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) { console.error('SUPABASE_DATABASE_URL missing'); process.exit(1); }

const sql = readFileSync('supabase/migrations/009_meta_ad_account_name.sql', 'utf8');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log('--- Applying migration 009 ---');
await client.query(sql);
console.log('Migration applied.\n');

const checks = [
  {
    label: 'stores.meta_ad_account_name column exists (text, nullable)',
    sql: `SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_name = 'stores' AND column_name = 'meta_ad_account_name'`,
    pass: r => r.rows.length === 1
              && r.rows[0].data_type === 'text'
              && r.rows[0].is_nullable === 'YES',
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
