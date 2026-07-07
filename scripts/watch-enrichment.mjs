// Watches the enrichment progress for the-trendy-homes-pk store.
// Run before triggering cron to capture baseline; will poll until
// line_items_backfilled_at is set on the store row.
import 'dotenv/config';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
const SHOP = 'the-trendy-homes-pk.myshopify.com';

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

async function snapshot(label) {
  const { rows: [r] } = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM orders WHERE store_id = $1) AS total,
       (SELECT COUNT(*) FROM orders WHERE store_id = $1 AND line_items IS NOT NULL) AS enriched,
       (SELECT line_items_backfilled_at FROM stores WHERE store_id = $1) AS flag,
       (SELECT cogs_match_in_progress FROM stores WHERE store_id = $1) AS lock,
       (SELECT COUNT(*) FROM orders WHERE store_id = $1 AND cogs_match_source = 'variant_id') AS variant_id_matched`,
    [SHOP]
  );
  console.log(
    `[${label}] total=${r.total} enriched=${r.enriched} variant_id_cogs=${r.variant_id_matched} lock=${r.lock} flag=${r.flag ?? 'NULL'}`
  );
  return r;
}

const start = await snapshot('baseline');
const startMs = Date.now();

console.log('\nWaiting for backfill flag to be set (polling every 5s, max 10 min)...\n');

let last = start;
for (let i = 0; i < 120; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const cur = await snapshot(`+${Math.round((Date.now() - startMs) / 1000)}s`);
  if (cur.flag && !last.flag) {
    console.log(`\n✓ Backfill flag set after ${Math.round((Date.now() - startMs) / 1000)}s.`);
    break;
  }
  last = cur;
}

await snapshot('final');
await client.end();
