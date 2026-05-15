import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  Form,
  useNavigation,
  useRevalidator,
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
  Select,
  Badge,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { validateToken } from "../lib/postex.server.js";
import { getMetaAuthUrl, isTokenExpired, isTokenExpiringSoon } from "../lib/meta.server.js";
import { metaOAuthSession } from "../lib/meta-session.server.js";
import { handleExpenseAction, summarizeExpenses } from "../lib/expense-actions.server.js";
import ExpenseManager from "../components/ExpenseManager.jsx";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const metaJustConnected = url.searchParams.get("meta") === "connected";

  const cookieHeader = request.headers.get("Cookie");
  const oauthSession = await metaOAuthSession.getSession(cookieHeader);
  const pendingToken: string | null = oauthSession.get("meta_access_token") ?? null;
  const pendingAccounts: Array<{ id: string; name: string }> | null =
    oauthSession.get("meta_ad_accounts") ?? null;

  const supabase = await getSupabaseForStore(shop);

  const [storeRes, expensesRes] = await Promise.all([
    supabase
      .from("stores")
      .select(
        "postex_token, meta_access_token, meta_ad_account_id, meta_ad_account_name, meta_token_expires_at, meta_sync_error, currency, money_format, meta_ad_account_currency"
      )
      .eq("store_id", shop)
      .single(),
    supabase
      .from("store_expenses")
      .select("id, series_id, name, amount, kind, is_variable, pct_base, effective_from, effective_to")
      .eq("store_id", shop)
      .order("created_at"),
  ]);

  const store = storeRes.data;

  return json({
    store,
    expensesList: summarizeExpenses(expensesRes.data ?? []),
    pendingToken,
    pendingAccounts,
    metaJustConnected,
    isMetaExpired:      isTokenExpired(store?.meta_token_expires_at),
    isMetaExpiringSoon: isTokenExpiringSoon(store?.meta_token_expires_at),
    metaSyncError:      store?.meta_sync_error ?? null,
  });
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

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
    const shopHandle = shop.replace(".myshopify.com", "");
    oauthSession.set("returnTo", `https://admin.shopify.com/store/${shopHandle}/apps/${process.env.SHOPIFY_API_KEY}`);
    const metaAuthUrl = getMetaAuthUrl(state);
    const setCookie = await metaOAuthSession.commitSession(oauthSession);
    return json(
      { intent, metaAuthUrl },
      { headers: { "Set-Cookie": setCookie } }
    );
  }

  // ── Section 2: Meta — disconnect ──────────────────────────────────────────
  // Clears the connection (token + account + expiry + error). Historical
  // ad_spend rows are intentionally left in place — past dashboard
  // snapshots remain accurate for the merchant's records.
  if (intent === "meta_disconnect") {
    await supabase
      .from("stores")
      .update({
        meta_access_token:     null,
        meta_ad_account_id:    null,
        meta_ad_account_name:  null,
        meta_token_expires_at: null,
        meta_sync_error:       null,
      })
      .eq("store_id", shop);
    return json({ intent, success: true });
  }

  // ── Section 2: Meta — save account after OAuth ────────────────────────────
  if (intent === "meta_save") {
    const adAccountId = String(formData.get("ad_account_id") ?? "");
    const accessToken = String(formData.get("access_token") ?? "");
    const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

    // Look up the chosen account's display name from the OAuth session so we
    // can show "Trendy Homes Ads" in settings instead of "act_1224674772151444".
    const cookieHeaderForName = request.headers.get("Cookie");
    const oauthSessionForName = await metaOAuthSession.getSession(cookieHeaderForName);
    const accounts: Array<{ id: string; name: string; currency?: string }> =
      oauthSessionForName.get("meta_ad_accounts") ?? [];
    const picked = accounts.find((a) => a.id === adAccountId);
    const adAccountName = picked?.name ?? null;
    const adAccountCurrency = picked?.currency ?? null;

    // Currency mismatch is not blocked — meta-spend cron converts to
    // store currency at ingest time. See app/lib/fx.server.js.

    await supabase
      .from("stores")
      .update({
        meta_access_token:    accessToken,
        meta_ad_account_id:   adAccountId,
        meta_ad_account_name: adAccountName,
        meta_ad_account_currency: adAccountCurrency,
        meta_token_expires_at: expiresAt,
        meta_sync_error:      null,
      })
      .eq("store_id", shop);

    const cookieHeader = request.headers.get("Cookie");
    const oauthSession = await metaOAuthSession.getSession(cookieHeader);
    const destroyCookie = await metaOAuthSession.destroySession(oauthSession);
    return redirect("/app/settings?meta=connected", { headers: { "Set-Cookie": destroyCookie } });
  }

  // ── Section 3: Expenses (add / edit / stop / delete / set-month) ──────────
  const exp = await handleExpenseAction(supabase, shop, formData);
  if (exp.handled) return json(exp.result);

  return json({ intent: "", error: "Unknown action." });
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { store, expensesList, pendingToken, pendingAccounts,
          metaJustConnected, isMetaExpired, isMetaExpiringSoon,
          metaSyncError } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const currentIntent = navigation.formData?.get("intent") as string | undefined;

  const [postexToken, setPostexToken] = useState(store?.postex_token ?? "");

  // Add-expense form state

  const [selectedMetaAccount, setSelectedMetaAccount] = useState(
    pendingAccounts?.[0]?.id ?? ""
  );

  const revalidator = useRevalidator();
  const [metaOAuthFailed, setMetaOAuthFailed] = useState(false);

  useEffect(() => {
    if (actionData && "metaAuthUrl" in actionData && actionData.metaAuthUrl) {
      const popup = window.open("", "meta_oauth_window");
      if (popup) {
        popup.location.href = actionData.metaAuthUrl as string;
      } else {
        (window.top ?? window).location.href = actionData.metaAuthUrl as string;
      }
    }
  }, [actionData]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "meta_oauth_complete") {
        revalidator.revalidate();
      } else if (event.data?.type === "meta_oauth_error") {
        setMetaOAuthFailed(true);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [revalidator]);

  useEffect(() => {
    if ((pendingToken && pendingAccounts) || metaJustConnected) {
      document.getElementById("meta-ads-section")?.scrollIntoView({ behavior: "smooth" });
    }
  }, [pendingToken, pendingAccounts, metaJustConnected]);

  const ad = actionData as { intent?: string; error?: string; success?: boolean; metaAuthUrl?: string } | null;
  const forSection = (section: string) => ad?.intent === section ? ad : null;

  const metaAccountOptions = (pendingAccounts ?? []).map(acc => ({
    label: `${acc.name} (${acc.id})`,
    value: acc.id,
  }));

  // Single source of truth: meta_sync_error is set by the cron whenever a sync
  // call fails (token expired, session invalidated, network error). Treat that
  // as the authoritative "disconnected" signal — falling back to expiry only
  // when no error has been recorded yet.
  const metaIsBroken = !!metaSyncError || isMetaExpired;

  const metaStatus = () => {
    if (!store?.meta_access_token) return <Badge tone="warning">Not connected</Badge>;
    if (metaIsBroken)              return <Badge tone="critical">Disconnected</Badge>;
    if (isMetaExpiringSoon)        return <Badge tone="warning">Expiring soon</Badge>;
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
        <div id="meta-ads-section" />
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Meta Ads Settings</Text>

              {metaJustConnected && (
                <Banner tone="success">Meta Ads connected successfully.</Banner>
              )}

              {metaOAuthFailed && (
                <Banner tone="critical">Meta Ads connection failed. Please try again.</Banner>
              )}

              {metaIsBroken && store?.meta_access_token && (
                <Banner tone="critical" title="Meta Ads disconnected">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodyMd">
                      Reconnect to resume ad spend syncing.
                    </Text>
                    {metaSyncError && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Reason: {metaSyncError}
                      </Text>
                    )}
                  </BlockStack>
                </Banner>
              )}

              {!metaIsBroken && isMetaExpiringSoon && metaExpiryLabel && (
                <Banner tone="warning">
                  Your Meta Ads connection expires on {metaExpiryLabel}.
                  Reconnect now to avoid an interruption.
                </Banner>
              )}

              <BlockStack gap="100">
                <InlineStack gap="300" blockAlign="center">
                  <Text as="span" variant="bodyMd">Status:</Text>
                  {metaStatus()}
                  {store?.meta_access_token && (
                    <Text as="span" variant="bodyMd">
                      {store.meta_ad_account_name ?? store.meta_ad_account_id}
                    </Text>
                  )}
                </InlineStack>
                {metaExpiryLabel && !metaIsBroken && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    Expires {metaExpiryLabel}
                  </Text>
                )}
              </BlockStack>

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
                <InlineStack gap="200" blockAlign="center">
                  <Form method="post">
                    <input type="hidden" name="intent" value="meta_connect" />
                    <Button
                      submit
                      variant="primary"
                      loading={submitting && currentIntent === "meta_connect"}
                      onClick={() => {
                        window.open("about:blank", "meta_oauth_window", "width=600,height=700,scrollbars=yes,resizable=yes");
                      }}
                    >
                      {store?.meta_access_token ? "Reconnect Meta Ads" : "Connect Meta Ads"}
                    </Button>
                  </Form>
                  {store?.meta_access_token && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="meta_disconnect" />
                      <Button
                        submit
                        tone="critical"
                        loading={submitting && currentIntent === "meta_disconnect"}
                      >
                        Disconnect
                      </Button>
                    </Form>
                  )}
                </InlineStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Section 3: COGS ───────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Cost of Goods (COGS)</Text>

              <InlineStack>
                <Button url="/app/cogs" variant="primary">
                  Edit COGS
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Section 4: Expenses ───────────────────────────────────────── */}
        <Layout.Section>
          <ExpenseManager
            expenses={expensesList}
            currency={store?.currency ?? "PKR"}
            actionData={
              String((actionData as any)?.intent ?? "").startsWith("expense_")
                ? actionData
                : null
            }
          />
        </Layout.Section>

      </Layout>
    </Page>
  );
}
