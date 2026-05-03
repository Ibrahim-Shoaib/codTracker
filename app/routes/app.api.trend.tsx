import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import {
  getTodayPKT,
  formatPKTDate,
} from "../lib/dates.server.js";

// Resource route the dashboard uses to swap the trend chart's window without
// reloading the whole page. Same payload shape as the loader's initial fetch
// in app._index.tsx so the chart component is agnostic to the source.
//
// Query params:
//   ?days=7|30|90        rolling window ending today (PKT)
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   explicit range
// Either the days form or the from/to form must be present.

const ALLOWED_DAY_WINDOWS = new Set([7, 30, 90]);
// Hard guard against a merchant tabbing through the URL bar with a giant
// range — 366 days covers a full year of comparison while keeping payloads
// bounded (a year is ~365 rows × ~10 numbers ≈ a few KB).
const MAX_RANGE_DAYS = 366;

function ymd(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function isYmd(s: string | null): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  let from: string;
  let to: string;

  const daysParam = url.searchParams.get("days");
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  if (daysParam) {
    const days = Number(daysParam);
    if (!ALLOWED_DAY_WINDOWS.has(days)) {
      return json({ error: "invalid_days" }, { status: 400 });
    }
    const today = getTodayPKT();
    to = formatPKTDate(today.start);
    const start = new Date(today.start);
    // Inclusive: a 7-day window ending today covers today + 6 prior days
    start.setUTCDate(start.getUTCDate() - (days - 1));
    from = ymd(start);
  } else if (isYmd(fromParam) && isYmd(toParam)) {
    if (fromParam > toParam) {
      return json({ error: "from_after_to" }, { status: 400 });
    }
    const fd = new Date(`${fromParam}T00:00:00Z`);
    const td = new Date(`${toParam}T00:00:00Z`);
    const lengthDays = Math.round((td.getTime() - fd.getTime()) / 86_400_000) + 1;
    if (lengthDays > MAX_RANGE_DAYS) {
      return json({ error: "range_too_large" }, { status: 400 });
    }
    from = fromParam;
    to = toParam;
  } else {
    return json({ error: "missing_range" }, { status: 400 });
  }

  const supabase = await getSupabaseForStore(shop);

  // Mirror the dashboard's expense math so chart numbers reconcile with cards
  const { data: expensesList } = await supabase
    .from("store_expenses")
    .select("amount, type")
    .eq("store_id", shop);
  const exps = expensesList ?? [];
  const monthlyExp = exps
    .filter((e: any) => e.type === "monthly")
    .reduce((s: number, e: any) => s + Number(e.amount), 0);
  const perOrderExp = exps
    .filter((e: any) => e.type === "per_order")
    .reduce((s: number, e: any) => s + Number(e.amount), 0);

  const { data, error } = await (supabase as any).rpc("get_daily_series", {
    p_store_id: shop,
    p_from_date: from,
    p_to_date: to,
    p_monthly_expenses: monthlyExp,
    p_per_order_expenses: perOrderExp,
  });

  if (error) {
    console.error("[api.trend] get_daily_series failed:", error);
    return json({ error: "rpc_failed" }, { status: 500 });
  }

  return json({ from, to, series: data ?? [] });
};
