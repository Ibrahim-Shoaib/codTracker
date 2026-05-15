import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { getPriorEqualLengthRange } from "../lib/dates.server.js";
import { effectiveStoreId } from "../lib/demo-pool.server.js";
import { maskDemoAdSpend } from "../lib/demo-ad-spend.server.js";
import { fetchUnfulfilledForRange } from "../lib/shopify-pipeline.server.js";
import { fetchDemoUnfulfilledForRange } from "../lib/demo-pipeline.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");

  if (!from || !to) return json({ stats: null, priorStats: null });

  const supabase = await getSupabaseForStore(shop);

  // Demo stores read orders/ad_spend from the shared pool — same swap
  // the dashboard loader does. Without this, custom date picks on a
  // demo store hit the merchant's own (empty) store_id and return zeros.
  const { data: storeRow } = await supabase
    .from("stores")
    .select("is_demo, meta_access_token")
    .eq("store_id", shop)
    .single();
  const dataStoreId = effectiveStoreId(storeRow ?? null, shop);

  // Equal-length immediately preceding range — same comparison rule the
  // dashboard's preset cards use, applied to whatever range the picker hands us.
  const prior = getPriorEqualLengthRange(from, to);

  // Unfulfilled pill for the selected range:
  //   * Real merchants — live Shopify call scoped to [from, to].
  //   * Demo merchants — pool query, only non-zero when today PKT is in
  //     the requested range (matches the default-card "today only" rule).
  const unfulfilledPromise = storeRow?.is_demo
    ? fetchDemoUnfulfilledForRange(supabase, dataStoreId, from, to)
    : fetchUnfulfilledForRange(session, from, to);

  const [{ data }, { data: priorData }, { data: breakdownData }, unfulfilled] = await Promise.all([
    (supabase as any).rpc("get_dashboard_stats", {
      p_store_id:         dataStoreId,
      p_from_date:        from,
      p_to_date:          to,
      p_expense_store_id: shop,
    }),
    (supabase as any).rpc("get_dashboard_stats", {
      p_store_id:         dataStoreId,
      p_from_date:        prior.from,
      p_to_date:          prior.to,
      p_expense_store_id: shop,
    }),
    (supabase as any).rpc("get_expense_breakdown", {
      p_store_id:         dataStoreId,
      p_from_date:        from,
      p_to_date:          to,
      p_expense_store_id: shop,
    }),
    unfulfilledPromise.catch((err: Error) => {
      console.error("[api.stats] unfulfilled fetch failed:", err);
      return { count: 0, value: 0 };
    }),
  ]);

  // Demo stores without a connected Meta account: zero ad_spend (and
  // recompute downstream metrics). No-op for real stores.
  const stats      = maskDemoAdSpend(data?.[0]      ?? null, storeRow);
  const priorStats = maskDemoAdSpend(priorData?.[0] ?? null, storeRow);

  return json({
    stats,
    priorStats,
    expenseBreakdown: breakdownData ?? [],
    unfulfilled,                  // { count, value } for the selected range
  });
};
