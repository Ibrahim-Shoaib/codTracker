import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");

  if (!from || !to) return json({ stats: null });

  const supabase = await getSupabaseForStore(shop);
  const { data: expensesList } = await supabase
    .from("store_expenses")
    .select("id, name, amount, type")
    .eq("store_id", shop);

  const expenses    = expensesList ?? [];
  const monthlyExp  = expenses.filter((e: any) => e.type === "monthly")
    .reduce((s: number, e: any) => s + Number(e.amount), 0);
  const perOrderExp = expenses.filter((e: any) => e.type === "per_order")
    .reduce((s: number, e: any) => s + Number(e.amount), 0);

  const { data } = await (supabase as any).rpc("get_dashboard_stats", {
    p_store_id:           shop,
    p_from_date:          from,
    p_to_date:            to,
    p_monthly_expenses:   monthlyExp,
    p_per_order_expenses: perOrderExp,
    p_days_in_period:     1,
  });

  return json({ stats: data?.[0] ?? null });
};
