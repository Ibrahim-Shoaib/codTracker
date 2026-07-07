// Apply migration 003 (orders include returns) via direct Postgres.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) { console.error('SUPABASE_DATABASE_URL missing'); process.exit(1); }

const sql = readFileSync('supabase/migrations/003_orders_include_returns.sql', 'utf8');

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log('--- Applying migration 003 ---');
await client.query(sql);
console.log('Function replaced.');

// Smoke-test: call the RPC for any one store + last month, and check that
// returned orders == (delivered + returned) by also running a raw count.
const { rows: stores } = await client.query(`SELECT store_id FROM stores LIMIT 1`);
if (!stores.length) { console.log('No stores yet — skipping smoke test.'); await client.end(); process.exit(0); }
const storeId = stores[0].store_id;

const { rows: stats } = await client.query(
  `SELECT * FROM get_dashboard_stats($1, '2026-03-01'::date, '2026-03-31'::date, 0::numeric, 0::numeric)`,
  [storeId]
);

const { rows: raw } = await client.query(
  `SELECT
     COUNT(*) FILTER (WHERE is_delivered) AS delivered,
     COUNT(*) FILTER (WHERE is_returned)  AS returned
   FROM orders
   WHERE store_id = $1
     AND transaction_date >= '2026-03-01'::timestamptz
     AND transaction_date <  '2026-04-01'::timestamptz`,
  [storeId]
);

const s = stats[0]; const r = raw[0];
console.log('Smoke test for last month:', { store: storeId, rpc_orders: Number(s.orders), rpc_returns: Number(s.returns), raw_delivered: Number(r.delivered), raw_returned: Number(r.returned) });
const expected = Number(r.delivered) + Number(r.returned);
console.log(`Expected orders (delivered+returned) = ${expected} ; RPC orders = ${Number(s.orders)} ; ${expected === Number(s.orders) ? 'MATCH ✓' : 'MISMATCH ✗'}`);
console.log(`AOV = ${s.aov} (sales / delivered = ${Number(s.sales)} / ${Number(r.delivered)} = ${Number(r.delivered) === 0 ? 'N/A' : (Number(s.sales)/Number(r.delivered)).toFixed(2)})`);

await client.end();
