import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  Form,
  useNavigation,
} from "@remix-run/react";
import { Card, BlockStack, Text, Button, Banner, InlineStack } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { getProductsForCOGS } from "../lib/shopify.server.js";
import { retroactiveCOGSMatch } from "../lib/sync.server.js";
import COGSTable from "../components/COGSTable.jsx";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const metaConnected = url.searchParams.get("meta") === "connected";

  const [productsResult, supabase] = await Promise.all([
    getProductsForCOGS(session).then(p => ({ ok: true as const, data: p, error: null as string | null })).catch(async (err: Error) => {
      if (err.message === 'SHOPIFY_401') {
        // Stale/revoked access token — delete session and force re-auth
        const { sessionStorage } = await import("../shopify.server");
        await sessionStorage.deleteSession(`offline_${shop}`);
        throw new Response(null, { status: 302, headers: { Location: `/auth?shop=${shop}` } });
      }
      console.error("getProductsForCOGS failed:", err.message);
      return { ok: false as const, data: [] as Awaited<ReturnType<typeof getProductsForCOGS>>, error: err.message };
    }),
    getSupabaseForStore(shop),
  ]);

  const { data: existingCosts } = await supabase
    .from("product_costs")
    .select("shopify_variant_id, unit_cost");

  const costsMap: Record<string, number> = {};
  for (const row of existingCosts ?? []) {
    costsMap[row.shopify_variant_id] = row.unit_cost;
  }

  return json({ products: productsResult.data, productsError: productsResult.error, costsMap, metaConnected });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  const supabase = await getSupabaseForStore(shop);

  // Collect all cost_<variantId> fields and build upsert rows
  const rows: Array<{
    store_id: string;
    shopify_variant_id: string;
    shopify_product_id: string;
    sku: string;
    product_title: string;
    variant_title: string;
    unit_cost: number;
    updated_at: string;
  }> = [];

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("cost_")) continue;
    const variantId = key.slice(5); // strip "cost_"
    rows.push({
      store_id: shop,
      shopify_variant_id: variantId,
      shopify_product_id: String(formData.get(`product_${variantId}`) ?? ""),
      sku: String(formData.get(`sku_${variantId}`) ?? ""),
      product_title: String(formData.get(`ptitle_${variantId}`) ?? ""),
      variant_title: String(formData.get(`vtitle_${variantId}`) ?? ""),
      unit_cost: Number(value) || 0,
      updated_at: new Date().toISOString(),
    });
  }

  if (rows.length > 0) {
    await supabase
      .from("product_costs")
      .upsert(rows, { onConflict: "store_id,shopify_variant_id" });
  }

  // Fire-and-forget retroactive COGS matching on all existing unmatched orders
  void retroactiveCOGSMatch(supabase, shop);

  await supabase
    .from("stores")
    .update({ onboarding_step: 4 })
    .eq("store_id", shop);

  return redirect("/app/onboarding/step4-expenses");
};

export default function Step3COGS() {
  const { products, costsMap, metaConnected, productsError } = useLoaderData<typeof loader>();
  // productsError is the raw error message string (null when products loaded OK)
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Set Cost of Goods (COGS)
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Enter the cost you pay per unit for each product variant. This is
            used to calculate your gross profit. You can update these anytime
            in Settings.
          </Text>
        </BlockStack>

        {metaConnected && (
          <Banner tone="success">Meta Ads connected successfully.</Banner>
        )}

        {productsError && (
          <Banner tone="critical">
            Could not load products from Shopify. Please refresh the page to try again.
            {" "}({productsError})
          </Banner>
        )}

        {actionData && "error" in actionData && (
          <Banner tone="critical">{(actionData as { error: string }).error}</Banner>
        )}

        <Form method="post">
          <BlockStack gap="400">
            <COGSTable products={products} costsMap={costsMap} />
            <InlineStack>
              <Button submit variant="primary" loading={saving}>
                Save & Continue
              </Button>
            </InlineStack>
          </BlockStack>
        </Form>
      </BlockStack>
    </Card>
  );
}
