import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const sql = readFileSync('supabase/migrations/011_daily_series_rpc.sql', 'utf8');
console.log('--- Applying migration 011 (get_daily_series) ---');
await client.query(sql);
console.log('Done.');

const { rows: stores } = await client.query(`SELECT store_id FROM stores LIMIT 1`);
if (stores.length) {
  const storeId = stores[0].store_id;
  const { rows } = await client.query(
    `SELECT * FROM get_daily_series($1, '2026-04-01'::date, '2026-05-03'::date, 0::numeric, 0::numeric)`,
    [storeId]
  );
  console.log(`\nDaily series for ${storeId} — ${rows.length} rows`);
  console.log('Last 7 days:');
  for (const r of rows.slice(-7)) {
    const d = new Date(r.day).toISOString().slice(0, 10);
    console.log(
      `  ${d}  sales=${Math.round(Number(r.sales)).toString().padStart(7)}  ` +
      `orders=${String(r.orders).padStart(3)}  ` +
      `cogs=${Math.round(Number(r.cogs)).toString().padStart(7)}  ` +
      `delivery=${Math.round(Number(r.delivery_cost)).toString().padStart(6)}  ` +
      `ad=${Math.round(Number(r.ad_spend)).toString().padStart(6)}  ` +
      `ret_loss=${Math.round(Number(r.return_loss)).toString().padStart(6)}  ` +
      `profit=${Math.round(Number(r.net_profit)).toString().padStart(8)}`
    );
  }

  // Reconciliation: SUM of daily series === single-period get_dashboard_stats
  const sums = rows.reduce(
    (a, r) => ({
      sales:    a.sales    + Number(r.sales),
      orders:   a.orders   + Number(r.orders),
      cogs:     a.cogs     + Number(r.cogs),
      delivery: a.delivery + Number(r.delivery_cost),
      ad:       a.ad       + Number(r.ad_spend),
      profit:   a.profit   + Number(r.net_profit),
    }),
    { sales: 0, orders: 0, cogs: 0, delivery: 0, ad: 0, profit: 0 }
  );
  const { rows: agg } = await client.query(
    `SELECT * FROM get_dashboard_stats($1, '2026-04-01'::date, '2026-05-03'::date, 0::numeric, 0::numeric)`,
    [storeId]
  );
  console.log('\nReconciliation (daily SUM vs aggregate RPC):');
  console.log('  sales    daily=', Math.round(sums.sales),    'agg=', Math.round(Number(agg[0].sales)));
  console.log('  orders   daily=', sums.orders,                'agg=', Number(agg[0].orders));
  console.log('  cogs     daily=', Math.round(sums.cogs),      'agg=', Math.round(Number(agg[0].cogs)));
  console.log('  delivery daily=', Math.round(sums.delivery),  'agg=', Math.round(Number(agg[0].delivery_cost)));
  console.log('  ad_spend daily=', Math.round(sums.ad),        'agg=', Math.round(Number(agg[0].ad_spend)));
  console.log('  profit   daily=', Math.round(sums.profit),    'agg=', Math.round(Number(agg[0].net_profit)));
}
await client.end();
