import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, Form, useNavigation } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, InlineStack, Button, Banner } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { getProductsForCOGS } from "../lib/shopify.server.js";
import { retroactiveCOGSMatch } from "../lib/sync.server.js";
import COGSTable from "../components/COGSTable.jsx";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [products, supabase] = await Promise.all([
    getProductsForCOGS(session),
    getSupabaseForStore(shop),
  ]);

  const { data: existingCosts } = await supabase
    .from("product_costs")
    .select("shopify_variant_id, unit_cost");

  const costsMap: Record<string, number> = {};
  for (const row of existingCosts ?? []) {
    costsMap[row.shopify_variant_id] = row.unit_cost;
  }

  return json({ products, costsMap });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const supabase = await getSupabaseForStore(shop);

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
    const variantId = key.slice(5);
    rows.push({
      store_id:           shop,
      shopify_variant_id: variantId,
      shopify_product_id: String(formData.get(`product_${variantId}`) ?? ""),
      sku:                String(formData.get(`sku_${variantId}`) ?? ""),
      product_title:      String(formData.get(`ptitle_${variantId}`) ?? ""),
      variant_title:      String(formData.get(`vtitle_${variantId}`) ?? ""),
      unit_cost:          Number(value) || 0,
      updated_at:         new Date().toISOString(),
    });
  }

  if (rows.length > 0) {
    await supabase
      .from("product_costs")
      .upsert(rows, { onConflict: "store_id,shopify_variant_id" });
  }

  void retroactiveCOGSMatch(supabase, shop, session);

  return json({ success: true });
};

export default function COGSPage() {
  const { products, costsMap } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  return (
    <Page
      backAction={{ content: "Settings", url: "/app/settings" }}
      title="Cost of Goods (COGS)"
    >
      <TitleBar title="Cost of Goods (COGS)" />
      <Layout>
        <Layout.Section>
          <Form method="post">
            <BlockStack gap="400">
              {actionData?.success && (
                <Banner tone="success" onDismiss={() => {}}>
                  Product costs saved successfully.
                </Banner>
              )}

              <Card>
                <BlockStack gap="400">
                  <COGSTable products={products} costsMap={costsMap} />
                </BlockStack>
              </Card>

              <InlineStack align="end">
                <Button submit variant="primary" loading={saving}>
                  Save COGS
                </Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
