import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { fetchDailySpend, isTokenExpired } from "../lib/meta.server.js";

// Manual trigger: POST /api/meta-backfill
// Headers: x-cron-secret, optionally x-start-date (YYYY-MM-DD), x-end-date (YYYY-MM-DD)
// Defaults to last 90 days if no dates provided.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const today = new Date();
  const defaultEnd = today.toISOString().slice(0, 10);
  const defaultStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const startDate = request.headers.get("x-start-date") ?? defaultStart;
  const endDate   = request.headers.get("x-end-date")   ?? defaultEnd;

  const { data: stores } = await adminClient
    .from("stores")
    .select("store_id, meta_access_token, meta_ad_account_id, meta_token_expires_at")
    .not("meta_access_token", "is", null);

  if (!stores?.length) {
    return json({ message: "No stores with Meta token", stores_processed: 0 });
  }

  const allResults: Array<{ store_id: string; days: number; error?: string }> = [];

  for (const store of stores) {
    if (isTokenExpired(store.meta_token_expires_at)) {
      allResults.push({ store_id: store.store_id, days: 0, error: "token_expired" });
      continue;
    }
    try {
      const daily = await fetchDailySpend(
        store.meta_access_token,
        store.meta_ad_account_id,
        startDate,
        endDate
      );

      if (daily.length > 0) {
        const rows = daily.map(d => ({
          store_id:   store.store_id,
          spend_date: d.date,
          amount:     d.spend,
          source:     "meta",
          updated_at: new Date().toISOString(),
        }));
        await adminClient
          .from("ad_spend")
          .upsert(rows, { onConflict: "store_id,spend_date" });

        await adminClient
          .from("stores")
          .update({ last_meta_sync_at: new Date().toISOString() })
          .eq("store_id", store.store_id);
      }

      allResults.push({ store_id: store.store_id, days: daily.length });
    } catch (err: any) {
      console.error(`Meta backfill failed for ${store.store_id}:`, err);
      allResults.push({ store_id: store.store_id, days: 0, error: err.message });
    }
  }

  return json({ startDate, endDate, stores_processed: allResults.length, results: allResults });
};
