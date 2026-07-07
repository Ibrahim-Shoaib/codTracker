import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Icon,
} from "@shopify/polaris";
import { CalendarIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { handleExpenseAction, summarizeExpenses } from "../lib/expense-actions.server.js";
import { summarizeImpact } from "../lib/expense-impact.server.js";
import { getMTD, formatDate } from "../lib/dates.server.js";
import { effectiveStoreId } from "../lib/demo-pool.server.js";
import { getStatsAdapter } from "../lib/stats-adapter.server.js";
import { formatMoney } from "../lib/format.js";
import ExpenseManager from "../components/ExpenseManager.jsx";

// ─── Loader ───────────────────────────────────────────────────────────────────
//
// Two things: the expense list (for the manager) and a month-to-date
// "impact" figure that reconciles exactly with the dashboard's MTD card.
// We compute the impact through the same path the dashboard uses:
//   • postex / demo → get_expense_breakdown RPC (orders from the pool for
//     demo stores via effectiveStoreId; expenses always the merchant's own
//     shop via p_expense_store_id).
//   • shopify_direct → the stats adapter's shared JS allocator, since the
//     orders aren't in the `orders` table.
// If anything in the impact path fails we return impact:null and the page
// hides the card — the manager still works, and we never show a wrong
// money number (the app's standing rule).

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const supabase = await getSupabaseForStore(shop);

  const [{ data: store }, { data: rawExpenses }] = await Promise.all([
    supabase
      .from("stores")
      .select("currency, is_demo, ingest_mode, timezone")
      .eq("store_id", shop)
      .single(),
    supabase
      .from("store_expenses")
      .select("id, series_id, name, amount, kind, is_variable, pct_base, effective_from, effective_to")
      .eq("store_id", shop)
      .order("created_at"),
  ]);

  const currency = store?.currency ?? "PKR";
  const expenseRows = rawExpenses ?? [];
  const expenses = summarizeExpenses(expenseRows);

  let impact: null | {
    total: number; fixed: number; perOrder: number; percent: number;
    anyEstimated: boolean; count: number; monthLabel: string;
  } = null;

  if (expenseRows.length > 0) {
    try {
      const tz = store?.timezone ?? "Asia/Karachi";
      const mtd = getMTD(tz);
      const from = formatDate(mtd.start, tz);
      const to = formatDate(mtd.end, tz);
      const dataStoreId = effectiveStoreId(store, shop);

      let breakdown: any[] = [];
      if (store?.ingest_mode === "shopify_direct") {
        const adapter = await getStatsAdapter(store, session);
        const res = await adapter.getDashboardStats({
          periods: { mtd: { from, toExclusive: to, to } },
          expenses: expenseRows,
          expenseStoreId: shop,
        });
        breakdown = res?.mtd?._expenseBreakdown ?? [];
      } else {
        const { data } = await (supabase as any).rpc("get_expense_breakdown", {
          p_store_id: dataStoreId,
          p_from_date: from,
          p_to_date: to,
          p_expense_store_id: shop,
        });
        breakdown = data ?? [];
      }

      const monthLabel = new Date(`${from}T00:00:00Z`).toLocaleDateString("en", {
        month: "long",
        year: "numeric",
      });
      impact = { ...summarizeImpact(breakdown), monthLabel };
    } catch (err) {
      console.error(`[expenses ${shop}] impact computation failed:`, err);
      impact = null;
    }
  }

  return json({ expenses, currency, impact });
};

// ─── Action ───────────────────────────────────────────────────────────────────
// The shared ExpenseManager posts its forms to the current route, so this
// page owns the same mutation handler the Settings page and onboarding
// step 4 use. One code path — the three screens can't drift.

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const supabase = await getSupabaseForStore(shop);

  const exp = await handleExpenseAction(supabase, shop, formData);
  if (exp.handled) return json(exp.result);

  return json({ intent: "", error: "Unknown action." });
};

// ─── Component ────────────────────────────────────────────────────────────────

const SEG = {
  fixed:   { label: "Fixed",     fill: "var(--p-color-bg-fill-info)" },
  perOrder:{ label: "Per order", fill: "var(--p-color-bg-fill-success)" },
  percent: { label: "% fees",    fill: "var(--p-color-bg-fill-magic)" },
} as const;

function ProportionBar({ parts }: { parts: Array<{ key: keyof typeof SEG; value: number }> }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: 10,
        borderRadius: "var(--p-border-radius-full)",
        overflow: "hidden",
        background: "var(--p-color-bg-surface-secondary)",
        gap: total > 0 ? 2 : 0,
      }}
    >
      {total > 0 &&
        parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <div
              key={p.key}
              title={`${SEG[p.key].label}: ${Math.round((p.value / total) * 100)}%`}
              style={{
                width: `${(p.value / total) * 100}%`,
                background: SEG[p.key].fill,
              }}
            />
          ))}
    </div>
  );
}

function Legend({
  parts,
  fmt,
}: {
  parts: Array<{ key: keyof typeof SEG; value: number }>;
  fmt: (n: number) => string;
}) {
  return (
    <InlineStack gap="600" wrap>
      {parts.map((p) => (
        <InlineStack key={p.key} gap="200" blockAlign="center" wrap={false}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "var(--p-border-radius-full)",
              background: SEG[p.key].fill,
              flex: "0 0 auto",
            }}
          />
          <BlockStack gap="0">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {fmt(p.value)}
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {SEG[p.key].label}
            </Text>
          </BlockStack>
        </InlineStack>
      ))}
    </InlineStack>
  );
}

export default function ExpensesPage() {
  const { expenses, currency, impact } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const fmt = (n: number) => formatMoney(n, currency, { nullDisplay: "—" });

  const parts = impact
    ? ([
        { key: "fixed",    value: impact.fixed },
        { key: "perOrder", value: impact.perOrder },
        { key: "percent",  value: impact.percent },
      ] as Array<{ key: keyof typeof SEG; value: number }>)
    : [];

  return (
    <Page>
      <TitleBar title="Expenses" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {impact && (
              <Card>
                <BlockStack gap="500">
                  <InlineStack align="space-between" blockAlign="start" wrap={false}>
                    <BlockStack gap="100">
                      <InlineStack gap="150" blockAlign="center">
                        <Icon source={CalendarIcon} tone="subdued" />
                        <Text as="span" variant="bodySm" tone="subdued" fontWeight="medium">
                          Expense impact &middot; {impact.monthLabel}
                        </Text>
                      </InlineStack>
                      <Text as="p" variant="heading2xl">{fmt(impact.total)}</Text>
                    </BlockStack>
                    {impact.anyEstimated && (
                      <Badge tone="attention">Estimated</Badge>
                    )}
                  </InlineStack>

                  <BlockStack gap="300">
                    <ProportionBar parts={parts} />
                    <Legend parts={parts} fmt={fmt} />
                  </BlockStack>
                </BlockStack>
              </Card>
            )}

            <ExpenseManager
              expenses={expenses}
              currency={currency}
              actionData={actionData}
              title="Business expenses"
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
