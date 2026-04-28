import { fetchOrders, mapOrder } from './postex.server.js';
import { getLastNDaysPKT } from './dates.server.js';
import {
  buildCostIndex,
  buildCostsByVariantId,
  computeCOGSFromOrder,
} from './cogs.server.js';
import { enrichOrdersWithShopify, loadOfflineSession } from './enrich.server.js';
import { cancelStaleBooked } from './stale-orders.server.js';

const BATCH_CHUNK = 1000; // rows per apply_cogs_batch RPC call

// Window we re-enrich on every cron tick. Slightly larger than the PostEx
// sync window (20 days) so any Shopify orders that arrived since last sync —
// even if PostEx hasn't caught up yet — get picked up.
const ROLLING_ENRICH_DAYS = 30;

// ------------------------------------------------------------
// 20-day rolling sync from PostEx + line-items enrichment.
// ------------------------------------------------------------
export async function syncStore(storeRow, supabase) {
  const { start, end } = getLastNDaysPKT(20);
  const rawOrders = await fetchOrders(storeRow.postex_token, start, end);
  const mapped = rawOrders.map(o => mapOrder(o, storeRow.store_id));

  // ---- 1. Upsert PostEx orders ----
  if (mapped.length > 0) {
    // Bulk upsert is cheaper than per-row. Conflict on (store_id,tracking_number)
    // means status/payment changes overwrite, which is the behaviour we want.
    const { error: upsertErr } = await supabase
      .from('orders')
      .upsert(mapped, { onConflict: 'store_id,tracking_number' });
    if (upsertErr) {
      console.error(`[sync ${storeRow.store_id}] order upsert failed:`, upsertErr);
      throw upsertErr;
    }
  }

  await supabase
    .from('stores')
    .update({ last_postex_sync_at: new Date().toISOString() })
    .eq('store_id', storeRow.store_id);

  // ---- 1b. Sweep stale Booked rows past the rolling window ----
  // Once an order ages beyond 20 days while still Booked, PostEx will never
  // return it again — it's abandoned. Flip to Cancelled so it stops counting
  // as in-transit. Best-effort: a failure here doesn't block the sync.
  await cancelStaleBooked(supabase, storeRow.store_id).catch(err => {
    console.error(`[sync ${storeRow.store_id}] cancelStaleBooked failed:`, err.message ?? err);
  });

  // ---- 2. Shopify line-items enrichment for the rolling window ----
  // Best-effort: any failure is logged and swallowed. Orders that don't get
  // enriched simply stay on the text matcher path until the next tick.
  const session = await loadOfflineSession(storeRow.store_id).catch(() => null);
  const sinceISO = new Date(Date.now() - ROLLING_ENRICH_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await enrichOrdersWithShopify({
    supabase,
    storeId: storeRow.store_id,
    session,
    sinceISO,
  }).catch(err => {
    console.error(`[sync ${storeRow.store_id}] rolling enrichment failed:`, err.message ?? err);
  });

  // ---- 3. One-shot historical line_items backfill (existing customers) ----
  // Triggered on the first cron tick after deploy when stores.line_items_backfilled_at
  // is NULL. Fire-and-forget: enrichment + COGS rematch happen in the
  // background; the cron returns to its next batch immediately. Idempotent —
  // the stores flag is set on completion so subsequent ticks skip this branch.
  if (!storeRow.line_items_backfilled_at && session) {
    void runOneShotHistoricalEnrichment({ supabase, storeId: storeRow.store_id, session })
      .catch(err => {
        console.error(`[backfill ${storeRow.store_id}] one-shot failed:`, err.message ?? err);
      });
  }
}

// ------------------------------------------------------------
// Historical enrichment + rematch — runs once per existing store after
// deploy. Self-flagging via stores.line_items_backfilled_at.
// ------------------------------------------------------------
export async function runOneShotHistoricalEnrichment({ supabase, storeId, session }) {
  console.log(`[backfill ${storeId}] starting one-shot historical line_items enrichment`);
  const result = await enrichOrdersWithShopify({
    supabase,
    storeId,
    session,
    sinceISO: null, // full lifetime
  });
  console.log(
    `[backfill ${storeId}] enriched ${result.enriched} of ${result.considered} orders` +
    (result.skipped ? ` (skipped: ${result.skipped})` : '')
  );

  // Recompute COGS so newly enriched orders adopt the variant_id path.
  // Retries on 'already_running' because the cron also fires a parallel
  // retroactiveCOGSMatch right after syncStore returns — if it grabs the
  // lock first, our call bails immediately and the freshly-enriched orders
  // wouldn't be matched until the NEXT cron tick. Polling here keeps the
  // post-deploy "first run" tight.
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await retroactiveCOGSMatch(supabase, storeId).catch(err => {
      console.error(`[backfill ${storeId}] post-backfill rematch failed:`, err.message ?? err);
      return { skipped: true, reason: 'error' };
    });
    if (!result?.skipped) break;
    if (result?.reason !== 'already_running') break;
    await new Promise(r => setTimeout(r, 5000));
  }

  // Stamp the flag — even when 0 orders were enriched (empty store, no
  // Shopify counterparts, or session expired). The point is "we attempted
  // the historical pass once"; subsequent ticks rely on the rolling
  // 30-day window in syncStore to keep new orders enriched.
  await supabase
    .from('stores')
    .update({ line_items_backfilled_at: new Date().toISOString() })
    .eq('store_id', storeId);
  console.log(`[backfill ${storeId}] one-shot backfill complete`);
}

// ------------------------------------------------------------
// Batch rematch for a whole store.
//
// Concurrency:     DB-backed per-store mutex (stores.cogs_match_in_progress).
//                  A second caller bails rather than racing on the same rows.
// Scope:           Re-evaluates orders that EITHER:
//                    - have line_items set (variant_id path is now available
//                      or the cost catalog may have changed for those variants), OR
//                    - have a weak text-match source ('none', 'fuzzy',
//                      'sibling_avg', 'fallback_avg').
//                  Orders matched cleanly by SKU/exact text matching with no
//                  line_items are deterministic and untouched.
// Performance:     Two paginated queries to fetch eligible orders, one JS
//                  match pass, then one apply_cogs_batch RPC per BATCH_CHUNK
//                  rows. Variant_id path is sub-millisecond per order.
//
// Returns:
//   { skipped?: true, reason?: 'already_running'|'no_costs'|'lock_error',
//     evaluated, updated, sku, exact, fuzzy, sibling_avg, fallback_avg, none, variant_id }
// ------------------------------------------------------------
export async function retroactiveCOGSMatch(supabase, storeId) {
  // ---- acquire lock (compare-and-set update) ----
  const { data: locked, error: lockErr } = await supabase
    .from('stores')
    .update({
      cogs_match_in_progress: true,
      cogs_match_started_at: new Date().toISOString(),
    })
    .eq('store_id', storeId)
    .eq('cogs_match_in_progress', false)
    .select('store_id');

  if (lockErr) {
    console.error(`[rematch ${storeId}] lock acquire failed:`, lockErr);
    return { skipped: true, reason: 'lock_error' };
  }
  if (!locked?.length) {
    console.log(`[rematch ${storeId}] already in progress, skipping`);
    return { skipped: true, reason: 'already_running' };
  }

  try {
    // ---- fetch costs ----
    // shopify_variant_id is the primary key for the variant_id direct path.
    const costsRes = await supabase
      .from('product_costs')
      .select('product_title, variant_title, unit_cost, sku, shopify_variant_id')
      .eq('store_id', storeId);

    const costs = costsRes.data ?? [];

    if (!costs.length) {
      // No costs saved — nothing meaningful to compute. Don't touch the DB;
      // surface the reason so callers can show a hint to the merchant.
      return { skipped: true, reason: 'no_costs' };
    }

    // ---- fetch candidate orders (two queries, deduplicated in-memory) ----
    // PostgREST's .or() chokes on parens inside .in.() values, so we issue
    // two simple queries and merge by tracking_number.
    const orders = [];
    const seen = new Set();
    const PAGE = 1000;

    // Query A: orders with line_items set (variant_id path candidates).
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('orders')
        .select('tracking_number, order_detail, line_items')
        .eq('store_id', storeId)
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

    // Query B: orders whose match source is weak (text-matcher candidates).
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('orders')
        .select('tracking_number, order_detail, line_items')
        .eq('store_id', storeId)
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

    const counts = {
      sku: 0, exact: 0, fuzzy: 0,
      sibling_avg: 0, fallback_avg: 0, none: 0,
      variant_id: 0,
    };

    if (!orders.length) {
      return { evaluated: 0, updated: 0, ...counts };
    }

    // ---- compute all updates in-memory ----
    const textIndex = buildCostIndex(costs);
    const costsByVariantId = buildCostsByVariantId(costs);

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

    // ---- flush in chunks via apply_cogs_batch RPC ----
    let updated = 0;
    for (let i = 0; i < updates.length; i += BATCH_CHUNK) {
      const chunk = updates.slice(i, i + BATCH_CHUNK);
      const { data: affected, error: rpcErr } = await supabase.rpc('apply_cogs_batch', {
        p_store_id: storeId,
        p_updates: chunk,
      });
      if (rpcErr) {
        console.error(`[rematch ${storeId}] apply_cogs_batch failed:`, rpcErr);
        throw rpcErr;
      }
      updated += Number(affected) || 0;
    }

    return { evaluated: orders.length, updated, ...counts };
  } finally {
    const { error: unlockErr } = await supabase
      .from('stores')
      .update({ cogs_match_in_progress: false })
      .eq('store_id', storeId);
    if (unlockErr) console.error(`[rematch ${storeId}] lock release failed:`, unlockErr);
  }
}
