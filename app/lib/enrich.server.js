// ============================================================
// Shopify enrichment for orders.
//
// Two responsibilities, ONE Shopify call (so adding the second
// responsibility costs zero extra API requests):
//
//   1. line_items — PostEx orders ingest with only an `orderDetail` text
//      string, no canonical product reference. For ~91% of orders (those
//      that originate from Shopify checkout), we look up the order in
//      Shopify Admin via `name` (= our `order_ref_number`) and store the
//      [{variant_id, quantity}] line items so COGS resolution becomes a
//      deterministic variant_id → product_costs.shopify_variant_id join.
//
//   2. order_date — PostEx's `transaction_date` is when PostEx accepted
//      the consignment, not when the customer placed the order. For
//      merchants who batch-upload (e.g. ship once a week), this collapses
//      multiple days of orders onto a single date on the dashboard. We
//      pull Shopify's `created_at` from the same response and store it
//      in orders.order_date. Dashboard date-bucketing should COALESCE
//      to transaction_date for orders that never get a Shopify match
//      (DM/WhatsApp bookings, deleted Shopify orders).
//
// Orders that miss Shopify after 5 enrichment attempts get
// transaction_date written into order_date as a permanent fallback —
// see finalize_order_date_fallbacks() in migration 022.
// ============================================================

import { getOrdersLineItemMap } from './shopify.server.js';

const ENRICH_BATCH = 1000;
const MAX_ORDER_DATE_ATTEMPTS = 5;

// Load the Shopify offline session for a shop. Returns undefined if the
// session was deleted (uninstall) or never existed.
//
// Dynamic import so that one-shot scripts (which only need
// enrichOrdersWithShopify and bring their own session) can `import` from
// this file without dragging in the .ts shopify.server module that raw
// Node ESM can't resolve. The import only fires when this function is
// actually called (cron / webhook / onboarding paths).
export async function loadOfflineSession(shop) {
  const { sessionStorage } = await import('../shopify.server');
  return sessionStorage.loadSession(`offline_${shop}`);
}

// Enrich orders with Shopify data (line_items + order_date) for a given window.
//
// Args:
//   supabase    - store-scoped client
//   storeId     - shop domain
//   session     - offline Shopify session (caller loads it; we don't fetch
//                 here so this function stays pure-async and easily mockable)
//   sinceISO    - optional ISO date string. If provided, only orders with
//                 transaction_date >= sinceISO are considered. Pass null/
//                 undefined to enrich the full history.
//
// Returns: { enriched, orderDateFilled, considered, skipped }
//   - enriched: rows that got line_items written
//   - orderDateFilled: rows that got order_date written from Shopify
//   - considered: rows in the candidate pool
//   - skipped: present with a reason when nothing happened
export async function enrichOrdersWithShopify({ supabase, storeId, session, sinceISO }) {
  if (!session?.accessToken) {
    return { enriched: 0, orderDateFilled: 0, considered: 0, skipped: 'no_session' };
  }

  // Candidate pool: rows missing line_items OR rows whose order_date hasn't
  // been resolved yet (and haven't exhausted their attempt budget).
  // PostgREST's .or() syntax: nested groups are parenthesised at the value
  // level — this filter reads as
  //   line_items IS NULL OR (order_date IS NULL AND order_date_attempts < 5).
  const orFilter = `line_items.is.null,and(order_date.is.null,order_date_attempts.lt.${MAX_ORDER_DATE_ATTEMPTS})`;
  const orders = [];
  for (let from = 0; ; from += ENRICH_BATCH) {
    let q = supabase
      .from('orders')
      .select('tracking_number, order_ref_number, line_items, order_date')
      .eq('store_id', storeId)
      .or(orFilter);
    if (sinceISO) q = q.gte('transaction_date', sinceISO);
    const { data, error } = await q.range(from, from + ENRICH_BATCH - 1);
    if (error) throw error;
    if (!data?.length) break;
    orders.push(...data);
    if (data.length < ENRICH_BATCH) break;
  }

  if (orders.length === 0) {
    return { enriched: 0, orderDateFilled: 0, considered: 0 };
  }

  // Pull Shopify line items + created_at for the same window. One bulk
  // paginated call covers BOTH responsibilities.
  let shopifyMap;
  try {
    shopifyMap = await getOrdersLineItemMap(session, sinceISO ?? undefined);
  } catch (err) {
    // We never want enrichment to take down sync. Log + return early so the
    // caller can fall back to text matching for these orders.
    console.error(`[enrich ${storeId}] Shopify fetch failed:`, err.message ?? err);
    return {
      enriched: 0,
      orderDateFilled: 0,
      considered: orders.length,
      skipped: 'shopify_error',
    };
  }

  if (!shopifyMap || shopifyMap.size === 0) {
    return {
      enriched: 0,
      orderDateFilled: 0,
      considered: orders.length,
      skipped: 'no_shopify_orders',
    };
  }

  // Build update payloads. PostEx strips the leading '#' from the Shopify
  // order name when storing as order_ref_number; Shopify's `name` field
  // INCLUDES the '#'. getOrdersLineItemMap keys by Shopify's name, so we
  // try both with and without the '#' to be safe.
  const lineItemUpdates = [];
  const orderDateUpdates = [];
  const unmatchedTrackingNumbers = [];

  for (const o of orders) {
    if (!o.order_ref_number) {
      // No ref number → can't match. Bump attempts so we don't loop forever.
      if (o.order_date == null) unmatchedTrackingNumbers.push(o.tracking_number);
      continue;
    }
    const ref = String(o.order_ref_number);
    const shopifyEntry = shopifyMap.get(`#${ref}`) ?? shopifyMap.get(ref);
    if (!shopifyEntry) {
      if (o.order_date == null) unmatchedTrackingNumbers.push(o.tracking_number);
      continue;
    }
    const { lineItems, createdAt } = shopifyEntry;
    if (o.line_items == null && lineItems && lineItems.length > 0) {
      lineItemUpdates.push({ tracking_number: o.tracking_number, line_items: lineItems });
    }
    if (o.order_date == null && createdAt) {
      orderDateUpdates.push({ tracking_number: o.tracking_number, order_date: createdAt });
    }
  }

  // Flush line_items via existing RPC.
  let enriched = 0;
  for (let i = 0; i < lineItemUpdates.length; i += ENRICH_BATCH) {
    const chunk = lineItemUpdates.slice(i, i + ENRICH_BATCH);
    const { data: affected, error: rpcErr } = await supabase.rpc('apply_line_items_batch', {
      p_store_id: storeId,
      p_updates: chunk,
    });
    if (rpcErr) {
      console.error(`[enrich ${storeId}] apply_line_items_batch failed:`, rpcErr);
      throw rpcErr;
    }
    enriched += Number(affected) || 0;
  }

  // Flush order_date via the new RPC (migration 022).
  let orderDateFilled = 0;
  for (let i = 0; i < orderDateUpdates.length; i += ENRICH_BATCH) {
    const chunk = orderDateUpdates.slice(i, i + ENRICH_BATCH);
    const { data: affected, error: rpcErr } = await supabase.rpc('apply_order_date_batch', {
      p_store_id: storeId,
      p_updates: chunk,
    });
    if (rpcErr) {
      console.error(`[enrich ${storeId}] apply_order_date_batch failed:`, rpcErr);
      throw rpcErr;
    }
    orderDateFilled += Number(affected) || 0;
  }

  // For rows we considered but didn't match, bump their attempt counter so
  // they eventually fall through to the transaction_date fallback finalize.
  if (unmatchedTrackingNumbers.length > 0) {
    for (let i = 0; i < unmatchedTrackingNumbers.length; i += ENRICH_BATCH) {
      const chunk = unmatchedTrackingNumbers.slice(i, i + ENRICH_BATCH);
      const { error: rpcErr } = await supabase.rpc('apply_order_date_attempts_batch', {
        p_store_id: storeId,
        p_tracking_numbers: chunk,
      });
      if (rpcErr) {
        console.warn(`[enrich ${storeId}] apply_order_date_attempts_batch failed:`, rpcErr.message);
        // Non-fatal — counter just stays the same; we'll retry next tick.
      }
    }
  }

  // Finalize: any row that's now exhausted its attempt budget gets
  // transaction_date as the permanent fallback. Idempotent.
  try {
    const { data: finalised } = await supabase.rpc('finalize_order_date_fallbacks', {
      p_store_id: storeId,
    });
    if ((Number(finalised) || 0) > 0) {
      console.log(`[enrich ${storeId}] finalised ${finalised} order_date fallbacks → transaction_date`);
    }
  } catch (err) {
    console.warn(`[enrich ${storeId}] finalize_order_date_fallbacks failed:`, err.message ?? err);
  }

  return {
    enriched,
    orderDateFilled,
    considered: orders.length,
  };
}
