// Apply migration 007 (orders.line_items + variant_id source) and verify.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) { console.error('SUPABASE_DATABASE_URL missing'); process.exit(1); }

const sql = readFileSync('supabase/migrations/007_line_items_variant_id.sql', 'utf8');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log('--- Applying migration 007 ---');
await client.query(sql);
console.log('Migration applied.\n');

const checks = [
  {
    label: 'orders.line_items column exists (JSONB, nullable)',
    sql: `SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_name = 'orders' AND column_name = 'line_items'`,
    pass: r => r.rows.length === 1
              && r.rows[0].data_type === 'jsonb'
              && r.rows[0].is_nullable === 'YES',
  },
  {
    label: 'GIN index idx_orders_line_items_gin exists',
    sql: `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_orders_line_items_gin'`,
    pass: r => r.rows.length === 1,
  },
  {
    label: "cogs_match_source CHECK includes 'variant_id'",
    sql: `SELECT pg_get_constraintdef(oid) AS def
          FROM pg_constraint
          WHERE conname = 'orders_cogs_match_source_check'`,
    pass: r => r.rows.length === 1 && r.rows[0].def.includes("'variant_id'"),
  },
  {
    label: 'stores.line_items_backfilled_at column exists (timestamptz, nullable)',
    sql: `SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_name = 'stores' AND column_name = 'line_items_backfilled_at'`,
    pass: r => r.rows.length === 1
              && r.rows[0].data_type === 'timestamp with time zone'
              && r.rows[0].is_nullable === 'YES',
  },
  {
    label: 'apply_line_items_batch RPC exists',
    sql: `SELECT proname FROM pg_proc WHERE proname = 'apply_line_items_batch'`,
    pass: r => r.rows.length === 1,
  },
  {
    label: 'No existing orders were modified (line_items defaults to NULL)',
    sql: `SELECT COUNT(*)::int AS non_null FROM orders WHERE line_items IS NOT NULL`,
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
