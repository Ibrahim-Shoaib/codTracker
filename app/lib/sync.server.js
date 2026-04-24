import { fetchOrders, mapOrder } from './postex.server.js';
import { getLastNDaysPKT } from './dates.server.js';
import { buildCostIndex, computeCOGS } from './cogs.server.js';

const BATCH_CHUNK = 1000; // rows per apply_cogs_batch RPC call

// ------------------------------------------------------------
// 30-day rolling sync from PostEx.
// ------------------------------------------------------------
export async function syncStore(storeRow, supabase) {
  const { start, end } = getLastNDaysPKT(20);
  const rawOrders = await fetchOrders(storeRow.postex_token, start, end);
  const mapped = rawOrders.map(o => mapOrder(o, storeRow.store_id));

  for (const order of mapped) {
    const { data: existing } = await supabase
      .from('orders')
      .select('is_delivered,is_returned,cogs_matched,cogs_match_source')
      .eq('tracking_number', order.tracking_number)
      .single();

    await supabase
      .from('orders')
      .upsert(order, { onConflict: 'store_id,tracking_number' });

    const statusChanged =
      existing &&
      (order.is_delivered !== existing.is_delivered ||
        order.is_returned !== existing.is_returned);

    // Re-run COGS only when the prior match was weak. A sku/exact match is
    // deterministic and won't improve on retry.
    const weakMatch =
      !existing ||
      !existing.cogs_matched ||
      existing.cogs_match_source === 'fuzzy' ||
      existing.cogs_match_source === 'sibling_avg' ||
      existing.cogs_match_source === 'fallback_avg';

    if (statusChanged && weakMatch) {
      matchCOGS(supabase, storeRow.store_id, order.tracking_number, order.order_detail)
        .catch(err => console.error(`matchCOGS failed for ${order.tracking_number}:`, err));
    }
  }

  await supabase
    .from('stores')
    .update({ last_postex_sync_at: new Date().toISOString() })
    .eq('store_id', storeRow.store_id);
}

// ------------------------------------------------------------
// Single-order COGS resolution used during sync.
// ------------------------------------------------------------
export async function matchCOGS(supabase, storeId, trackingNumber, orderDetail) {
  const { data: costs } = await supabase
    .from('product_costs')
    .select('product_title, variant_title, unit_cost, sku')
    .eq('store_id', storeId);

  const index = buildCostIndex(costs);
  const { cogsTotal, allMatched, source } = computeCOGS(orderDetail, index);

  await supabase
    .from('orders')
    .update({
      cogs_total: cogsTotal,
      cogs_matched: allMatched,
      cogs_match_source: source,
    })
    .eq('store_id', storeId)
    .eq('tracking_number', trackingNumber);
}

// ------------------------------------------------------------
// Batch rematch for a whole store.
//
// Concurrency:     DB-backed per-store mutex (stores.cogs_match_in_progress).
//                  A second caller bails rather than racing on the same rows.
// Scope:           Re-evaluates orders whose source is 'none' or any estimate
//                  ('fuzzy', 'sibling_avg', 'fallback_avg'). sku/exact rows
//                  are deterministic and untouched.
// Performance:     One JS match pass, then one apply_cogs_batch RPC per
//                  BATCH_CHUNK rows. ~3 seconds for 5000 orders.
//
// Returns:
//   { skipped?: true, reason?: 'already_running'|'no_costs'|'lock_error',
//     evaluated, updated, sku, exact, fuzzy, sibling_avg, fallback_avg, none }
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
    // ---- fetch costs + candidate orders ----
    // PostgREST caps a single response at ~1000 rows, so the order fetch must
    // paginate or we'd silently truncate for large stores.
    const costsRes = await supabase
      .from('product_costs')
      .select('product_title, variant_title, unit_cost, sku')
      .eq('store_id', storeId);

    const costs = costsRes.data ?? [];

    const orders = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('orders')
        .select('tracking_number, order_detail')
        .eq('store_id', storeId)
        .in('cogs_match_source', ['none', 'fuzzy', 'sibling_avg', 'fallback_avg'])
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data?.length) break;
      orders.push(...data);
      if (data.length < PAGE) break;
    }

    if (!costs.length) {
      // No costs saved for this store — every order would fall to 'none'.
      // Don't touch the DB; let the merchant know via the return value.
      return { skipped: true, reason: 'no_costs' };
    }

    const counts = { sku: 0, exact: 0, fuzzy: 0, sibling_avg: 0, fallback_avg: 0, none: 0 };

    if (!orders.length) {
      return { evaluated: 0, updated: 0, ...counts };
    }

    // ---- compute all updates in-memory ----
    const index = buildCostIndex(costs);
    const updates = [];
    for (const o of orders) {
      const { cogsTotal, allMatched, source } = computeCOGS(o.order_detail ?? '', index);
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
