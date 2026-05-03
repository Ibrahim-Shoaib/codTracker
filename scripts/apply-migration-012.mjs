import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const sql = readFileSync('supabase/migrations/012_trend_series_rpc.sql', 'utf8');
console.log('--- Applying migration 012 (get_trend_series) ---');
await client.query(sql);
console.log('Done.\n');

const { rows: stores } = await client.query(`SELECT store_id FROM stores LIMIT 1`);
if (!stores.length) { console.log('no stores'); process.exit(0); }
const storeId = stores[0].store_id;

for (const g of ['day', 'month', 'year']) {
  const { rows } = await client.query(
    `SELECT * FROM get_trend_series($1, '2025-01-01'::date, '2026-05-03'::date, 0::numeric, 0::numeric, $2)`,
    [storeId, g]
  );
  const sums = rows.reduce(
    (a, r) => ({
      sales: a.sales + Number(r.sales),
      orders: a.orders + Number(r.orders),
      cost: a.cost + Number(r.total_cost),
      profit: a.profit + Number(r.net_profit),
    }),
    { sales: 0, orders: 0, cost: 0, profit: 0 }
  );
  console.log(
    `${g.padEnd(5)} buckets=${String(rows.length).padStart(4)} ` +
    `sales=${Math.round(sums.sales).toLocaleString().padStart(10)} ` +
    `orders=${String(sums.orders).padStart(5)} ` +
    `cost=${Math.round(sums.cost).toLocaleString().padStart(10)} ` +
    `profit=${Math.round(sums.profit).toLocaleString().padStart(10)}`
  );
  if (rows.length) {
    const sample = rows.slice(-3);
    for (const r of sample) {
      const d = new Date(r.bucket_start).toISOString().slice(0, 10);
      console.log(`        ${d}  sales=${Math.round(Number(r.sales)).toString().padStart(7)}  profit=${Math.round(Number(r.net_profit)).toString().padStart(8)}`);
    }
  }
}

await client.end();
