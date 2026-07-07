// Add match_keys column to capi_delivery_log so we can compute a real EMQ
// score from the user_data we sent to Meta. Idempotent — safe to re-run.
import pg from "pg";

const { Client } = pg;
const c = new Client({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await c.connect();
console.log("Connected.");

console.log("\n1. ALTER TABLE capi_delivery_log ADD COLUMN match_keys TEXT[] ...");
await c.query(`
  ALTER TABLE capi_delivery_log
    ADD COLUMN IF NOT EXISTS match_keys TEXT[] NULL;
`);
console.log("   ✓ done");

console.log("\n2. Verify column exists:");
const v = await c.query(`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'capi_delivery_log' AND column_name = 'match_keys';
`);
console.log(`   ${JSON.stringify(v.rows[0])}`);

await c.end();
console.log("\nMigration complete.");
