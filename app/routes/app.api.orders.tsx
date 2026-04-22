import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";

// Resource route — returns JSON, no component. Called by DrillDownTable via useFetcher.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  const fromDate = url.searchParams.get("fromDate") ?? "";
  const toDate = url.searchParams.get("toDate") ?? "";
  const statusFilter = url.searchParams.get("statusFilter") ?? "all";
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const limit = 50;

  const supabase = await getSupabaseForStore(shop);
  const { data: orders } = await supabase.rpc("get_orders_for_period", {
    p_store_id: shop,
    p_from_date: fromDate,
    p_to_date: toDate,
    p_status_filter: statusFilter,
    p_limit: limit,
    p_offset: offset,
  });

  return json({
    orders: orders ?? [],
    hasMore: (orders?.length ?? 0) === limit,
    offset,
  });
};
