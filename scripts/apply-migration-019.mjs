import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";

const client = new pg.Client({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const sql = readFileSync("supabase/migrations/019_ingest_mode.sql", "utf8");
console.log("--- Applying migration 019 (ingest_mode) ---");
await client.query(sql);
console.log("Done.");

const { rows } = await client.query(
  `SELECT store_id, ingest_mode FROM stores ORDER BY store_id`
);
console.log("\nVerification — ingest_mode on all stores:");
for (const r of rows) console.log(`  ${r.store_id.padEnd(50)} ${r.ingest_mode}`);

await client.end();
