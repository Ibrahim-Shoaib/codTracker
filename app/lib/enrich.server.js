// ============================================================
// Shopify line-item enrichment for orders.
//
// PostEx orders ingest with only an `orderDetail` text string — no canonical
// product reference. For ~91% of orders (those that originate from Shopify
// checkout), we can look up the same order in Shopify Admin via `name` (=
// our `order_ref_number`) and store the [{variant_id, quantity}] line items
// on the order row. COGS resolution then becomes a deterministic
// variant_id → product_costs.shopify_variant_id join.
//
// Orders that have no Shopify counterpart (DM/WhatsApp bookings entered
// directly into PostEx, or orders pre-dating the Shopify install) keep
// line_items = NULL and continue to flow through the existing 5-tier text
// matcher — silently. No merchant-facing surface for them.
// ============================================================

import { sessionStorage } from '../shopify.server';
import { getOrdersLineItemMap } from './shopify.server.js';

const ENRICH_BATCH = 1000;

// Load the Shopify offline session for a shop. Returns undefined if the
// session was deleted (uninstall) or never existed.
export async function loadOfflineSession(shop) {
  return sessionStorage.loadSession(`offline_${shop}`);
}

// Enrich orders with Shopify line items for a given window.
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
// Returns: { enriched, considered, skipped }
//   skipped is set with a reason when nothing happened (no session, etc.)
export async function enrichOrdersWithShopify({ supabase, storeId, session, sinceISO }) {
  if (!session?.accessToken) {
    return { enriched: 0, considered: 0, skipped: 'no_session' };
  }

  // Fetch our orders that need enrichment. We deliberately limit to
  // line_items IS NULL so this function is idempotent — re-running enrichment
  // never overwrites an order that's already been resolved.
  const orders = [];
  for (let from = 0; ; from += ENRICH_BATCH) {
    let q = supabase
      .from('orders')
      .select('tracking_number, order_ref_number')
      .eq('store_id', storeId)
      .is('line_items', null);
    if (sinceISO) q = q.gte('transaction_date', sinceISO);
    const { data, error } = await q.range(from, from + ENRICH_BATCH - 1);
    if (error) throw error;
    if (!data?.length) break;
    orders.push(...data);
    if (data.length < ENRICH_BATCH) break;
  }

  if (orders.length === 0) {
    return { enriched: 0, considered: 0 };
  }

  // Pull Shopify line items for the same window. One bulk paginated call.
  let shopifyMap;
  try {
    shopifyMap = await getOrdersLineItemMap(session, sinceISO ?? undefined);
  } catch (err) {
    // We never want enrichment to take down sync. Log + return early so the
    // caller can fall back to text matching for these orders.
    console.error(`[enrich ${storeId}] Shopify fetch failed:`, err.message ?? err);
    return { enriched: 0, considered: orders.length, skipped: 'shopify_error' };
  }

  if (!shopifyMap || shopifyMap.size === 0) {
    return { enriched: 0, considered: orders.length, skipped: 'no_shopify_orders' };
  }

  // Build update payloads. PostEx strips the leading '#' from the Shopify
  // order name when storing as order_ref_number; Shopify's `name` field
  // INCLUDES the '#'. getOrdersLineItemMap keys by Shopify's name, so we
  // try both with and without the '#' to be safe.
  const updates = [];
  for (const o of orders) {
    if (!o.order_ref_number) continue;
    const ref = String(o.order_ref_number);
    const lineItems =
      shopifyMap.get(`#${ref}`) ??
      shopifyMap.get(ref);
    if (!lineItems || lineItems.length === 0) continue;
    updates.push({ tracking_number: o.tracking_number, line_items: lineItems });
  }

  if (updates.length === 0) {
    return { enriched: 0, considered: orders.length };
  }

  // Flush via batch RPC — same pattern as apply_cogs_batch.
  let enriched = 0;
  for (let i = 0; i < updates.length; i += ENRICH_BATCH) {
    const chunk = updates.slice(i, i + ENRICH_BATCH);
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

  return { enriched, considered: orders.length };
}
