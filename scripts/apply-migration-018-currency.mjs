import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";

const url = process.env.SUPABASE_DATABASE_URL;
const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const sql = readFileSync("supabase/migrations/018_store_currency.sql", "utf8");
console.log("--- Applying migration 018 (store currency + fx_rates) ---");
await client.query(sql);
console.log("Done.");

const { rows: cols } = await client.query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_name='stores' AND column_name IN ('currency','money_format','meta_ad_account_currency')
   ORDER BY column_name`
);
console.log("\nVerification:");
console.log(`  stores.currency:                ${cols.find(r=>r.column_name==='currency') ? '✓' : '✗'}`);
console.log(`  stores.money_format:            ${cols.find(r=>r.column_name==='money_format') ? '✓' : '✗'}`);
console.log(`  stores.meta_ad_account_currency: ${cols.find(r=>r.column_name==='meta_ad_account_currency') ? '✓' : '✗'}`);
const { rows: fx } = await client.query(
  `SELECT to_regclass('public.fx_rates') AS exists`
);
console.log(`  fx_rates table:                 ${fx[0].exists ? '✓' : '✗'}`);

const { rows: legacy } = await client.query(
  `SELECT store_id, currency, money_format FROM stores LIMIT 5`
);
console.log("\nLegacy stores defaulted to PKR:");
for (const r of legacy) console.log(`  ${r.store_id.padEnd(50)} ${r.currency} ${r.money_format}`);

await client.end();
