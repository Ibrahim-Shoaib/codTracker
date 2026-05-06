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
  Collapsible,
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

type TodayStats = {
  /** Distinct Purchase event_ids that landed at Meta with status=sent today (PKT). */
  trackedCount: number;
  /** Distinct Purchase event_ids that have only-failed attempts today — i.e. retrying. */
  retryingCount: number;
};

// Pakistan-default day boundary. Most merchants on this app are PK COD stores;
// a non-PK store sees their day boundary off by a few hours, which is acceptable
// noise for a top-level "today" counter (we'd swap to per-store timezone if a
// non-PK merchant ever asks).
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
function pktTodayWindowUtc(): { startIso: string; endIso: string } {
  const nowUtcMs = Date.now();
  const todayPkt = new Date(nowUtcMs + PKT_OFFSET_MS).toISOString().slice(0, 10);
  const startUtcMs = new Date(`${todayPkt}T00:00:00Z`).getTime() - PKT_OFFSET_MS;
  return {
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(startUtcMs + 24 * 3600 * 1000).toISOString(),
  };
}

// ─── Theme app embed activation deep link ────────────────────────────────────
//
// Shopify's deep-link format opens the theme editor with our app embed
// pre-toggled ON; the merchant just needs to click Save in the top-right.
// Auto-save is NOT supported by Shopify (deliberately — quoting their staff:
// "merchants should be able to preview how your app works before saving").
// Every Meta-tracking app on the App Store uses this exact pattern.
//
// Format (per Shopify's official docs):
//   activateAppId=<api_key>/<block_handle>
// We use the App's API key (stable, identical across deployments) instead
// of the extension UUID. An earlier hardcoded UUID happened to mismatch
// what Shopify actually deployed for this app's extension version, which
// caused "App embed does not exist" on first click — the API-key form
// avoids that whole class of bug because the API key never changes.
const SHOPIFY_API_KEY = "4e49263445787763216232655d181ef2";

function buildThemeActivationUrl(shop: string): string {
  // shop is "the-trendy-homes-pk.myshopify.com" → handle is the-trendy-homes-pk
  const shopHandle = shop.replace(/\.myshopify\.com$/, "");
  const params = new URLSearchParams({
    context: "apps",
    template: "index",
    activateAppId: `${SHOPIFY_API_KEY}/meta-pixel`,
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
  const manualEntryRequired: boolean =
    oauthSession.get("manual_entry_required") === true;

  const supabase = await getSupabaseForStore(shop);

  const { startIso, endIso } = pktTodayWindowUtc();

  const [connRes, todayRes, emqRes] = await Promise.all([
    supabase
      .from("meta_pixel_connections")
      .select(
        "config_id, business_id, business_name, dataset_id, dataset_name, status, status_reason, connected_at, last_event_sent_at"
      )
      .eq("store_id", shop)
      .maybeSingle(),
    // Today's Purchase rows only — small, indexed query that powers the hero.
    // We dedupe to distinct event_ids in JS because Postgres DISTINCT through
    // PostgREST is awkward and the row count is tiny (~10s/day for active stores).
    supabase
      .from("capi_delivery_log")
      .select("event_id, status")
      .eq("store_id", shop)
      .eq("event_name", "Purchase")
      .gte("sent_at", startIso)
      .lt("sent_at", endIso),
    supabase
      .from("emq_snapshots")
      .select("captured_at, overall_emq")
      .eq("store_id", shop)
      .order("captured_at", { ascending: false })
      .limit(1),
  ]);

  const conn = connRes.data;
  const latestEMQ = emqRes.data?.[0] ?? null;

  // Distinct Purchase event_ids today: at-least-one-sent → tracked, only-failed → retrying.
  const sentIds = new Set<string>();
  const allIds = new Set<string>();
  for (const r of todayRes.data ?? []) {
    allIds.add(r.event_id);
    if (r.status === "sent") sentIds.add(r.event_id);
  }
  const retryingCount = [...allIds].filter((id) => !sentIds.has(id)).length;
  const todayStats: TodayStats = {
    trackedCount: sentIds.size,
    retryingCount,
  };

  return json({
    shop,
    connection: conn,
    pending: pendingToken
      ? {
          datasets: pendingDatasets ?? [],
          manualEntryRequired,
        }
      : null,
    todayStats,
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
    const manualEntry: boolean =
      oauthSession.get("manual_entry_required") === true;

    if (!bisu) {
      return json({ intent, error: "OAuth session expired — please connect again." });
    }

    // Manual entry path: validate the merchant typed a numeric Meta dataset
    // id. Range is permissive (10–20 digits) — Pixel IDs vary in length
    // across vintages, and we'd rather accept a slightly old format than
    // reject a real Pixel.
    if (manualEntry && !/^\d{10,20}$/.test(datasetId)) {
      return json({
        intent,
        error: "Pixel ID should be a 10–20 digit number from Events Manager.",
      });
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
    // Pull the merchant's store currency so the test event renders in
    // their currency, not a hardcoded PKR. (Hits Events Manager → Test
    // Events with the right currency code so the merchant's eyeballs
    // see the same value/format that real Purchase events will carry.)
    const supabase = await getSupabaseForStore(shop);
    const { data: storeRow } = await supabase
      .from("stores")
      .select("currency")
      .eq("store_id", shop)
      .single();
    const storeCurrency = storeRow?.currency ?? "PKR";

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
      currency: storeCurrency,
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
  const { shop, connection, pending, todayStats, latestEMQ } =
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
  // Connection settings collapse open/close. Defaults closed when everything
  // is healthy; we auto-open below when the storefront embed needs activation.
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  // ── Connected: hero + Connection settings collapsible ─────────────────────
  if (connection?.status === "active") {
    const embed = embedFetcher.data;
    const metaPixelActive = embed?.metaPixel === true;
    const cartRelayActive = embed?.cartRelay === true;
    const everyEmbedActive = metaPixelActive && cartRelayActive;

    // Drive the hero's tone + copy from observable signals only — no claims
    // we can't back. "Tracking" means CAPI deliveries are green; pixel embed
    // is a separate (optional but recommended) signal we surface inline.
    const tracked = todayStats.trackedCount;
    const retrying = todayStats.retryingCount;
    const lastSent = connection.last_event_sent_at;

    let heroTitle: string;
    let heroSubtitle: string;
    let heroBadge: { label: string; tone: "success" | "attention" | "warning" };
    if (retrying > 0) {
      heroTitle = `${tracked} order${tracked === 1 ? "" : "s"} tracked, ${retrying} retrying`;
      heroSubtitle =
        "Meta returned a transient error on the retrying events. They'll auto-resend over the next 30 minutes — no action needed.";
      heroBadge = { label: "Recovering", tone: "warning" };
    } else if (tracked > 0) {
      heroTitle = `Tracking is healthy`;
      heroSubtitle = `${tracked} order${tracked === 1 ? "" : "s"} sent to Meta today${
        lastSent ? ` · last ${formatRelative(lastSent)}` : ""
      }.`;
      heroBadge = { label: "Healthy", tone: "success" };
    } else if (lastSent) {
      heroTitle = `Tracking is armed`;
      heroSubtitle = `No orders today yet. Last event sent ${formatRelative(lastSent)}.`;
      heroBadge = { label: "Connected", tone: "success" };
    } else {
      heroTitle = `Tracking is armed`;
      heroSubtitle = `Your first order will start the data flowing.`;
      heroBadge = { label: "Connected", tone: "success" };
    }

    // Auto-open Connection settings when the storefront embed needs the
    // merchant's attention. We compute this each render rather than on mount
    // because the polling fetcher might detect activation while the page is
    // open — at which point we want to leave the panel closed unless the user
    // explicitly opened it.
    const needsEmbedAction = embed != null && !everyEmbedActive;
    const settingsActuallyOpen = settingsOpen || needsEmbedAction;

    return (
      <Page>
        <TitleBar title="Ad Tracking" />
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="start" gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingLg">
                      {heroTitle}
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      {heroSubtitle}
                    </Text>
                  </BlockStack>
                  <Badge tone={heroBadge.tone}>{heroBadge.label}</Badge>
                </InlineStack>

                {needsEmbedAction && (
                  <Banner
                    tone="info"
                    action={{
                      content: "Open theme editor",
                      url: buildThemeActivationUrl(shop),
                      external: true,
                    }}
                  >
                    <Text as="p" variant="bodyMd">
                      Server-side tracking is active — your storefront pixel is
                      not yet enabled. Click Open theme editor → Save to turn
                      it on (5 seconds). We'll detect it automatically.
                    </Text>
                  </Banner>
                )}

                <Text as="p" variant="bodySm" tone="subdued">
                  Connected to{" "}
                  <Text as="span" fontWeight="semibold">
                    {connection.dataset_name ?? `Pixel ${connection.dataset_id}`}
                  </Text>
                  {connection.dataset_name ? ` · ID ${connection.dataset_id}` : ""}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingMd">
                    Connection settings
                  </Text>
                  <Button
                    variant="plain"
                    onClick={() => setSettingsOpen((v) => !v)}
                    ariaExpanded={settingsActuallyOpen}
                    ariaControls="connection-settings-content"
                  >
                    {settingsActuallyOpen ? "Hide" : "Show"}
                  </Button>
                </InlineStack>

                <Collapsible
                  open={settingsActuallyOpen}
                  id="connection-settings-content"
                  transition={{ duration: "150ms", timingFunction: "ease-in-out" }}
                >
                  <BlockStack gap="400">
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
                            : "Activated alongside the browser pixel from the same theme editor."
                        }
                        active={cartRelayActive}
                      />
                    </BlockStack>

                    <Divider />

                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h4" variant="headingSm">
                          Match strength
                        </Text>
                        <Badge tone={emqBadgeTone(latestEMQ?.overall_emq)}>
                          {emqBadgeLabel(latestEMQ?.overall_emq)}
                        </Badge>
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {emqBadgeHelper(latestEMQ?.overall_emq)}
                      </Text>
                    </BlockStack>

                    <Divider />

                    <BlockStack gap="200">
                      <Text as="h4" variant="headingSm">
                        Send test events
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Paste your Test Event Code from{" "}
                        <Link
                          url={`https://www.facebook.com/events_manager2/list/dataset/${connection.dataset_id}/test_events`}
                          target="_blank"
                        >
                          Events Manager → Test Events
                        </Link>
                        . Looks like{" "}
                        <Text as="span" fontWeight="semibold">
                          TEST30616
                        </Text>
                        .
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
                                  "traceId" in tr && tr.traceId
                                    ? ` · trace ${tr.traceId}`
                                    : ""
                                }.`
                              : `Test events failed: ${
                                  ("reason" in tr && tr.reason) || "unknown error"
                                }.`}
                          </Banner>
                        );
                      })()}
                    </BlockStack>

                    <Divider />

                    <InlineStack gap="200">
                      <Form method="post">
                        <input type="hidden" name="intent" value="disconnect" />
                        <Button
                          submit
                          tone="critical"
                          variant="plain"
                          loading={
                            submitting &&
                            navigation.formData?.get("intent") === "disconnect"
                          }
                        >
                          Disconnect
                        </Button>
                      </Form>
                    </InlineStack>
                  </BlockStack>
                </Collapsible>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  // ── Manual Pixel ID entry — auto-discovery failed for this BISU shape ────
  // We only land here when every automatic discovery path in the OAuth
  // callback came up empty. The merchant has already granted Pixel access in
  // the consent screen — the BISU just doesn't expose the granted asset
  // through any of the documented Graph API paths. Asking for the Pixel ID
  // (which they can copy from Events Manager in 10 seconds) is strictly
  // better than blocking onboarding.
  if (pending?.manualEntryRequired) {
    return (
      <Page>
        <TitleBar title="Ad Tracking" />
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">Almost there — paste your Pixel ID</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Meta authorized your account but didn't return your
                    Pixel's ID directly through the API for this Business
                    Manager configuration. Paste your Pixel ID below and
                    we'll connect — takes 10 seconds.
                  </Text>
                </BlockStack>

                <Banner tone="info">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      How to find your Pixel ID
                    </Text>
                    <Text as="p" variant="bodyMd">
                      1. Open{" "}
                      <Link
                        url="https://business.facebook.com/events_manager2"
                        target="_blank"
                      >
                        Meta Events Manager
                      </Link>
                    </Text>
                    <Text as="p" variant="bodyMd">
                      2. Click your Pixel/Dataset in the left sidebar
                    </Text>
                    <Text as="p" variant="bodyMd">
                      3. Copy the 10–20 digit number shown under the Pixel
                      name (e.g. <code>1234567890123456</code>)
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
    activateAppId: `${SHOPIFY_API_KEY}/meta-pixel`,
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

// EMQ presentation: merchants don't read raw 0-10 scores well, and a low
// number reads as "this app is broken" when it's actually just identity-
// signal warm-up. We bucket into qualitative bands and pair each with a
// reassuring helper line that frames warm-up as expected behaviour.
function emqBadgeTone(
  score: number | null | undefined,
): "success" | "info" | "attention" | "new" {
  if (score == null) return "new";
  if (score >= 8) return "success";
  if (score >= 6) return "info";
  return "attention";
}

function emqBadgeLabel(score: number | null | undefined): string {
  if (score == null) return "Calibrating";
  if (score >= 8) return "Excellent";
  if (score >= 6) return "Good";
  return "Improving";
}

function emqBadgeHelper(score: number | null | undefined): string {
  if (score == null) {
    return "Match strength updates daily once events are flowing — typically settles within 7 days.";
  }
  if (score >= 8) {
    return "Meta is matching conversions back to customers at the top of the industry — your ad delivery is getting the strongest possible signal.";
  }
  if (score >= 6) {
    return "Match strength is solid. It usually creeps higher over the first 2-3 weeks as we accumulate visitor history.";
  }
  return "Match strength is still warming up. This typically settles within 7 days as more orders flow through — no action needed on your side.";
}
