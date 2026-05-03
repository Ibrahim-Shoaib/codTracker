import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import {
  getTodayPKT,
  formatPKTDate,
  getPriorEqualLengthRange,
} from "../lib/dates.server.js";

// Resource route the dashboard chart uses to swap windows without reloading.
// Returns the Shopify-style "current period vs prior equal-length period"
// payload with bucketing chosen automatically from the range size:
//   * ≤ 90 days        → day buckets
//   * ≤ 90 months      → month buckets   (~7.5 years)
//   * > 90 months      → year buckets
// Per-day granularity stays sharp for the standard 7/30/90 toggles, while
// custom multi-year ranges don't blow up the payload or overplot the chart.
//
// Query params (one of):
//   ?days=7|30|90
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD

const ALLOWED_DAY_WINDOWS = new Set([7, 30, 90]);
const MAX_RANGE_DAYS = 365 * 20; // 20 years — generous; payload is bucketed

function ymd(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function isYmd(s: string | null): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function pickGranularity(days: number): "day" | "month" | "year" {
  if (days <= 90) return "day";
  if (days <= 30 * 90) return "month"; // ≈ 90 months ≈ 7.4 years
  return "year";
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

  // Range length and prior-period bounds
  const fd = new Date(`${from}T00:00:00Z`);
  const td = new Date(`${to}T00:00:00Z`);
  const lengthDays = Math.round((td.getTime() - fd.getTime()) / 86_400_000) + 1;
  const granularity = pickGranularity(lengthDays);
  const prior = getPriorEqualLengthRange(from, to);

  const supabase = await getSupabaseForStore(shop);

  // Mirror dashboard expense math
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

  const args = {
    p_store_id: shop,
    p_monthly_expenses: monthlyExp,
    p_per_order_expenses: perOrderExp,
    p_granularity: granularity,
  };

  // Two RPCs in parallel — current and prior buckets aligned by index
  const [curRes, priorRes] = await Promise.all([
    (supabase as any).rpc("get_trend_series", {
      ...args,
      p_from_date: from,
      p_to_date: to,
    }),
    (supabase as any).rpc("get_trend_series", {
      ...args,
      p_from_date: prior.from,
      p_to_date: prior.to,
    }),
  ]);

  if (curRes.error || priorRes.error) {
    console.error("[api.trend] get_trend_series failed:", curRes.error || priorRes.error);
    return json({ error: "rpc_failed" }, { status: 500 });
  }

  return json({
    granularity,
    current: { from, to, points: curRes.data ?? [] },
    prior:   { from: prior.from, to: prior.to, points: priorRes.data ?? [] },
  });
};
