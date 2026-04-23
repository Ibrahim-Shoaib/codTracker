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
  getDaysInPeriod,
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

// Format "Apr 22"
function fmtDay(dateStr: string) {
  const [, m, d] = dateStr.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

// Format "Apr 1–22" or "Mar 1–31"
function fmtRange(fromStr: string, toStr: string) {
  const [y1, m1, d1] = fromStr.split("-");
  const [y2, m2, d2] = toStr.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mLabel = months[parseInt(m1, 10) - 1];
  if (m1 === m2 && y1 === y2) {
    return `${mLabel} ${parseInt(d1, 10)}–${parseInt(d2, 10)}`;
  }
  return `${mLabel} ${parseInt(d1, 10)} – ${months[parseInt(m2, 10) - 1]} ${parseInt(d2, 10)}`;
}

function statsRpc(supabase: ReturnType<typeof getSupabaseForStore> extends Promise<infer T> ? T : never, shop: string, from: string, to: string, monthlyExp: number, perOrderExp: number, days: number) {
  return (supabase as any).rpc("get_dashboard_stats", {
    p_store_id:           shop,
    p_from_date:          from,
    p_to_date:            to,
    p_monthly_expenses:   monthlyExp,
    p_per_order_expenses: perOrderExp,
    p_days_in_period:     days,
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

  // 3. Parallel RPC calls — 6 stats + 1 count
  //    yesterday doubles as Today's comparison period
  const [
    todayRes,
    yesterdayRes,   // also used as today's prior comparison
    dayBeforeRes,
    mtdRes,
    mtdCompRes,
    lastMonthRes,
    { count: unmatchedCount },
  ] = await Promise.all([
    statsRpc(supabase, shop, todayFrom,   todayTo,   monthlyExp, perOrderExp, getDaysInPeriod(today.start,      today.end)),
    statsRpc(supabase, shop, yestFrom,    yestTo,    monthlyExp, perOrderExp, getDaysInPeriod(yesterday.start,  yesterday.end)),
    statsRpc(supabase, shop, dayBefFrom,  dayBefTo,  monthlyExp, perOrderExp, getDaysInPeriod(dayBefore.start,  dayBefore.end)),
    statsRpc(supabase, shop, mtdFrom,     mtdTo,     monthlyExp, perOrderExp, getDaysInPeriod(mtd.start,        mtd.end)),
    statsRpc(supabase, shop, mtdCompFrom, mtdCompTo, monthlyExp, perOrderExp, getDaysInPeriod(mtdComp.start,    mtdComp.end)),
    statsRpc(supabase, shop, lmFrom,      lmTo,      monthlyExp, perOrderExp, getDaysInPeriod(lastMonth.start,  lastMonth.end)),
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("cogs_matched", false),
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
    sellableReturnsPct: store.sellable_returns_pct ?? 100,
    metaConnected:      !!store.meta_access_token,
    isMetaExpired:      isTokenExpired(store.meta_token_expires_at),
    isMetaExpiringSoon: isTokenExpiringSoon(store.meta_token_expires_at),
    metaExpiresAt:      store.meta_token_expires_at,
    backfillInProgress: !store.last_postex_sync_at,
    unmatchedCOGSCount: unmatchedCount ?? 0,
    periods: {
      today: {
        stats: s.today,
        comparison: pct(s.today, s.yesterday),
        dateLabel: fmtDay(todayFrom),
        dateRange: { from: todayFrom, to: todayTo },
      },
      yesterday: {
        stats: s.yesterday,
        comparison: pct(s.yesterday, s.dayBefore),
        dateLabel: fmtDay(yestFrom),
        dateRange: { from: yestFrom, to: yestTo },
      },
      mtd: {
        stats: s.mtd,
        comparison: pct(s.mtd, s.mtdComp),
        dateLabel: fmtRange(mtdFrom, mtdTo),
        dateRange: { from: mtdFrom, to: mtdTo },
      },
      lastMonth: {
        stats: s.lastMonth,
        comparison: null,
        dateLabel: fmtRange(lmFrom, lmTo),
        dateRange: { from: lmFrom, to: lmTo },
      },
    },
  });
};

const PERIOD_KEYS = ["today", "yesterday", "mtd", "lastMonth"] as const;
type PeriodKey = typeof PERIOD_KEYS[number];

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const [openDetail, setOpenDetail] = useState<PeriodKey | null>(null);

  if ("redirectTo" in data) {
    return <Navigate to={(data as { redirectTo: string }).redirectTo} replace />;
  }

  const { periods, expensesList, sellableReturnsPct, unmatchedCOGSCount,
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
                dateLabel={periods[key].dateLabel}
                onMore={() => setOpenDetail(key)}
              />
            ))}
          </InlineGrid>
        )}
      </BlockStack>

      {/* Detail panel for whichever period is open */}
      {openDetail && (
        <DetailPanel
          period={openDetail}
          stats={periods[openDetail].stats}
          dateRange={periods[openDetail].dateRange}
          sellableReturnsPct={sellableReturnsPct}
          expensesList={expensesList}
          open={!!openDetail}
          onClose={() => setOpenDetail(null)}
        />
      )}
    </Page>
  );
}
