import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { sessionStorage } from "../shopify.server";
import {
  fabricateDemoDataForDates,
  datesBetween,
} from "../lib/demo-fabricator.server.js";
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

function ymdOf(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function tick(request: Request) {
  if (request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  // Reseed mode: wipe + regenerate the requested window (default 90d) for
  // either one named store (?shop=…) or all demo stores. Use after
  // changing fabrication parameters so existing demos pick up the new math.
  const reseed = url.searchParams.get("reseed") === "1";
  const targetShop = url.searchParams.get("shop");
  const reseedDays = Number(url.searchParams.get("days") ?? 90);

  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Build the store list. In reseed mode the targetShop param can scope to
  // one store; we still verify it's marked is_demo so we never wipe a real
  // merchant's data by accident.
  let storesQuery = adminClient.from("stores").select("store_id").eq("is_demo", true);
  if (targetShop) storesQuery = storesQuery.eq("store_id", targetShop);
  const { data: stores } = await storesQuery;

  if (!stores?.length) return json({ ticked: 0, total: 0, mode: reseed ? "reseed" : "tick" });

  const todayPkt = formatPKTDate(getTodayPKT().start);
  const reseedDates = reseed
    ? datesBetween(
        ymdOf(new Date(Date.now() - (reseedDays - 1) * 24 * 60 * 60 * 1000)),
        ymdOf(new Date())
      )
    : null;

  let ticked = 0;
  let totalOrders = 0;
  let errors = 0;

  for (const store of stores) {
    try {
      const offlineSession = await sessionStorage.loadSession(`offline_${store.store_id}`);
      if (!offlineSession) {
        console.warn(`[demo-tick] no offline session for ${store.store_id}, skipping`);
        continue;
      }
      const supabase = await getSupabaseForStore(store.store_id);

      // Reseed: wipe existing fabricated data so the new params take effect.
      // The is_demo guard above means this can never touch a real merchant.
      if (reseed) {
        await supabase.from("orders").delete().eq("store_id", store.store_id);
        await supabase.from("ad_spend").delete().eq("store_id", store.store_id);
      }

      const result = await fabricateDemoDataForDates({
        supabase,
        storeId: store.store_id,
        session: offlineSession,
        dates: reseedDates ?? [todayPkt],
      });
      totalOrders += result.ordersInserted;
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

  return json({
    mode: reseed ? "reseed" : "tick",
    ticked,
    total: stores.length,
    totalOrders,
    errors,
    day: todayPkt,
    reseedDays: reseed ? reseedDays : undefined,
  });
}

export const action = async ({ request }: ActionFunctionArgs) => tick(request);
export const loader = async ({ request }: LoaderFunctionArgs) => tick(request);
