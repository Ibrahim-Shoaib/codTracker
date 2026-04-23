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
  Card,
  BlockStack,
  Text,
  Button,
  Banner,
  Select,
  InlineStack,
  FormLayout,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { getMetaAuthUrl } from "../lib/meta.server.js";
import { metaOAuthSession } from "../lib/meta-session.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const cookieHeader = request.headers.get("Cookie");
  const oauthSession = await metaOAuthSession.getSession(cookieHeader);
  const pendingToken: string | null = oauthSession.get("meta_access_token") ?? null;
  const pendingAccounts: Array<{ id: string; name: string }> | null =
    oauthSession.get("meta_ad_accounts") ?? null;

  const supabase = await getSupabaseForStore(shop);
  const { data: store } = await supabase
    .from("stores")
    .select("meta_access_token")
    .eq("store_id", shop)
    .single();

  return json({
    alreadyConnected: !!store?.meta_access_token,
    pendingToken,
    pendingAccounts,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "skip") {
    const supabase = await getSupabaseForStore(shop);
    await supabase
      .from("stores")
      .update({ onboarding_step: 3 })
      .eq("store_id", shop);
    return redirect("/app/onboarding/step3-cogs");
  }

  if (intent === "connect") {
    const state = randomBytes(16).toString("hex");
    const cookieHeader = request.headers.get("Cookie");
    const oauthSession = await metaOAuthSession.getSession(cookieHeader);
    oauthSession.set("state", state);
    oauthSession.set("shop", shop);
    // After Meta OAuth we must re-enter via Shopify admin so authenticate.admin() works.
    // Direct navigation to /app/* outside the iframe loses the embedded session context.
    const shopHandle = shop.replace(".myshopify.com", "");
    oauthSession.set("returnTo", `https://admin.shopify.com/store/${shopHandle}/apps/${process.env.SHOPIFY_API_KEY}`);
    const metaAuthUrl = getMetaAuthUrl(state);
    const setCookie = await metaOAuthSession.commitSession(oauthSession);
    // Return the URL as JSON — client breaks out of the Shopify iframe via window.top
    return json(
      { metaAuthUrl },
      { headers: { "Set-Cookie": setCookie } }
    );
  }

  if (intent === "save_account") {
    const adAccountId = String(formData.get("ad_account_id") ?? "");
    const accessToken = String(formData.get("access_token") ?? "");
    const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

    const supabase = await getSupabaseForStore(shop);
    await supabase
      .from("stores")
      .update({
        meta_access_token: accessToken,
        meta_ad_account_id: adAccountId,
        meta_token_expires_at: expiresAt,
        onboarding_step: 3,
      })
      .eq("store_id", shop);

    const cookieHeader = request.headers.get("Cookie");
    const oauthSession = await metaOAuthSession.getSession(cookieHeader);
    const destroyCookie = await metaOAuthSession.destroySession(oauthSession);
    return redirect("/app/onboarding/step3-cogs?meta=connected", {
      headers: { "Set-Cookie": destroyCookie },
    });
  }

  return json({ error: "Unknown action." });
};

export default function Step2Meta() {
  const { alreadyConnected, pendingToken, pendingAccounts } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  const revalidator = useRevalidator();
  const [metaOAuthFailed, setMetaOAuthFailed] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState(
    pendingAccounts?.[0]?.id ?? ""
  );

  // Once the server returns the OAuth URL, navigate the already-open popup to it.
  // Fallback: if popup was blocked, navigate window.top (existing behaviour).
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

  // Listen for the popup to signal completion, then reload loader data in-place.
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

  const accountOptions = (pendingAccounts ?? []).map(acc => ({
    label: `${acc.name} (${acc.id})`,
    value: acc.id,
  }));

  // After OAuth callback — show ad account selector
  if (pendingToken && pendingAccounts) {
    return (
      <Card>
        <BlockStack gap="400">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">
              Select Ad Account
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Choose which Meta ad account to use for tracking advertising costs.
            </Text>
          </BlockStack>

          <Form method="post">
            <input type="hidden" name="intent" value="save_account" />
            <input type="hidden" name="access_token" value={pendingToken} />
            <FormLayout>
              <Select
                label="Ad Account"
                name="ad_account_id"
                options={accountOptions}
                onChange={setSelectedAccount}
                value={selectedAccount || accountOptions[0]?.value}
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

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Connect Meta Ads
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Connect your Meta Ads account to track advertising costs and see
            ROAS. You can skip this and connect later in Settings.
          </Text>
        </BlockStack>

        {alreadyConnected && (
          <Banner tone="success">
            Meta Ads is already connected. You can reconnect below or continue.
          </Banner>
        )}

        {(metaOAuthFailed || "error" in (actionData ?? {})) && (
          <Banner tone="critical">
            {metaOAuthFailed
              ? "Meta Ads connection failed. Please try again."
              : (actionData as { error: string }).error}
          </Banner>
        )}

        <InlineStack gap="300">
          <Form method="post">
            <input type="hidden" name="intent" value="connect" />
            <Button
              submit
              variant="primary"
              loading={saving}
              onClick={() => {
                window.open("about:blank", "meta_oauth_window", "width=600,height=700,scrollbars=yes,resizable=yes");
              }}
            >
              Connect Meta Ads
            </Button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="skip" />
            <Button submit variant="plain" loading={saving}>
              Skip for now
            </Button>
          </Form>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
