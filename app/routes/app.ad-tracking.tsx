import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
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
  Badge,
  Select,
  ProgressBar,
  EmptyState,
  Divider,
  Link,
} from "@shopify/polaris";
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

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const cookieHeader = request.headers.get("Cookie");
  const oauthSession = await metaPixelOAuthSession.getSession(cookieHeader);
  const pendingToken: string | null = oauthSession.get("bisu_token") ?? null;
  const pendingDatasets: DatasetOption[] | null =
    oauthSession.get("datasets") ?? null;
  const pendingBusinessId: string | null = oauthSession.get("business_id") ?? null;
  const manualEntryRequired: boolean = !!oauthSession.get("manual_entry_required");

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
    connection: conn,
    pending: pendingToken
      ? {
          datasets: pendingDatasets ?? [],
          businessId: pendingBusinessId,
          manualEntryRequired,
        }
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

  // ── Save selected dataset, install Web Pixel, persist BISU ──────────────────
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
    const manualEntry: boolean = !!oauthSession.get("manual_entry_required");

    // Manual entry flow: business_id couldn't be discovered, so we accept the
    // Pixel ID directly typed by the merchant. business_id stays null on the
    // saved connection — CAPI doesn't need it, only the dataset_id matters.
    if (!bisu) {
      return json({ intent, error: "OAuth session expired — please connect again." });
    }
    if (!businessId && !manualEntry) {
      return json({ intent, error: "OAuth session expired — please connect again." });
    }

    // Validate the manually-entered Pixel ID is a numeric Meta dataset id.
    if (manualEntry && !/^\d{10,20}$/.test(datasetId)) {
      return json({
        intent,
        error: "Pixel ID should be a 15-16 digit number from Events Manager.",
      });
    }

    const dataset = datasets.find((d) => d.id === datasetId);

    // Install (or update) the Custom Web Pixel via Admin GraphQL.
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
          // For manual entry, business_id is unknown — store empty string
          // (the column is NOT NULL). CAPI relay only needs dataset_id +
          // BISU; business_id is purely informational.
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
      { intent, success: true },
      { headers: { "Set-Cookie": destroy } }
    );
  }

  // ── Send test events ────────────────────────────────────────────────────────
  // Fire one of every event the integration emits in production, with full
  // (dummy) identity hashed in. The test_event_code keeps these out of the
  // merchant's real audience — they only show in Events Manager → Test Events.
  // This lets the merchant verify the entire pipeline (PageView → Purchase) in
  // a single click instead of having to walk through a real checkout.
  if (intent === "test_event") {
    // The Test Event Code is per-merchant and rotates — Meta shows it in
    // Events Manager → Test Events tab (looks like "TEST30616"). Without a
    // valid code, the events go to Meta but the merchant can't see them
    // anywhere. We refuse to fire the test if the code is missing — this
    // prevents the "I clicked Send but nothing showed up" support issue.
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
  const { connection, pending, recentEvents, latestEMQ } =
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

  // Listen for the popup's postMessage on completion.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "meta_pixel_oauth_complete") {
        revalidator.revalidate();
      } else if (event.data?.type === "meta_pixel_oauth_error") {
        // Prefer the Meta-supplied detail message when present — it's far
        // more diagnostic than our top-level `reason` code.
        const reason = event.data?.detail
          ? `${event.data.reason}: ${event.data.detail}`
          : event.data?.reason ?? "unknown";
        setOauthFailed(reason);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [revalidator]);

  // ── Connected: status + recent events + EMQ ─────────────────────────────────
  if (connection?.status === "active") {
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
                        : "No events sent yet."}
                    </Text>
                  </BlockStack>
                  <Badge tone="success">Connected</Badge>
                </InlineStack>

                {(() => {
                  // If they connected but no Purchase has fired yet, the
                  // Theme App Extension probably isn't enabled — without it
                  // cart attributes don't carry fbp/fbc into the order, and
                  // EMQ stays low. Surface this prominently.
                  const connectedAgo =
                    Date.now() - new Date(connection.connected_at).getTime();
                  const noEventsYet =
                    !connection.last_event_sent_at && connectedAgo > 60 * 60 * 1000;
                  const hasPurchase = recentEvents.some(
                    (e) => e.event_name === "Purchase"
                  );
                  if (noEventsYet || (connectedAgo > 24 * 60 * 60 * 1000 && !hasPurchase)) {
                    return (
                      <Banner tone="warning" title="Enable the Theme block to start tracking">
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd">
                            We installed the storefront pixel, but the
                            <strong> COD Tracker Cart Relay </strong>
                            theme app block isn't active yet. Without it, server-side
                            Purchase events miss the fbp/fbc identity that drives match quality.
                          </Text>
                          <Text as="p" variant="bodyMd">
                            Online Store → Themes → Customize → App embeds →
                            toggle <strong>COD Tracker Cart Relay</strong> on.
                          </Text>
                        </BlockStack>
                      </Banner>
                    );
                  }
                  return null;
                })()}

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

  // ── Manual Pixel ID entry — auto-discovery failed, ask user to type it ─────
  if (pending && (pending as { manualEntryRequired?: boolean }).manualEntryRequired) {
    return (
      <Page>
        <TitleBar title="Ad Tracking" />
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">Enter your Pixel ID</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Meta authorized your account but didn't return your Business
                    Manager's Pixel list directly. No problem — just paste your
                    Pixel ID below and we'll connect.
                  </Text>
                </BlockStack>

                <Banner tone="info">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodyMd">
                      <strong>How to find your Pixel ID:</strong>
                    </Text>
                    <Text as="p" variant="bodyMd">
                      1. Open <a href="https://business.facebook.com/events_manager2" target="_blank" rel="noopener noreferrer">Meta Events Manager</a>
                    </Text>
                    <Text as="p" variant="bodyMd">
                      2. Click your Pixel/Dataset in the left sidebar
                    </Text>
                    <Text as="p" variant="bodyMd">
                      3. Copy the 15–16 digit number shown under the Pixel name (e.g. <code>1234567890123456</code>)
                    </Text>
                  </BlockStack>
                </Banner>

                <Form method="post">
                  <input type="hidden" name="intent" value="save_dataset" />
                  <BlockStack gap="300">
                    <input
                      type="text"
                      name="dataset_id"
                      placeholder="1234567890123456"
                      pattern="[0-9]{10,20}"
                      required
                      style={{
                        padding: "10px 12px",
                        border: "1px solid #ccc",
                        borderRadius: "8px",
                        fontSize: "16px",
                        fontFamily: "monospace",
                      }}
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

  // ── Pending dataset selection ───────────────────────────────────────────────
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
                  identity — recovering signal you're losing today.
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
