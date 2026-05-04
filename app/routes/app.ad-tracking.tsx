import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  useFetcher,
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
  Badge,
  Select,
  ProgressBar,
  EmptyState,
  Divider,
  Link,
  Icon,
} from "@shopify/polaris";
import { CheckCircleIcon, AlertTriangleIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { getMetaPixelAuthUrl, revokeBISU } from "../lib/meta-pixel.server.js";
import { metaPixelOAuthSession } from "../lib/meta-pixel-session.server.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.server.js";
import {
  installWebPixel,
  uninstallWebPixel,
} from "../lib/web-pixel-install.server.js";
import {
  buildCAPIEvent,
  sendCAPIEventsForShop,
} from "../lib/meta-capi.server.js";
import { buildUserData } from "../lib/meta-hash.server.js";

type DatasetOption = { id: string; name: string; owned?: boolean; last_fired_time?: string };
type RecentEvent = {
  id: number;
  event_id: string;
  event_name: string;
  status: "sent" | "failed";
  trace_id: string | null;
  http_status: number | null;
  error_msg: string | null;
  sent_at: string;
};

// ─── Theme app embed activation deep link ────────────────────────────────────
//
// Shopify's deep-link format opens the theme editor with our app embed
// pre-toggled ON; the merchant just needs to click Save in the top-right.
// Auto-save is NOT supported by Shopify (deliberately — quoting their staff:
// "merchants should be able to preview how your app works before saving").
// Every Meta-tracking app on the App Store uses this exact pattern.
//
// extension_uuid comes from extensions/cart-identity-relay/shopify.extension.toml
// (the `uid` field). Hard-coded here because it's stable across deploys —
// Shopify only re-generates it if the extension is deleted and recreated.
const CART_RELAY_EXT_UUID = "53765f90-3a3e-f68c-8285-3ae78dd9fa2f31183fee";

function buildThemeActivationUrl(shop: string): string {
  // shop is "the-trendy-homes-pk.myshopify.com" → handle is the-trendy-homes-pk
  const shopHandle = shop.replace(/\.myshopify\.com$/, "");
  const params = new URLSearchParams({
    context: "apps",
    template: "index",
    activateAppId: `${CART_RELAY_EXT_UUID}/meta-pixel`,
  });
  return `https://admin.shopify.com/store/${shopHandle}/themes/current/editor?${params}`;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const cookieHeader = request.headers.get("Cookie");
  const oauthSession = await metaPixelOAuthSession.getSession(cookieHeader);
  const pendingToken: string | null = oauthSession.get("bisu_token") ?? null;
  const pendingDatasets: DatasetOption[] | null =
    oauthSession.get("datasets") ?? null;

  const supabase = await getSupabaseForStore(shop);

  const [connRes, recentRes, emqRes] = await Promise.all([
    supabase
      .from("meta_pixel_connections")
      .select(
        "config_id, business_id, business_name, dataset_id, dataset_name, status, status_reason, connected_at, last_event_sent_at"
      )
      .eq("store_id", shop)
      .maybeSingle(),
    supabase
      .from("capi_delivery_log")
      .select("id, event_id, event_name, status, trace_id, http_status, error_msg, sent_at")
      .eq("store_id", shop)
      .order("sent_at", { ascending: false })
      .limit(50),
    supabase
      .from("emq_snapshots")
      .select("captured_at, overall_emq, per_event")
      .eq("store_id", shop)
      .order("captured_at", { ascending: false })
      .limit(1),
  ]);

  const conn = connRes.data;
  const latestEMQ = emqRes.data?.[0] ?? null;

  return json({
    shop,
    connection: conn,
    pending: pendingToken
      ? { datasets: pendingDatasets ?? [] }
      : null,
    recentEvents: (recentRes.data ?? []) as RecentEvent[],
    latestEMQ,
  });
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const accessToken = session.accessToken;

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  // ── Initiate OAuth — redirect popup to Meta ─────────────────────────────────
  if (intent === "connect") {
    const state = randomBytes(16).toString("hex");
    const cookieHeader = request.headers.get("Cookie");
    const oauthSession = await metaPixelOAuthSession.getSession(cookieHeader);
    oauthSession.set("state", state);
    oauthSession.set("shop", shop);
    const shopHandle = shop.replace(".myshopify.com", "");
    oauthSession.set(
      "returnTo",
      `https://admin.shopify.com/store/${shopHandle}/apps/${process.env.SHOPIFY_API_KEY}/app/ad-tracking`
    );
    const authUrl = getMetaPixelAuthUrl(state);
    const setCookie = await metaPixelOAuthSession.commitSession(oauthSession);
    return json({ intent, authUrl }, { headers: { "Set-Cookie": setCookie } });
  }

  // ── Save selected dataset (multi-Pixel disambiguation only) ────────────────
  // The single-Pixel case is auto-completed inside the OAuth callback so the
  // merchant never sees this screen. This handler only fires when the
  // merchant's Business Manager grants access to multiple Pixels and they
  // need to pick one.
  if (intent === "save_dataset") {
    const datasetId = String(formData.get("dataset_id") ?? "");
    if (!datasetId) {
      return json({ intent, error: "Pick a Pixel/Dataset to continue." });
    }

    const cookieHeader = request.headers.get("Cookie");
    const oauthSession = await metaPixelOAuthSession.getSession(cookieHeader);
    const bisu: string | null = oauthSession.get("bisu_token") ?? null;
    const businessId: string | null = oauthSession.get("business_id") ?? null;
    const datasets: DatasetOption[] = oauthSession.get("datasets") ?? [];

    if (!bisu) {
      return json({ intent, error: "OAuth session expired — please connect again." });
    }

    const dataset = datasets.find((d) => d.id === datasetId);

    let webPixelId: string | null = null;
    try {
      if (!accessToken) throw new Error("Missing Shopify admin access token");
      const wp = await installWebPixel({ shop, accessToken });
      webPixelId = wp?.id ?? null;
    } catch (err) {
      console.error(`Web Pixel install failed for ${shop}:`, err);
      return json({
        intent,
        error: `Couldn't install the Web Pixel on your storefront: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      });
    }

    const supabase = await getSupabaseForStore(shop);
    const { error: upsertErr } = await supabase
      .from("meta_pixel_connections")
      .upsert(
        {
          store_id: shop,
          config_id: process.env.META_PIXEL_CONFIG_ID ?? "",
          bisu_token: encryptSecret(bisu),
          business_id: businessId ?? "",
          business_name: null,
          dataset_id: datasetId,
          dataset_name: dataset?.name ?? null,
          web_pixel_id: webPixelId,
          status: "active",
          status_reason: null,
          connected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "store_id" }
      );
    if (upsertErr) {
      console.error(`meta_pixel_connections upsert failed for ${shop}:`, upsertErr);
      return json({ intent, error: "Couldn't save your connection." });
    }

    const destroy = await metaPixelOAuthSession.destroySession(oauthSession);
    return json(
      {
        intent,
        success: true,
        themeActivationUrl: buildThemeActivationUrl(shop),
      },
      { headers: { "Set-Cookie": destroy } }
    );
  }

  // ── Send test events ────────────────────────────────────────────────────────
  if (intent === "test_event") {
    const testCode = String(formData.get("test_code") || "").trim();
    if (!testCode || !/^TEST[A-Z0-9]+$/i.test(testCode)) {
      return json({
        intent,
        testResult: {
          ok: false as const,
          reason:
            "Enter your Meta Test Event Code first. Find it at Events Manager → Test Events → top of page (e.g. TEST30616).",
        },
      });
    }
    const now = new Date();
    const ts = Math.floor(now.getTime() / 1000);
    const testUserData = buildUserData({
      email: "test@codprofit.co",
      phone: "+923001234567",
      firstName: "Test",
      lastName: "User",
      city: "Karachi",
      state: "Sindh",
      zip: "75200",
      country: "PK",
      externalId: `test-${shop}`,
      clientIp: "127.0.0.1",
      clientUa: "COD-Tracker-Test/1.0",
      fbp: `fb.1.${ts}000.1234567890`,
    });
    const productId = "TEST-PRODUCT-1";
    const orderId = `test-order-${ts}`;
    const productCustom = {
      content_ids: [productId],
      content_type: "product",
      value: 1000,
      currency: "PKR",
    };
    const checkoutCustom = { ...productCustom, num_items: 1 };

    const events = [
      buildCAPIEvent({
        eventName: "PageView",
        eventId: `test:pageview:${shop}:${ts}`,
        eventTime: now,
        eventSourceUrl: `https://${shop}/`,
        userData: testUserData,
      }),
      buildCAPIEvent({
        eventName: "ViewContent",
        eventId: `test:viewcontent:${shop}:${ts}`,
        eventTime: now,
        eventSourceUrl: `https://${shop}/products/test-product`,
        userData: testUserData,
        customData: productCustom,
      }),
      buildCAPIEvent({
        eventName: "Search",
        eventId: `test:search:${shop}:${ts}`,
        eventTime: now,
        eventSourceUrl: `https://${shop}/search?q=test`,
        userData: testUserData,
        customData: { search_string: "test product" },
      }),
      buildCAPIEvent({
        eventName: "AddToCart",
        eventId: `test:addtocart:${shop}:${ts}`,
        eventTime: now,
        eventSourceUrl: `https://${shop}/products/test-product`,
        userData: testUserData,
        customData: productCustom,
      }),
      buildCAPIEvent({
        eventName: "InitiateCheckout",
        eventId: `test:initiatecheckout:${shop}:${ts}`,
        eventTime: now,
        eventSourceUrl: `https://${shop}/checkout`,
        userData: testUserData,
        customData: checkoutCustom,
      }),
      buildCAPIEvent({
        eventName: "AddPaymentInfo",
        eventId: `test:addpaymentinfo:${shop}:${ts}`,
        eventTime: now,
        eventSourceUrl: `https://${shop}/checkout`,
        userData: testUserData,
        customData: checkoutCustom,
      }),
      buildCAPIEvent({
        eventName: "Purchase",
        eventId: `test:purchase:${shop}:${orderId}`,
        eventTime: now,
        eventSourceUrl: `https://${shop}/thank-you`,
        userData: testUserData,
        customData: { ...checkoutCustom, order_id: orderId },
      }),
    ];

    const result = await sendCAPIEventsForShop({
      storeId: shop,
      events,
      testEventCode: testCode,
    });
    return json({ intent, testResult: result });
  }

  // ── Disconnect — revoke BISU, uninstall Web Pixel, drop row ────────────────
  if (intent === "disconnect") {
    const supabase = await getSupabaseForStore(shop);
    const { data: conn } = await supabase
      .from("meta_pixel_connections")
      .select("bisu_token, web_pixel_id")
      .eq("store_id", shop)
      .single();

    if (conn) {
      try {
        const token = decryptSecret(conn.bisu_token);
        if (token) await revokeBISU(token);
      } catch (err) {
        console.error(`BISU revoke failed for ${shop}:`, err);
      }
      if (conn.web_pixel_id && accessToken) {
        try {
          await uninstallWebPixel({ shop, accessToken, id: conn.web_pixel_id });
        } catch (err) {
          console.error(`Web Pixel uninstall failed for ${shop}:`, err);
        }
      }
    }
    await supabase.from("meta_pixel_connections").delete().eq("store_id", shop);
    return json({ intent, success: true });
  }

  return json({ error: "Unknown intent" });
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdTracking() {
  const { shop, connection, pending, recentEvents, latestEMQ } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submitting = navigation.state === "submitting";

  const [oauthFailed, setOauthFailed] = useState<string | null>(null);
  const [selectedDataset, setSelectedDataset] = useState<string>(
    pending?.datasets?.[0]?.id ?? ""
  );
  const [testCode, setTestCode] = useState("");
  const testCodeValid = /^TEST[A-Z0-9]+$/i.test(testCode.trim());

  // Open the popup and navigate it to Meta when the action returns the URL.
  useEffect(() => {
    if (actionData && "authUrl" in actionData && actionData.authUrl) {
      const popup = window.open("", "meta_pixel_oauth_window");
      if (popup) {
        popup.location.href = actionData.authUrl as string;
      } else {
        (window.top ?? window).location.href = actionData.authUrl as string;
      }
    }
  }, [actionData]);

  // After save_dataset completes successfully (multi-Pixel case), or after
  // OAuth auto-completes for the single-Pixel case, auto-open the theme
  // editor in a new tab with our app embed pre-toggled. The merchant just
  // needs to click Save — the polling fetcher below auto-detects when they
  // do and flips the status without them coming back to our app.
  const themeActivationUrl =
    actionData && "themeActivationUrl" in actionData
      ? (actionData.themeActivationUrl as string | undefined)
      : undefined;
  useEffect(() => {
    if (!themeActivationUrl) return;
    window.open(themeActivationUrl, "_blank", "noopener,noreferrer");
  }, [themeActivationUrl]);

  // Listen for the popup's postMessage on completion. The auto-completed
  // single-Pixel case sends { type: "...complete", auto: true } — when we
  // see that, also pop the theme editor automatically (the action handler
  // wasn't invoked, so themeActivationUrl above won't fire).
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "meta_pixel_oauth_complete") {
        if (event.data?.auto) {
          window.open(
            buildThemeActivationUrlClient(shop),
            "_blank",
            "noopener,noreferrer"
          );
        }
        revalidator.revalidate();
      } else if (event.data?.type === "meta_pixel_oauth_error") {
        const reason = event.data?.detail
          ? `${event.data.reason}: ${event.data.detail}`
          : event.data?.reason ?? "unknown";
        setOauthFailed(reason);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [revalidator, shop]);

  // ── Embed activation polling ───────────────────────────────────────────────
  // Once connected, we poll the merchant's active theme every 5s to see if
  // they've enabled the app embed yet. As soon as we detect activation, we
  // stop polling and flip the status indicator. This is exactly the pattern
  // wetracked.io / Triple Whale / Klaviyo use for their "Connected" pill.
  const embedFetcher = useFetcher<{
    metaPixel: boolean;
    cartRelay: boolean;
    reason?: string;
  }>();
  useEffect(() => {
    if (connection?.status !== "active") return;
    // Initial fetch immediately, then poll while either embed is missing.
    embedFetcher.load("/app/api/embed-status");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.status]);

  useEffect(() => {
    if (connection?.status !== "active") return;
    if (embedFetcher.state !== "idle") return;
    const data = embedFetcher.data;
    if (!data) return;
    if (data.metaPixel && data.cartRelay) return; // both active — done polling
    const t = setTimeout(() => {
      embedFetcher.load("/app/api/embed-status");
    }, 5000);
    return () => clearTimeout(t);
  }, [embedFetcher, connection?.status]);

  // ── Connected: status surface + recent events + EMQ ────────────────────────
  if (connection?.status === "active") {
    const embed = embedFetcher.data;
    const metaPixelActive = embed?.metaPixel === true;
    const cartRelayActive = embed?.cartRelay === true;
    const everyEmbedActive = metaPixelActive && cartRelayActive;

    return (
      <Page>
        <TitleBar title="Ad Tracking" />
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingLg">
                      Pixel Tracking is live
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Sending purchase events server-side to Meta with full
                      identity. {connection.last_event_sent_at
                        ? `Last event sent ${formatRelative(connection.last_event_sent_at)}.`
                        : "No events sent yet — your next order will fire."}
                    </Text>
                  </BlockStack>
                  <Badge tone="success">Connected</Badge>
                </InlineStack>

                <Divider />

                {/* Three-line status surface — replaces the old "warning if no
                    events yet" banner. Always visible, always informative. */}
                <BlockStack gap="200">
                  <StatusRow
                    label="Meta CAPI"
                    sublabel="Server-side events flow on every order, refund, and checkout."
                    active
                  />
                  <StatusRow
                    label="Browser pixel"
                    sublabel={
                      metaPixelActive
                        ? "Detected on storefront. Pixel Helper will see events here."
                        : embed?.reason
                        ? "Open theme editor and click Save (top-right) — takes 5 seconds. We'll detect it automatically."
                        : "Detecting…"
                    }
                    active={metaPixelActive}
                    actionLabel={
                      metaPixelActive ? undefined : "Open theme editor"
                    }
                    actionUrl={
                      metaPixelActive ? undefined : buildThemeActivationUrl(shop)
                    }
                  />
                  <StatusRow
                    label="Identity relay"
                    sublabel={
                      cartRelayActive
                        ? "fbp/fbc/fbclid are forwarded onto every order — match quality maximized."
                        : "Boosts EMQ from ~7 to ~9. One-click activate from the same theme editor."
                    }
                    active={cartRelayActive}
                  />
                </BlockStack>

                {!everyEmbedActive && (
                  <Banner tone="info">
                    <Text as="p" variant="bodyMd">
                      Server-side tracking already works — your next order will
                      fire a Purchase event to Meta. Enabling the storefront
                      embeds is optional but pushes Event Match Quality from
                      ~7 to ~9 (Meta's gold standard).
                    </Text>
                  </Banner>
                )}

                <Divider />

                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">Connected pixel</Text>
                  <Text as="p" variant="bodyMd">
                    {connection.dataset_name ?? "(unnamed)"} · ID {connection.dataset_id}
                  </Text>
                </BlockStack>

                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Send test events
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Paste your current Test Event Code from{" "}
                    <Link
                      url={`https://www.facebook.com/events_manager2/list/dataset/${connection.dataset_id}/test_events`}
                      target="_blank"
                    >
                      Events Manager → Test Events
                    </Link>
                    . The code rotates and looks like{" "}
                    <Text as="span" fontWeight="semibold">
                      TEST30616
                    </Text>
                    . Without it, the events fire safely (excluded from
                    production) but you won't see them in the dashboard.
                  </Text>
                  <Form method="post">
                    <input type="hidden" name="intent" value="test_event" />
                    <input type="hidden" name="test_code" value={testCode.trim()} />
                    <InlineStack gap="200" align="start" blockAlign="end">
                      <div style={{ minWidth: 220 }}>
                        <TextField
                          label="Test Event Code"
                          labelHidden
                          autoComplete="off"
                          placeholder="TEST30616"
                          value={testCode}
                          onChange={setTestCode}
                          error={
                            testCode.length > 0 && !testCodeValid
                              ? "Must start with TEST followed by digits/letters"
                              : undefined
                          }
                        />
                      </div>
                      <Button
                        submit
                        disabled={!testCodeValid}
                        loading={
                          submitting &&
                          navigation.formData?.get("intent") === "test_event"
                        }
                      >
                        Send 7 test events
                      </Button>
                    </InlineStack>
                  </Form>
                </BlockStack>

                <InlineStack gap="200">
                  <Form method="post">
                    <input type="hidden" name="intent" value="disconnect" />
                    <Button
                      submit
                      tone="critical"
                      variant="plain"
                      loading={submitting && navigation.formData?.get("intent") === "disconnect"}
                    >
                      Disconnect
                    </Button>
                  </Form>
                </InlineStack>

                {actionData && "testResult" in actionData && (() => {
                  const tr = actionData.testResult as
                    | { ok: true; eventsReceived?: number; traceId?: string }
                    | { ok: false; reason?: string }
                    | undefined;
                  if (!tr) return null;
                  return (
                    <Banner tone={tr.ok ? "success" : "warning"}>
                      {tr.ok
                        ? `${
                            "eventsReceived" in tr && tr.eventsReceived
                              ? tr.eventsReceived
                              : 7
                          } test events accepted by Meta — check Events Manager → Test Events${
                            "traceId" in tr && tr.traceId ? ` · trace ${tr.traceId}` : ""
                          }.`
                        : `Test events failed: ${("reason" in tr && tr.reason) || "unknown error"}.`}
                    </Banner>
                  );
                })()}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h3" variant="headingMd">Event Match Quality</Text>
                {latestEMQ?.overall_emq != null ? (
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text as="p" variant="bodyMd">
                        Overall EMQ
                      </Text>
                      <Text as="p" variant="headingLg">
                        {Number(latestEMQ.overall_emq).toFixed(1)} / 10
                      </Text>
                    </InlineStack>
                    <ProgressBar
                      progress={Math.min(
                        100,
                        Math.max(0, Number(latestEMQ.overall_emq) * 10)
                      )}
                      tone={
                        Number(latestEMQ.overall_emq) >= 7
                          ? "success"
                          : Number(latestEMQ.overall_emq) >= 5
                          ? "primary"
                          : "critical"
                      }
                    />
                    <Text as="p" variant="bodySm" tone="subdued">
                      EMQ is Meta's measure of how well we identify customers.
                      7+ is good; 8+ is excellent. Collect phone at checkout to
                      improve.
                    </Text>
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    EMQ updates daily once events are flowing. Check back
                    tomorrow.
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Recent events</Text>
                {recentEvents.length === 0 ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No events yet — fire a test event above or wait for your
                    next purchase.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {recentEvents.slice(0, 25).map((e) => (
                      <InlineStack key={e.id} align="space-between">
                        <InlineStack gap="200">
                          <Badge
                            tone={e.status === "sent" ? "success" : "critical"}
                          >
                            {e.event_name}
                          </Badge>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {formatRelative(e.sent_at)}
                          </Text>
                        </InlineStack>
                        <Text
                          as="span"
                          variant="bodySm"
                          tone={e.status === "sent" ? "subdued" : "critical"}
                        >
                          {e.status === "sent"
                            ? `trace ${(e.trace_id ?? "").slice(0, 12) || "—"}`
                            : e.error_msg ?? `HTTP ${e.http_status ?? "?"}`}
                        </Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  // ── Pending dataset selection (multi-Pixel case only) ───────────────────────
  if (pending?.datasets?.length) {
    const options = pending.datasets.map((d) => ({
      label: `${d.name ?? "(unnamed)"}${d.owned ? "" : " (shared)"} — ${d.id}`,
      value: d.id,
    }));
    return (
      <Page>
        <TitleBar title="Ad Tracking" />
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">Pick the Pixel to use</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Choose which Meta Pixel COD Tracker should send events to.
                  </Text>
                </BlockStack>

                <Form method="post">
                  <input type="hidden" name="intent" value="save_dataset" />
                  <BlockStack gap="300">
                    <Select
                      label="Pixel"
                      name="dataset_id"
                      options={options}
                      onChange={setSelectedDataset}
                      value={selectedDataset || options[0]?.value}
                    />
                    <InlineStack>
                      <Button submit variant="primary" loading={submitting}>
                        Save & install pixel on storefront
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Form>

                {actionData && "error" in actionData && actionData.error && (
                  <Banner tone="critical">{actionData.error}</Banner>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  // ── Disconnected: hero + connect button ─────────────────────────────────────
  return (
    <Page>
      <TitleBar title="Ad Tracking" />
      <Layout>
        <Layout.Section>
          <Card>
            <EmptyState
              heading="Recover lost conversions for Meta Ads"
              action={undefined}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <BlockStack gap="400">
                <Text as="p" variant="bodyMd">
                  iOS 14+, ad blockers, and ITP cause Meta to lose track of
                  ~40% of conversions. Connect your Meta Pixel here and we'll
                  send Purchase events directly from your server with full
                  hashed identity — recovering signal you're losing today.
                  Setup takes about 30 seconds.
                </Text>
                {oauthFailed && (
                  <Banner tone="critical">
                    Connection failed: <strong>{oauthFailed.replace(/_/g, " ")}</strong>.{" "}
                    {oauthFailed === "no_pixel_granted"
                      ? "Make sure to select a Pixel in the Meta consent screen."
                      : "Try again or contact support."}
                  </Banner>
                )}
                <InlineStack>
                  <Form method="post">
                    <input type="hidden" name="intent" value="connect" />
                    <Button
                      submit
                      variant="primary"
                      loading={submitting}
                      onClick={() => {
                        // Pre-open the popup synchronously so we don't get
                        // blocked by browser popup blockers.
                        window.open(
                          "about:blank",
                          "meta_pixel_oauth_window",
                          "width=600,height=700,scrollbars=yes,resizable=yes"
                        );
                      }}
                    >
                      Connect Meta Pixel
                    </Button>
                  </Form>
                </InlineStack>
              </BlockStack>
            </EmptyState>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusRow(props: {
  label: string;
  sublabel: string;
  active: boolean;
  actionLabel?: string;
  actionUrl?: string;
}) {
  return (
    <InlineStack align="space-between" blockAlign="center" gap="300">
      <InlineStack gap="200" blockAlign="center">
        <span style={{ width: 20, height: 20 }}>
          <Icon
            source={props.active ? CheckCircleIcon : AlertTriangleIcon}
            tone={props.active ? "success" : "caution"}
          />
        </span>
        <BlockStack gap="050">
          <Text as="p" variant="bodyMd" fontWeight="semibold">
            {props.label}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {props.sublabel}
          </Text>
        </BlockStack>
      </InlineStack>
      {props.actionUrl && props.actionLabel && (
        <Button url={props.actionUrl} target="_blank" variant="primary">
          {props.actionLabel}
        </Button>
      )}
    </InlineStack>
  );
}

// Same activation-URL builder as the server side, but reachable from
// useEffect handlers running in the browser (where `process.env` isn't
// available and we don't want to round-trip through the loader).
function buildThemeActivationUrlClient(shop: string): string {
  const shopHandle = shop.replace(/\.myshopify\.com$/, "");
  const params = new URLSearchParams({
    context: "apps",
    template: "index",
    activateAppId: `${CART_RELAY_EXT_UUID}/meta-pixel`,
  });
  return `https://admin.shopify.com/store/${shopHandle}/themes/current/editor?${params}`;
}

function formatRelative(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
