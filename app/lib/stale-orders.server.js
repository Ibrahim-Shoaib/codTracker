// Sweeps orders that PostEx will never update again because they sit outside
// the rolling 20-day sync window. Two passes:
//
//   1. Booked older than 20 days → flip to Cancelled and clear in_transit.
//      PostEx only revisits the last 20 days, so a still-Booked order beyond
//      that window is effectively abandoned and shouldn't count as in-transit.
//
//   2. Repair flags on already-Cancelled / Unbooked / Transferred rows that
//      were ingested before the mapper learned those statuses are terminal.
//      They currently carry is_in_transit=true, which inflates the in-transit
//      bucket. This pass only touches rows whose flags need fixing.
//
// Idempotent: only flips eligible rows. Safe to call after every sync.

const STALE_DAYS = 20;
const CANCELLED_TERMINAL_STATUSES = ['Cancelled', 'Unbooked', 'Transferred'];

export async function cancelStaleBooked(supabase, storeId) {
  const cutoffISO = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const nowISO = new Date().toISOString();

  const { data: flipped, error: flipErr } = await supabase
    .from('orders')
    .update({
      transaction_status: 'Cancelled',
      is_in_transit: false,
      is_delivered: false,
      is_returned: false,
      updated_at: nowISO,
    })
    .eq('store_id', storeId)
    .eq('transaction_status', 'Booked')
    .lt('transaction_date', cutoffISO)
    .select('tracking_number');

  if (flipErr) {
    console.error(`[cancelStaleBooked ${storeId}] flip Booked→Cancelled failed:`, flipErr);
    throw flipErr;
  }

  const { data: repaired, error: repairErr } = await supabase
    .from('orders')
    .update({
      is_in_transit: false,
      is_delivered: false,
      is_returned: false,
      updated_at: nowISO,
    })
    .eq('store_id', storeId)
    .in('transaction_status', CANCELLED_TERMINAL_STATUSES)
    .eq('is_in_transit', true)
    .select('tracking_number');

  if (repairErr) {
    console.error(`[cancelStaleBooked ${storeId}] flag repair failed:`, repairErr);
    throw repairErr;
  }

  const result = {
    staleCancelled: flipped?.length ?? 0,
    flagsRepaired: repaired?.length ?? 0,
  };

  if (result.staleCancelled || result.flagsRepaired) {
    console.log(
      `[cancelStaleBooked ${storeId}] flipped ${result.staleCancelled} stale Booked → Cancelled, ` +
      `repaired ${result.flagsRepaired} mis-flagged terminal rows`
    );
  }

  return result;
}
