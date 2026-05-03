import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { sessionStorage } from "../shopify.server";
import { fabricateDemoDataForDates } from "../lib/demo-fabricator.server.js";
import { getTodayPKT, formatPKTDate } from "../lib/dates.server.js";

// Daily cron: keeps every is_demo store's data rolling forward by appending
// "today" each day. Idempotent — calling this multiple times in one day is
// a no-op for any day that already has orders, so safe to retry / re-fire.
//
// Recommended Railway schedule: 0 4 * * *  (UTC = 9 AM PKT). Pick any time
// — there's no data race, the per-day idempotency check ensures we never
// double-insert.
//
// Auth: same x-cron-secret pattern as the other crons.
//
// Accepts both POST (cron) and GET (manual debug) so you can hit the URL
// from a browser when iterating locally.

async function tick(request: Request) {
  if (request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: stores } = await adminClient
    .from("stores")
    .select("store_id")
    .eq("is_demo", true);

  if (!stores?.length) return json({ ticked: 0, total: 0 });

  const todayPkt = formatPKTDate(getTodayPKT().start);

  let ticked = 0;
  let totalOrders = 0;
  let errors = 0;

  for (const store of stores) {
    try {
      // Fabricator needs a Shopify session to read the merchant's catalog.
      // If the offline session is gone (uninstalled but row not yet purged)
      // skip cleanly.
      const offlineSession = await sessionStorage.loadSession(`offline_${store.store_id}`);
      if (!offlineSession) {
        console.warn(`[demo-tick] no offline session for ${store.store_id}, skipping`);
        continue;
      }
      const supabase = await getSupabaseForStore(store.store_id);
      const result = await fabricateDemoDataForDates({
        supabase,
        storeId: store.store_id,
        session: offlineSession,
        dates: [todayPkt],
      });
      totalOrders += result.ordersInserted;
      // Stamp last_postex_sync_at so the dashboard's "Syncing…" empty-state
      // logic stays happy even after the initial seed expires from view.
      await adminClient
        .from("stores")
        .update({ last_postex_sync_at: new Date().toISOString() })
        .eq("store_id", store.store_id);
      ticked++;
    } catch (err) {
      console.error(`[demo-tick ${store.store_id}] failed:`, err);
      errors++;
    }
  }

  return json({ ticked, total: stores.length, totalOrders, errors, day: todayPkt });
}

export const action = async ({ request }: ActionFunctionArgs) => tick(request);
export const loader = async ({ request }: LoaderFunctionArgs) => tick(request);
