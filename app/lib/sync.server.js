import { fetchOrders, mapOrder } from './postex.server.js';
import { getOrderByName } from './shopify.server.js';
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
// Called fire-and-forget from onboarding step 3 after product costs are saved.
export async function retroactiveCOGSMatch(supabase, storeId, session) {
  const { data: unmatched } = await supabase
    .from('orders')
    .select('order_ref_number, tracking_number')
    .eq('cogs_matched', false);

  if (!unmatched?.length) return;

  // Sequential to avoid Shopify rate limits
  for (const order of unmatched) {
    await matchCOGS(
      supabase,
      storeId,
      session,
      order.order_ref_number,
      order.tracking_number
    );
  }
}
