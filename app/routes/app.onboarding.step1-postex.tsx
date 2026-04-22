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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const supabase = await getSupabaseForStore(session.shop);

  const { data: store } = await supabase
    .from("stores")
    .select("postex_token, postex_merchant_id")
    .eq("store_id", session.shop)
    .single();

  return json({
    postexToken: store?.postex_token ?? "",
    postexMerchantId: store?.postex_merchant_id ?? "",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const token = String(formData.get("postex_token") ?? "").trim();
  const merchantId = String(formData.get("postex_merchant_id") ?? "").trim();

  if (!token) {
    return json({ error: "PostEx API Token is required." });
  }

  const valid = await validateToken(token).catch(() => false);
  if (!valid) {
    return json({ error: "Invalid token. Please check your PostEx credentials." });
  }

  const supabase = await getSupabaseForStore(shop);
  await supabase
    .from("stores")
    .update({ postex_token: token, postex_merchant_id: merchantId, onboarding_step: 2 })
    .eq("store_id", shop);

  // Fire-and-forget historical backfill — do NOT await
  void runHistoricalBackfill({ store_id: shop, postex_token: token });

  return redirect("/app/onboarding/step2-meta");
};

export default function Step1PostEx() {
  const { postexToken, postexMerchantId } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [token, setToken] = useState(postexToken);
  const [merchantId, setMerchantId] = useState(postexMerchantId);

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
            <TextField
              label="Merchant ID"
              name="postex_merchant_id"
              value={merchantId}
              onChange={setMerchantId}
              autoComplete="off"
              helpText="Your PostEx merchant ID."
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
