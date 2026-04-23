import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  Form,
  useNavigation,
} from "@remix-run/react";
import { useEffect, useState } from "react";
import { randomBytes } from "crypto";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Banner,
  FormLayout,
  RadioButton,
  Select,
  Badge,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { validateToken } from "../lib/postex.server.js";
import { getProductVariants } from "../lib/shopify.server.js";
import { getMetaAuthUrl } from "../lib/meta.server.js";
import { isTokenExpired, isTokenExpiringSoon } from "../lib/meta.server.js";
import { metaOAuthSession } from "../lib/meta-session.server.js";
import COGSTable from "../components/COGSTable.jsx";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Check for pending Meta OAuth data (after callback redirect)
  const cookieHeader = request.headers.get("Cookie");
  const oauthSession = await metaOAuthSession.getSession(cookieHeader);
  const pendingToken: string | null = oauthSession.get("meta_access_token") ?? null;
  const pendingAccounts: Array<{ id: string; name: string }> | null =
    oauthSession.get("meta_ad_accounts") ?? null;

  const supabase = await getSupabaseForStore(shop);
  const [storeRes, costsRes, variants] = await Promise.all([
    supabase
      .from("stores")
      .select(
        "postex_token, meta_access_token, meta_ad_account_id, meta_token_expires_at, expenses_amount, expenses_type"
      )
      .eq("store_id", shop)
      .single(),
    supabase
      .from("product_costs")
      .select("shopify_variant_id, unit_cost"),
    getProductVariants(session),
  ]);

  const store = storeRes.data;
  const costsMap: Record<string, number> = {};
  for (const row of costsRes.data ?? []) {
    costsMap[row.shopify_variant_id] = row.unit_cost;
  }

  return json({
    store,
    variants,
    costsMap,
    pendingToken,
    pendingAccounts,
    isMetaExpired:      isTokenExpired(store?.meta_token_expires_at),
    isMetaExpiringSoon: isTokenExpiringSoon(store?.meta_token_expires_at),
  });
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // formData can only be read once
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const supabase = await getSupabaseForStore(shop);

  // ── Section 1: PostEx ──────────────────────────────────────────────────────
  if (intent === "postex") {
    const token = String(formData.get("postex_token") ?? "").trim();

    if (!token) {
      return json({ intent, error: "PostEx API Token is required." });
    }
    const valid = await validateToken(token).catch(() => false);
    if (!valid) {
      return json({ intent, error: "Invalid token. Please check your PostEx credentials." });
    }
    await supabase
      .from("stores")
      .update({ postex_token: token })
      .eq("store_id", shop);
    return json({ intent, success: true });
  }

  // ── Section 2: Meta — initiate OAuth ──────────────────────────────────────
  if (intent === "meta_connect") {
    const state = randomBytes(16).toString("hex");
    const cookieHeader = request.headers.get("Cookie");
    const oauthSession = await metaOAuthSession.getSession(cookieHeader);
    oauthSession.set("state", state);
    oauthSession.set("shop", shop);
    oauthSession.set("returnTo", "/app/settings"); // redirect back to settings after callback
    const metaAuthUrl = getMetaAuthUrl(state);
    const setCookie = await metaOAuthSession.commitSession(oauthSession);
    return json(
      { intent, metaAuthUrl },
      { headers: { "Set-Cookie": setCookie } }
    );
  }

  // ── Section 2: Meta — save account after OAuth ────────────────────────────
  if (intent === "meta_save") {
    const adAccountId = String(formData.get("ad_account_id") ?? "");
    const accessToken = String(formData.get("access_token") ?? "");
    const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

    await supabase
      .from("stores")
      .update({
        meta_access_token:    accessToken,
        meta_ad_account_id:   adAccountId,
        meta_token_expires_at: expiresAt,
      })
      .eq("store_id", shop);

    const cookieHeader = request.headers.get("Cookie");
    const oauthSession = await metaOAuthSession.getSession(cookieHeader);
    const destroyCookie = await metaOAuthSession.destroySession(oauthSession);
    return redirect("/app/settings", { headers: { "Set-Cookie": destroyCookie } });
  }

  // ── Section 3: COGS ───────────────────────────────────────────────────────
  if (intent === "cogs") {
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
        sku:                String(formData.get(`sku_${variantId}`)     ?? ""),
        product_title:      String(formData.get(`ptitle_${variantId}`)  ?? ""),
        variant_title:      String(formData.get(`vtitle_${variantId}`)  ?? ""),
        unit_cost:          Number(value) || 0,
        updated_at:         new Date().toISOString(),
      });
    }

    if (rows.length > 0) {
      await supabase
        .from("product_costs")
        .upsert(rows, { onConflict: "store_id,shopify_variant_id" });
    }
    // Note: do NOT trigger retroactiveCOGSMatch from settings (spec rule)
    return json({ intent, success: true });
  }

  // ── Section 4: Expenses ───────────────────────────────────────────────────
  if (intent === "expenses") {
    const amount = Number(formData.get("expenses_amount")) || 0;
    const type   = String(formData.get("expenses_type") ?? "monthly");

    if (!["monthly", "per_order"].includes(type)) {
      return json({ intent, error: "Invalid expense type." });
    }
    await supabase
      .from("stores")
      .update({ expenses_amount: amount, expenses_type: type })
      .eq("store_id", shop);
    return json({ intent, success: true });
  }

  return json({ intent: "", error: "Unknown action." });
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { store, variants, costsMap, pendingToken, pendingAccounts,
          isMetaExpired, isMetaExpiringSoon } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const currentIntent = navigation.formData?.get("intent") as string | undefined;

  // Controlled state for text inputs (Polaris requires value + onChange)
  const [postexToken, setPostexToken] = useState(store?.postex_token ?? "");
  const [expAmount,        setExpAmount]        = useState(String(store?.expenses_amount ?? "0"));
  const [expType,          setExpType]          = useState<"monthly" | "per_order">(
    (store?.expenses_type ?? "monthly") as "monthly" | "per_order"
  );
  const [selectedMetaAccount, setSelectedMetaAccount] = useState(
    pendingAccounts?.[0]?.id ?? ""
  );

  // Break out of Shopify iframe to reach Meta OAuth
  useEffect(() => {
    if (actionData && "metaAuthUrl" in actionData && actionData.metaAuthUrl) {
      (window.top ?? window).location.href = actionData.metaAuthUrl as string;
    }
  }, [actionData]);

  // Shorthand for per-section action result
  const ad = actionData as { intent?: string; error?: string; success?: boolean; metaAuthUrl?: string } | null;
  const forSection = (section: string) => ad?.intent === section ? ad : null;

  const metaAccountOptions = (pendingAccounts ?? []).map(acc => ({
    label: `${acc.name} (${acc.id})`,
    value: acc.id,
  }));

  // Meta connection status badge
  const metaStatus = () => {
    if (!store?.meta_access_token) return <Badge tone="warning">Not connected</Badge>;
    if (isMetaExpired)              return <Badge tone="critical">Token expired</Badge>;
    if (isMetaExpiringSoon)         return <Badge tone="warning">Expiring soon</Badge>;
    return <Badge tone="success">Connected</Badge>;
  };

  const metaExpiryLabel = store?.meta_token_expires_at
    ? new Date(store.meta_token_expires_at).toLocaleDateString("en-PK", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <Page>
      <TitleBar title="Settings" />
      <Layout>

        {/* ── Section 1: PostEx ─────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">PostEx Settings</Text>

              <Banner tone="warning">
                Changing your PostEx token will trigger a validation check.
                Your order data will remain unchanged.
              </Banner>

              {forSection("postex")?.error && (
                <Banner tone="critical">{forSection("postex")!.error}</Banner>
              )}
              {forSection("postex")?.success && (
                <Banner tone="success">PostEx credentials saved.</Banner>
              )}

              <Form method="post">
                <input type="hidden" name="intent" value="postex" />
                <FormLayout>
                  <TextField
                    label="PostEx API Token"
                    name="postex_token"
                    value={postexToken}
                    onChange={setPostexToken}
                    type="password"
                    autoComplete="off"
                  />
                  <Button
                    submit
                    variant="primary"
                    loading={submitting && currentIntent === "postex"}
                  >
                    Save PostEx Settings
                  </Button>
                </FormLayout>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Section 2: Meta Ads ───────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Meta Ads Settings</Text>

              <Banner tone="warning">
                You will be redirected to Meta to re-authorize. This is required
                when your token expires.
              </Banner>

              {/* Connection status */}
              <InlineStack gap="300" blockAlign="center">
                <Text as="span" variant="bodyMd">Status:</Text>
                {metaStatus()}
                {metaExpiryLabel && !isMetaExpired && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    Expires {metaExpiryLabel}
                  </Text>
                )}
              </InlineStack>

              {/* Ad account selector shown after OAuth callback */}
              {pendingToken && pendingAccounts ? (
                <Form method="post">
                  <input type="hidden" name="intent"       value="meta_save" />
                  <input type="hidden" name="access_token" value={pendingToken} />
                  <FormLayout>
                    <Select
                      label="Ad Account"
                      name="ad_account_id"
                      options={metaAccountOptions}
                      onChange={setSelectedMetaAccount}
                      value={selectedMetaAccount || metaAccountOptions[0]?.value}
                    />
                    <Button
                      submit
                      variant="primary"
                      loading={submitting && currentIntent === "meta_save"}
                    >
                      Save Ad Account
                    </Button>
                  </FormLayout>
                </Form>
              ) : (
                <Form method="post">
                  <input type="hidden" name="intent" value="meta_connect" />
                  <Button
                    submit
                    variant="primary"
                    loading={submitting && currentIntent === "meta_connect"}
                  >
                    Reconnect Meta Ads
                  </Button>
                </Form>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Section 3: COGS ───────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Cost of Goods (COGS)</Text>

              <Banner tone="warning">
                Updated costs apply to future calculations only. Historical
                snapshots will not be recalculated.
              </Banner>

              {forSection("cogs")?.success && (
                <Banner tone="success">Product costs saved.</Banner>
              )}

              <Form method="post">
                <input type="hidden" name="intent" value="cogs" />
                <BlockStack gap="400">
                  <COGSTable variants={variants} costsMap={costsMap} />
                  <InlineStack>
                    <Button
                      submit
                      variant="primary"
                      loading={submitting && currentIntent === "cogs"}
                    >
                      Save COGS
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Section 4: Expenses ───────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Expenses</Text>

              <Banner tone="warning">
                Expense changes apply from today. Past snapshots will not be
                updated.
              </Banner>

              {forSection("expenses")?.error && (
                <Banner tone="critical">{forSection("expenses")!.error}</Banner>
              )}
              {forSection("expenses")?.success && (
                <Banner tone="success">Expense settings saved.</Banner>
              )}

              <Form method="post">
                <input type="hidden" name="intent" value="expenses" />
                <FormLayout>
                  <TextField
                    label="Expense Amount (PKR)"
                    name="expenses_amount"
                    value={expAmount}
                    onChange={setExpAmount}
                    type="number"
                    min="0"
                    autoComplete="off"
                    helpText="Enter 0 to disable expense tracking."
                  />
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">Expense Type</Text>
                    <RadioButton
                      label="Per Month"
                      helpText="Prorated across each time period."
                      id="expenses_monthly"
                      name="expenses_type"
                      value="monthly"
                      checked={expType === "monthly"}
                      onChange={() => setExpType("monthly")}
                    />
                    <RadioButton
                      label="Per Order"
                      helpText="Multiplied by the number of delivered orders in each period."
                      id="expenses_per_order"
                      name="expenses_type"
                      value="per_order"
                      checked={expType === "per_order"}
                      onChange={() => setExpType("per_order")}
                    />
                  </BlockStack>
                  <Button
                    submit
                    variant="primary"
                    loading={submitting && currentIntent === "expenses"}
                  >
                    Save Expenses
                  </Button>
                </FormLayout>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>
    </Page>
  );
}
