import { fetchOrders, mapOrder } from './postex.server.js';
import { fetchDailySpend } from './meta.server.js';
import { getSupabaseForStore } from './supabase.server.js';

const CHUNK_DAYS = 60;
const STOP_AFTER_EMPTY = 2;

function todayPKT() {
  const pkt = new Date(Date.now() + 5 * 60 * 60 * 1000);
  const y = pkt.getUTCFullYear();
  const m = String(pkt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(pkt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function subtractDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Pulls PostEx order history backwards in 60-day chunks.
// Stops after 2 consecutive empty chunks — signals start of merchant's PostEx history.
// Fire-and-forget: called without await during onboarding.
export async function runHistoricalBackfill({ store_id, postex_token }) {
  const supabase = await getSupabaseForStore(store_id);

  let end = todayPKT();
  let start = subtractDays(end, CHUNK_DAYS - 1);
  let consecutiveEmpty = 0;
  let totalOrders = 0;
  let totalChunks = 0;

  while (true) {
    try {
      const raw = await fetchOrders(postex_token, start, end);
      totalChunks++;

      if (raw.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= STOP_AFTER_EMPTY) break;
      } else {
        consecutiveEmpty = 0;
        const mapped = raw.map(o => mapOrder(o, store_id));
        await supabase
          .from('orders')
          .upsert(mapped, { onConflict: 'store_id,tracking_number' });
        totalOrders += raw.length;
      }
    } catch (err) {
      console.error(`Backfill chunk ${start}–${end} failed for ${store_id}:`, err);
    }

    end   = subtractDays(start, 1);
    start = subtractDays(end, CHUNK_DAYS - 1);
  }

  await supabase
    .from('stores')
    .update({ last_postex_sync_at: new Date().toISOString() })
    .eq('store_id', store_id);

  console.log(`Backfill done for ${store_id}: ${totalOrders} orders across ${totalChunks} chunks`);
}

// Pulls Meta ad spend history backwards in 60-day chunks.
// Stops after 2 consecutive empty chunks — signals start of merchant's ad history.
// Fire-and-forget: called without await when Meta account is connected.
export async function runMetaHistoricalBackfill({ store_id, access_token, ad_account_id }) {
  const supabase = await getSupabaseForStore(store_id);

  let end = todayPKT();
  let start = subtractDays(end, CHUNK_DAYS - 1);
  let consecutiveEmpty = 0;
  let totalDays = 0;
  let totalChunks = 0;

  while (true) {
    try {
      const daily = await fetchDailySpend(access_token, ad_account_id, start, end);
      totalChunks++;

      if (daily.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= STOP_AFTER_EMPTY) break;
      } else {
        consecutiveEmpty = 0;
        const rows = daily.map(d => ({
          store_id,
          spend_date: d.date,
          amount:     d.spend,
          source:     'meta',
          updated_at: new Date().toISOString(),
        }));
        await supabase
          .from('ad_spend')
          .upsert(rows, { onConflict: 'store_id,spend_date' });
        totalDays += daily.length;
      }
    } catch (err) {
      console.error(`Meta backfill chunk ${start}–${end} failed for ${store_id}:`, err);
      consecutiveEmpty++;
      if (consecutiveEmpty >= STOP_AFTER_EMPTY) break;
    }

    end   = subtractDays(start, 1);
    start = subtractDays(end, CHUNK_DAYS - 1);
  }

  await supabase
    .from('stores')
    .update({ last_meta_sync_at: new Date().toISOString() })
    .eq('store_id', store_id);

  console.log(`Meta backfill done for ${store_id}: ${totalDays} days across ${totalChunks} chunks`);
}
