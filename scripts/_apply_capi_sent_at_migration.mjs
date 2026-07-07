// Apply the order_attribution.capi_sent_at migration directly via the
// Supabase Postgres connection. Idempotent — safe to re-run.
//   1. ADD COLUMN IF NOT EXISTS
//   2. CREATE INDEX IF NOT EXISTS
//   3. Backfill from capi_delivery_log evidence
//   4. Verify
import pg from "pg";

const { Client } = pg;
const c = new Client({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await c.connect();
console.log("Connected.");

console.log("\n1. ALTER TABLE order_attribution ADD COLUMN capi_sent_at ...");
await c.query(`
  ALTER TABLE order_attribution
    ADD COLUMN IF NOT EXISTS capi_sent_at TIMESTAMPTZ NULL;
`);
console.log("   ✓ done");

console.log("\n2. CREATE INDEX idx_order_attribution_pending ...");
await c.query(`
  CREATE INDEX IF NOT EXISTS idx_order_attribution_pending
    ON order_attribution (store_id, attributed_at)
    WHERE capi_sent_at IS NULL;
`);
console.log("   ✓ done");

console.log("\n3. Backfill from capi_delivery_log evidence ...");
const r = await c.query(`
  UPDATE order_attribution oa
  SET capi_sent_at = log.first_sent_at
  FROM (
    SELECT store_id, event_id, MIN(sent_at) AS first_sent_at
    FROM capi_delivery_log
    WHERE event_name = 'Purchase' AND status = 'sent'
    GROUP BY store_id, event_id
  ) log
  WHERE log.store_id = oa.store_id
    AND log.event_id = 'purchase:' || oa.store_id || ':' || oa.shopify_order_id
    AND oa.capi_sent_at IS NULL;
`);
console.log(`   ✓ backfilled ${r.rowCount} row(s)`);

console.log("\n4. Verify per-shop today state:");
const v = await c.query(`
  SELECT
    store_id,
    COUNT(*)                                     AS total_today,
    COUNT(capi_sent_at)                          AS sent,
    COUNT(*) FILTER (WHERE capi_sent_at IS NULL) AS pending
  FROM order_attribution
  WHERE attributed_at >= NOW() - INTERVAL '24 hours'
  GROUP BY store_id
  ORDER BY total_today DESC;
`);
for (const row of v.rows) {
  console.log(`   ${row.store_id}: total=${row.total_today} sent=${row.sent} pending=${row.pending}`);
}

await c.end();
console.log("\nMigration complete.");
