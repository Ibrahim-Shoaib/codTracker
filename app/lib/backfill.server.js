import { fetchOrders, mapOrder } from './postex.server.js';
import { fetchDailySpendInStoreCurrency, fetchSpendInStoreCurrency } from './meta.server.js';
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

// ─── Foolproof entry point ───────────────────────────────────────────────
//
// Call this on ANY save of a Meta connection — onboarding step 2, settings
// meta_save, future paths. It:
//
//   1. Introspects existing ad_spend for the store (row count + latest
//      spend_date). Logs it so ops can see what state a store was in when
//      the merchant reconnected.
//   2. Fetches TODAY's spend synchronously (~1 s, one Meta API call) and
//      upserts it, so the dashboard KPI card shows the number seconds after
//      the merchant clicks Save. Without this, they'd wait up to 2 hours
//      for the meta-today cron.
//   3. Fires the full 90-day historical backfill fire-and-forget. Backfill
//      is idempotent (upsert on store_id,spend_date), so calling this on
//      an already-populated store just fills any gaps left by earlier
//      cron failures / disconnect windows.
//
// Demo stores are skipped — their ad_spend is fabricated separately.
//
// Errors never propagate: today-sync failure is logged and the historical
// still runs; historical-fire failure is caught by the outer .catch(). The
// idea is that the merchant's Save click never fails because of a Meta API
// hiccup.
export async function bootstrapMetaConnection({ store_id, access_token, ad_account_id }) {
  const supabase = await getSupabaseForStore(store_id);

  const { data: storeRow } = await supabase
    .from('stores')
    .select('is_demo, currency, meta_ad_account_currency')
    .eq('store_id', store_id)
    .single();

  if (storeRow?.is_demo) {
    console.log(`[bootstrapMeta] ${store_id}: skip — demo store (fabricated ad_spend)`);
    return { skipped: 'demo' };
  }

  // 1. Introspect. Gives log + return-value visibility into what was
  //    already in storage vs what this call is about to add.
  const [{ count }, { data: latest }] = await Promise.all([
    supabase.from('ad_spend').select('id', { count: 'exact', head: true }).eq('store_id', store_id),
    supabase.from('ad_spend').select('spend_date').eq('store_id', store_id)
      .order('spend_date', { ascending: false }).limit(1),
  ]);
  const rowsBefore = count ?? 0;
  const latestExisting = latest?.[0]?.spend_date ?? null;

  console.log(
    `[bootstrapMeta] ${store_id}: existing ad_spend rows=${rowsBefore}, ` +
    `latest existing spend_date=${latestExisting ?? 'none'}`
  );

  // 2. Instant today sync. Blocking so the merchant sees a real KPI number
  //    within seconds. Errors are swallowed — historical still fires.
  const storeCurrency = storeRow?.currency ?? 'PKR';
  const accountCurrency = storeRow?.meta_ad_account_currency ?? null;
  const today = todayPKT();
  let todayStatus = 'skipped';
  let todayAmount = null;
  try {
    todayAmount = await fetchSpendInStoreCurrency({
      accessToken: access_token,
      adAccountId: ad_account_id,
      sinceDate: today,
      untilDate: today,
      accountCurrency,
      storeCurrency,
    });
    await supabase.from('ad_spend').upsert(
      {
        store_id,
        spend_date: today,
        amount: todayAmount,
        source: 'meta',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'store_id,spend_date' }
    );
    await supabase.from('stores').update({
      last_meta_sync_at: new Date().toISOString(),
      meta_sync_error: null,
    }).eq('store_id', store_id);
    todayStatus = 'synced';
    console.log(`[bootstrapMeta] ${store_id}: today (${today}) = ${todayAmount} ${storeCurrency}`);
  } catch (err) {
    console.error(`[bootstrapMeta] ${store_id}: today sync failed:`, err?.message ?? err);
    todayStatus = 'error';
  }

  // 3. Full 90-day historical backfill, fire-and-forget. Idempotent via
  //    (store_id, spend_date) upsert — safe on first connect, reconnect,
  //    or account switch.
  runMetaHistoricalBackfill({ store_id, access_token, ad_account_id })
    .catch(err => console.error(`[bootstrapMeta] ${store_id}: historical backfill failed:`, err));

  return {
    rows_before: rowsBefore,
    latest_existing: latestExisting,
    today: todayStatus,
    today_amount: todayAmount,
    historical: 'started',
  };
}
