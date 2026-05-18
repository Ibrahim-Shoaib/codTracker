import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Box,
  Text,
  Badge,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { handleExpenseAction, summarizeExpenses } from "../lib/expense-actions.server.js";
import { summarizeImpact } from "../lib/expense-impact.server.js";
import { getMTDPKT, formatPKTDate } from "../lib/dates.server.js";
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
      .select("currency, is_demo, ingest_mode")
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
      const mtd = getMTDPKT();
      const from = formatPKTDate(mtd.start);
      const to = formatPKTDate(mtd.end);
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

function ImpactStat({ label, value }: { label: string; value: string }) {
  return (
    <BlockStack gap="050">
      <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
      <Text as="span" variant="bodyMd" fontWeight="semibold">{value}</Text>
    </BlockStack>
  );
}

export default function ExpensesPage() {
  const { expenses, currency, impact } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const fmt = (n: number) => formatMoney(n, currency, { nullDisplay: "—" });

  return (
    <Page
      backAction={{ content: "Settings", url: "/app/settings" }}
      title="Expenses"
    >
      <TitleBar title="Expenses" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {impact && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center" wrap={false}>
                    <Text as="h2" variant="headingSm" tone="subdued">
                      This month&rsquo;s expense impact &middot; {impact.monthLabel}
                    </Text>
                    {impact.anyEstimated && (
                      <Badge tone="attention">Includes estimates</Badge>
                    )}
                  </InlineStack>

                  <Text as="p" variant="heading2xl">{fmt(impact.total)}</Text>

                  <Box
                    background="bg-surface-secondary"
                    padding="300"
                    borderRadius="200"
                  >
                    <InlineStack gap="600" blockAlign="center" wrap>
                      <ImpactStat label="Fixed monthly" value={fmt(impact.fixed)} />
                      <ImpactStat label="Per delivered order" value={fmt(impact.perOrder)} />
                      <ImpactStat label="Percentage fees" value={fmt(impact.percent)} />
                    </InlineStack>
                  </Box>

                  <Divider />

                  <Text as="p" variant="bodySm" tone="subdued">
                    Expenses are subtracted from gross profit to give your true
                    net profit. These exact figures flow into every period on
                    your dashboard{impact.anyEstimated
                      ? " — amounts marked “Monthly” still use last month’s value until you confirm this month."
                      : "."}
                  </Text>
                </BlockStack>
              </Card>
            )}

            <ExpenseManager
              expenses={expenses}
              currency={currency}
              actionData={actionData}
              title="Business expenses"
              subtitle="Rent, salaries, packaging and payment fees — anything that eats into profit. Changes apply across every dashboard period."
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
