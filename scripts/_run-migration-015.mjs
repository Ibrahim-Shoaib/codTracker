// One-off runner for migration 015 (ad-tracking tables).
// Reads the SQL file, executes it against SUPABASE_DATABASE_URL, then runs
// post-checks to verify the schema is correct.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) {
  console.error("SUPABASE_DATABASE_URL not set");
  process.exit(1);
}

const sqlPath = resolve(__dirname, "..", "supabase", "migrations", "015_ad_tracking.sql");
const sql = readFileSync(sqlPath, "utf8");

const client = new pg.Client({ connectionString: url });
await client.connect();

console.log("→ running migration 015_ad_tracking.sql ...");
try {
  await client.query("BEGIN");
  await client.query(sql);
  await client.query("COMMIT");
  console.log("✓ migration committed");
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("✗ migration failed — rolled back:", err.message);
  await client.end();
  process.exit(1);
}

console.log("\n→ verifying schema:");
const checks = [
  ["meta_pixel_connections row count", "SELECT count(*)::int AS n FROM meta_pixel_connections"],
  ["capi_retries row count", "SELECT count(*)::int AS n FROM capi_retries"],
  ["capi_delivery_log row count", "SELECT count(*)::int AS n FROM capi_delivery_log"],
  ["emq_snapshots row count", "SELECT count(*)::int AS n FROM emq_snapshots"],
  [
    "row-cap trigger present",
    "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_capi_delivery_log_cap'",
  ],
  [
    "RLS enabled on all 4 tables",
    `SELECT count(*)::int AS n FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname IN ('meta_pixel_connections','capi_retries','capi_delivery_log','emq_snapshots')
       AND c.relrowsecurity = true`,
  ],
];

let pass = 0;
let fail = 0;
for (const [label, query] of checks) {
  const { rows } = await client.query(query);
  const n = rows[0].n;
  const expected = label.includes("trigger present") ? 1
    : label.includes("RLS enabled") ? 4
    : 0;
  const ok = n === expected;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${n} (expected ${expected})`);
  if (ok) pass++; else fail++;
}

await client.end();
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
