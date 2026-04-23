import { fetchOrders, mapOrder } from './postex.server.js';
import { getLast30DaysPKT } from './dates.server.js';
import { buildCostMap, computeCOGS } from './cogs.server.js';

// Regular 30-day rolling sync. Called by cron and on-demand.
export async function syncStore(storeRow, supabase) {
  const { start, end } = getLast30DaysPKT();
  const rawOrders = await fetchOrders(storeRow.postex_token, start, end);
  const mapped = rawOrders.map(o => mapOrder(o, storeRow.store_id));

  for (const order of mapped) {
    const { data: existing } = await supabase
      .from('orders')
      .select('is_delivered,is_returned,cogs_matched')
      .eq('tracking_number', order.tracking_number)
      .single();

    await supabase
      .from('orders')
      .upsert(order, { onConflict: 'store_id,tracking_number' });

    const statusChanged =
      existing &&
      (order.is_delivered !== existing.is_delivered ||
        order.is_returned !== existing.is_returned);

    if (statusChanged && !existing.cogs_matched) {
      matchCOGS(supabase, storeRow.store_id, order.tracking_number, order.order_detail)
        .catch(err => console.error(`matchCOGS failed for ${order.tracking_number}:`, err));
    }
  }

  await supabase
    .from('stores')
    .update({ last_postex_sync_at: new Date().toISOString() })
    .eq('store_id', storeRow.store_id);
}

// Looks up COGS for one order using orderDetail text — no Shopify API call needed.
export async function matchCOGS(supabase, storeId, trackingNumber, orderDetail) {
  const { data: costs } = await supabase
    .from('product_costs')
    .select('product_title, variant_title, unit_cost')
    .eq('store_id', storeId);

  const costMap = buildCostMap(costs);
  const { cogsTotal, allMatched } = computeCOGS(orderDetail, costMap);

  await supabase
    .from('orders')
    .update({ cogs_total: cogsTotal, cogs_matched: allMatched })
    .eq('store_id', storeId)
    .eq('tracking_number', trackingNumber);
}

// Batch retroactive COGS match for all unmatched orders — pure DB operation, no external APIs.
export async function retroactiveCOGSMatch(supabase, storeId) {
  const { data: unmatched } = await supabase
    .from('orders')
    .select('tracking_number, order_detail')
    .eq('store_id', storeId)
    .eq('cogs_matched', false);

  if (!unmatched?.length) return { unmatched: 0, updates: 0 };

  const { data: costs } = await supabase
    .from('product_costs')
    .select('product_title, variant_title, unit_cost')
    .eq('store_id', storeId);

  const costMap = buildCostMap(costs);

  const updates = [];
  for (const order of unmatched) {
    const { cogsTotal, allMatched } = computeCOGS(order.order_detail, costMap);
    updates.push({ tracking_number: order.tracking_number, cogsTotal, allMatched });
  }

  for (const u of updates) {
    await supabase
      .from('orders')
      .update({ cogs_total: u.cogsTotal, cogs_matched: u.allMatched })
      .eq('store_id', storeId)
      .eq('tracking_number', u.tracking_number);
  }

  return { unmatched: unmatched.length, updates: updates.length };
}
