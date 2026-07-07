// Pre/post-deploy diagnostic for the expiring-offline-tokens migration.
// Uses the SUPABASE_DATABASE_URL (direct Postgres) rather than PostgREST so
// we can query information_schema.
//
// Reports:
//   1. shopify_sessions columns (checks for refreshToken + refreshTokenExpires)
//   2. Trendy's offline session state (accessToken length, expires, scope)
//   3. Session count + fresh-token distribution across all shops
//
// Run: node scripts/_check_shopify_sessions_schema.mjs
import 'dotenv/config';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DATABASE_URL;
if (!DB_URL) {
  console.error('SUPABASE_DATABASE_URL not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DB_URL });
await client.connect();

const SHOP = 'the-trendy-homes-pk.myshopify.com';

console.log('=== 1. shopify_sessions schema ===');
const cols = await client.query(
  `SELECT column_name, data_type, character_maximum_length
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'shopify_sessions'
   ORDER BY ordinal_position`
);
for (const row of cols.rows) {
  const len = row.character_maximum_length ? `(${row.character_maximum_length})` : '';
  console.log(`  ${row.column_name.padEnd(24)} ${row.data_type}${len}`);
}
const columnNames = new Set(cols.rows.map((r) => r.column_name));
console.log('');
console.log(`  refreshToken column present:         ${columnNames.has('refreshToken')}`);
console.log(`  refreshTokenExpires column present:  ${columnNames.has('refreshTokenExpires')}`);
console.log(`  Post-migration schema:               ${columnNames.has('refreshToken') && columnNames.has('refreshTokenExpires')}`);

console.log('');
console.log(`=== 2. ${SHOP} session state ===`);
const hasRefreshCols = columnNames.has('refreshToken');
const sessionQuery = hasRefreshCols
  ? `SELECT id, shop, "isOnline", scope, expires,
            LEFT("accessToken", 8) AS access_token_prefix,
            LENGTH("accessToken") AS access_token_len,
            "refreshToken" IS NOT NULL AS has_refresh_token,
            "refreshTokenExpires"
     FROM shopify_sessions
     WHERE shop = $1
     ORDER BY "isOnline"`
  : `SELECT id, shop, "isOnline", scope, expires,
            LEFT("accessToken", 8) AS access_token_prefix,
            LENGTH("accessToken") AS access_token_len
     FROM shopify_sessions
     WHERE shop = $1
     ORDER BY "isOnline"`;
const trendy = await client.query(sessionQuery, [SHOP]);
if (!trendy.rows.length) {
  console.log(`  NO SESSION for ${SHOP} — merchant either uninstalled or never installed on this deployment.`);
} else {
  for (const row of trendy.rows) {
    console.log(`  id:            ${row.id}`);
    console.log(`    isOnline:              ${row.isOnline}`);
    console.log(`    scope:                 ${row.scope}`);
    console.log(`    expires:               ${row.expires}`);
    console.log(`    accessToken prefix:    ${row.access_token_prefix}… (len=${row.access_token_len})`);
    if (hasRefreshCols) {
      console.log(`    has_refresh_token:     ${row.has_refresh_token}`);
      console.log(`    refreshTokenExpires:   ${row.refreshTokenExpires}`);
    }
  }
}

console.log('');
console.log('=== 3. All shops: fresh vs stale sessions ===');
// expires is stored as unix-epoch integer (seconds), so compare against
// extract(epoch from now()) rather than NOW() directly.
const allShops = await client.query(
  `SELECT shop,
          "isOnline",
          expires,
          CASE
            WHEN expires IS NULL THEN 'no-expiry'
            WHEN expires > EXTRACT(EPOCH FROM NOW() + INTERVAL '5 minutes')::int THEN 'fresh'
            WHEN expires > EXTRACT(EPOCH FROM NOW())::int THEN 'near-expiry'
            ELSE 'expired'
          END AS status
   FROM shopify_sessions
   ORDER BY shop, "isOnline"`
);
const bucket = { 'no-expiry': 0, fresh: 0, 'near-expiry': 0, expired: 0 };
for (const row of allShops.rows) {
  bucket[row.status]++;
}
console.log(`  Total sessions:            ${allShops.rows.length}`);
console.log(`  no-expiry (non-expiring):  ${bucket['no-expiry']}`);
console.log(`  fresh (>5min left):        ${bucket.fresh}`);
console.log(`  near-expiry (<5min left):  ${bucket['near-expiry']}`);
console.log(`  expired:                   ${bucket.expired}`);

console.log('');
console.log('=== 4. Recent Trendy CAPI activity (last 6h) ===');
const capi = await client.query(
  `SELECT COUNT(*) AS n_events,
          COUNT(*) FILTER (WHERE status = 'sent') AS sent,
          COUNT(*) FILTER (WHERE status <> 'sent') AS not_sent,
          MAX(sent_at) AS last_event_at
   FROM capi_delivery_log
   WHERE store_id = $1 AND sent_at > NOW() - INTERVAL '6 hours'`,
  [SHOP]
);
console.log(`  events (6h):    ${capi.rows[0].n_events}`);
console.log(`    sent:         ${capi.rows[0].sent}`);
console.log(`    not_sent:     ${capi.rows[0].not_sent}`);
console.log(`    last_event:   ${capi.rows[0].last_event_at ?? '(none)'}`);

console.log('');
console.log('=== 5. Trendy — recent Purchase events by status (last 24h) ===');
const capiMix = await client.query(
  `SELECT event_name, status, http_status, COUNT(*) AS n
   FROM capi_delivery_log
   WHERE store_id = $1 AND sent_at > NOW() - INTERVAL '24 hours'
   GROUP BY 1,2,3
   ORDER BY 1,2,3`,
  [SHOP]
);
if (!capiMix.rows.length) {
  console.log('  no events in the last 24h');
} else {
  for (const row of capiMix.rows) {
    console.log(`  ${row.event_name.padEnd(20)} status=${row.status.padEnd(10)} http=${row.http_status ?? '-'}  n=${row.n}`);
  }
}

await client.end();
