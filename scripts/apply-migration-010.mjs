// Apply migration 010 (in_transit_value in get_dashboard_stats) and verify.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) { console.error('SUPABASE_DATABASE_URL missing'); process.exit(1); }

const sql = readFileSync('supabase/migrations/010_in_transit_value.sql', 'utf8');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log('--- Applying migration 010 ---');
await client.query(sql);
console.log('Migration applied.\n');

const checks = [
  {
    label: "get_dashboard_stats now returns in_transit_value",
    sql: `SELECT pg_get_function_result(p.oid) AS rt
          FROM pg_proc p
          WHERE p.proname = 'get_dashboard_stats'`,
    pass: r => r.rows.length === 1 && r.rows[0].rt.includes('in_transit_value numeric'),
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

// Quick smoke: call the RPC for the trendy-homes store covering MTD
const probe = await client.query(`
  SELECT in_transit_value, sales, in_transit
  FROM get_dashboard_stats(
    'the-trendy-homes-pk.myshopify.com',
    date_trunc('month', current_date)::date,
    current_date,
    0::numeric, 0::numeric
  )
`);
console.log('\nMTD probe:', probe.rows[0]);

await client.end();
console.log(allPassed ? '\nAll checks passed.' : '\nFAIL: see above.');
process.exit(allPassed ? 0 : 1);
