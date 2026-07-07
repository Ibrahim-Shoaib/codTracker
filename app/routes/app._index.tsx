import type { LoaderFunctionArgs } from "@remix-run/node";
import { defer, json } from "@remix-run/node";
import { Await, Navigate, useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { Suspense, useEffect, useState } from "react";
import {
  Page,
  BlockStack,
  InlineGrid,
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
import { fetchDemoPipeline } from "../lib/demo-pipeline.server.js";
import { effectiveStoreId } from "../lib/demo-pool.server.js";
import {
  maskDemoAdSpend,
  maskDemoAdSpendForTrendPoint,
} from "../lib/demo-ad-spend.server.js";
import { getStatsAdapter } from "../lib/stats-adapter.server.js";
import KPICard from "../components/KPICard.jsx";
import WarningBanner from "../components/WarningBanner.jsx";
import DetailPanel from "../components/DetailPanel.jsx";
import CityLossPanel from "../components/CityLossPanel.jsx";
import BreakEvenSection from "../components/BreakEvenSection.jsx";
import TrendPanel from "../components/TrendPanel.jsx";
import SyncingLoader from "../components/SyncingLoader.jsx";
import {
  KPIGridSkeleton,
  PanelSkeleton,
  PanelError,
} from "../components/Skeletons.jsx";

const STEP_ROUTES: Record<number, string> = {
  1: "/app/onboarding/step1-postex",
  2: "/app/onboarding/step2-meta",
  3: "/app/onboarding/step3-cogs",
  4: "/app/onboarding/step4-expenses",
};

type PeriodStats = Record<string, any> | null;
type PeriodPayload = {
  stats: PeriodStats;
  priorStats: PeriodStats;
  dateRange: { from: string; to: string };
  expenseBreakdown: any[];
};
type BreakEvenPayload = {
  breakEvenRoas: number | null;
  breakEvenCac: number | null;
  actualRoas: number | null;
  actualCac: number | null;
  deliverySuccessPct: number | null;
  costPerReturn: number | null;
  windowDays: number;
  from: string;
  to: string;
  contribAfterFixed: number;
  isFallback?: boolean;
} | null;

// Expenses are read inside the RPC from store_expenses. For demo stores
// orders come from the pool (dataStoreId) but expenses stay the merchant's
// own (expenseStoreId = session.shop); p_expense_store_id keeps them apart.
function statsRpc(supabase: any, dataStoreId: string, from: string, to: string, expenseStoreId: string) {
  return supabase.rpc("get_dashboard_stats", {
    p_store_id:         dataStoreId,
    p_from_date:        from,
    p_to_date:          to,
    p_expense_store_id: expenseStoreId,
  });
}

function breakdownRpc(supabase: any, dataStoreId: string, from: string, to: string, expenseStoreId: string) {
  return supabase.rpc("get_expense_breakdown", {
    p_store_id:         dataStoreId,
    p_from_date:        from,
    p_to_date:          to,
    p_expense_store_id: expenseStoreId,
  });
}

// Derive the break-even card numbers.
//
// Two corrections vs the v1 formula:
//  1. STRICT — subtract fixed expenses from gross profit so the threshold
//     reflects everything ads have to cover, not just delivery + COGS.
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
function deriveBreakEvenPostex(stats: PeriodStats, windowFrom: string, windowTo: string, days: number): BreakEvenPayload {
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

// Window selection shared by both ingest modes: prefer the strict 30-day
// window; fall back to 60/90 only when 30 days can't clear fixed expenses.
// `isFallback` lets the section explain which window is on screen and why.
function pickBreakEvenWindow(candidates: BreakEvenPayload[]): BreakEvenPayload {
  const present = candidates.filter(Boolean) as NonNullable<BreakEvenPayload>[];
  const win30 = present.find((c) => c.windowDays === 30);
  const longerOK = present.find(
    (c) => c.windowDays > 30 && c.contribAfterFixed > 0
  );
  const selected =
    win30 != null && win30.contribAfterFixed > 0
      ? win30
      : longerOK ?? win30 ?? present[0] ?? null;
  return selected
    ? { ...selected, isFallback: selected.windowDays !== 30 }
    : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const supabase: any = await getSupabaseForStore(shop);

  // 1. Store row + expenses list (parallel). These stay awaited — the store
  // row drives onboarding redirects and the warning banner, both of which
  // must render with the first byte.
  const [{ data: store }, { data: expensesList }] = await Promise.all([
    supabase
      .from("stores")
      .select(
        "store_id, postex_token, onboarding_complete, onboarding_step, sellable_returns_pct, meta_access_token, meta_token_expires_at, meta_sync_error, last_postex_sync_at, is_demo, currency, money_format, meta_ad_account_currency, ingest_mode"
      )
      .eq("store_id", shop)
      .single(),
    supabase
      .from("store_expenses")
      .select("id, series_id, name, amount, kind, is_variable, pct_base, effective_from, effective_to")
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

  const expenses: any[] = expensesList ?? [];

  // For demo stores, all orders/ad_spend reads target the shared pool
  // store_id; expenses + COGS lookups continue to use the merchant's own shop.
  const dataStoreId = effectiveStoreId(store, shop);

  // 2. Period boundaries
  const today     = getTodayPKT();
  const yesterday = getYesterdayPKT();
  const mtd       = getMTDPKT();
  const lastMonth = getLastMonthPKT();

  // ── ShopifyDirect ingest mode ────────────────────────────────────────
  if (store.ingest_mode === "shopify_direct") {
    return buildShopifyDirectResponse({
      session, store, expenses,
      today, yesterday, mtd, lastMonth,
    });
  }

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

  // Break-even card windows (30/60/90 days, computed in parallel).
  function rollingFromUTC(days: number) {
    const s = new Date(today.start);
    s.setUTCDate(s.getUTCDate() - (days - 1));
    return formatPKTDate(s);
  }
  const window30From = rollingFromUTC(30);
  const window60From = rollingFromUTC(60);
  const window90From = rollingFromUTC(90);
  const windowTo     = todayTo;

  // 3. Deferred payloads. Everything below streams in AFTER the first byte —
  // the shell (page chrome, banner, skeletons) renders immediately and each
  // panel pops in when its data lands. Grouping:
  //   statsPromise      → 7 stats RPCs + 4 expense breakdowns (KPI cards)
  //   breakEvenPromise  → 3 rolling-window stats RPCs
  //   trendPromise      → 2 trend-series RPCs
  //   cityPromise       → all-time city breakdown (slowest query on the page)
  //   unfulfilledPipeline → live Shopify / demo-pool pipeline pills

  const statsPromise = (async () => {
    const [
      todayRes, yesterdayRes, mtdRes, lastMonthRes,
      dbyRes, mtdCompRes, mblRes,
      bdTodayRes, bdYestRes, bdMtdRes, bdLmRes,
    ] = await Promise.all([
      statsRpc(supabase, dataStoreId, todayFrom, todayTo, shop),
      statsRpc(supabase, dataStoreId, yestFrom,  yestTo,  shop),
      statsRpc(supabase, dataStoreId, mtdFrom,   mtdTo,   shop),
      statsRpc(supabase, dataStoreId, lmFrom,    lmTo,    shop),
      statsRpc(supabase, dataStoreId, dbyFrom,     dbyTo,     shop),
      statsRpc(supabase, dataStoreId, mtdCompFrom, mtdCompTo, shop),
      statsRpc(supabase, dataStoreId, mblFrom,     mblTo,     shop),
      breakdownRpc(supabase, dataStoreId, todayFrom, todayTo, shop),
      breakdownRpc(supabase, dataStoreId, yestFrom,  yestTo,  shop),
      breakdownRpc(supabase, dataStoreId, mtdFrom,   mtdTo,   shop),
      breakdownRpc(supabase, dataStoreId, lmFrom,    lmTo,    shop),
    ]);

    // Demo stores without a connected Meta Ads account: zero ad_spend (and
    // recompute derived metrics) so the dashboard doesn't surface synthetic
    // pool spend the merchant never ran. No-op for real stores.
    const todayStat     = maskDemoAdSpend(todayRes.data?.[0]     ?? null, store);
    const yesterdayStat = maskDemoAdSpend(yesterdayRes.data?.[0] ?? null, store);
    const mtdStat       = maskDemoAdSpend(mtdRes.data?.[0]       ?? null, store);
    const lastMonthStat = maskDemoAdSpend(lastMonthRes.data?.[0] ?? null, store);
    const dbyStat       = maskDemoAdSpend(dbyRes.data?.[0]       ?? null, store);
    const mtdCompStat   = maskDemoAdSpend(mtdCompRes.data?.[0]   ?? null, store);
    const mblStat       = maskDemoAdSpend(mblRes.data?.[0]       ?? null, store);

    // Prior-period stats: Today's prior = Yesterday's current, so we reuse
    // `yesterdayStat` rather than issuing a duplicate RPC.
    const periods: Record<string, PeriodPayload> = {
      today:     { stats: todayStat,     priorStats: yesterdayStat, dateRange: { from: todayFrom, to: todayTo }, expenseBreakdown: bdTodayRes.data ?? [] },
      yesterday: { stats: yesterdayStat, priorStats: dbyStat,       dateRange: { from: yestFrom,  to: yestTo  }, expenseBreakdown: bdYestRes.data ?? [] },
      mtd:       { stats: mtdStat,       priorStats: mtdCompStat,   dateRange: { from: mtdFrom,   to: mtdTo   }, expenseBreakdown: bdMtdRes.data ?? [] },
      lastMonth: { stats: lastMonthStat, priorStats: mblStat,       dateRange: { from: lmFrom,    to: lmTo    }, expenseBreakdown: bdLmRes.data ?? [] },
    };
    return { periods };
  })();

  const breakEvenPromise = (async () => {
    const [win30Res, win60Res, win90Res] = await Promise.all([
      statsRpc(supabase, dataStoreId, window30From, windowTo, shop),
      statsRpc(supabase, dataStoreId, window60From, windowTo, shop),
      statsRpc(supabase, dataStoreId, window90From, windowTo, shop),
    ]);
    const win30Stat = maskDemoAdSpend(win30Res.data?.[0] ?? null, store);
    const win60Stat = maskDemoAdSpend(win60Res.data?.[0] ?? null, store);
    const win90Stat = maskDemoAdSpend(win90Res.data?.[0] ?? null, store);
    return pickBreakEvenWindow([
      deriveBreakEvenPostex(win30Stat, window30From, windowTo, 30),
      deriveBreakEvenPostex(win60Stat, window60From, windowTo, 60),
      deriveBreakEvenPostex(win90Stat, window90From, windowTo, 90),
    ]);
  })();

  const trendPromise = (async () => {
    // Initial trend payload — current 30d + prior 30d, day buckets. The
    // chart fetcher swaps windows client-side via /app/api/trend afterwards.
    const prior = getPriorEqualLengthRange(window30From, windowTo);
    const [cur, pri] = await Promise.all([
      supabase.rpc("get_trend_series", {
        p_store_id:         dataStoreId,
        p_from_date:        window30From,
        p_to_date:          windowTo,
        p_granularity:      "day",
        p_expense_store_id: shop,
      }),
      supabase.rpc("get_trend_series", {
        p_store_id:         dataStoreId,
        p_from_date:        prior.from,
        p_to_date:          prior.to,
        p_granularity:      "day",
        p_expense_store_id: shop,
      }),
    ]);
    const curPoints = (cur.data ?? []).map((p: any) => maskDemoAdSpendForTrendPoint(p, store));
    const priPoints = (pri.data ?? []).map((p: any) => maskDemoAdSpendForTrendPoint(p, store));
    return {
      granularity: "day" as const,
      current: { from: window30From, to: windowTo, points: curPoints },
      prior:   { from: prior.from,   to: prior.to, points: priPoints },
    };
  })();

  const cityPromise = (async () => {
    const cityRes = await supabase.rpc("get_city_breakdown", {
      p_store_id:  dataStoreId,
      p_from_date: cityFromDate,
      p_to_date:   cityToDate,
    });
    return {
      cities: cityRes.data ?? [],
      from:   cityFromDate,
      to:     cityToDate,
    };
  })();

  // COGS-warning count is cheap (partial index) and drives the banner, which
  // renders in the awaited shell — keep it awaited.
  const { count: unmatchedCount } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("store_id", dataStoreId)
    .eq("cogs_match_source", "none");

  // Pipeline value for the dashboard pills. Real stores hit Shopify Admin
  // for live unfulfilled orders; demo stores read in-transit fabricated
  // orders out of the DB.
  const pipelineRanges = {
    today:     { from: todayFrom, to: todayTo },
    yesterday: { from: yestFrom,  to: yestTo  },
    mtd:       { from: mtdFrom,   to: mtdTo   },
    lastMonth: { from: lmFrom,    to: lmTo    },
  };
  const unfulfilledPipeline = (
    store.is_demo
      ? fetchDemoPipeline(supabase, dataStoreId, pipelineRanges)
      : fetchUnfulfilledPipeline(session, pipelineRanges)
  ).catch((err: unknown) => {
    console.error("Pipeline fetch failed:", err);
    return null;
  });

  return defer({
    metaConnected:      !!store.meta_access_token,
    isMetaExpired:      isTokenExpired(store.meta_token_expires_at),
    isMetaExpiringSoon: isTokenExpiringSoon(store.meta_token_expires_at),
    metaExpiresAt:      store.meta_token_expires_at,
    metaSyncError:      store.meta_sync_error ?? null,
    backfillInProgress: !store.last_postex_sync_at,
    unmatchedCOGSCount: unmatchedCount ?? 0,
    currency:           store.currency ?? "PKR",
    metaAdAccountCurrency: store.meta_ad_account_currency ?? null,
    caps: {
      mode: "postex",
      showPipelinePills: true,
      showCityLoss: true,
      returnsLabel: "Returns",
      returnsUnit: "count",
    },
    stats: statsPromise,
    breakEven: breakEvenPromise,
    trend: trendPromise,
    cityBreakdown: cityPromise,
    unfulfilledPipeline,
  });
};

// ─── ShopifyDirect path ──────────────────────────────────────────────────
//
// Same deferred shape as the PostEx path above, populated from a live
// Shopify Admin API fetch via the stats adapter instead of the RPCs.
// Panels that don't apply (city loss, trend, pipeline) resolve to
// empty/null so the `caps` flags hide them without crashing.
async function buildShopifyDirectResponse({
  session, store, expenses,
  today, yesterday, mtd, lastMonth,
}: {
  session: any; store: any; expenses: any[];
  today: any; yesterday: any; mtd: any; lastMonth: any;
}) {
  const todayFrom = formatPKTDate(today.start);
  const todayTo   = formatPKTDate(today.end);
  const yestFrom  = formatPKTDate(yesterday.start);
  const yestTo    = formatPKTDate(yesterday.end);
  const mtdFrom   = formatPKTDate(mtd.start);
  const mtdTo     = formatPKTDate(mtd.end);
  const lmFrom    = formatPKTDate(lastMonth.start);
  const lmTo      = formatPKTDate(lastMonth.end);
  const dbyFrom   = formatPKTDate(getDayBeforeYesterdayPKT().start);
  const dbyTo     = formatPKTDate(getDayBeforeYesterdayPKT().end);
  const mtdCompFrom = formatPKTDate(getMTDComparisonPKT().start);
  const mtdCompTo   = formatPKTDate(getMTDComparisonPKT().end);
  const mblFrom   = formatPKTDate(getMonthBeforeLastPKT().start);
  const mblTo     = formatPKTDate(getMonthBeforeLastPKT().end);

  const periodsCurrent = {
    today:     { from: todayFrom, toExclusive: todayTo, to: todayTo },
    yesterday: { from: yestFrom,  toExclusive: yestTo,  to: yestTo  },
    mtd:       { from: mtdFrom,   toExclusive: mtdTo,   to: mtdTo   },
    lastMonth: { from: lmFrom,    toExclusive: lmTo,    to: lmTo    },
  };
  const periodsPrior = {
    today:     { from: yestFrom,    toExclusive: yestTo,    to: yestTo    },
    yesterday: { from: dbyFrom,     toExclusive: dbyTo,     to: dbyTo     },
    mtd:       { from: mtdCompFrom, toExclusive: mtdCompTo, to: mtdCompTo },
    lastMonth: { from: mblFrom,     toExclusive: mblTo,     to: mblTo     },
  };

  const adapter = await getStatsAdapter(store, session);

  function rollingFromUTC(days: number) {
    const startMs = today.start.getTime() - (days - 1) * 24 * 60 * 60 * 1000;
    return formatPKTDate(new Date(startMs));
  }
  const window30From = rollingFromUTC(30);
  const window60From = rollingFromUTC(60);
  const window90From = rollingFromUTC(90);
  const windowTo = todayTo;

  const statsPromise = (async () => {
    // Single broad-range fetch under the hood — both calls share the
    // adapter's 60s cache, so the second is a memory hit.
    const [s, prior]: [Record<string, any>, Record<string, any>] = await Promise.all([
      adapter.getDashboardStats({ periods: periodsCurrent, expenses }),
      adapter.getDashboardStats({ periods: periodsPrior,   expenses }),
    ]);
    const periods: Record<string, PeriodPayload> = {
      today:     { stats: s.today,     priorStats: prior.today,     dateRange: { from: todayFrom, to: todayTo }, expenseBreakdown: s.today?._expenseBreakdown     ?? [] },
      yesterday: { stats: s.yesterday, priorStats: prior.yesterday, dateRange: { from: yestFrom,  to: yestTo  }, expenseBreakdown: s.yesterday?._expenseBreakdown ?? [] },
      mtd:       { stats: s.mtd,       priorStats: prior.mtd,       dateRange: { from: mtdFrom,   to: mtdTo   }, expenseBreakdown: s.mtd?._expenseBreakdown       ?? [] },
      lastMonth: { stats: s.lastMonth, priorStats: prior.lastMonth, dateRange: { from: lmFrom,    to: lmTo    }, expenseBreakdown: s.lastMonth?._expenseBreakdown ?? [] },
    };
    return { periods };
  })();

  // Chained after statsPromise so the adapter's order cache is warm — firing
  // both at once would double-fetch the same Shopify order range.
  const breakEvenPromise = statsPromise.then(async () => {
    const breakEvenStats: Record<string, any> = await adapter.getDashboardStats({
      periods: {
        w30: { from: window30From, toExclusive: windowTo, to: windowTo },
        w60: { from: window60From, toExclusive: windowTo, to: windowTo },
        w90: { from: window90From, toExclusive: windowTo, to: windowTo },
      },
      expenses,
    });

    // Direct mode uses refunds-as-loss instead of returns-as-loss; the
    // adapter populates `returns`/`return_loss` with refund-derived values
    // and there's no delivery-success adjustment (bookedValue = sales).
    function deriveBreakEvenDirect(stats: PeriodStats, windowFrom: string, days: number): BreakEvenPayload {
      if (!stats) return null;
      const sales       = Number(stats.sales        ?? 0);
      const grossProfit = Number(stats.gross_profit ?? 0);
      const periodExp   = Number(stats.expenses     ?? 0);
      const ordersTotal = Number(stats.orders       ?? 0);
      const adSpend     = Number(stats.ad_spend     ?? 0);
      const refundPct   = stats.refund_pct == null ? null : Number(stats.refund_pct) * 100;
      const returnLoss  = Number(stats.return_loss  ?? 0);
      const returns     = Number(stats.returns      ?? 0);

      const contribAfterFixed = grossProfit - periodExp;
      const successPct =
        refundPct == null ? null : Math.max(0, 100 - refundPct);
      const bookedValue = sales;
      return {
        breakEvenRoas:
          contribAfterFixed > 0 ? sales / contribAfterFixed : null,
        breakEvenCac:
          contribAfterFixed > 0 && ordersTotal > 0
            ? contribAfterFixed / ordersTotal
            : null,
        actualRoas: adSpend > 0 ? bookedValue / adSpend : null,
        actualCac: adSpend > 0 && ordersTotal > 0 ? adSpend / ordersTotal : null,
        deliverySuccessPct: successPct,
        costPerReturn: returns > 0 ? returnLoss / returns : null,
        windowDays: days,
        from: windowFrom,
        to: windowTo,
        contribAfterFixed,
      };
    }

    return pickBreakEvenWindow([
      deriveBreakEvenDirect(breakEvenStats.w30, window30From, 30),
      deriveBreakEvenDirect(breakEvenStats.w60, window60From, 60),
      deriveBreakEvenDirect(breakEvenStats.w90, window90From, 90),
    ]);
  });

  return defer({
    metaConnected:      !!store.meta_access_token,
    isMetaExpired:      isTokenExpired(store.meta_token_expires_at),
    isMetaExpiringSoon: isTokenExpiringSoon(store.meta_token_expires_at),
    metaExpiresAt:      store.meta_token_expires_at,
    metaSyncError:      store.meta_sync_error ?? null,
    backfillInProgress: false, // no historical backfill in shopify_direct
    unmatchedCOGSCount: 0,
    currency:           store.currency ?? "PKR",
    metaAdAccountCurrency: store.meta_ad_account_currency ?? null,
    caps: adapter.capabilities(),
    stats: statsPromise,
    breakEven: breakEvenPromise,
    trend: Promise.resolve(null),                 // TrendPanel hides when null
    cityBreakdown: Promise.resolve({ cities: [], from: window30From, to: windowTo }),
    unfulfilledPipeline: Promise.resolve(null),
  });
}

const PERIOD_KEYS = ["today", "yesterday", "mtd", "lastMonth"] as const;

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const [detail, setDetail] = useState<{
    stats: any; dateRange: { from: string; to: string }; title: string;
    expenseBreakdown: any[];
  } | null>(null);

  // Backfill polling must be set up before any conditional return — hooks
  // can't be skipped between renders. `active` is false for the redirect case.
  const backfillInProgress =
    "backfillInProgress" in data ? (data as any).backfillInProgress : false;
  const revalidator = useRevalidator();
  const statusFetcher = useFetcher<{ done: boolean }>();

  // While the first PostEx sync runs, poll the one-row status endpoint
  // (NOT the full 17-RPC dashboard loader) and revalidate exactly once
  // when the sync lands.
  useEffect(() => {
    if (!backfillInProgress) return;
    const id = setInterval(() => {
      if (statusFetcher.state === "idle") statusFetcher.load("/app/api/sync-status");
    }, 4000);
    return () => clearInterval(id);
    // statusFetcher identity changes per render; the interval only needs mount/unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backfillInProgress]);

  useEffect(() => {
    if (backfillInProgress && statusFetcher.data?.done && revalidator.state === "idle") {
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFetcher.data, backfillInProgress]);

  if ("redirectTo" in data) {
    return <Navigate to={(data as { redirectTo: string }).redirectTo} replace />;
  }

  const { stats, breakEven, trend, cityBreakdown, unfulfilledPipeline,
          unmatchedCOGSCount,
          metaConnected, isMetaExpired, isMetaExpiringSoon, metaExpiresAt,
          metaSyncError,
          currency,
          caps = { mode: "postex", showPipelinePills: true, showCityLoss: true, returnsLabel: "Returns", returnsUnit: "count" } } = data as any;

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

        {/* Always render the full app — even with zero orders, every card
            shows so the merchant sees the product they bought. While data
            is still being populated we surface a small inline loader at
            the top instead of hiding the dashboard behind an empty state. */}
        {backfillInProgress && (
          <SyncingLoader
            title="Setting up your dashboard…"
            subtitle="Your sales, profit and orders will appear here in a moment. This usually takes under a minute."
          />
        )}

        <Suspense fallback={<KPIGridSkeleton />}>
          <Await resolve={stats} errorElement={<PanelError title="Your sales stats couldn't load" />}>
            {(resolved: { periods: Record<string, PeriodPayload> }) => (
              <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
                {PERIOD_KEYS.map((key) => (
                  <KPICard
                    key={key}
                    period={key}
                    stats={resolved.periods[key].stats}
                    priorStats={resolved.periods[key].priorStats}
                    dateRange={resolved.periods[key].dateRange}
                    expenseBreakdown={resolved.periods[key].expenseBreakdown}
                    unfulfilledPromise={unfulfilledPipeline}
                    currency={currency}
                    caps={caps}
                    onMore={(stats: any, dateRange: any, title: string, expenseBreakdown: any[]) =>
                      setDetail({ stats, dateRange, title, expenseBreakdown })
                    }
                  />
                ))}
              </InlineGrid>
            )}
          </Await>
        </Suspense>

        <Suspense fallback={<PanelSkeleton lines={4} />}>
          <Await resolve={breakEven} errorElement={<PanelError title="Break-even targets couldn't load" />}>
            {(be: BreakEvenPayload) =>
              be ? <BreakEvenSection {...be} currency={currency} caps={caps} /> : null
            }
          </Await>
        </Suspense>

        <Suspense fallback={<PanelSkeleton lines={8} />}>
          <Await resolve={trend} errorElement={<PanelError title="The trend chart couldn't load" />}>
            {(t: any) =>
              t ? (
                <TrendPanel
                  initialPayload={t}
                  backfillInProgress={backfillInProgress}
                  currency={currency}
                />
              ) : null
            }
          </Await>
        </Suspense>

        {caps.showCityLoss && (
          <Suspense fallback={<PanelSkeleton lines={6} />}>
            <Await resolve={cityBreakdown} errorElement={<PanelError title="City analysis couldn't load" />}>
              {(cb: { cities: any[]; from: string; to: string }) => (
                <CityLossPanel
                  initialCities={cb.cities}
                  initialFrom={cb.from}
                  initialTo={cb.to}
                  initialLabel="Maximum"
                  currency={currency}
                />
              )}
            </Await>
          </Suspense>
        )}
      </BlockStack>

      {detail && (
        <DetailPanel
          title={detail.title}
          stats={detail.stats}
          dateRange={detail.dateRange}
          expenseBreakdown={detail.expenseBreakdown}
          open={!!detail}
          onClose={() => setDetail(null)}
          currency={currency}
          caps={caps}
        />
      )}
    </Page>
  );
}
