import { getMonthlyChunks } from './dates.server.js';
import { fetchOrders, mapOrder } from './postex.server.js';
import { getSupabaseForStore } from './supabase.server.js';

// Fetches all orders from Jan 1 of current year to today, chunked by month.
// Called fire-and-forget from onboarding step 1 — do NOT await at call site.
export async function runHistoricalBackfill(storeRow) {
  const supabase = await getSupabaseForStore(storeRow.store_id);
  const year = new Date().getFullYear();
  const chunks = getMonthlyChunks(`${year}-01-01`);

  for (const chunk of chunks) {
    try {
      const rawOrders = await fetchOrders(storeRow.postex_token, chunk.start, chunk.end);
      const mapped = rawOrders.map(o => mapOrder(o, storeRow.store_id));
      if (mapped.length > 0) {
        await supabase
          .from('orders')
          .upsert(mapped, { onConflict: 'store_id,tracking_number' });
      }
    } catch (err) {
      console.error(`Backfill chunk ${chunk.start}–${chunk.end} failed for ${storeRow.store_id}:`, err);
    }
  }

  // Mark backfill complete — dashboard uses last_postex_sync_at IS NULL as "still syncing" signal
  await supabase
    .from('stores')
    .update({ last_postex_sync_at: new Date().toISOString() })
    .eq('store_id', storeRow.store_id);
}
