import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  Form,
  useNavigation,
} from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Banner,
  FormLayout,
  RadioButton,
  Badge,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { ensurePoolSeeded } from "../lib/demo-pool.server.js";

type Expense = { id: string; name: string; amount: number; type: "monthly" | "per_order" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const supabase = await getSupabaseForStore(session.shop);

  const { data: expenses } = await supabase
    .from("store_expenses")
    .select("id, name, amount, type")
    .eq("store_id", session.shop)
    .order("created_at");

  return json({ expenses: (expenses ?? []) as Expense[] });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const supabase = await getSupabaseForStore(shop);

  if (intent === "add_expense") {
    const name = String(formData.get("name") ?? "").trim();
    const amount = Number(formData.get("amount")) || 0;
    const type = String(formData.get("type") ?? "monthly");

    if (!name) return json({ error: "Expense name is required." });
    if (!["monthly", "per_order"].includes(type)) return json({ error: "Invalid expense type." });

    await supabase.from("store_expenses").insert({ store_id: shop, name, amount, type });
    return json({ intent: "add_expense", error: null });
  }

  if (intent === "delete_expense") {
    const id = String(formData.get("id") ?? "");
    await supabase.from("store_expenses").delete().eq("id", id).eq("store_id", shop);
    return json({ error: null });
  }

  if (intent === "finish") {
    await supabase
      .from("stores")
      .update({
        onboarding_complete: true,
        onboarding_step: 4,
        // Mark first sync as "done" so the dashboard's backfill banner / empty
        // state never appears for demo stores. Otherwise the merchant lands on
        // an empty dashboard while we backfill.
      })
      .eq("store_id", shop);

    // Demo seed: 90 days back through today, fabricated from real Shopify
    // catalog. Triggered async so the merchant isn't blocked on the redirect.
    // We also stamp last_postex_sync_at so the dashboard treats the store as
    // "ready" instead of showing the syncing banner.
    const { data: storeRow } = await supabase
      .from("stores")
      .select("is_demo")
      .eq("store_id", shop)
      .single();

    if (storeRow?.is_demo) {
      // Demo stores share the pool — no per-store fabrication. The pool
      // was seeded asynchronously back in step 1 (ensurePoolSeeded);
      // here we just guarantee it's ready in case the merchant flew
      // through onboarding faster than the seed could finish.
      void (async () => {
        try {
          await ensurePoolSeeded(supabase);
        } catch (err) {
          console.error(`[demo onboard ${shop}] ensurePoolSeeded failed:`, err);
        }
        // Stamp the sync timestamp so the dashboard's loader banner
        // disappears and the merchant lands on a populated dashboard.
        await supabase
          .from("stores")
          .update({ last_postex_sync_at: new Date().toISOString() })
          .eq("store_id", shop);
      })();
    }

    return redirect("/app");
  }

  return json({ error: "Unknown action." });
};

export default function Step4Expenses() {
  const { expenses } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const currentIntent = navigation.formData?.get("intent") as string | undefined;

  const [name, setName] = useState("");
  const [amount, setAmount] = useState("0");
  const [expType, setExpType] = useState<"monthly" | "per_order">("monthly");

  useEffect(() => {
    if ((actionData as any)?.intent === "add_expense" && (actionData as any)?.error === null) {
      setName("");
      setAmount("0");
      setExpType("monthly");
    }
  }, [actionData]);

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Set Business Expenses
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Add your fixed business expenses (e.g. rent, salaries, packaging).
            Monthly expenses are charged in full on the 1st of each month. Per Order expenses
            multiply by the number of delivered orders.
          </Text>
        </BlockStack>

        {actionData?.error && (
          <Banner tone="critical">{actionData.error}</Banner>
        )}

        {/* Existing expenses list */}
        {expenses.length > 0 && (
          <BlockStack gap="200">
            <Text as="p" variant="headingSm">Your expenses</Text>
            {expenses.map((exp) => (
              <InlineStack key={exp.id} align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" variant="bodyMd">{exp.name}</Text>
                  <Badge tone="info">
                    {exp.type === "monthly" ? "Monthly" : "Per Order"}
                  </Badge>
                  <Text as="span" variant="bodyMd" tone="subdued">
                    PKR {Number(exp.amount).toLocaleString()}
                  </Text>
                </InlineStack>
                <Form method="post">
                  <input type="hidden" name="intent" value="delete_expense" />
                  <input type="hidden" name="id" value={exp.id} />
                  <Button
                    submit
                    variant="plain"
                    tone="critical"
                    loading={saving && currentIntent === "delete_expense"}
                  >
                    Remove
                  </Button>
                </Form>
              </InlineStack>
            ))}
          </BlockStack>
        )}

        {expenses.length === 0 && (
          <Text as="p" variant="bodyMd" tone="subdued">
            No expenses added yet. Add one below, or skip if you don't track expenses.
          </Text>
        )}

        <Divider />

        {/* Add expense form */}
        <Text as="p" variant="headingSm">Add an expense</Text>
        <Form method="post">
          <input type="hidden" name="intent" value="add_expense" />
          <FormLayout>
            <TextField
              label="Name"
              name="name"
              value={name}
              onChange={setName}
              placeholder="e.g. Warehouse Rent"
              autoComplete="off"
            />
            <TextField
              label="Amount (PKR)"
              name="amount"
              value={amount}
              onChange={setAmount}
              type="number"
              min="0"
              autoComplete="off"
            />
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">Expense Type</Text>
              <RadioButton
                label="Per Month"
                helpText="Full amount charged on the 1st of each month."
                id="add_monthly"
                name="type"
                value="monthly"
                checked={expType === "monthly"}
                onChange={() => setExpType("monthly")}
              />
              <RadioButton
                label="Per Order"
                helpText="Multiplied by the number of delivered orders in each period."
                id="add_per_order"
                name="type"
                value="per_order"
                checked={expType === "per_order"}
                onChange={() => setExpType("per_order")}
              />
            </BlockStack>
            <Button
              submit
              variant="secondary"
              loading={saving && currentIntent === "add_expense"}
            >
              + Add Expense
            </Button>
          </FormLayout>
        </Form>

        <Divider />

        {/* Finish / skip */}
        <Form method="post">
          <input type="hidden" name="intent" value="finish" />
          <InlineStack gap="300">
            <Button
              submit
              variant="primary"
              loading={saving && currentIntent === "finish"}
            >
              Finish Setup
            </Button>
            {expenses.length === 0 && (
              <Text as="span" variant="bodyMd" tone="subdued">
                or{" "}
                <Button
                  submit
                  variant="plain"
                  loading={saving && currentIntent === "finish"}
                >
                  skip for now
                </Button>
              </Text>
            )}
          </InlineStack>
        </Form>
      </BlockStack>
    </Card>
  );
}
