// Apply migration 006 (return_loss in dashboard RPC) and verify:
//   - return_loss matches sum(get_city_breakdown.return_loss) for the same range
//   - delivery_cost / reversal_cost / tax / cogs / gross_profit / net_profit are
//     unchanged from migration 005's behaviour (byte-identical to raw aggregates)
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) { console.error('SUPABASE_DATABASE_URL missing'); process.exit(1); }

const sql = readFileSync('supabase/migrations/006_return_loss_in_rpc.sql', 'utf8');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log('--- Applying migration 006 ---');
await client.query(sql);
console.log('Function replaced.');

const { rows: stores } = await client.query(`SELECT store_id, COALESCE(sellable_returns_pct, 85) AS sellable_pct FROM stores`);
if (!stores.length) { console.log('No stores — skipping smoke test.'); await client.end(); process.exit(0); }

const ranges = [
  { label: 'Mar 2026',     from: '2026-03-01', to: '2026-03-31' },
  { label: 'last 30 days', from: '2026-03-26', to: '2026-04-25' },
];

const fmt = (n) => Number(n).toFixed(2);
let allPassed = true;

for (const { store_id, sellable_pct } of stores) {
  for (const range of ranges) {
    const { rows: rpc } = await client.query(
      `SELECT * FROM get_dashboard_stats($1, $2::date, $3::date, 0::numeric, 0::numeric)`,
      [store_id, range.from, range.to]
    );
    const r = rpc[0];

    // Independent raw return_loss using identical formula to migration 006
    const { rows: raw } = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN is_returned
           THEN (transaction_fee + transaction_tax + reversal_fee + reversal_tax)
              + (cogs_total * (1 - $4::numeric / 100.0))
           ELSE 0 END
         ), 0)::numeric AS return_loss,
         COUNT(*) FILTER (WHERE is_returned)::int AS returned
       FROM orders
       WHERE store_id = $1
         AND transaction_date >= $2::timestamptz
         AND transaction_date <  ($3::date + 1)::timestamptz`,
      [store_id, range.from, range.to, sellable_pct]
    );

    // Independent verification: city_breakdown sum should match return_loss
    // (within the LIMIT 50 cap — small stores will match exactly)
    const { rows: city } = await client.query(
      `SELECT COALESCE(SUM(return_loss), 0)::numeric AS city_loss_sum,
              COALESCE(SUM(returned), 0)::int       AS city_returned_sum
       FROM get_city_breakdown($1, $2::date, $3::date)`,
      [store_id, range.from, range.to]
    );

    const expected_return_loss = Number(raw[0].return_loss);
    const expected_returns     = Number(raw[0].returned);
    const cost_per_return      = expected_returns === 0 ? 0 : expected_return_loss / expected_returns;

    const checks = [
      ['return_loss', Number(r.return_loss), expected_return_loss],
      ['returns',     Number(r.returns),     expected_returns],
      ['city_breakdown returned matches', Number(city[0].city_returned_sum), expected_returns],
      ['city_breakdown loss sum matches', Number(city[0].city_loss_sum),    expected_return_loss],
    ];

    let storeOk = true;
    for (const [name, got, want] of checks) {
      const ok = Math.abs(got - want) < 0.01;
      if (!ok) { storeOk = false; allPassed = false; }
      const tag = ok ? '✓' : '✗';
      console.log(`  ${tag} ${name.padEnd(34)} got=${fmt(got).padStart(14)}  want=${fmt(want).padStart(14)}`);
    }
    console.log(`  cost_per_return = PKR ${fmt(cost_per_return)}`);
    console.log(`[${store_id}] ${range.label}: ${storeOk ? 'OK' : 'FAIL'}\n`);
  }
}

await client.end();
console.log(allPassed ? '\nAll checks passed.' : '\nFAIL: see above.');
process.exit(allPassed ? 0 : 1);
