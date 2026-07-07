// Why did only 333 of 6128 orders get enriched?
// Hypothesis: SHOPIFY_SCOPES lacks read_all_orders → Shopify only returns
// the last 60 days of orders.
import 'dotenv/config';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
const SHOP = 'the-trendy-homes-pk.myshopify.com';

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

// 1. Date range of the 333 enriched orders
const { rows: enrichedRange } = await client.query(
  `SELECT MIN(transaction_date) AS min_date, MAX(transaction_date) AS max_date, COUNT(*) AS n
   FROM orders
   WHERE store_id = $1 AND line_items IS NOT NULL`,
  [SHOP]
);
console.log('Enriched orders date range:');
console.log(`  ${enrichedRange[0].min_date}  →  ${enrichedRange[0].max_date}  (${enrichedRange[0].n} orders)`);

// 2. By month: enriched vs total
const { rows: byMonth } = await client.query(
  `SELECT TO_CHAR(transaction_date, 'YYYY-MM') AS month,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE line_items IS NOT NULL) AS enriched,
          COUNT(*) FILTER (WHERE order_ref_number != '1' OR order_ref_number IS NULL) AS real_ref_count
   FROM orders
   WHERE store_id = $1
   GROUP BY 1
   ORDER BY 1 DESC
   LIMIT 12`,
  [SHOP]
);
console.log('\nBy month (recent 12):');
console.log('Month     | Total | Real-ref | Enriched | % enriched of real-ref');
for (const r of byMonth) {
  const pct = r.real_ref_count > 0 ? ((r.enriched / r.real_ref_count) * 100).toFixed(1) : '0.0';
  console.log(`${r.month}   | ${String(r.total).padStart(5)} |  ${String(r.real_ref_count).padStart(6)}  |  ${String(r.enriched).padStart(6)}  |  ${pct}%`);
}

// 3. Sample enriched line_items
const { rows: samples } = await client.query(
  `SELECT order_ref_number, transaction_date, line_items
   FROM orders
   WHERE store_id = $1 AND line_items IS NOT NULL
   ORDER BY transaction_date DESC
   LIMIT 3`,
  [SHOP]
);
console.log('\nSample enriched orders:');
for (const r of samples) {
  console.log(`  ref=${r.order_ref_number}  date=${r.transaction_date.toISOString().slice(0,10)}`);
  console.log(`    line_items=${JSON.stringify(r.line_items)}`);
}

// 4. COGS source distribution after the rematch
const { rows: sources } = await client.query(
  `SELECT cogs_match_source, COUNT(*) AS n
   FROM orders
   WHERE store_id = $1
   GROUP BY 1
   ORDER BY n DESC`,
  [SHOP]
);
console.log('\nCOGS match source distribution after rematch:');
for (const r of sources) {
  console.log(`  ${(r.cogs_match_source ?? 'NULL').padEnd(15)} ${r.n}`);
}

await client.end();
