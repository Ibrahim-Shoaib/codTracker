import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
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
  getMTDComparisonPKT,
  formatPKTDate,
} from "../lib/dates.server.js";
import { calcPctChange } from "../lib/calculations.server.js";
import { isTokenExpired, isTokenExpiringSoon } from "../lib/meta.server.js";
import KPICard from "../components/KPICard.jsx";
import WarningBanner from "../components/WarningBanner.jsx";
import DetailPanel from "../components/DetailPanel.jsx";

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
        "postex_token, onboarding_complete, onboarding_step, sellable_returns_pct, meta_access_token, meta_token_expires_at, last_postex_sync_at"
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
  const today = getTodayPKT();
  const yesterday = getYesterdayPKT();
  const mtd = getMTDPKT();
  const lastMonth = getLastMonthPKT();
  const mtdComp = getMTDComparisonPKT();
  const dayBefore = {
    start: new Date(yesterday.start.getTime() - 86_400_000),
    end:   new Date(yesterday.end.getTime()   - 86_400_000),
  };

  const todayFrom    = formatPKTDate(today.start);
  const todayTo      = formatPKTDate(today.end);
  const yestFrom     = formatPKTDate(yesterday.start);
  const yestTo       = formatPKTDate(yesterday.end);
  const dayBefFrom   = formatPKTDate(dayBefore.start);
  const dayBefTo     = formatPKTDate(dayBefore.end);
  const mtdFrom      = formatPKTDate(mtd.start);
  const mtdTo        = formatPKTDate(mtd.end);
  const mtdCompFrom  = formatPKTDate(mtdComp.start);
  const mtdCompTo    = formatPKTDate(mtdComp.end);
  const lmFrom       = formatPKTDate(lastMonth.start);
  const lmTo         = formatPKTDate(lastMonth.end);

  // 3. Parallel RPC calls — 6 stats + 2 banner counts
  //    yesterday doubles as Today's comparison period
  const [
    todayRes,
    yesterdayRes,   // also used as today's prior comparison
    dayBeforeRes,
    mtdRes,
    mtdCompRes,
    lastMonthRes,
    { count: unmatchedCount },
    { count: fuzzyCount },
  ] = await Promise.all([
    statsRpc(supabase, shop, todayFrom,   todayTo,   monthlyExp, perOrderExp),
    statsRpc(supabase, shop, yestFrom,    yestTo,    monthlyExp, perOrderExp),
    statsRpc(supabase, shop, dayBefFrom,  dayBefTo,  monthlyExp, perOrderExp),
    statsRpc(supabase, shop, mtdFrom,     mtdTo,     monthlyExp, perOrderExp),
    statsRpc(supabase, shop, mtdCompFrom, mtdCompTo, monthlyExp, perOrderExp),
    statsRpc(supabase, shop, lmFrom,      lmTo,      monthlyExp, perOrderExp),
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("cogs_match_source", "none"),
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .in("cogs_match_source", ["fuzzy", "sibling_avg", "fallback_avg"]),
  ]);

  const s = {
    today:     todayRes.data?.[0]     ?? null,
    yesterday: yesterdayRes.data?.[0] ?? null,
    dayBefore: dayBeforeRes.data?.[0] ?? null,
    mtd:       mtdRes.data?.[0]       ?? null,
    mtdComp:   mtdCompRes.data?.[0]   ?? null,
    lastMonth: lastMonthRes.data?.[0] ?? null,
  };

  // 4. % change — computed in JS from live RPC data
  const pct = (cur: any, prior: any) =>
    cur && prior
      ? {
          salesPctChange:  calcPctChange(Number(cur.sales),      Number(prior.sales)),
          profitPctChange: calcPctChange(Number(cur.net_profit),  Number(prior.net_profit)),
        }
      : null;

  return json({
    expensesList: expenses,
    metaConnected:      !!store.meta_access_token,
    isMetaExpired:      isTokenExpired(store.meta_token_expires_at),
    isMetaExpiringSoon: isTokenExpiringSoon(store.meta_token_expires_at),
    metaExpiresAt:      store.meta_token_expires_at,
    backfillInProgress: !store.last_postex_sync_at,
    unmatchedCOGSCount: unmatchedCount ?? 0,
    estimatedCOGSCount: fuzzyCount ?? 0,
    periods: {
      today:     { stats: s.today,     comparison: pct(s.today,     s.yesterday), dateRange: { from: todayFrom, to: todayTo } },
      yesterday: { stats: s.yesterday, comparison: pct(s.yesterday, s.dayBefore), dateRange: { from: yestFrom,  to: yestTo  } },
      mtd:       { stats: s.mtd,       comparison: pct(s.mtd,       s.mtdComp),  dateRange: { from: mtdFrom,   to: mtdTo   } },
      lastMonth: { stats: s.lastMonth, comparison: null,                          dateRange: { from: lmFrom,    to: lmTo    } },
    },
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

  const { periods, expensesList, unmatchedCOGSCount, estimatedCOGSCount,
          metaConnected, isMetaExpired, isMetaExpiringSoon, metaExpiresAt,
          backfillInProgress } = data;

  // Empty state: no orders in any period
  const totalOrders = PERIOD_KEYS.reduce(
    (sum, k) => sum + Number(periods[k].stats?.orders ?? 0),
    0
  );
  const isEmpty = totalOrders === 0;

  return (
    <Page>
      <TitleBar title="COD Tracker" />
      <BlockStack gap="400">
        <WarningBanner
          unmatchedCOGSCount={unmatchedCOGSCount}
          estimatedCOGSCount={estimatedCOGSCount}
          metaConnected={metaConnected}
          isMetaExpired={isMetaExpired}
          isMetaExpiringSoon={isMetaExpiringSoon}
          metaExpiresAt={metaExpiresAt}
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
          <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
            {PERIOD_KEYS.map((key) => (
              <KPICard
                key={key}
                period={key}
                stats={periods[key].stats}
                comparison={periods[key].comparison}
                dateRange={periods[key].dateRange}
                onMore={(stats, dateRange, title) =>
                  setDetail({ stats, dateRange, title })
                }
              />
            ))}
          </InlineGrid>
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
