import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useActionData, Form, useNavigation } from "@remix-run/react";
import { Card, BlockStack, InlineStack, Text, Button } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { ensurePoolSeeded } from "../lib/demo-pool.server.js";
import { handleExpenseAction, summarizeExpenses } from "../lib/expense-actions.server.js";
import ExpenseManager from "../components/ExpenseManager.jsx";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const supabase = await getSupabaseForStore(session.shop);

  const [{ data: expenses }, { data: storeRow }] = await Promise.all([
    supabase
      .from("store_expenses")
      .select("id, series_id, name, amount, kind, is_variable, pct_base, effective_from, effective_to")
      .eq("store_id", session.shop)
      .order("created_at"),
    supabase
      .from("stores")
      .select("currency")
      .eq("store_id", session.shop)
      .single(),
  ]);

  return json({
    expenses: summarizeExpenses(expenses ?? []),
    currency: storeRow?.currency ?? "PKR",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const supabase = await getSupabaseForStore(shop);

  if (intent === "finish") {
    await supabase
      .from("stores")
      .update({ onboarding_complete: true, onboarding_step: 4 })
      .eq("store_id", shop);

    const { data: storeRow } = await supabase
      .from("stores")
      .select("is_demo")
      .eq("store_id", shop)
      .single();

    if (storeRow?.is_demo) {
      // Demo stores share the pool — seed it (idempotent) and stamp the
      // sync timestamp so the dashboard lands populated, not "syncing".
      void (async () => {
        try {
          await ensurePoolSeeded(supabase);
        } catch (err) {
          console.error(`[demo onboard ${shop}] ensurePoolSeeded failed:`, err);
        }
        await supabase
          .from("stores")
          .update({ last_postex_sync_at: new Date().toISOString() })
          .eq("store_id", shop);
      })();
    }

    return redirect("/app");
  }

  const exp = await handleExpenseAction(supabase, shop, formData);
  if (exp.handled) return json(exp.result);

  return json({ intent, error: "Unknown action." });
};

export default function Step4Expenses() {
  const { expenses, currency } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const finishing =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "finish";

  return (
    <BlockStack gap="400">
      <ExpenseManager
        expenses={expenses}
        currency={currency}
        actionData={actionData}
        title="Set your business expenses"
        subtitle="Add rent, salaries, packaging, payment fees — anything that eats into profit. You can change these any time in Settings."
      />

      <Card>
        <Form method="post">
          <input type="hidden" name="intent" value="finish" />
          <InlineStack gap="300" blockAlign="center">
            <Button submit variant="primary" loading={finishing}>
              Finish setup
            </Button>
            {expenses.length === 0 && (
              <Text as="span" variant="bodySm" tone="subdued">
                or skip — you can add expenses later in Settings
              </Text>
            )}
          </InlineStack>
        </Form>
      </Card>
    </BlockStack>
  );
}
