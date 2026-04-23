import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { getTodayPKT, formatPKTDate, getDaysInPeriod } from "../lib/dates.server.js";

// Railway cron: 55 18 * * * (UTC) = 11:55 PM PKT
// Snapshots today's aggregated stats into daily_snapshots for % change calculations.
// These rows are never deleted.
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
    .select("store_id")
    .eq("onboarding_complete", true);

  if (!stores?.length) {
    return json({ snapshotted: 0, errors: 0 });
  }

  // Fetch all expenses for all stores in one query (service role bypasses RLS)
  const storeIds = stores.map((s) => s.store_id);
  const { data: allExpenses } = await adminClient
    .from("store_expenses")
    .select("store_id, amount, type")
    .in("store_id", storeIds);

  // Group by store: { monthly total, per_order total }
  const expByStore = new Map<string, { monthly: number; perOrder: number }>();
  for (const exp of allExpenses ?? []) {
    const cur = expByStore.get(exp.store_id) ?? { monthly: 0, perOrder: 0 };
    if (exp.type === "monthly")   cur.monthly  += Number(exp.amount);
    if (exp.type === "per_order") cur.perOrder += Number(exp.amount);
    expByStore.set(exp.store_id, cur);
  }

  const today = getTodayPKT();
  const todayStr = formatPKTDate(today.start);
  const daysInPeriod = getDaysInPeriod(today.start, today.end);

  let snapshotted = 0;
  let errors = 0;

  for (const store of stores) {
    try {
      const { monthly, perOrder } = expByStore.get(store.store_id) ?? { monthly: 0, perOrder: 0 };

      const { data: stats } = await adminClient.rpc("get_dashboard_stats", {
        p_store_id:           store.store_id,
        p_from_date:          todayStr,
        p_to_date:            todayStr,
        p_monthly_expenses:   monthly,
        p_per_order_expenses: perOrder,
        p_days_in_period:     daysInPeriod,
      });

      const s = stats?.[0];
      if (!s) {
        snapshotted++;
        continue;
      }

      await adminClient.from("daily_snapshots").upsert(
        {
          store_id:            store.store_id,
          snapshot_date:       todayStr,
          total_sales:         s.sales         ?? 0,
          total_orders:        Number(s.orders) ?? 0,
          total_units:         Number(s.units)  ?? 0,
          total_returns:       Number(s.returns) ?? 0,
          total_in_transit:    Number(s.in_transit) ?? 0,
          total_delivery_cost: s.delivery_cost ?? 0,
          total_cogs:          s.cogs          ?? 0,
          total_ad_spend:      s.ad_spend      ?? 0,
          total_expenses:      s.expenses      ?? 0,
          gross_profit:        s.gross_profit  ?? 0,
          net_profit:          s.net_profit    ?? 0,
        },
        { onConflict: "store_id,snapshot_date" }
      );
      snapshotted++;
    } catch (err) {
      console.error(`Snapshot failed for ${store.store_id}:`, err);
      errors++;
    }
  }

  return json({ snapshotted, errors });
};
