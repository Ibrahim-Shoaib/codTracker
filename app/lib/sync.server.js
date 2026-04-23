import { fetchOrders, mapOrder } from './postex.server.js';
import { getOrderByName, getOrdersLineItemMap } from './shopify.server.js';
import { getLast30DaysPKT } from './dates.server.js';

// Regular 30-day rolling sync. Called by cron and on-demand.
export async function syncStore(storeRow, session, supabase) {
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

    // If status changed to a final state and COGS not yet matched: match now
    const statusChanged =
      existing &&
      (order.is_delivered !== existing.is_delivered ||
        order.is_returned !== existing.is_returned);
    if (statusChanged && !existing.cogs_matched) {
      await matchCOGS(
        supabase,
        storeRow.store_id,
        session,
        order.order_ref_number,
        order.tracking_number
      );
    }
  }

  await supabase
    .from('stores')
    .update({ last_postex_sync_at: new Date().toISOString() })
    .eq('store_id', storeRow.store_id);
}

// Looks up Shopify line items for one order and computes + writes cogs_total.
export async function matchCOGS(supabase, storeId, session, orderRefNumber, trackingNumber) {
  if (!orderRefNumber) return;

  const lineItems = await getOrderByName(session, orderRefNumber);
  if (!lineItems || lineItems.length === 0) return;

  let cogsTotal = 0;
  let allMatched = true;

  for (const item of lineItems) {
    const { data: cost } = await supabase
      .from('product_costs')
      .select('unit_cost')
      .eq('store_id', storeId)
      .eq('shopify_variant_id', item.variant_id)
      .single();

    if (cost) {
      cogsTotal += cost.unit_cost * item.quantity;
    } else {
      allMatched = false;
    }
  }

  await supabase
    .from('orders')
    .update({ cogs_total: cogsTotal, cogs_matched: allMatched })
    .eq('tracking_number', trackingNumber);
}

// Batch retroactive COGS match for all unmatched orders.
// Fetches all Shopify orders in bulk (one paginated scan) to avoid per-order API calls.
export async function retroactiveCOGSMatch(supabase, storeId, session) {
  const { data: unmatched } = await supabase
    .from('orders')
    .select('order_ref_number, tracking_number, transaction_date')
    .eq('store_id', storeId)
    .eq('cogs_matched', false);

  if (!unmatched?.length) return;

  // Find earliest order date, then offset 60 days back — Shopify orders are created
  // when the customer places the order, which can be weeks before the PostEx booking.
  const earliestRaw = unmatched
    .map(o => o.transaction_date)
    .filter(Boolean)
    .sort()[0] ?? '2020-01-01T00:00:00Z';
  const earliest = new Date(new Date(earliestRaw).getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // Single paginated Shopify scan → name→lineItems map (~4–6 API calls total)
  const lineItemMap = await getOrdersLineItemMap(session, earliest);

  // Fetch all product costs for this store once
  const { data: costs } = await supabase
    .from('product_costs')
    .select('shopify_variant_id, unit_cost')
    .eq('store_id', storeId);

  const costMap = new Map((costs ?? []).map(c => [c.shopify_variant_id, Number(c.unit_cost)]));

  // Match each unmatched order against the in-memory maps — no more API calls
  const updates = [];
  for (const order of unmatched) {
    if (!order.order_ref_number) continue;
    const lineItems = lineItemMap.get(`#${order.order_ref_number}`);
    if (!lineItems?.length) continue;

    let cogsTotal = 0;
    let allMatched = true;
    for (const item of lineItems) {
      const unitCost = costMap.get(item.variant_id);
      if (unitCost != null) {
        cogsTotal += unitCost * item.quantity;
      } else {
        allMatched = false;
      }
    }

    updates.push({ tracking_number: order.tracking_number, cogsTotal, allMatched });
  }

  // Write all updates to the DB
  for (const u of updates) {
    await supabase
      .from('orders')
      .update({ cogs_total: u.cogsTotal, cogs_matched: u.allMatched })
      .eq('store_id', storeId)
      .eq('tracking_number', u.tracking_number);
  }
}
