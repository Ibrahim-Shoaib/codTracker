import type { ActionFunctionArgs } from "@remix-run/node";
import { verifyCronSecret } from "../lib/cron-auth.server.js";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import {
  fetchSpendInStoreCurrency,
  isTokenExpired,
  isTokenExpiringSoon,
  refreshLongLivedToken,
} from "../lib/meta.server.js";
import { getToday, formatDate } from "../lib/dates.server.js";
import { decryptMaybe, encryptSecret } from "../lib/crypto.server.js";

const CONCURRENCY = 5;

// Railway cron: 0 */2 * * * (UTC) = every 2 hours
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!verifyCronSecret(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: stores } = await adminClient
    .from("stores")
    .select("store_id, meta_access_token, meta_ad_account_id, meta_token_expires_at, currency, meta_ad_account_currency, timezone")
    .not("meta_access_token", "is", null)
    // Demo stores complete real Meta OAuth (so the connected-account UX is
    // intact) but their ad_spend is fabricated — never query Meta for them.
    .neq("is_demo", true);

  if (!stores?.length) {
    return json({ synced: 0, skipped: 0, errors: 0 });
  }

  let synced = 0;
  let skipped = 0;
  let errors = 0;
  let refreshed = 0;

  async function syncOne(store: any): Promise<"synced" | "skipped"> {
    if (isTokenExpired(store.meta_token_expires_at)) {
      // Stored expiry says the token is dead — surface this to the merchant
      // the same way as a runtime auth failure so the dashboard banner appears.
      await adminClient
        .from("stores")
        .update({ meta_sync_error: "Meta token expired. Reconnect to resume sync." })
        .eq("store_id", store.store_id);
      return "skipped";
    }

    // Tokens may be encrypted at rest (new writes) or legacy plaintext.
    let accessToken = decryptMaybe(store.meta_access_token);

    // Auto-refresh: a long-lived token inside its last 7 days can be
    // re-exchanged for a fresh ~60-day one without merchant interaction.
    // Best-effort — on failure we proceed with the current (still valid)
    // token, and the expiry banner remains the safety net.
    if (isTokenExpiringSoon(store.meta_token_expires_at)) {
      try {
        const { access_token, expires_in } = await refreshLongLivedToken(accessToken);
        if (access_token) {
          accessToken = access_token;
          await adminClient
            .from("stores")
            .update({
              meta_access_token: encryptSecret(access_token),
              meta_token_expires_at: new Date(
                Date.now() + (Number(expires_in) || 5_184_000) * 1000
              ).toISOString(),
            })
            .eq("store_id", store.store_id);
          refreshed++;
        }
      } catch (err) {
        console.warn(`Meta token refresh failed for ${store.store_id}:`, err);
      }
    }

    // "Today" in the store's own timezone — Meta's time_range is
    // interpreted in the ad account's local day, so a UK store must ask
    // for the London day, not PKT.
    const todayStr = formatDate(getToday(store.timezone ?? "Asia/Karachi").start, store.timezone ?? "Asia/Karachi");
    // Convert from ad-account currency to store currency at ingest
    // time. Identity passthrough when they match (typical PKR-on-PKR
    // case); FX-converted via fx.server.js when they differ.
    const amount = await fetchSpendInStoreCurrency({
      accessToken,
      adAccountId: store.meta_ad_account_id,
      sinceDate: todayStr,
      untilDate: todayStr,
      accountCurrency: store.meta_ad_account_currency,
      storeCurrency: store.currency,
    });
    await adminClient.from("ad_spend").upsert(
      {
        store_id:   store.store_id,
        spend_date: todayStr,
        amount,
        source:     "meta",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_id,spend_date" }
    );
    // Success — one write both clears any prior error and stamps sync time.
    await adminClient
      .from("stores")
      .update({
        last_meta_sync_at: new Date().toISOString(),
        meta_sync_error:   null,
      })
      .eq("store_id", store.store_id);
    return "synced";
  }

  // Small parallel batches — keeps the cron tick bounded as stores grow
  // without hammering Meta or Supabase with one giant burst.
  for (let i = 0; i < stores.length; i += CONCURRENCY) {
    const batch = stores.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((store) => syncOne(store)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        if (r.value === "synced") synced++;
        else skipped++;
      } else {
        const store = batch[j];
        const err: any = r.reason;
        const message = (err?.message ?? String(err)).replace(/^Meta fetchSpend failed:\s*/, "");
        console.error(`Meta today sync failed for ${store.store_id}:`, err);
        await adminClient
          .from("stores")
          .update({ meta_sync_error: message })
          .eq("store_id", store.store_id);
        errors++;
      }
    }
  }

  return json({ synced, skipped, errors, refreshed });
};
