// Replacement for fetchUnfulfilledPipeline (Shopify Admin API call) for
// stores marked is_demo. Same return shape, but never hits Shopify.
//
// Conceptually different from the dashboard's in_transit_value pill:
//   * Unfulfilled (this helper) = orders sitting in Shopify that the
//     merchant hasn't sent to PostEx yet. Real merchants only see this
//     for *today's* orders — anything older has already been processed.
//   * In Transit (stats.in_transit_value, computed by get_dashboard_stats)
//     = orders shipped via PostEx that haven't yet been delivered/returned.
//     Spans the full 14-day in-transit window.
//
// So: only the Today bucket is non-zero here; yesterday / MTD / last month
// are always 0. The number we surface for Today is a small fraction
// (~25%) of today's fabricated in-transit volume — it represents the
// portion still "queued in Shopify" instead of "out with PostEx".
//
// Returns: { today: { count, value }, yesterday: …, mtd: …, lastMonth: … }
// or null on error (caller already handles null gracefully).

const UNFULFILLED_FRACTION_OF_TODAY = 0.25;

export async function fetchDemoPipeline(supabase, storeId, ranges) {
  if (!ranges) return null;

  const empty = {
    today:     { count: 0, value: 0 },
    yesterday: { count: 0, value: 0 },
    mtd:       { count: 0, value: 0 },
    lastMonth: { count: 0, value: 0 },
  };

  const todayRange = ranges.today;
  if (!todayRange) return empty;

  // Today's in-transit orders — the universe we draw the unfulfilled
  // sample from. Single round-trip, scoped to a single PKT day.
  const { data, error } = await supabase
    .from('orders')
    .select('invoice_payment')
    .eq('store_id', storeId)
    .eq('is_in_transit', true)
    .gte('transaction_date', `${todayRange.from}T00:00:00+05:00`)
    .lte('transaction_date', `${todayRange.to}T23:59:59+05:00`);

  if (error) {
    console.error('[demo-pipeline] query failed:', error);
    return null;
  }

  const rows = data ?? [];
  const totalCount = rows.length;
  const totalValue = rows.reduce((s, r) => s + (Number(r.invoice_payment) || 0), 0);

  return {
    ...empty,
    today: {
      count: Math.round(totalCount * UNFULFILLED_FRACTION_OF_TODAY),
      value: Math.round(totalValue * UNFULFILLED_FRACTION_OF_TODAY),
    },
  };
}
