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
  formatPKTDate,
} from "../lib/dates.server.js";
import { isTokenExpired, isTokenExpiringSoon } from "../lib/meta.server.js";
import KPICard from "../components/KPICard.jsx";
import WarningBanner from "../components/WarningBanner.jsx";
import DetailPanel from "../components/DetailPanel.jsx";
import CityLossPanel from "../components/CityLossPanel.jsx";

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

  const todayFrom    = formatPKTDate(today.start);
  const todayTo      = formatPKTDate(today.end);
  const yestFrom     = formatPKTDate(yesterday.start);
  const yestTo       = formatPKTDate(yesterday.end);
  const mtdFrom      = formatPKTDate(mtd.start);
  const mtdTo        = formatPKTDate(mtd.end);
  const lmFrom       = formatPKTDate(lastMonth.start);
  const lmTo         = formatPKTDate(lastMonth.end);

  // City panel default window — "Maximum" (all-time). 2010-01-01 predates
  // any Pakistani Shopify merchant, and the partial idx_orders_city_terminal
  // index handles the wider range without a seq scan.
  const cityToDate   = todayTo;
  const cityFromDate = "2010-01-01";

  // 3. Parallel RPC calls — 4 stats + 1 banner count + 1 city breakdown
  const [
    todayRes,
    yesterdayRes,
    mtdRes,
    lastMonthRes,
    { count: unmatchedCount },
    cityRes,
  ] = await Promise.all([
    statsRpc(supabase, shop, todayFrom, todayTo, monthlyExp, perOrderExp),
    statsRpc(supabase, shop, yestFrom,  yestTo,  monthlyExp, perOrderExp),
    statsRpc(supabase, shop, mtdFrom,   mtdTo,   monthlyExp, perOrderExp),
    statsRpc(supabase, shop, lmFrom,    lmTo,    monthlyExp, perOrderExp),
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("cogs_match_source", "none"),
    (supabase as any).rpc("get_city_breakdown", {
      p_store_id:  shop,
      p_from_date: cityFromDate,
      p_to_date:   cityToDate,
    }),
  ]);

  const s = {
    today:     todayRes.data?.[0]     ?? null,
    yesterday: yesterdayRes.data?.[0] ?? null,
    mtd:       mtdRes.data?.[0]       ?? null,
    lastMonth: lastMonthRes.data?.[0] ?? null,
  };

  return json({
    expensesList: expenses,
    metaConnected:      !!store.meta_access_token,
    isMetaExpired:      isTokenExpired(store.meta_token_expires_at),
    isMetaExpiringSoon: isTokenExpiringSoon(store.meta_token_expires_at),
    metaExpiresAt:      store.meta_token_expires_at,
    backfillInProgress: !store.last_postex_sync_at,
    unmatchedCOGSCount: unmatchedCount ?? 0,
    periods: {
      today:     { stats: s.today,     dateRange: { from: todayFrom, to: todayTo } },
      yesterday: { stats: s.yesterday, dateRange: { from: yestFrom,  to: yestTo  } },
      mtd:       { stats: s.mtd,       dateRange: { from: mtdFrom,   to: mtdTo   } },
      lastMonth: { stats: s.lastMonth, dateRange: { from: lmFrom,    to: lmTo    } },
    },
    cityBreakdown: {
      cities: cityRes.data ?? [],
      from:   cityFromDate,
      to:     cityToDate,
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

  const { periods, expensesList, unmatchedCOGSCount,
          metaConnected, isMetaExpired, isMetaExpiringSoon, metaExpiresAt,
          backfillInProgress, cityBreakdown } = data;

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
          <>
            <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
              {PERIOD_KEYS.map((key) => (
                <KPICard
                  key={key}
                  period={key}
                  stats={periods[key].stats}
                  dateRange={periods[key].dateRange}
                  onMore={(stats, dateRange, title) =>
                    setDetail({ stats, dateRange, title })
                  }
                />
              ))}
            </InlineGrid>

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
