import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const sql = readFileSync('supabase/migrations/014_demo_pool_store.sql', 'utf8');
console.log('--- Applying migration 014 (demo pool sentinel) ---');
await client.query(sql);
console.log('Done.');

const { rows } = await client.query(
  `SELECT store_id, is_demo, onboarding_complete FROM stores WHERE store_id = '__codprofit_demo_pool__'`
);
console.log('\nPool sentinel:');
for (const r of rows) console.log(`  ${r.store_id}  is_demo=${r.is_demo}  complete=${r.onboarding_complete}`);

await client.end();
