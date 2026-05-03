import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { effectiveStoreId } from "../lib/demo-pool.server.js";

// Powers the city panel's date-range refetches. Same shape as the
// initial loader payload so the panel can drop the response straight
// into state.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url  = new URL(request.url);
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");

  if (!from || !to) return json({ cities: [] });

  const supabase = await getSupabaseForStore(shop);

  // Demo stores read from the shared pool — same swap the dashboard
  // loader does so custom date refetches return real data.
  const { data: storeRow } = await supabase
    .from("stores")
    .select("is_demo")
    .eq("store_id", shop)
    .single();
  const dataStoreId = effectiveStoreId(storeRow ?? null, shop);

  const { data } = await (supabase as any).rpc("get_city_breakdown", {
    p_store_id:  dataStoreId,
    p_from_date: from,
    p_to_date:   to,
  });

  return json({ cities: data ?? [] });
};
