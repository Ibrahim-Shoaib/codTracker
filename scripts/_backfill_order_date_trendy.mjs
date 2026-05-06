// One-shot backfill of orders.order_date for the-trendy-homes-pk.
//
// Two phases:
//   A. enrichOrdersWithShopify(sinceISO: null) — full-lifetime Shopify
//      match. Fills order_date for every row that has a Shopify counterpart.
//   B. Direct UPDATE on remaining NULLs: order_date = transaction_date.
//      Backfill is one-shot, so we don't wait for the 5-attempt budget
//      that the cron uses; missing rows get the transaction_date
//      fallback immediately.
//
// Idempotent — re-runs only touch rows that are still NULL.
//
// Run: node --env-file=.env scripts/_backfill_order_date_trendy.mjs
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { enrichOrdersWithShopify } from "../app/lib/enrich.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

console.log(`Backfilling order_date for ${SHOP}…`);

const { count: nullCountBefore } = await supabase
  .from("orders")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP)
  .is("order_date", null);
console.log(`Rows with NULL order_date before: ${nullCountBefore}`);

// enrichOrdersWithShopify only consumes session.accessToken + session.shop.
// Skip Remix's PostgresSessionStorage (which is a .ts module not resolvable
// from a raw-Node script) and pull the offline session directly from the
// shopify_sessions table.
const { data: sessRow } = await supabase
  .from("shopify_sessions")
  .select("accessToken")
  .eq("shop", SHOP)
  .eq("isOnline", false)
  .maybeSingle();
if (!sessRow?.accessToken) {
  console.error("FAIL — no offline Shopify session for " + SHOP);
  process.exit(1);
}
const session = { shop: SHOP, accessToken: sessRow.accessToken };

const t0 = Date.now();
const result = await enrichOrdersWithShopify({
  supabase,
  storeId: SHOP,
  session,
  sinceISO: null, // full lifetime
});
const dt = Date.now() - t0;

console.log(`\nEnrichment finished in ${(dt / 1000).toFixed(1)}s:`);
console.log(`  considered:        ${result.considered}`);
console.log(`  enriched (line_items): ${result.enriched}`);
console.log(`  order_date filled: ${result.orderDateFilled}`);
if (result.skipped) console.log(`  skipped reason:    ${result.skipped}`);

const { count: nullCountAfterShopify } = await supabase
  .from("orders")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP)
  .is("order_date", null);
console.log(`\nRows still NULL after Shopify pass: ${nullCountAfterShopify}`);

// Phase B: one-shot fallback. Drop the remaining NULLs onto transaction_date
// directly. The trigger from migration 021 only preserves order_date when
// NEW is NULL — passing a real timestamp (transaction_date) writes through.
console.log(`Phase B: backfilling remaining NULLs from transaction_date…`);
const pgClient = new pg.Client({ connectionString: process.env.SUPABASE_DATABASE_URL });
await pgClient.connect();
const fallbackRes = await pgClient.query(
  `UPDATE orders
     SET order_date          = transaction_date,
         order_date_attempts = GREATEST(order_date_attempts, 5)
   WHERE store_id          = $1
     AND order_date         IS NULL
     AND transaction_date   IS NOT NULL
   RETURNING 1`,
  [SHOP]
);
await pgClient.end();
console.log(`  fallback rows updated: ${fallbackRes.rowCount}`);

const { count: nullCountFinal } = await supabase
  .from("orders")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP)
  .is("order_date", null);
const { count: total } = await supabase
  .from("orders")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP);
console.log(`\nFinal NULL count: ${nullCountFinal} / ${total}`);
console.log(
  `Coverage: ${total - nullCountFinal} / ${total} = ${(((total - nullCountFinal) / total) * 100).toFixed(1)}%`
);

// Summary of where the values came from (Shopify match vs transaction_date fallback)
const { data: sample } = await supabase
  .from("orders")
  .select("order_date, transaction_date")
  .eq("store_id", SHOP)
  .not("order_date", "is", null)
  .limit(5000);

let matchedFromShopify = 0;
let fellBackToTransaction = 0;
for (const r of sample ?? []) {
  if (
    r.order_date &&
    r.transaction_date &&
    new Date(r.order_date).getTime() === new Date(r.transaction_date).getTime()
  ) {
    fellBackToTransaction++;
  } else {
    matchedFromShopify++;
  }
}
console.log(
  `\nFilled-row provenance (sample of up to 5000):\n` +
    `  matched from Shopify:    ${matchedFromShopify}\n` +
    `  equal to transaction_date: ${fellBackToTransaction} (either fallback OR Shopify date legitimately equal)`
);
