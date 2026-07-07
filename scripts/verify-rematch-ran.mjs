// Verify: did retroactiveCOGSMatch actually run on old orders during the
// historical backfill, or did the cogs_total values stay frozen?
import 'dotenv/config';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
const SHOP = 'the-trendy-homes-pk.myshopify.com';

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

// 1. The most direct evidence: when was each order's cogs_total LAST UPDATED?
// If the rematch ran today, updated_at on rematched orders will be very recent.
const { rows: updatedRecency } = await client.query(
  `SELECT
     CASE
       WHEN updated_at > now() - interval '1 hour' THEN 'last 1h'
       WHEN updated_at > now() - interval '1 day'  THEN 'last 1d'
       WHEN updated_at > now() - interval '7 days' THEN 'last 7d'
       ELSE 'older'
     END AS bucket,
     COUNT(*) AS n
   FROM orders
   WHERE store_id = $1
   GROUP BY 1
   ORDER BY MIN(updated_at) DESC`,
  [SHOP]
);
console.log('When was each order last updated?');
for (const r of updatedRecency) {
  console.log(`  ${r.bucket.padEnd(10)} ${r.n}`);
}

// 2. By cogs_match_source — when were rows of each source last updated?
const { rows: bySource } = await client.query(
  `SELECT
     cogs_match_source,
     COUNT(*) AS n,
     MAX(updated_at) AS most_recent_update,
     MIN(updated_at) AS oldest_update
   FROM orders
   WHERE store_id = $1
   GROUP BY 1
   ORDER BY n DESC`,
  [SHOP]
);
console.log('\nBy match source (most-recent-update tells us if rematch touched them):');
for (const r of bySource) {
  console.log(`  ${(r.cogs_match_source ?? 'NULL').padEnd(15)} n=${String(r.n).padStart(5)}  newest=${r.most_recent_update?.toISOString().slice(0,19)}  oldest=${r.oldest_update?.toISOString().slice(0,19)}`);
}

// 3. Sanity check on a variant_id order: does cogs_total = sum(unit_cost × qty)?
const { rows: sample } = await client.query(
  `SELECT o.tracking_number, o.cogs_total, o.line_items
   FROM orders o
   WHERE o.store_id = $1 AND o.cogs_match_source = 'variant_id'
   ORDER BY o.transaction_date DESC
   LIMIT 5`,
  [SHOP]
);
console.log('\nVariant_id orders — does cogs_total match recomputed value?');
for (const o of sample) {
  let expected = 0;
  for (const li of o.line_items ?? []) {
    const { rows: [pc] } = await client.query(
      `SELECT unit_cost FROM product_costs WHERE store_id = $1 AND shopify_variant_id = $2`,
      [SHOP, li.variant_id]
    );
    expected += Number(pc?.unit_cost ?? 0) * Number(li.quantity ?? 0);
  }
  const ok = Number(o.cogs_total) === expected;
  console.log(`  ${ok ? '✓' : '✗'} tn=${o.tracking_number}  stored=${o.cogs_total}  recomputed=${expected}  line_items=${JSON.stringify(o.line_items)}`);
}

// 4. For comparison: pick a random fallback_avg order and check its cogs_total
const { rows: fallbackSample } = await client.query(
  `SELECT tracking_number, cogs_total, order_detail, transaction_date, updated_at
   FROM orders
   WHERE store_id = $1 AND cogs_match_source = 'fallback_avg'
   ORDER BY transaction_date DESC
   LIMIT 3`,
  [SHOP]
);
console.log('\nfallback_avg sample (these stayed on text matcher):');
for (const o of fallbackSample) {
  console.log(`  tn=${o.tracking_number}  cogs=${o.cogs_total}  updated=${o.updated_at.toISOString().slice(0,19)}  detail=${o.order_detail?.slice(0,60)}`);
}

await client.end();
