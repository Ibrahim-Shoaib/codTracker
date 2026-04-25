// Apply migration 005 (separate Tax field in dashboard RPC) and verify that:
//   - delivery_cost is byte-identical to a raw-aggregate full sum
//   - reversal_cost (new semantics) equals raw SUM(reversal_fee) for returned
//   - tax equals raw SUM(transaction_tax + reversal_tax)
//   - shipping (delivery - reversal - tax) equals raw SUM(transaction_fee)
//   - gross_profit and net_profit match what the pre-migration RPC produced
//     (computed from the same raw aggregates the old code used)
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) { console.error('SUPABASE_DATABASE_URL missing'); process.exit(1); }

const sql = readFileSync('supabase/migrations/005_separate_tax_in_rpc.sql', 'utf8');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log('--- Applying migration 005 ---');
await client.query(sql);
console.log('Function replaced.');

const { rows: stores } = await client.query(`SELECT store_id, COALESCE(sellable_returns_pct, 85) AS sellable_pct FROM stores`);
if (!stores.length) { console.log('No stores — skipping smoke test.'); await client.end(); process.exit(0); }

// Test across two ranges per store: last full month and the trailing 90 days.
// That way both a sparse window and a denser window are exercised.
const ranges = [
  { label: 'Mar 2026',     from: '2026-03-01', to: '2026-03-31' },
  { label: 'last 90 days', from: '2026-01-26', to: '2026-04-25' },
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

    const { rows: raw } = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN is_delivered THEN invoice_payment ELSE 0 END), 0)::numeric AS sales,
         COUNT(*) FILTER (WHERE is_delivered)::int AS delivered,
         COUNT(*) FILTER (WHERE is_returned)::int  AS returned,
         COALESCE(SUM(CASE WHEN is_delivered OR is_returned THEN transaction_fee  ELSE 0 END), 0)::numeric AS sum_tx_fee,
         COALESCE(SUM(CASE WHEN is_delivered OR is_returned THEN transaction_tax  ELSE 0 END), 0)::numeric AS sum_tx_tax,
         COALESCE(SUM(CASE WHEN is_returned THEN reversal_fee ELSE 0 END), 0)::numeric AS sum_rev_fee,
         COALESCE(SUM(CASE WHEN is_returned THEN reversal_tax ELSE 0 END), 0)::numeric AS sum_rev_tax,
         COALESCE(SUM(
           CASE WHEN is_delivered THEN cogs_total
                WHEN is_returned  THEN cogs_total * (1 - $4::numeric / 100.0)
                ELSE 0 END
         ), 0)::numeric AS cogs
       FROM orders
       WHERE store_id = $1
         AND transaction_date >= $2::timestamptz
         AND transaction_date <  ($3::date + 1)::timestamptz`,
      [store_id, range.from, range.to, sellable_pct]
    );
    const x = raw[0];
    const expected_delivery = Number(x.sum_tx_fee) + Number(x.sum_tx_tax) + Number(x.sum_rev_fee) + Number(x.sum_rev_tax);
    const expected_reversal = Number(x.sum_rev_fee);
    const expected_tax      = Number(x.sum_tx_tax) + Number(x.sum_rev_tax);
    const expected_shipping = Number(x.sum_tx_fee);

    const { rows: ad } = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS ad_spend
       FROM ad_spend WHERE store_id = $1 AND spend_date >= $2 AND spend_date <= $3`,
      [store_id, range.from, range.to]
    );
    const expected_gross = Number(x.sales) - expected_delivery - Number(x.cogs);
    const expected_net   = expected_gross - Number(ad[0].ad_spend);

    const shipping_displayed = Number(r.delivery_cost) - Number(r.reversal_cost) - Number(r.tax);

    const checks = [
      ['delivery_cost',      Number(r.delivery_cost), expected_delivery],
      ['reversal_cost',      Number(r.reversal_cost), expected_reversal],
      ['tax',                Number(r.tax),           expected_tax],
      ['shipping displayed', shipping_displayed,      expected_shipping],
      ['cogs',               Number(r.cogs),          Number(x.cogs)],
      ['gross_profit',       Number(r.gross_profit),  expected_gross],
      ['net_profit',         Number(r.net_profit),    expected_net],
      ['parts sum to delivery', shipping_displayed + Number(r.reversal_cost) + Number(r.tax), Number(r.delivery_cost)],
    ];

    let storeOk = true;
    for (const [name, got, want] of checks) {
      const ok = Math.abs(got - want) < 0.01;
      if (!ok) { storeOk = false; allPassed = false; }
      const tag = ok ? '✓' : '✗';
      console.log(`  ${tag} ${name.padEnd(24)} got=${fmt(got).padStart(14)}  want=${fmt(want).padStart(14)}`);
    }
    console.log(`[${store_id}] ${range.label}: ${storeOk ? 'OK' : 'FAIL'}\n`);
  }
}

await client.end();
console.log(allPassed ? '\nAll checks passed.' : '\nFAIL: see above.');
process.exit(allPassed ? 0 : 1);
