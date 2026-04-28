import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { fetchSpend, isTokenExpired } from "../lib/meta.server.js";
import { getYesterdayPKT, formatPKTDate } from "../lib/dates.server.js";

// Railway cron: 0 21 * * * (UTC) = 2 AM PKT
// Writes the authoritative final spend for yesterday after Meta closes the previous day.
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
    return json({ finalized: 0, skipped: 0, errors: 0 });
  }

  const yesterday = getYesterdayPKT();
  const yesterdayStr = formatPKTDate(yesterday.start);

  let finalized = 0;
  let skipped = 0;
  let errors = 0;

  for (const store of stores) {
    if (isTokenExpired(store.meta_token_expires_at)) {
      await adminClient
        .from("stores")
        .update({ meta_sync_error: "Meta token expired. Reconnect to resume sync." })
        .eq("store_id", store.store_id);
      skipped++;
      continue;
    }
    try {
      const amount = await fetchSpend(
        store.meta_access_token,
        store.meta_ad_account_id,
        yesterdayStr,
        yesterdayStr
      );
      await adminClient.from("ad_spend").upsert(
        {
          store_id:   store.store_id,
          spend_date: yesterdayStr,
          amount,
          source:     "meta",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "store_id,spend_date" }
      );
      await adminClient
        .from("stores")
        .update({
          last_meta_sync_at: new Date().toISOString(),
          meta_sync_error:   null,
        })
        .eq("store_id", store.store_id);
      finalized++;
    } catch (err: any) {
      const message = (err?.message ?? String(err)).replace(/^Meta fetchSpend failed:\s*/, "");
      console.error(`Meta finalize failed for ${store.store_id}:`, err);
      await adminClient
        .from("stores")
        .update({ meta_sync_error: message })
        .eq("store_id", store.store_id);
      errors++;
    }
  }

  return json({ finalized, skipped, errors });
};
