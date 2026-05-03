import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const sql = readFileSync('supabase/migrations/013_is_demo_flag.sql', 'utf8');
console.log('--- Applying migration 013 (is_demo flag) ---');
await client.query(sql);
console.log('Done.');

const { rows } = await client.query(
  `SELECT store_id, is_demo FROM stores ORDER BY created_at`
);
console.log('\nStores after migration:');
for (const r of rows) {
  console.log(`  ${r.store_id.padEnd(45)}  is_demo=${r.is_demo}`);
}
console.log(`\nTotal: ${rows.length} stores. Demo: ${rows.filter(r => r.is_demo).length}.`);

await client.end();
