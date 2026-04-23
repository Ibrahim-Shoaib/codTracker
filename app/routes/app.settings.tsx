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
  RadioButton,
  Select,
  Badge,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { validateToken } from "../lib/postex.server.js";
import { getMetaAuthUrl } from "../lib/meta.server.js";
import { isTokenExpired, isTokenExpiringSoon } from "../lib/meta.server.js";
import { metaOAuthSession } from "../lib/meta-session.server.js";

type Expense = { id: string; name: string; amount: number; type: "monthly" | "per_order" };

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
        "postex_token, meta_access_token, meta_ad_account_id, meta_token_expires_at"
      )
      .eq("store_id", shop)
      .single(),
    supabase
      .from("store_expenses")
      .select("id, name, amount, type")
      .eq("store_id", shop)
      .order("created_at"),
  ]);

  const store = storeRes.data;

  return json({
    store,
    expensesList: (expensesRes.data ?? []) as Expense[],
    pendingToken,
    pendingAccounts,
    metaJustConnected,
    isMetaExpired:      isTokenExpired(store?.meta_token_expires_at),
    isMetaExpiringSoon: isTokenExpiringSoon(store?.meta_token_expires_at),
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
    return redirect("/app/settings?meta=connected", { headers: { "Set-Cookie": destroyCookie } });
  }

  // ── Section 3: Expenses — add ─────────────────────────────────────────────
  if (intent === "expense_add") {
    const name = String(formData.get("name") ?? "").trim();
    const amount = Number(formData.get("amount")) || 0;
    const type = String(formData.get("type") ?? "monthly");

    if (!name) return json({ intent, error: "Expense name is required." });
    if (!["monthly", "per_order"].includes(type)) {
      return json({ intent, error: "Invalid expense type." });
    }
    await supabase.from("store_expenses").insert({ store_id: shop, name, amount, type });
    return json({ intent, success: true });
  }

  // ── Section 3: Expenses — delete ─────────────────────────────────────────
  if (intent === "expense_delete") {
    const id = String(formData.get("id") ?? "");
    await supabase.from("store_expenses").delete().eq("id", id).eq("store_id", shop);
    return json({ intent, success: true });
  }

  return json({ intent: "", error: "Unknown action." });
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { store, expensesList, pendingToken, pendingAccounts,
          metaJustConnected, isMetaExpired, isMetaExpiringSoon } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const currentIntent = navigation.formData?.get("intent") as string | undefined;

  const [postexToken, setPostexToken] = useState(store?.postex_token ?? "");

  // Add-expense form state
  const [newExpName,   setNewExpName]   = useState("");
  const [newExpAmount, setNewExpAmount] = useState("0");
  const [newExpType,   setNewExpType]   = useState<"monthly" | "per_order">("monthly");

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
    const channel = new BroadcastChannel("meta_oauth");
    channel.onmessage = (event) => {
      if (event.data?.type === "meta_oauth_complete") {
        revalidator.revalidate();
      } else if (event.data?.type === "meta_oauth_error") {
        setMetaOAuthFailed(true);
      }
      channel.close();
    };
    return () => channel.close();
  }, [revalidator]);

  useEffect(() => {
    if ((pendingToken && pendingAccounts) || metaJustConnected) {
      document.getElementById("meta-ads-section")?.scrollIntoView({ behavior: "smooth" });
    }
  }, [pendingToken, pendingAccounts, metaJustConnected]);

  // Clear add-expense form after a successful add
  useEffect(() => {
    if (actionData && "intent" in actionData && actionData.intent === "expense_add" && "success" in actionData) {
      setNewExpName("");
      setNewExpAmount("0");
      setNewExpType("monthly");
    }
  }, [actionData]);

  const ad = actionData as { intent?: string; error?: string; success?: boolean; metaAuthUrl?: string } | null;
  const forSection = (section: string) => ad?.intent === section ? ad : null;

  const metaAccountOptions = (pendingAccounts ?? []).map(acc => ({
    label: `${acc.name} (${acc.id})`,
    value: acc.id,
  }));

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
        <div id="meta-ads-section" />
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Meta Ads Settings</Text>

              <Banner tone="warning">
                You will be redirected to Meta to re-authorize. This is required
                when your token expires.
              </Banner>

              {metaJustConnected && (
                <Banner tone="success">Meta Ads connected successfully.</Banner>
              )}

              {metaOAuthFailed && (
                <Banner tone="critical">Meta Ads connection failed. Please try again.</Banner>
              )}

              <InlineStack gap="300" blockAlign="center">
                <Text as="span" variant="bodyMd">Status:</Text>
                {metaStatus()}
                {metaExpiryLabel && !isMetaExpired && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    Expires {metaExpiryLabel}
                  </Text>
                )}
              </InlineStack>

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
                    onClick={() => {
                      window.open("about:blank", "meta_oauth_window", "width=600,height=700,scrollbars=yes,resizable=yes");
                    }}
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
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Expenses</Text>

              <Banner tone="warning">
                Expense changes apply from today. Past snapshots will not be updated.
              </Banner>

              {(forSection("expense_add")?.error || forSection("expense_delete")?.error) && (
                <Banner tone="critical">
                  {forSection("expense_add")?.error ?? forSection("expense_delete")?.error}
                </Banner>
              )}
              {forSection("expense_add")?.success && (
                <Banner tone="success">Expense added.</Banner>
              )}

              {/* Existing expenses */}
              {expensesList.length > 0 ? (
                <BlockStack gap="200">
                  {expensesList.map((exp) => (
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
                        <input type="hidden" name="intent" value="expense_delete" />
                        <input type="hidden" name="id" value={exp.id} />
                        <Button
                          submit
                          variant="plain"
                          tone="critical"
                          loading={submitting && currentIntent === "expense_delete"}
                        >
                          Remove
                        </Button>
                      </Form>
                    </InlineStack>
                  ))}
                </BlockStack>
              ) : (
                <Text as="p" variant="bodyMd" tone="subdued">
                  No expenses added. Use the form below to add one.
                </Text>
              )}

              <Divider />

              {/* Add expense form */}
              <Text as="p" variant="headingSm">Add an expense</Text>
              <Form method="post">
                <input type="hidden" name="intent" value="expense_add" />
                <FormLayout>
                  <TextField
                    label="Name"
                    name="name"
                    value={newExpName}
                    onChange={setNewExpName}
                    placeholder="e.g. Warehouse Rent"
                    autoComplete="off"
                  />
                  <TextField
                    label="Amount (PKR)"
                    name="amount"
                    value={newExpAmount}
                    onChange={setNewExpAmount}
                    type="number"
                    min="0"
                    autoComplete="off"
                  />
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">Expense Type</Text>
                    <RadioButton
                      label="Per Month"
                      helpText="Full amount charged on the 1st of each month."
                      id="new_expenses_monthly"
                      name="type"
                      value="monthly"
                      checked={newExpType === "monthly"}
                      onChange={() => setNewExpType("monthly")}
                    />
                    <RadioButton
                      label="Per Order"
                      helpText="Multiplied by the number of delivered orders in each period."
                      id="new_expenses_per_order"
                      name="type"
                      value="per_order"
                      checked={newExpType === "per_order"}
                      onChange={() => setNewExpType("per_order")}
                    />
                  </BlockStack>
                  <Button
                    submit
                    variant="primary"
                    loading={submitting && currentIntent === "expense_add"}
                  >
                    + Add Expense
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
