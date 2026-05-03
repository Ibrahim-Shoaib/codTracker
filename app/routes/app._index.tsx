import type { LoaderFunctionArgs } from "@remix-run/node";
import { defer, json } from "@remix-run/node";
import { Navigate, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  BlockStack,
  InlineGrid,
  Text,
  EmptyState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { metaOAuthSession } from "../lib/meta-session.server.js";
import {
  getTodayPKT,
  getYesterdayPKT,
  getMTDPKT,
  getLastMonthPKT,
  getDayBeforeYesterdayPKT,
  getMTDComparisonPKT,
  getMonthBeforeLastPKT,
  formatPKTDate,
  getPriorEqualLengthRange,
} from "../lib/dates.server.js";
import { isTokenExpired, isTokenExpiringSoon } from "../lib/meta.server.js";
import { fetchUnfulfilledPipeline } from "../lib/shopify-pipeline.server.js";
import KPICard from "../components/KPICard.jsx";
import WarningBanner from "../components/WarningBanner.jsx";
import DetailPanel from "../components/DetailPanel.jsx";
import CityLossPanel from "../components/CityLossPanel.jsx";
import BreakEvenSection from "../components/BreakEvenSection.jsx";
import TrendPanel from "../components/TrendPanel.jsx";

const STEP_ROUTES: Record<number, string> = {
  1: "/app/onboarding/step1-postex",
  2: "/app/onboarding/step2-meta",
  3: "/app/onboarding/step3-cogs",
  4: "/app/onboarding/step4-expenses",
};


function statsRpc(supabase: ReturnType<typeof getSupabaseForStore> extends Promise<infer T> ? T : never, shop: string, from: string, to: string, monthlyExp: number, perOrderExp: number) {
  return (supabase as any).rpc("get_dashboard_stats", {
    p_store_id:           shop,
    p_from_date:          from,
    p_to_date:            to,
    p_monthly_expenses:   monthlyExp,
    p_per_order_expenses: perOrderExp,
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const supabase = await getSupabaseForStore(shop);

  // 1. Store row + expenses list (parallel)
  const [{ data: store }, { data: expensesList }] = await Promise.all([
    supabase
      .from("stores")
      .select(
        "postex_token, onboarding_complete, onboarding_step, sellable_returns_pct, meta_access_token, meta_token_expires_at, meta_sync_error, last_postex_sync_at"
      )
      .eq("store_id", shop)
      .single(),
    supabase
      .from("store_expenses")
      .select("id, name, amount, type")
      .eq("store_id", shop)
      .order("created_at"),
  ]);

  // Client-side redirects preserve App Bridge auth context; server-side 302s strip it
  if (!store) return json({ redirectTo: "/app/onboarding/step1-postex" });
  if (!store.onboarding_complete) {
    return json({ redirectTo: STEP_ROUTES[store.onboarding_step] ?? "/app/onboarding/step1-postex" });
  }

  // After Meta OAuth from settings, the callback redirects here (app root).
  // If a pending token is in the cookie, send the user to settings to complete the connection.
  const cookieHeader = request.headers.get("Cookie");
  const oauthSession = await metaOAuthSession.getSession(cookieHeader);
  if (oauthSession.get("meta_access_token")) {
    return json({ redirectTo: "/app/settings" });
  }

  const expenses = expensesList ?? [];
  const monthlyExp   = expenses.filter((e: any) => e.type === "monthly").reduce((s: number, e: any) => s + Number(e.amount), 0);
  const perOrderExp  = expenses.filter((e: any) => e.type === "per_order").reduce((s: number, e: any) => s + Number(e.amount), 0);

  // 2. Period boundaries
  const today     = getTodayPKT();
  const yesterday = getYesterdayPKT();
  const mtd       = getMTDPKT();
  const lastMonth = getLastMonthPKT();

  // Prior periods (Option A: equal-length immediately preceding for the daily
  // and monthly cards, days-elapsed mirror for MTD). Today's prior = Yesterday,
  // so we reuse the existing `yesterdayRes` and don't issue a 5th call.
  const dayBeforeYest   = getDayBeforeYesterdayPKT();
  const mtdComp         = getMTDComparisonPKT();
  const monthBeforeLast = getMonthBeforeLastPKT();

  const todayFrom    = formatPKTDate(today.start);
  const todayTo      = formatPKTDate(today.end);
  const yestFrom     = formatPKTDate(yesterday.start);
  const yestTo       = formatPKTDate(yesterday.end);
  const mtdFrom      = formatPKTDate(mtd.start);
  const mtdTo        = formatPKTDate(mtd.end);
  const lmFrom       = formatPKTDate(lastMonth.start);
  const lmTo         = formatPKTDate(lastMonth.end);
  const dbyFrom      = formatPKTDate(dayBeforeYest.start);
  const dbyTo        = formatPKTDate(dayBeforeYest.end);
  const mtdCompFrom  = formatPKTDate(mtdComp.start);
  const mtdCompTo    = formatPKTDate(mtdComp.end);
  const mblFrom      = formatPKTDate(monthBeforeLast.start);
  const mblTo        = formatPKTDate(monthBeforeLast.end);

  // City panel default window — "Maximum" (all-time). 2010-01-01 predates
  // any Pakistani Shopify merchant, and the partial idx_orders_city_terminal
  // index handles the wider range without a seq scan.
  const cityToDate   = todayTo;
  const cityFromDate = "2010-01-01";

  // Break-even card section uses a rolling window. We try 30 days first
  // (freshest signal) and fall back to 60 then 90 days when the shorter
  // window has too little gross profit to clear fixed expenses. All three
  // windows are computed in parallel to keep dashboard latency unchanged.
  function rollingFromUTC(days: number) {
    const s = new Date(today.start);
    s.setUTCDate(s.getUTCDate() - (days - 1));
    return formatPKTDate(s);
  }
  const window30From = rollingFromUTC(30);
  const window60From = rollingFromUTC(60);
  const window90From = rollingFromUTC(90);
  const windowTo     = todayTo;

  // 3. Parallel RPC calls — 4 KPI stats + 3 prior-period stats (Today reuses
  // Yesterday) + 3 break-even windows + 1 banner count + 1 city breakdown
  // + 1 daily trend series (initial 30 days; the chart fetcher swaps this
  // window client-side via /app/api/trend without reloading the dashboard).
  const [
    todayRes,
    yesterdayRes,
    mtdRes,
    lastMonthRes,
    dbyRes,
    mtdCompRes,
    mblRes,
    win30Res,
    win60Res,
    win90Res,
    { count: unmatchedCount },
    cityRes,
    trendRes,
  ] = await Promise.all([
    statsRpc(supabase, shop, todayFrom, todayTo, monthlyExp, perOrderExp),
    statsRpc(supabase, shop, yestFrom,  yestTo,  monthlyExp, perOrderExp),
    statsRpc(supabase, shop, mtdFrom,   mtdTo,   monthlyExp, perOrderExp),
    statsRpc(supabase, shop, lmFrom,    lmTo,    monthlyExp, perOrderExp),
    statsRpc(supabase, shop, dbyFrom,     dbyTo,     monthlyExp, perOrderExp),
    statsRpc(supabase, shop, mtdCompFrom, mtdCompTo, monthlyExp, perOrderExp),
    statsRpc(supabase, shop, mblFrom,     mblTo,     monthlyExp, perOrderExp),
    statsRpc(supabase, shop, window30From, windowTo, monthlyExp, perOrderExp),
    statsRpc(supabase, shop, window60From, windowTo, monthlyExp, perOrderExp),
    statsRpc(supabase, shop, window90From, windowTo, monthlyExp, perOrderExp),
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("store_id", shop)
      .eq("cogs_match_source", "none"),
    (supabase as any).rpc("get_city_breakdown", {
      p_store_id:  shop,
      p_from_date: cityFromDate,
      p_to_date:   cityToDate,
    }),
    // Initial trend payload — current 30d + prior 30d, day buckets.
    // Comparison fetched inline so the chart renders fully on first paint
    // without waiting for a client fetcher.
    (async () => {
      const prior = getPriorEqualLengthRange(window30From, windowTo);
      const [cur, pri] = await Promise.all([
        (supabase as any).rpc("get_trend_series", {
          p_store_id:           shop,
          p_from_date:          window30From,
          p_to_date:            windowTo,
          p_monthly_expenses:   monthlyExp,
          p_per_order_expenses: perOrderExp,
          p_granularity:        "day",
        }),
        (supabase as any).rpc("get_trend_series", {
          p_store_id:           shop,
          p_from_date:          prior.from,
          p_to_date:            prior.to,
          p_monthly_expenses:   monthlyExp,
          p_per_order_expenses: perOrderExp,
          p_granularity:        "day",
        }),
      ]);
      return {
        granularity: "day" as const,
        current: { from: window30From, to: windowTo,    points: cur.data ?? [] },
        prior:   { from: prior.from,   to: prior.to,    points: pri.data ?? [] },
      };
    })(),
  ]);

  const s = {
    today:     todayRes.data?.[0]     ?? null,
    yesterday: yesterdayRes.data?.[0] ?? null,
    mtd:       mtdRes.data?.[0]       ?? null,
    lastMonth: lastMonthRes.data?.[0] ?? null,
  };

  // Prior-period stats. Today's prior = Yesterday's current, so we reuse
  // `yesterdayRes` rather than issuing a duplicate RPC.
  const prior = {
    today:     yesterdayRes.data?.[0] ?? null,
    yesterday: dbyRes.data?.[0]       ?? null,
    mtd:       mtdCompRes.data?.[0]   ?? null,
    lastMonth: mblRes.data?.[0]       ?? null,
  };

  // Derive the break-even card numbers.
  //
  // Two corrections vs the v1 formula:
  //  1. STRICT — subtract fixed expenses from gross profit so the threshold
  //     reflects everything ads have to cover, not just delivery + COGS. The
  //     marketing-only formula was generous enough to hide a real loss in a
  //     period where ROAS was above 4× but net profit was negative.
  //  2. META-COMPARABLE — translate everything into the units Meta Ads
  //     Manager uses (booked value / ad spend, ad spend / booking) so the
  //     merchant can read the card and compare 1:1 with their reporting.
  //
  // Conversion: Meta counts every purchase event (delivered + returned),
  // we count only delivered. delivery_success = delivered / orders is the
  // bridge:
  //   booked_value ≈ sales / delivery_success
  //   meta_ROAS    = booked_value / ad_spend = our_ROAS / delivery_success
  //   meta_CPA     = ad_spend / orders        = our_CAC × delivery_success
  //
  // Window selection: try 30 → 60 → 90 days. Skip a window if its
  // contribution_after_fixed is ≤ 0 (a window with too few delivered orders
  // to clear fixed expenses gives a meaningless N/A). If all three are
  // bad, surface the 30-day window with N/A — that is itself an honest
  // signal ("nothing cleared expenses yet").
  function deriveBreakEven(stats: any, windowFrom: string, days: number) {
    if (!stats) return null;
    const sales        = Number(stats.sales        ?? 0);
    const grossProfit  = Number(stats.gross_profit ?? 0);
    const periodExp    = Number(stats.expenses     ?? 0);
    const ordersTotal  = Number(stats.orders       ?? 0);
    const returns      = Number(stats.returns      ?? 0);
    const returnLoss   = Number(stats.return_loss  ?? 0);
    const adSpend      = Number(stats.ad_spend     ?? 0);
    const refundPct    = stats.refund_pct == null ? null : Number(stats.refund_pct);
    const delivered    = Math.max(0, ordersTotal - returns);

    const contribAfterFixed = grossProfit - periodExp;
    const deliverySuccess   = ordersTotal > 0 ? delivered / ordersTotal : null;
    const bookedValue       = deliverySuccess != null && deliverySuccess > 0
      ? sales / deliverySuccess
      : null;

    return {
      breakEvenRoas:
        contribAfterFixed > 0 && bookedValue != null
          ? bookedValue / contribAfterFixed
          : null,
      breakEvenCac:
        contribAfterFixed > 0 && ordersTotal > 0
          ? contribAfterFixed / ordersTotal
          : null,
      actualRoas:
        adSpend > 0 && bookedValue != null ? bookedValue / adSpend : null,
      actualCac:
        adSpend > 0 && ordersTotal > 0 ? adSpend / ordersTotal : null,
      deliverySuccessPct: refundPct == null ? null : 100 - refundPct,
      costPerReturn: returns > 0 ? returnLoss / returns : null,
      windowDays: days,
      from: windowFrom,
      to:   windowTo,
      contribAfterFixed,
    };
  }

  const candidates = [
    deriveBreakEven(win30Res.data?.[0], window30From, 30),
    deriveBreakEven(win60Res.data?.[0], window60From, 60),
    deriveBreakEven(win90Res.data?.[0], window90From, 90),
  ].filter(Boolean) as Array<NonNullable<ReturnType<typeof deriveBreakEven>>>;

  // Hybrid window: prefer the strict 30-day window. Only fall back to a
  // longer window when 30 days can't clear fixed expenses, and surface
  // `isFallback` so the section can show a small footer note explaining
  // which window is on screen and why.
  const win30 = candidates.find((c) => c.windowDays === 30);
  const longerOK = candidates.find(
    (c) => c.windowDays > 30 && c.contribAfterFixed > 0
  );
  const selected =
    win30 != null && win30.contribAfterFixed > 0
      ? win30
      : longerOK ?? win30 ?? candidates[0] ?? null;
  const breakEven = selected
    ? { ...selected, isFallback: selected.windowDays !== 30 }
    : null;

  // Real-time Shopify "Unfulfilled" pipeline. Fired in parallel and not
  // awaited — the loader returns immediately with the SQL payload while
  // the dashboard renders <Suspense> skeleton chips for this promise.
  const unfulfilledPipeline = fetchUnfulfilledPipeline(session, {
    today:     { from: todayFrom, to: todayTo },
    yesterday: { from: yestFrom,  to: yestTo  },
    mtd:       { from: mtdFrom,   to: mtdTo   },
    lastMonth: { from: lmFrom,    to: lmTo    },
  }).catch((err) => {
    console.error("Shopify pipeline fetch failed:", err);
    return null;
  });

  return defer({
    expensesList: expenses,
    metaConnected:      !!store.meta_access_token,
    isMetaExpired:      isTokenExpired(store.meta_token_expires_at),
    isMetaExpiringSoon: isTokenExpiringSoon(store.meta_token_expires_at),
    metaExpiresAt:      store.meta_token_expires_at,
    metaSyncError:      store.meta_sync_error ?? null,
    backfillInProgress: !store.last_postex_sync_at,
    unmatchedCOGSCount: unmatchedCount ?? 0,
    periods: {
      today:     { stats: s.today,     priorStats: prior.today,     dateRange: { from: todayFrom, to: todayTo } },
      yesterday: { stats: s.yesterday, priorStats: prior.yesterday, dateRange: { from: yestFrom,  to: yestTo  } },
      mtd:       { stats: s.mtd,       priorStats: prior.mtd,       dateRange: { from: mtdFrom,   to: mtdTo   } },
      lastMonth: { stats: s.lastMonth, priorStats: prior.lastMonth, dateRange: { from: lmFrom,    to: lmTo    } },
    },
    breakEven,
    cityBreakdown: {
      cities: cityRes.data ?? [],
      from:   cityFromDate,
      to:     cityToDate,
    },
    trend: trendRes,
    unfulfilledPipeline,
  });
};

const PERIOD_KEYS = ["today", "yesterday", "mtd", "lastMonth"] as const;

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const [detail, setDetail] = useState<{
    stats: any; dateRange: { from: string; to: string }; title: string;
  } | null>(null);

  if ("redirectTo" in data) {
    return <Navigate to={(data as { redirectTo: string }).redirectTo} replace />;
  }

  const { periods, expensesList, unmatchedCOGSCount,
          metaConnected, isMetaExpired, isMetaExpiringSoon, metaExpiresAt,
          metaSyncError,
          backfillInProgress, cityBreakdown, breakEven, trend,
          unfulfilledPipeline } = data;

  // Empty state: no orders in any period
  const totalOrders = PERIOD_KEYS.reduce(
    (sum, k) => sum + Number(periods[k].stats?.orders ?? 0),
    0
  );
  const isEmpty = totalOrders === 0;

  return (
    <Page>
      <TitleBar title="CODProfit" />
      <BlockStack gap="400">
        <WarningBanner
          unmatchedCOGSCount={unmatchedCOGSCount}
          metaConnected={metaConnected}
          isMetaExpired={isMetaExpired}
          isMetaExpiringSoon={isMetaExpiringSoon}
          metaExpiresAt={metaExpiresAt}
          metaSyncError={metaSyncError}
          backfillInProgress={backfillInProgress}
        />

        {isEmpty ? (
          <EmptyState
            heading={
              backfillInProgress
                ? "Syncing your order history…"
                : "No orders found"
            }
            image=""
          >
            <Text as="p" tone="subdued">
              {backfillInProgress
                ? "Your order data is being synced. Check back in a few minutes."
                : "No orders found for any of the tracked periods."}
            </Text>
          </EmptyState>
        ) : (
          <>
            <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
              {PERIOD_KEYS.map((key) => (
                <KPICard
                  key={key}
                  period={key}
                  stats={periods[key].stats}
                  priorStats={periods[key].priorStats}
                  dateRange={periods[key].dateRange}
                  unfulfilledPromise={unfulfilledPipeline}
                  onMore={(stats, dateRange, title) =>
                    setDetail({ stats, dateRange, title })
                  }
                />
              ))}
            </InlineGrid>

            {breakEven && <BreakEvenSection {...breakEven} />}

            <TrendPanel
              initialPayload={trend}
              backfillInProgress={backfillInProgress}
            />

            <CityLossPanel
              initialCities={cityBreakdown.cities}
              initialFrom={cityBreakdown.from}
              initialTo={cityBreakdown.to}
              initialLabel="Maximum"
            />
          </>
        )}
      </BlockStack>

      {detail && (
        <DetailPanel
          title={detail.title}
          stats={detail.stats}
          dateRange={detail.dateRange}
          expensesList={expensesList}
          open={!!detail}
          onClose={() => setDetail(null)}
        />
      )}
    </Page>
  );
}
