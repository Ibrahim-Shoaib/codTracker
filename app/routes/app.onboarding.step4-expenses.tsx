import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  Form,
  useNavigation,
} from "@remix-run/react";
import { useState } from "react";
import {
  Card,
  BlockStack,
  Text,
  TextField,
  Button,
  Banner,
  FormLayout,
  RadioButton,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const supabase = await getSupabaseForStore(session.shop);

  const { data: store } = await supabase
    .from("stores")
    .select("expenses_amount, expenses_type")
    .eq("store_id", session.shop)
    .single();

  return json({
    expensesAmount: String(store?.expenses_amount ?? "0"),
    expensesType: (store?.expenses_type ?? "monthly") as "monthly" | "per_order",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const amount = Number(formData.get("expenses_amount")) || 0;
  const type = String(formData.get("expenses_type") ?? "monthly");

  if (!["monthly", "per_order"].includes(type)) {
    return json({ error: "Invalid expense type." });
  }

  const supabase = await getSupabaseForStore(shop);
  await supabase
    .from("stores")
    .update({
      expenses_amount: amount,
      expenses_type: type,
      onboarding_complete: true,
      onboarding_step: 4,
    })
    .eq("store_id", shop);

  return redirect("/app");
};

export default function Step4Expenses() {
  const { expensesAmount, expensesType } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [expType, setExpType] = useState<"monthly" | "per_order">(expensesType);
  const [amount, setAmount] = useState(expensesAmount);

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Set Business Expenses
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Enter your fixed business expenses (e.g. rent, salaries, utilities).
            Per Month expenses are prorated across each time period. Per Order
            expenses multiply by the number of delivered orders.
          </Text>
        </BlockStack>

        {actionData?.error && (
          <Banner tone="critical">{actionData.error}</Banner>
        )}

        <Form method="post">
          <FormLayout>
            <TextField
              label="Expense Amount (PKR)"
              name="expenses_amount"
              value={amount}
              onChange={setAmount}
              type="number"
              min="0"
              autoComplete="off"
              helpText="Enter 0 if you don't want to track expenses right now."
            />
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                Expense Type
              </Text>
              <RadioButton
                label="Per Month"
                helpText="Prorated across each time period (e.g. today = 1/30 of monthly amount)."
                id="monthly"
                name="expenses_type"
                value="monthly"
                checked={expType === "monthly"}
                onChange={() => setExpType("monthly")}
              />
              <RadioButton
                label="Per Order"
                helpText="Multiplied by the number of delivered orders in each period."
                id="per_order"
                name="expenses_type"
                value="per_order"
                checked={expType === "per_order"}
                onChange={() => setExpType("per_order")}
              />
            </BlockStack>
            <Button submit variant="primary" loading={saving}>
              Finish Setup
            </Button>
          </FormLayout>
        </Form>
      </BlockStack>
    </Card>
  );
}
