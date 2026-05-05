import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, Form, useNavigation } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { Page, Layout, Card, BlockStack, Banner } from "@shopify/polaris";
import { TitleBar, SaveBar } from "@shopify/app-bridge-react";
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

  const [{ data: existingCosts }, { data: storeRow }] = await Promise.all([
    supabase
      .from("product_costs")
      .select("shopify_variant_id, unit_cost")
      .eq("store_id", shop),
    supabase
      .from("stores")
      .select("currency")
      .eq("store_id", shop)
      .single(),
  ]);

  const costsMap: Record<string, number> = {};
  for (const row of existingCosts ?? []) {
    costsMap[row.shopify_variant_id] = row.unit_cost;
  }

  return json({
    products: productsResult.data,
    costsMap,
    currency: storeRow?.currency ?? "PKR",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const supabase = await getSupabaseForStore(shop);

  // ---- collect posted rows ----
  // The form only POSTs rows whose value differs from the saved baseline (the
  // SaveBar UI submits dirty rows only). Empty submission = nothing changed.
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

  // Nothing to save → still report success so the UI flashes its banner.
  if (rows.length === 0) {
    return json({ success: true, matchResult: null, savedCount: 0 });
  }

  // ---- persist + verify BEFORE running the matcher ----
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

  // ---- ONLY NOW: run the matcher ----
  const matchResult = await retroactiveCOGSMatch(supabase, shop);

  return json({ success: true, matchResult, savedCount: rows.length });
};

export default function COGSPage() {
  const { products, costsMap, currency } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const formRef = useRef<HTMLFormElement>(null);
  const [dirtyCount, setDirtyCount] = useState(0);
  // Bumping resetKey forces COGSTable to remount with fresh state from costsMap
  // — the cleanest way to implement Discard without lifting all of its
  // collapsibles + per-product state up here.
  const [resetKey, setResetKey] = useState(0);
  const [showSavedBanner, setShowSavedBanner] = useState(false);

  const handleSave = () => formRef.current?.requestSubmit();
  const handleDiscard = () => {
    setResetKey(k => k + 1);
    setDirtyCount(0);
  };

  // After a successful save, briefly flash a confirmation banner. Also
  // bump resetKey so dirtyCount resets to 0 (since the just-saved values
  // are now the new baseline).
  useEffect(() => {
    if (actionData && "success" in actionData && actionData.success) {
      setShowSavedBanner(true);
      const t = setTimeout(() => setShowSavedBanner(false), 4000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const isDirty = dirtyCount > 0;
  // matchResult comes from retroactiveCOGSMatch which returns either
  // { skipped: true, reason } OR { evaluated, updated, ...counts }. The narrow
  // type here just lets us read the fields the banner cares about.
  const rawMatch =
    actionData && "matchResult" in actionData ? actionData.matchResult : null;
  const matchResult = (rawMatch ?? null) as null | {
    skipped?: boolean;
    evaluated?: number;
  };
  const savedCount =
    actionData && "savedCount" in actionData ? actionData.savedCount : 0;

  return (
    <Page
      backAction={{ content: "Settings", url: "/app/settings" }}
      title="Cost of Goods (COGS)"
    >
      <TitleBar title="Cost of Goods (COGS)" />

      {/* App Bridge SaveBar — only opens when at least one cost differs from
          the saved baseline. Discard is wired to remount the table; Save
          delegates to the underlying form's submit so Remix picks it up.
          The button elements are passed through to a `ui-save-bar` web
          component which interprets `variant`/`loading` web-component
          attributes (not standard HTML, but JSX accepts unknown attrs). */}
      <SaveBar id="cogs-save-bar" open={isDirty}>
        <button
          variant="primary"
          loading={saving ? "" : undefined}
          onClick={handleSave}
        >
          {saving ? "Saving…" : `Save ${dirtyCount} change${dirtyCount === 1 ? "" : "s"}`}
        </button>
        <button onClick={handleDiscard} disabled={saving || undefined}>
          Discard
        </button>
      </SaveBar>

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {showSavedBanner && (
              <Banner
                tone="success"
                onDismiss={() => setShowSavedBanner(false)}
              >
                {savedCount} cost{savedCount === 1 ? "" : "s"} saved
                {matchResult && !matchResult.skipped &&
                  ` · ${matchResult.evaluated} order${matchResult.evaluated === 1 ? "" : "s"} recomputed`}
                .
              </Banner>
            )}
            {actionData && "error" in actionData && actionData.error && (
              <Banner tone="critical">{actionData.error}</Banner>
            )}

            <Card>
              <Form method="post" ref={formRef}>
                <COGSTable
                  key={resetKey}
                  products={products}
                  costsMap={costsMap}
                  onDirtyCountChange={setDirtyCount}
                  currency={currency}
                />
              </Form>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
