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

  const [productsResult, supabase] = await Promise.all([
    getProductsForCOGS(session).then(p => ({ ok: true as const, data: p })).catch(async (err: Error) => {
      if (err.message === 'SHOPIFY_401') {
        const { sessionStorage } = await import("../shopify.server");
        await sessionStorage.deleteSession(`offline_${shop}`);
        throw new Response(null, { status: 302, headers: { Location: `/auth?shop=${shop}` } });
      }
      console.error("getProductsForCOGS failed:", err.message);
      return { ok: false as const, data: [] as Awaited<ReturnType<typeof getProductsForCOGS>> };
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

  return json({ products: productsResult.data, costsMap });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const supabase = await getSupabaseForStore(shop);

  // ---- collect posted rows ----
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

  // ---- persist + verify BEFORE running the matcher ----
  if (rows.length > 0) {
    const { error: upsertErr, data: upserted } = await supabase
      .from("product_costs")
      .upsert(rows, { onConflict: "store_id,shopify_variant_id" })
      .select("shopify_variant_id");

    if (upsertErr) {
      console.error("[cogs save] upsert failed:", upsertErr);
      return json(
        { success: false, error: "Could not save product costs. Please try again." },
        { status: 500 }
      );
    }
    if ((upserted?.length ?? 0) !== rows.length) {
      console.error(
        `[cogs save] upsert row-count mismatch: sent=${rows.length} received=${upserted?.length ?? 0}`
      );
      return json(
        { success: false, error: "Some costs didn't save. Please try again." },
        { status: 500 }
      );
    }

    // Paranoia readback — confirms the data is durably readable from the DB
    // before we let the matcher run. Catches the theoretical case where the
    // write committed on one pooler connection but readers don't see it yet.
    const variantIds = rows.map(r => r.shopify_variant_id);
    const { data: readback, error: readErr } = await supabase
      .from("product_costs")
      .select("shopify_variant_id")
      .eq("store_id", shop)
      .in("shopify_variant_id", variantIds);

    if (readErr || (readback?.length ?? 0) !== rows.length) {
      console.error(
        `[cogs save] readback mismatch: expected=${rows.length} got=${readback?.length}`,
        readErr
      );
      return json(
        { success: false, error: "Save verification failed. Please try again." },
        { status: 500 }
      );
    }
  }

  // ---- ONLY NOW: run the matcher ----
  const matchResult = await retroactiveCOGSMatch(supabase, shop);

  return json({ success: true, matchResult });
};

export default function COGSPage() {
  const { products, costsMap } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const match = actionData && "matchResult" in actionData ? actionData.matchResult : null;

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
              {actionData?.success && match && (
                <Banner tone="success" onDismiss={() => {}}>
                  {matchSummary(match)}
                </Banner>
              )}
              {actionData && "error" in actionData && actionData.error && (
                <Banner tone="critical">{actionData.error}</Banner>
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

// Renders the rematch result as a human sentence so the merchant sees what
// their save produced without having to refresh the dashboard.
function matchSummary(m: any): string {
  if (!m) return "Product costs saved.";
  if (m.skipped) {
    if (m.reason === "already_running") {
      return "Product costs saved. A previous match is still running — counts will refresh automatically.";
    }
    if (m.reason === "no_costs") {
      return "Product costs saved. Add some costs first to run the matcher.";
    }
    return "Product costs saved.";
  }
  const matched = (m.sku ?? 0) + (m.exact ?? 0);
  const est = (m.fuzzy ?? 0) + (m.sibling_avg ?? 0) + (m.fallback_avg ?? 0);
  const missing = m.none ?? 0;
  const parts = [`Product costs saved. Re-matched ${m.evaluated ?? 0} orders.`];
  if (matched) parts.push(`${matched} exact`);
  if (est) parts.push(`${est} estimated (review)`);
  if (missing) parts.push(`${missing} still missing`);
  return parts.join(" · ");
}
