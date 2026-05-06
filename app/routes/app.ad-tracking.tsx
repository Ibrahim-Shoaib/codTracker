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

type Channel = "facebook_ads" | "instagram_ads" | "direct_organic";

type AttributionRow = {
  channel: Channel;
  attributed_at: string;
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
  // Pull the full 30 days of attribution rows once. The Today/7d/30d tabs
  // filter client-side from this single payload — saves a round-trip per
  // tab click and keeps the loader query count bounded.
  const thirtyDaysAgoIso = new Date(
    Date.now() - 30 * 24 * 3600 * 1000
  ).toISOString();

  const [connRes, todayRes, emqRes, attributionRes] = await Promise.all([
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
    // Last 30 days of attribution. Indexed on (store_id, attributed_at DESC),
    // capped at 30 days by the nightly trim — for a 1000-orders/month store
    // this is at most a few thousand small rows. Sub-50ms.
    supabase
      .from("order_attribution")
      .select("channel, attributed_at")
      .eq("store_id", shop)
      .gte("attributed_at", thirtyDaysAgoIso)
      .order("attributed_at", { ascending: false }),
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
    attribution: (attributionRes.data ?? []) as AttributionRow[],
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
  const { shop, connection, pending, todayStats, latestEMQ, attribution } =
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
  // Channels card window: defaults to today, never causes a refetch — the
  // loader pulls 30 days once and we group client-side.
  const [channelWindow, setChannelWindow] =
    useState<"today" | "7d" | "30d">("today");

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
    let heroTone: "success" | "attention" | "warning";
    if (retrying > 0) {
      heroTitle = `${tracked} order${tracked === 1 ? "" : "s"} tracked, ${retrying} retrying`;
      heroSubtitle =
        "Meta returned a transient error on the retrying events. They'll auto-resend over the next 30 minutes — no action needed.";
      heroTone = "warning";
    } else if (tracked > 0) {
      heroTitle = `Tracking is healthy`;
      heroSubtitle = `${tracked} order${tracked === 1 ? "" : "s"} sent to Meta today${
        lastSent ? ` · last ${formatRelative(lastSent)}` : ""
      }.`;
      heroTone = "success";
    } else if (lastSent) {
      heroTitle = `Tracking is armed`;
      heroSubtitle = `No orders today yet. Last event sent ${formatRelative(lastSent)}.`;
      heroTone = "success";
    } else {
      heroTitle = `Tracking is armed`;
      heroSubtitle = `Your first order will start the data flowing.`;
      heroTone = "success";
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
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <StatusDot tone={heroTone} />
                    <Text as="h2" variant="headingLg">
                      {heroTitle}
                    </Text>
                  </div>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    {heroSubtitle}
                  </Text>
                </BlockStack>

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

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    paddingTop: 8,
                    borderTop: "1px solid #f1f5f9",
                  }}
                >
                  <Text as="span" variant="bodySm" tone="subdued">
                    Pixel
                  </Text>
                  <Text as="span" variant="bodySm" fontWeight="semibold">
                    {connection.dataset_name ?? `#${connection.dataset_id}`}
                  </Text>
                  {connection.dataset_name && (
                    <>
                      <span style={{ color: "#cbd5e1" }}>·</span>
                      <span
                        style={{
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          fontSize: 12,
                          color: "#64748b",
                          letterSpacing: "0.01em",
                        }}
                      >
                        {connection.dataset_id}
                      </span>
                    </>
                  )}
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <ChannelsCard
              attribution={attribution}
              window={channelWindow}
              setWindow={setChannelWindow}
            />
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="start">
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingMd">
                      Match strength
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Meta's score for how well we identify your customers.
                    </Text>
                  </BlockStack>
                  <Badge tone={emqBadgeTone(latestEMQ?.overall_emq)}>
                    {emqBadgeLabel(latestEMQ?.overall_emq)}
                  </Badge>
                </InlineStack>

                {latestEMQ?.overall_emq != null ? (
                  <BlockStack gap="300">
                    <InlineStack gap="200" blockAlign="baseline">
                      <span
                        style={{
                          fontSize: 36,
                          fontWeight: 700,
                          letterSpacing: "-0.02em",
                          color: emqAccentHex(latestEMQ.overall_emq),
                          lineHeight: 1,
                        }}
                      >
                        {Number(latestEMQ.overall_emq).toFixed(1)}
                      </span>
                      <Text as="span" variant="bodyMd" tone="subdued">
                        / 10
                      </Text>
                    </InlineStack>

                    <MatchStrengthBar score={Number(latestEMQ.overall_emq)} />

                    <MatchStrengthHelper score={Number(latestEMQ.overall_emq)} />
                  </BlockStack>
                ) : (
                  <BlockStack gap="300">
                    <MatchStrengthBar score={null} />
                    <MatchStrengthHelper score={null} />
                  </BlockStack>
                )}
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

// Channel display metadata. Single source of truth for label, icon path,
// and accent colour — anything that visually represents a channel reads
// from this map. Changing the icon or colour for, say, Facebook Ads only
// needs editing this object once.
const CHANNEL_META: Record<
  Channel,
  { label: string; iconUrl: string; accent: string; iconBg: string }
> = {
  facebook_ads: {
    label: "Facebook Ads",
    iconUrl: "/logos/fb.svg",
    accent: "#0866ff",
    iconBg: "#eff6ff",
  },
  instagram_ads: {
    label: "Instagram Ads",
    iconUrl: "/logos/insta.svg",
    accent: "#d6249f",
    iconBg: "#fdf2f8",
  },
  direct_organic: {
    label: "Direct / Organic",
    iconUrl: "/logos/organic.svg",
    accent: "#475569",
    iconBg: "#f1f5f9",
  },
};
const CHANNEL_ORDER: Channel[] = [
  "facebook_ads",
  "instagram_ads",
  "direct_organic",
];

const WINDOW_OPTIONS: Array<{ value: "today" | "7d" | "30d"; label: string }> = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

// Bucket attribution rows into the active window using PKT day boundaries
// for "today" and rolling 7/30-day windows for the others. Pure function so
// the tab switch stays cheap (zero queries, just a recompute).
function bucketAttribution(
  rows: AttributionRow[],
  windowKey: "today" | "7d" | "30d"
): { totals: Record<Channel, number>; total: number } {
  let lowerBoundMs: number;
  if (windowKey === "today") {
    const { startIso } = pktTodayWindowUtc();
    lowerBoundMs = new Date(startIso).getTime();
  } else if (windowKey === "7d") {
    lowerBoundMs = Date.now() - 7 * 24 * 3600 * 1000;
  } else {
    lowerBoundMs = Date.now() - 30 * 24 * 3600 * 1000;
  }
  const totals: Record<Channel, number> = {
    facebook_ads: 0,
    instagram_ads: 0,
    direct_organic: 0,
  };
  let total = 0;
  for (const r of rows) {
    if (new Date(r.attributed_at).getTime() < lowerBoundMs) continue;
    totals[r.channel] += 1;
    total += 1;
  }
  return { totals, total };
}

function ChannelsCard({
  attribution,
  window,
  setWindow,
}: {
  attribution: AttributionRow[];
  window: "today" | "7d" | "30d";
  setWindow: (w: "today" | "7d" | "30d") => void;
}) {
  const { totals, total } = bucketAttribution(attribution, window);

  // Used to scale per-channel bars relative to the largest bucket so a 60/20/20
  // split renders as 100% / 33% / 33% width — easier to read at small counts
  // than scaling by absolute percentage of total.
  const max = Math.max(1, ...CHANNEL_ORDER.map((c) => totals[c]));

  const windowLabel =
    window === "today" ? "today" : window === "7d" ? "in the last 7 days" : "in the last 30 days";

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <BlockStack gap="100">
            <Text as="h3" variant="headingMd">
              Where orders came from
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              First-touch channel for each tracked Purchase.
            </Text>
          </BlockStack>
          <SegmentedTabs
            value={window}
            options={WINDOW_OPTIONS}
            onChange={setWindow}
          />
        </InlineStack>

        {total === 0 ? (
          <div
            style={{
              padding: "32px 16px",
              textAlign: "center",
              color: "#64748b",
              background: "#f8fafc",
              borderRadius: 12,
              border: "1px dashed #e2e8f0",
            }}
          >
            <Text as="p" variant="bodyMd" tone="subdued">
              No tracked orders {windowLabel}.
            </Text>
          </div>
        ) : (
          <BlockStack gap="300">
            {CHANNEL_ORDER.map((c) => (
              <ChannelRow
                key={c}
                channel={c}
                count={totals[c]}
                total={total}
                max={max}
              />
            ))}
          </BlockStack>
        )}

        <Text as="p" variant="bodySm" tone="subdued">
          {total} order{total === 1 ? "" : "s"} {windowLabel}
        </Text>
      </BlockStack>
    </Card>
  );
}

function ChannelRow({
  channel,
  count,
  total,
  max,
}: {
  channel: Channel;
  count: number;
  total: number;
  max: number;
}) {
  const meta = CHANNEL_META[channel];
  const pctOfTotal = total === 0 ? 0 : Math.round((count / total) * 100);
  const barWidthPct = max === 0 ? 0 : (count / max) * 100;
  const dim = count === 0;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "40px 1fr auto",
        alignItems: "center",
        gap: 14,
        opacity: dim ? 0.55 : 1,
      }}
    >
      {/* Boxed brand icon. Stripe / Linear treatment — a small rounded tile
          tinted with the channel's brand colour at low alpha, so the icon
          itself stays readable on a wide range of backgrounds. */}
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: meta.iconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <img
          src={meta.iconUrl}
          alt=""
          width={24}
          height={24}
          style={{ display: "block" }}
        />
      </div>

      {/* Label + bar stacked. Bar uses the channel accent at full saturation
          for the filled portion, with the unfilled track in slate-100. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {meta.label}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {pctOfTotal}%
          </Text>
        </div>
        <div
          role="progressbar"
          aria-valuenow={count}
          aria-valuemin={0}
          aria-valuemax={total || 1}
          style={{
            position: "relative",
            width: "100%",
            height: 6,
            background: "#f1f5f9",
            borderRadius: 9999,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${barWidthPct}%`,
              height: "100%",
              background: meta.accent,
              borderRadius: 9999,
              transition: "width 400ms cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          />
        </div>
      </div>

      {/* Count, right-aligned, monospace tabular figures so the digits line
          up vertically across rows even at different widths. */}
      <Text as="span" variant="headingMd">
        <span
          style={{
            fontFeatureSettings: '"tnum" on, "lnum" on',
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {count}
        </span>
      </Text>
    </div>
  );
}

// Segmented control for the Today / 7d / 30d window picker. Custom rather
// than Polaris Tabs because Polaris Tabs is heavy (full-width tabbed page
// pattern) and reads as a layout primitive — we want a compact pill-group
// control sitting alongside a heading. Same UX as Stripe's date-range
// segmented controls.
function SegmentedTabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "inline-flex",
        padding: 3,
        background: "#f1f5f9",
        borderRadius: 10,
        gap: 2,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            style={{
              border: 0,
              padding: "6px 12px",
              borderRadius: 8,
              background: active ? "#ffffff" : "transparent",
              color: active ? "#0f172a" : "#64748b",
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              cursor: "pointer",
              boxShadow: active
                ? "0 1px 2px rgba(15, 23, 42, 0.08), 0 0 0 0.5px rgba(15, 23, 42, 0.06)"
                : "none",
              transition:
                "background 120ms ease, color 120ms ease, box-shadow 120ms ease",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

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

// Solid accent colour matched to each band. Used by the big numeric score so
// the digits read as a continuation of the bar's colour, not a separate visual
// element. Hex picked from Tailwind's 600-shade palette so it stays legible
// against the white Polaris card background regardless of band.
function emqAccentHex(score: number | null | undefined): string {
  if (score == null) return "#475569"; // slate-600
  if (score >= 8) return "#15803d"; // green-700
  if (score >= 6) return "#1d4ed8"; // blue-700
  return "#b91c1c"; // red-700
}

// Hero-level status dot with the same accent + halo treatment used by the
// Match strength helper, sized larger because it's the page's primary
// "is this working?" anchor. Tone maps onto the same accent colours we use
// elsewhere so the page reads as one design system, not three.
function StatusDot({
  tone,
}: {
  tone: "success" | "attention" | "warning";
}) {
  const color =
    tone === "success"
      ? "#15803d" // green-700
      : tone === "warning"
        ? "#b45309" // amber-700
        : "#475569"; // slate-600 (attention/neutral)
  return (
    <span
      aria-hidden="true"
      style={{
        width: 10,
        height: 10,
        borderRadius: 9999,
        background: color,
        boxShadow: `0 0 0 4px ${color}1f`,
        flexShrink: 0,
        display: "inline-block",
      }}
    />
  );
}

// Status-pulse dot + one-line helper. The dot picks up the band's accent
// colour so the helper line reads as part of the bar rather than a separate
// block of copy — keeps the section calm but still scanned.
function MatchStrengthHelper({
  score,
}: {
  score: number | null;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: 9999,
          background: emqAccentHex(score),
          boxShadow: `0 0 0 3px ${emqAccentHex(score)}1f`,
          flexShrink: 0,
        }}
      />
      <Text as="p" variant="bodySm" tone="subdued">
        {emqBadgeHelper(score)}
      </Text>
    </div>
  );
}

// Custom modern progress bar. Polaris ProgressBar reads as flat next to
// dashboards merchants spend their day in (Stripe / Vercel / Linear), so we
// render our own pill-shaped track with a band-aware gradient fill, an inset
// shadow on the track for depth, and a subtle outer-shadow + top-highlight
// on the fill that makes the colour feel solid rather than painted-on. The
// 600ms ease-out transition runs once on mount so the bar feels alive on
// page load. Tick marks at 6 and 8 show the band boundaries inline.
function MatchStrengthBar({
  score,
}: {
  score: number | null;
}) {
  const pct = score == null ? 0 : Math.min(100, Math.max(0, score * 10));
  const fillBackground =
    score == null
      ? "transparent"
      : score >= 8
        ? "linear-gradient(90deg, #15803d 0%, #22c55e 100%)"
        : score >= 6
          ? "linear-gradient(90deg, #1d4ed8 0%, #3b82f6 100%)"
          : "linear-gradient(90deg, #b91c1c 0%, #ef4444 100%)";

  return (
    <div style={{ width: "100%" }}>
      <div
        role="progressbar"
        aria-valuenow={score ?? undefined}
        aria-valuemin={0}
        aria-valuemax={10}
        style={{
          position: "relative",
          width: "100%",
          height: 14,
          background: "#eef2f7",
          borderRadius: 9999,
          overflow: "hidden",
          boxShadow: "inset 0 1px 2px rgba(15, 23, 42, 0.08)",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: fillBackground,
            borderRadius: 9999,
            transition: "width 600ms cubic-bezier(0.16, 1, 0.3, 1)",
            boxShadow:
              score == null
                ? undefined
                : "0 1px 3px rgba(15, 23, 42, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.25)",
          }}
        />
        {/* Band boundary tick marks at 60% (Good) and 80% (Excellent). Drawn
            on top of the fill at low opacity so they stay visible whether the
            fill has reached them or not. */}
        <div
          style={{
            position: "absolute",
            left: "60%",
            top: 0,
            bottom: 0,
            width: 1,
            background: "rgba(15, 23, 42, 0.2)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "80%",
            top: 0,
            bottom: 0,
            width: 1,
            background: "rgba(15, 23, 42, 0.2)",
          }}
        />
      </div>
      {/* Inline scale legend — three labels positioned under the band ticks. */}
      <div
        style={{
          position: "relative",
          height: 16,
          marginTop: 6,
          fontSize: 11,
          color: "#64748b",
          letterSpacing: "0.01em",
        }}
      >
        <span style={{ position: "absolute", left: 0 }}>0</span>
        <span
          style={{
            position: "absolute",
            left: "60%",
            transform: "translateX(-50%)",
          }}
        >
          6 · Good
        </span>
        <span
          style={{
            position: "absolute",
            left: "80%",
            transform: "translateX(-50%)",
          }}
        >
          8 · Excellent
        </span>
        <span style={{ position: "absolute", right: 0 }}>10</span>
      </div>
    </div>
  );
}

function emqBadgeLabel(score: number | null | undefined): string {
  if (score == null) return "Calibrating";
  if (score >= 8) return "Excellent";
  if (score >= 6) return "Good";
  return "Improving";
}

function emqBadgeHelper(score: number | null | undefined): string {
  if (score == null) return "Calibrating — first reading in a day or two.";
  if (score >= 8) return "Top of the industry.";
  if (score >= 6) return "Solid. We keep tuning — climbs over the next 2-3 weeks.";
  return "Optimizing. Usually settles within a week.";
}
