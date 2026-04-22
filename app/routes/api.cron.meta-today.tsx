import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { fetchSpend, isTokenExpired } from "../lib/meta.server.js";
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
    .select("store_id, meta_access_token, meta_ad_account_id, meta_token_expires_at")
    .not("meta_access_token", "is", null);

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
      skipped++;
      continue;
    }
    try {
      const amount = await fetchSpend(
        store.meta_access_token,
        store.meta_ad_account_id,
        todayStr,
        todayStr
      );
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
      await adminClient
        .from("stores")
        .update({ last_meta_sync_at: new Date().toISOString() })
        .eq("store_id", store.store_id);
      synced++;
    } catch (err) {
      console.error(`Meta today sync failed for ${store.store_id}:`, err);
      errors++;
    }
  }

  return json({ synced, skipped, errors });
};
