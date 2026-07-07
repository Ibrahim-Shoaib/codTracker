// Force-run a full COGS rematch for one store, inline.
//
// This bypasses the sync.server.js → enrich.server.js → shopify.server.ts
// import chain (which raw Node can't resolve). It implements the SAME logic
// retroactiveCOGSMatch uses, just without the surrounding lock-and-flag
// scaffolding (we acquire the lock manually below).
//
// Safety:
//   - Acquires the per-store lock (cogs_match_in_progress) before doing
//     anything; if it's already held, bails immediately
//   - Uses computeCOGSFromOrder (variant_id path → text fallback) — same
//     function the production code path uses
//   - Updates via apply_cogs_batch RPC — same RPC the production code uses
//   - Always releases the lock in `finally`
//   - Prints before/after snapshot for sanity

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  buildCostIndex,
  buildCostsByVariantId,
  computeCOGSFromOrder,
} from '../app/lib/cogs.server.js';

const SHOP = 'the-trendy-homes-pk.myshopify.com';
const BATCH_CHUNK = 1000;
const PAGE = 1000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function snapshot(label) {
  const { data: src } = await supabase
    .from('orders')
    .select('cogs_match_source, cogs_total')
    .eq('store_id', SHOP)
    .limit(50000);

  const counts = {};
  let totalCogs = 0;
  for (const r of src ?? []) {
    counts[r.cogs_match_source ?? 'NULL'] = (counts[r.cogs_match_source ?? 'NULL'] || 0) + 1;
    totalCogs += Number(r.cogs_total) || 0;
  }

  const { data: store } = await supabase
    .from('stores')
    .select('cogs_match_in_progress')
    .eq('store_id', SHOP)
    .single();

  console.log(`\n[${label}]`);
  console.log(`  store lock      = ${store.cogs_match_in_progress}`);
  console.log(`  total cogs sum  = ${Math.round(totalCogs).toLocaleString()} PKR`);
  console.log(`  by source:`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(15)} ${v}`);
  }
  return { totalCogs, counts, lockHeld: store.cogs_match_in_progress };
}

const before = await snapshot('BEFORE');

if (before.lockHeld) {
  console.log('\n⚠ Lock is currently held by another process. Aborting to avoid races.');
  console.log('  If you are SURE no other rematch is running, clear it first:');
  console.log(`  UPDATE stores SET cogs_match_in_progress = false WHERE store_id = '${SHOP}';`);
  process.exit(1);
}

// ---- Acquire lock (compare-and-set) ----
const { data: locked, error: lockErr } = await supabase
  .from('stores')
  .update({ cogs_match_in_progress: true, cogs_match_started_at: new Date().toISOString() })
  .eq('store_id', SHOP)
  .eq('cogs_match_in_progress', false)
  .select('store_id');

if (lockErr || !locked?.length) {
  console.error('Lock acquire failed:', lockErr ?? '(no rows)');
  process.exit(1);
}
console.log('\n✓ Lock acquired.');

const t0 = Date.now();

try {
  // ---- Fetch costs ----
  const { data: costs } = await supabase
    .from('product_costs')
    .select('product_title, variant_title, unit_cost, sku, shopify_variant_id')
    .eq('store_id', SHOP);

  if (!costs?.length) {
    console.log('No costs in product_costs. Nothing to do.');
    process.exit(0);
  }
  console.log(`Loaded ${costs.length} cost rows.`);

  // ---- Fetch eligible orders (line_items NOT NULL ∪ weak match source) ----
  const orders = [];
  const seen = new Set();

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('orders')
      .select('tracking_number, order_detail, line_items')
      .eq('store_id', SHOP)
      .not('line_items', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const o of data) {
      if (!seen.has(o.tracking_number)) {
        seen.add(o.tracking_number);
        orders.push(o);
      }
    }
    if (data.length < PAGE) break;
  }
  console.log(`Loaded ${orders.length} orders with line_items.`);

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('orders')
      .select('tracking_number, order_detail, line_items')
      .eq('store_id', SHOP)
      .in('cogs_match_source', ['none', 'fuzzy', 'sibling_avg', 'fallback_avg'])
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const o of data) {
      if (!seen.has(o.tracking_number)) {
        seen.add(o.tracking_number);
        orders.push(o);
      }
    }
    if (data.length < PAGE) break;
  }
  console.log(`Total candidate orders: ${orders.length}`);

  // ---- Compute updates in-memory ----
  const textIndex = buildCostIndex(costs);
  const costsByVariantId = buildCostsByVariantId(costs);

  const counts = { sku: 0, exact: 0, fuzzy: 0, sibling_avg: 0, fallback_avg: 0, none: 0, variant_id: 0 };
  const updates = [];
  for (const o of orders) {
    const { cogsTotal, allMatched, source } = computeCOGSFromOrder(o, costsByVariantId, textIndex);
    counts[source]++;
    updates.push({
      tracking_number: o.tracking_number,
      cogs_total: cogsTotal,
      cogs_matched: allMatched,
      cogs_match_source: source,
    });
  }

  // ---- Flush via apply_cogs_batch RPC ----
  let updated = 0;
  for (let i = 0; i < updates.length; i += BATCH_CHUNK) {
    const chunk = updates.slice(i, i + BATCH_CHUNK);
    const { data: affected, error: rpcErr } = await supabase.rpc('apply_cogs_batch', {
      p_store_id: SHOP,
      p_updates: chunk,
    });
    if (rpcErr) throw rpcErr;
    updated += Number(affected) || 0;
  }

  console.log(`\n✓ Recompute done in ${Date.now() - t0}ms`);
  console.log(`  evaluated: ${orders.length}`);
  console.log(`  updated:   ${updated}`);
  console.log(`  source counts:`, counts);
} finally {
  // ---- Release lock ----
  await supabase
    .from('stores')
    .update({ cogs_match_in_progress: false })
    .eq('store_id', SHOP);
  console.log('\n✓ Lock released.');
}

const after = await snapshot('AFTER');

console.log('\n---- Diff ----');
const allSources = new Set([...Object.keys(before.counts), ...Object.keys(after.counts)]);
console.log('source           before  →  after   Δ');
for (const k of allSources) {
  const b = before.counts[k] ?? 0;
  const a = after.counts[k] ?? 0;
  const sign = a - b > 0 ? '+' : '';
  console.log(`  ${k.padEnd(15)} ${String(b).padStart(5)}  →  ${String(a).padStart(5)}   ${sign}${a - b}`);
}
console.log(`\nTotal cogs sum: ${Math.round(before.totalCogs).toLocaleString()}  →  ${Math.round(after.totalCogs).toLocaleString()}  Δ ${(after.totalCogs - before.totalCogs > 0 ? '+' : '')}${Math.round(after.totalCogs - before.totalCogs).toLocaleString()} PKR`);
