// Replacement for fetchUnfulfilledPipeline (Shopify Admin API call) for
// stores marked is_demo. Same return shape, but bucketizes the in-transit
// fabricated orders out of our own DB so the dashboard never hits Shopify
// for a demo store. Internally consistent: the value the pills show always
// matches the rows that drive the rest of the dashboard.
//
// Returns: { today: { count, value }, yesterday: …, mtd: …, lastMonth: … }
// or null on error (caller already handles null gracefully).

export async function fetchDemoPipeline(supabase, storeId, ranges) {
  if (!ranges) return null;
  // Use the widest envelope across all four ranges as the SQL filter so we
  // make a single round trip, then bucket in JS — same approach as the real
  // Shopify pipeline helper.
  const fromFloor = Object.values(ranges).reduce(
    (min, r) => (r.from < min ? r.from : min),
    '9999-12-31'
  );
  const toCeiling = Object.values(ranges).reduce(
    (max, r) => (r.to > max ? r.to : max),
    '0000-01-01'
  );

  const { data, error } = await supabase
    .from('orders')
    .select('transaction_date, invoice_payment')
    .eq('store_id', storeId)
    .eq('is_in_transit', true)
    .gte('transaction_date', `${fromFloor}T00:00:00+05:00`)
    .lte('transaction_date', `${toCeiling}T23:59:59+05:00`);

  if (error) {
    console.error('[demo-pipeline] query failed:', error);
    return null;
  }

  const buckets = {
    today:     { count: 0, value: 0 },
    yesterday: { count: 0, value: 0 },
    mtd:       { count: 0, value: 0 },
    lastMonth: { count: 0, value: 0 },
  };

  for (const row of data ?? []) {
    // transaction_date comes back as an ISO string in UTC. We compare on
    // PKT calendar dates — shift the timestamp to PKT then take YYYY-MM-DD.
    const t = new Date(row.transaction_date);
    const pktMs = t.getTime() + 5 * 60 * 60 * 1000;
    const pkt = new Date(pktMs);
    const ymd = `${pkt.getUTCFullYear()}-${String(pkt.getUTCMonth() + 1).padStart(2, '0')}-${String(pkt.getUTCDate()).padStart(2, '0')}`;
    const amount = Number(row.invoice_payment) || 0;
    for (const [key, range] of Object.entries(ranges)) {
      if (ymd >= range.from && ymd <= range.to) {
        buckets[key].count += 1;
        buckets[key].value += amount;
      }
    }
  }

  return buckets;
}
