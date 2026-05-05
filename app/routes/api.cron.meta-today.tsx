import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { fetchSpendInStoreCurrency, isTokenExpired } from "../lib/meta.server.js";
import { getTodayPKT, formatPKTDate } from "../lib/dates.server.js";

// Railway cron: 0 */2 * * * (UTC) = every 2 hours
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: stores } = await adminClient
    .from("stores")
    .select("store_id, meta_access_token, meta_ad_account_id, meta_token_expires_at, currency, meta_ad_account_currency")
    .not("meta_access_token", "is", null)
    // Demo stores complete real Meta OAuth (so the connected-account UX is
    // intact) but their ad_spend is fabricated — never query Meta for them.
    .neq("is_demo", true);

  if (!stores?.length) {
    return json({ synced: 0, skipped: 0, errors: 0 });
  }

  const today = getTodayPKT();
  const todayStr = formatPKTDate(today.start);

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const store of stores) {
    if (isTokenExpired(store.meta_token_expires_at)) {
      // Stored expiry says the token is dead — surface this to the merchant
      // the same way as a runtime auth failure so the dashboard banner appears.
      await adminClient
        .from("stores")
        .update({ meta_sync_error: "Meta token expired. Reconnect to resume sync." })
        .eq("store_id", store.store_id);
      skipped++;
      continue;
    }
    try {
      // Convert from ad-account currency to store currency at ingest
      // time. Identity passthrough when they match (typical PKR-on-PKR
      // case); FX-converted via fx.server.js when they differ.
      const amount = await fetchSpendInStoreCurrency({
        accessToken: store.meta_access_token,
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
      // Success — clear any prior error so the disconnected banner disappears.
      await adminClient
        .from("stores")
        .update({
          last_meta_sync_at: new Date().toISOString(),
          meta_sync_error:   null,
        })
        .eq("store_id", store.store_id);
      synced++;
    } catch (err: any) {
      const message = (err?.message ?? String(err)).replace(/^Meta fetchSpend failed:\s*/, "");
      console.error(`Meta today sync failed for ${store.store_id}:`, err);
      await adminClient
        .from("stores")
        .update({ meta_sync_error: message })
        .eq("store_id", store.store_id);
      errors++;
    }
  }

  return json({ synced, skipped, errors });
};
