import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const sql = readFileSync('supabase/migrations/004_city_breakdown_rpc.sql', 'utf8');
console.log('--- Applying migration 004 ---');
await client.query(sql);
console.log('Done.');

const { rows: stores } = await client.query(`SELECT store_id FROM stores LIMIT 1`);
if (stores.length) {
  const storeId = stores[0].store_id;
  const { rows } = await client.query(
    `SELECT * FROM get_city_breakdown($1, '2026-03-01'::date, '2026-03-31'::date)`,
    [storeId]
  );
  console.log(`\nLast month sample for ${storeId} — ${rows.length} cities returned`);
  console.log('Top 5 by money lost:');
  rows
    .map(r => ({ ...r, return_loss: Number(r.return_loss), return_pct: Number(r.return_pct) }))
    .sort((a, b) => b.return_loss - a.return_loss)
    .slice(0, 5)
    .forEach(r => {
      console.log(`  ${r.city.padEnd(20)}  PKR ${Math.round(r.return_loss).toLocaleString().padStart(8)}   ${String(r.returned).padStart(3)}/${String(r.total_orders).padEnd(3)}   ${r.return_pct.toFixed(1)}%`);
    });
}
await client.end();
