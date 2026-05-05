import { fetchOrders, mapOrder } from './postex.server.js';
import { fetchDailySpendInStoreCurrency } from './meta.server.js';
import { getSupabaseForStore } from './supabase.server.js';
import { enrichOrdersWithShopify, loadOfflineSession } from './enrich.server.js';
import { cancelStaleBooked } from './stale-orders.server.js';

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

  // Sweep historical Booked orders that are already past the rolling 20-day
  // window — PostEx will never update them again. Also repair flags on any
  // Cancelled/Unbooked/Transferred rows whose is_in_transit is still true.
  await cancelStaleBooked(supabase, store_id).catch(err => {
    console.error(`Backfill stale-Booked sweep failed for ${store_id}:`, err.message ?? err);
  });

  // ---- Shopify line-items enrichment for the full lifetime we just pulled ----
  // For new customers this runs immediately after onboarding step 1. There
  // are no costs yet (step 3 is later) so we don't trigger COGS rematch here;
  // the matcher will use the populated line_items the first time the
  // merchant saves costs in step 3.
  //
  // Marks line_items_backfilled_at so the cron doesn't re-run the historical
  // pass for this store.
  try {
    const session = await loadOfflineSession(store_id);
    if (session) {
      const enrichResult = await enrichOrdersWithShopify({
        supabase,
        storeId: store_id,
        session,
        sinceISO: null, // full lifetime
      });
      console.log(
        `Backfill enrichment for ${store_id}: ` +
        `${enrichResult.enriched} of ${enrichResult.considered} orders enriched` +
        (enrichResult.skipped ? ` (skipped: ${enrichResult.skipped})` : '')
      );
    } else {
      console.log(`Backfill enrichment for ${store_id}: no offline session — skipping`);
    }
  } catch (err) {
    // Never block onboarding on enrichment failure. The cron's one-shot path
    // will retry on next tick (the flag won't be set if we throw before the
    // update below).
    console.error(`Backfill enrichment for ${store_id} failed:`, err.message ?? err);
    return;
  }

  await supabase
    .from('stores')
    .update({ line_items_backfilled_at: new Date().toISOString() })
    .eq('store_id', store_id);
}

// Pulls Meta ad spend history backwards in 60-day chunks.
// Stops after 2 consecutive empty chunks — signals start of merchant's ad history.
// Errors are retried once with backoff; after that they abort the run rather than masquerade
// as 'history ended' (which would leave a partial backfill and a stale last_meta_sync_at).
// Fire-and-forget: called without await when Meta account is connected.
export async function runMetaHistoricalBackfill({ store_id, access_token, ad_account_id }) {
  const supabase = await getSupabaseForStore(store_id);

  // Look up the FX context once. Used by fetchDailySpendInStoreCurrency
  // to convert when account currency differs from store currency.
  const { data: storeRow } = await supabase
    .from('stores')
    .select('currency, meta_ad_account_currency')
    .eq('store_id', store_id)
    .single();
  const storeCurrency = storeRow?.currency ?? 'PKR';
  const accountCurrency = storeRow?.meta_ad_account_currency ?? null;

  let end = todayPKT();
  let start = subtractDays(end, CHUNK_DAYS - 1);
  let consecutiveEmpty = 0;
  let totalDays = 0;
  let totalChunks = 0;
  let aborted = false;

  while (true) {
    let daily = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        daily = await fetchDailySpendInStoreCurrency({
          accessToken: access_token,
          adAccountId: ad_account_id,
          sinceDate: start,
          untilDate: end,
          accountCurrency,
          storeCurrency,
        });
        break;
      } catch (err) {
        console.error(`Meta backfill chunk ${start}–${end} attempt ${attempt + 1} failed for ${store_id}:`, err);
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    if (daily === null) {
      console.error(`Meta backfill aborted at chunk ${start}–${end} for ${store_id} after retries`);
      aborted = true;
      break;
    }

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
      const { error: upsertErr } = await supabase
        .from('ad_spend')
        .upsert(rows, { onConflict: 'store_id,spend_date' });
      if (upsertErr) {
        console.error(`Meta backfill upsert failed at chunk ${start}–${end} for ${store_id}:`, upsertErr);
        aborted = true;
        break;
      }
      totalDays += daily.length;
    }

    end   = subtractDays(start, 1);
    start = subtractDays(end, CHUNK_DAYS - 1);
  }

  // Only stamp last_meta_sync_at on a clean run, so an aborted backfill is visible/retriable.
  if (!aborted) {
    await supabase
      .from('stores')
      .update({ last_meta_sync_at: new Date().toISOString() })
      .eq('store_id', store_id);
  }

  console.log(`Meta backfill ${aborted ? 'aborted' : 'done'} for ${store_id}: ${totalDays} days across ${totalChunks} chunks`);
}
