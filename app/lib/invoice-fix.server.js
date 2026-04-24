const API_VERSION = '2025-10';

// Fixes orders where invoice_payment = 0 by looking up the real amount in Shopify.
// Safe matching rules — ALL three must hold:
//   1. order_ref_number appears exactly once across the store's orders (unique = real Shopify ref)
//   2. Shopify finds an order with that name
//   3. Customer name matches exactly (case-insensitive)
export async function fixZeroInvoicePayments(supabase, storeId, session) {
  // Step 1: all zero-invoice orders with a ref number
  const { data: candidates } = await supabase
    .from('orders')
    .select('tracking_number, order_ref_number, customer_name')
    .eq('store_id', storeId)
    .eq('invoice_payment', 0)
    .not('order_ref_number', 'is', null);

  if (!candidates?.length) return { checked: 0, unique: 0, updated: 0 };

  // Step 2: count how many times each ref appears across ALL orders for this store
  const refs = [...new Set(candidates.map(c => c.order_ref_number))];
  const { data: allWithRefs } = await supabase
    .from('orders')
    .select('order_ref_number')
    .eq('store_id', storeId)
    .in('order_ref_number', refs);

  const refCount = {};
  for (const row of allWithRefs ?? []) {
    refCount[row.order_ref_number] = (refCount[row.order_ref_number] || 0) + 1;
  }

  // Step 3: keep only candidates whose ref is unique across the entire orders table
  const unique = candidates.filter(c => refCount[c.order_ref_number] === 1);
  if (!unique.length) return { checked: candidates.length, unique: 0, updated: 0 };

  const { shop, accessToken } = session;
  let updated = 0;

  for (const order of unique) {
    try {
      const res = await fetch(
        `https://${shop}/admin/api/${API_VERSION}/orders.json?name=${encodeURIComponent('#' + order.order_ref_number)}&status=any&fields=total_price,billing_address,shipping_address,customer`,
        { headers: { 'X-Shopify-Access-Token': accessToken } }
      );
      if (!res.ok) continue;
      const { orders } = await res.json();
      if (!orders?.length) continue;

      const so = orders[0];
      const shopifyTotal = parseFloat(so.total_price ?? '0');
      if (shopifyTotal <= 0) continue;

      // Resolve customer name from Shopify (billing → shipping → customer object)
      const shopifyName = (
        so.billing_address?.name ||
        so.shipping_address?.name ||
        `${so.customer?.first_name ?? ''} ${so.customer?.last_name ?? ''}`.trim()
      ).toLowerCase().trim();

      const dbName = (order.customer_name ?? '').toLowerCase().trim();

      if (!shopifyName || !dbName || shopifyName !== dbName) continue;

      await supabase
        .from('orders')
        .update({ invoice_payment: shopifyTotal })
        .eq('store_id', storeId)
        .eq('tracking_number', order.tracking_number);

      updated++;
    } catch (err) {
      console.error(`fixZeroInvoicePayments: ref ${order.order_ref_number} failed:`, err);
    }
  }

  return { checked: candidates.length, unique: unique.length, updated };
}
