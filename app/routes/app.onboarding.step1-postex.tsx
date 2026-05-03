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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { validateToken } from "../lib/postex.server.js";
import { runHistoricalBackfill } from "../lib/backfill.server.js";
import { fixZeroInvoicePayments } from "../lib/invoice-fix.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const supabase = await getSupabaseForStore(session.shop);

  const { data: store } = await supabase
    .from("stores")
    .select("postex_token")
    .eq("store_id", session.shop)
    .single();

  return json({
    postexToken: store?.postex_token ?? "",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const token = String(formData.get("postex_token") ?? "").trim();

  if (!token) {
    return json({ error: "PostEx API Token is required." });
  }

  // Demo trigger: a magic env-var token flips the store into demo mode and
  // skips the real PostEx validation + historical backfill. The merchant
  // (and anyone watching) sees an identical flow — no badge, no banner —
  // they advance to step 2 normally and Meta will be connected for real.
  // The actual order data is fabricated at the end of step 4.
  const demoKey = process.env.DEMO_POSTEX_KEY;
  if (demoKey && token === demoKey) {
    const supabase = await getSupabaseForStore(shop);
    await supabase
      .from("stores")
      .update({
        postex_token: token,    // stored but never used — cron skips is_demo stores
        is_demo: true,
        onboarding_step: 2,
      })
      .eq("store_id", shop);
    return redirect("/app/onboarding/step2-meta");
  }

  const valid = await validateToken(token).catch(() => false);
  if (!valid) {
    return json({ error: "Invalid token. Please check your PostEx credentials." });
  }

  const supabase = await getSupabaseForStore(shop);
  await supabase
    .from("stores")
    .update({ postex_token: token, onboarding_step: 2 })
    .eq("store_id", shop);

  void runHistoricalBackfill({ store_id: shop, postex_token: token });
  void fixZeroInvoicePayments(await getSupabaseForStore(shop), shop, session);

  return redirect("/app/onboarding/step2-meta");
};

export default function Step1PostEx() {
  const { postexToken } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [token, setToken] = useState(postexToken);

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Connect PostEx
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Enter your PostEx API credentials. We'll validate the token and
            start syncing your order history.
          </Text>
        </BlockStack>

        {actionData?.error && (
          <Banner tone="critical">{actionData.error}</Banner>
        )}

        <Form method="post">
          <FormLayout>
            <TextField
              label="PostEx API Token"
              name="postex_token"
              value={token}
              onChange={setToken}
              autoComplete="off"
              type="password"
              helpText="Found in your PostEx merchant portal under API settings."
            />
            <Button submit variant="primary" loading={saving}>
              Save & Continue
            </Button>
          </FormLayout>
        </Form>
      </BlockStack>
    </Card>
  );
}
