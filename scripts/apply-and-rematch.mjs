import pg from 'pg';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { buildCostIndex, computeCOGS } from '../app/lib/cogs.server.js';

const SHOP = 'the-trendy-homes-pk.myshopify.com';

// ---- verify schema ----
const u = new URL(process.env.SUPABASE_DATABASE_URL);
const dbClient = new pg.Client({
  host: u.hostname,
  port: Number(u.port || 5432),
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ''),
  ssl: { rejectUnauthorized: false },
});
await dbClient.connect();

const check = await dbClient.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name='orders' AND column_name IN ('cogs_match_source')
  UNION
  SELECT column_name FROM information_schema.columns
  WHERE table_name='stores' AND column_name IN ('cogs_match_in_progress','cogs_match_started_at')
  ORDER BY 1
`);
console.log('Schema columns present:', check.rows.map(r => r.column_name));
await dbClient.end();

// ---- run the new matcher for this store ----
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function fetchAll(table, build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(supabase.from(table)).range(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

const [orders, costs] = await Promise.all([
  fetchAll('orders', q =>
    q.select('tracking_number, order_detail, cogs_match_source').eq('store_id', SHOP)
      .in('cogs_match_source', ['none', 'fuzzy'])
  ),
  fetchAll('product_costs', q =>
    q.select('product_title, variant_title, unit_cost, sku').eq('store_id', SHOP)
  ),
]);

console.log(`Candidate orders (source none|fuzzy): ${orders.length}`);
console.log(`product_costs rows: ${costs.length}`);

const index = buildCostIndex(costs);

const counts = { sku: 0, exact: 0, fuzzy: 0, none: 0 };
let updates = 0;
const batchSize = 100;
const pending = [];

for (const o of orders) {
  const { cogsTotal, allMatched, source } = computeCOGS(o.order_detail || '', index);
  counts[source]++;

  pending.push({
    tracking_number: o.tracking_number,
    cogs_total: cogsTotal,
    cogs_matched: allMatched,
    cogs_match_source: source,
  });

  if (pending.length >= batchSize) {
    await flush(pending.splice(0));
  }
}
if (pending.length) await flush(pending.splice(0));

console.log('\n--- RESULT ---');
console.log(`sku   : ${counts.sku}`);
console.log(`exact : ${counts.exact}`);
console.log(`fuzzy : ${counts.fuzzy}`);
console.log(`none  : ${counts.none}`);
console.log(`updated rows: ${updates}`);

async function flush(rows) {
  // Update one-by-one — PostgREST upsert can't target a composite unique key
  // across (store_id, tracking_number) here without the store_id, but rows
  // come from this store only so just do matched updates.
  for (const r of rows) {
    const { error } = await supabase
      .from('orders')
      .update({
        cogs_total: r.cogs_total,
        cogs_matched: r.cogs_matched,
        cogs_match_source: r.cogs_match_source,
      })
      .eq('store_id', SHOP)
      .eq('tracking_number', r.tracking_number);
    if (error) console.error(`update ${r.tracking_number}:`, error.message);
    else updates++;
  }
}
