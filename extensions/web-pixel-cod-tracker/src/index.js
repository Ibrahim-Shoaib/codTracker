// COD Tracker — Custom Web Pixel.
//
// Runs in Shopify's strict-mode (LavaMoat) sandbox on the storefront and
// checkout. Captures customer events and beacons them to our App Proxy
// endpoint (/apps/tracking/track) so the server-side CAPI relay can fire
// matching events with the highest possible Event Match Quality.
//
// CRITICAL: event_id MUST match between the browser pixel event and the
// server-side CAPI event for Meta to deduplicate. We use the same
// `<event>:<shop>:<resource>` format on both sides — see
// app/routes/api.webhooks.meta-pixel.tsx for the matching server logic.
//
// Sandbox APIs available:
//   analytics.subscribe(name, cb)
//   browser.cookie.get / set
//   browser.localStorage.get / set / remove
//   browser.sendBeacon(url, body)   // best effort, doesn't block
//   init.context.window.location, init.context.document.referrer, etc.

import { register } from "@shopify/web-pixels-extension";

register(({ analytics, browser, init, settings }) => {
  const accountID = settings?.accountID;
  if (!accountID) {
    // No shop id → can't route the beacon, can't compute deterministic event_ids. Bail silently.
    return;
  }

  // App Proxy endpoint on the merchant's storefront domain. Shopify rewrites
  // /apps/tracking/* to https://{ourapp}/proxy/tracking/* and signs the call.
  // Using the merchant's domain keeps cookies first-party and bypasses
  // most ad blockers (they don't filter the merchant's own host).
  const beaconBase = `${init.context.window.location.origin}/apps/tracking/track`;

  // ─── Cookie + identity helpers ──────────────────────────────────────────────

  const NINETY_DAYS = 90 * 24 * 60 * 60;

  function generateFbp() {
    const rand = Math.floor(Math.random() * 1e10);
    return `fb.1.${Date.now()}.${rand}`;
  }

  function captureFbclid() {
    const search = init.context.window.location.search ?? "";
    const m = search.match(/[?&]fbclid=([^&#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function ensureFbCookies() {
    let fbp = await browser.cookie.get("_fbp");
    if (!fbp) {
      fbp = generateFbp();
      await browser.cookie.set("_fbp", fbp, { maxAge: NINETY_DAYS });
    }

    let fbc = await browser.cookie.get("_fbc");
    const fbclid = captureFbclid();
    if (!fbc && fbclid) {
      fbc = `fb.1.${Date.now()}.${fbclid}`;
      await browser.cookie.set("_fbc", fbc, { maxAge: NINETY_DAYS });
    }

    return { fbp, fbc, fbclid };
  }

  // ─── event_id strategy ──────────────────────────────────────────────────────
  //
  // Deterministic format `<event>:<shop>:<resource>` matched on the server.
  // For events with a stable resource id available in the customer-event
  // payload (Purchase has order.id, AddPaymentInfo/InitiateCheckout have
  // checkout.token), we derive the id; webhook retries + browser pixel both
  // produce the SAME id so Meta deduplicates correctly.
  //
  // For events without a stable resource id (PageView, ViewContent, AddToCart
  // before a cart is created, Search), we fall back to a session+timestamp
  // composite that's stable across the same page load — these events don't
  // have a webhook counterpart so dedup isn't critical for them.

  function deterministicId(eventName, resourceId) {
    return `${eventName.toLowerCase()}:${accountID}:${resourceId}`;
  }

  // Per-page-load id, used as a fallback when no resource id is in scope.
  // We persist it to a cookie (`_codprofit_psid`) so the unsandboxed theme
  // app embed (which fires browser-side fbq() for Meta Pixel Helper) can
  // read the same value and produce matching event_ids — Meta dedupes on
  // event_id, and without a shared session key the browser-side PageView
  // and the server-side PageView would double-count.
  //
  // Cookie reads/writes via browser.cookie are async and not always
  // available in every sandbox build, so we wrap the whole thing in a
  // promise. The cookie has a 30-minute TTL — long enough for one browsing
  // session but short enough that stale ids don't leak across visitors.
  const PSID_COOKIE = "_codprofit_psid";
  const PSID_TTL = 30 * 60; // 30 minutes

  async function resolvePageSession() {
    try {
      const existing = await browser.cookie.get(PSID_COOKIE);
      if (existing) return existing;
    } catch (_) {
      /* cookie read failed — fall through to generate a fresh one */
    }
    const rand = Math.floor(Math.random() * 1e12).toString(36);
    const psid = `${Date.now()}.${rand}`;
    try {
      await browser.cookie.set(PSID_COOKIE, psid, { maxAge: PSID_TTL });
    } catch (_) {
      /* swallow — id still works for this page even if not persisted */
    }
    return psid;
  }

  // Resolved once at register-time so all subscriptions share the same id.
  // The promise is awaited inside fallbackId where needed.
  const pageSessionPromise = resolvePageSession();

  async function fallbackId(eventName) {
    const psid = await pageSessionPromise;
    return `${eventName.toLowerCase()}:${accountID}:${psid}`;
  }

  // ─── Beacon ─────────────────────────────────────────────────────────────────

  function send(payload) {
    try {
      const body = JSON.stringify(payload);
      browser.sendBeacon(beaconBase, body);
    } catch (err) {
      try {
        fetch(beaconBase, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true,
          credentials: "include",
        });
      } catch (_) {
        /* swallow */
      }
    }
  }

  // track() now resolves eventId before sending. eventId may be a string
  // (deterministic, when a resource id is in scope) OR a Promise<string>
  // (fallback, when we have to read the shared page-session cookie). The
  // wrapper normalizes both so subscribe handlers stay tidy.
  async function track(eventName, eventId, customData = {}) {
    const resolvedId =
      typeof eventId === "string" ? eventId : await eventId;
    const { fbp, fbc } = await ensureFbCookies();
    send({
      event: eventName,
      event_id: resolvedId,
      event_time: Date.now(),
      url: init.context.window.location.href,
      fbp,
      fbc,
      user_agent: init.context.navigator?.userAgent,
      ...customData,
    });
  }

  // ─── Subscribe to standard customer events ─────────────────────────────────

  // PageView — included for retargeting and Lookalike-from-website-visitors
  // audience generation. Some merchants run brand-awareness campaigns that
  // need this signal. AEM no longer caps at 8 events (June 2025), so the
  // bandwidth tradeoff is fine.
  analytics.subscribe("page_viewed", () => {
    track("page_viewed", fallbackId("page_viewed"));
  });

  analytics.subscribe("product_viewed", (event) => {
    const variant = event?.data?.productVariant;
    if (!variant) return;
    track("product_viewed", fallbackId("product_viewed"), {
      content_ids: variant.product?.id ? [String(variant.product.id)] : [],
      value: Number(variant.price?.amount ?? 0),
      currency: variant.price?.currencyCode,
      num_items: 1,
    });
  });

  analytics.subscribe("product_added_to_cart", (event) => {
    const item = event?.data?.cartLine;
    const merch = item?.merchandise;
    track("product_added_to_cart", fallbackId("product_added_to_cart"), {
      content_ids: merch?.product?.id ? [String(merch.product.id)] : [],
      value: Number(item?.cost?.totalAmount?.amount ?? 0),
      currency: item?.cost?.totalAmount?.currencyCode,
      num_items: Number(item?.quantity ?? 1),
    });
  });

  analytics.subscribe("search_submitted", (event) => {
    const query = event?.data?.searchResult?.query;
    if (!query) return;
    track("search_submitted", fallbackId("search_submitted"), {
      search_string: query,
    });
  });

  // checkout_started → InitiateCheckout. Use checkout.token as the resource id
  // so the matching server-side webhook (CHECKOUTS_CREATE) produces the same
  // event_id and Meta dedups.
  analytics.subscribe("checkout_started", (event) => {
    const c = event?.data?.checkout;
    if (!c) return;
    const eventId = c.token
      ? deterministicId("InitiateCheckout", c.token)
      : fallbackId("checkout_started");
    track("checkout_started", eventId, {
      value: Number(c.totalPrice?.amount ?? 0),
      currency: c.totalPrice?.currencyCode,
      num_items: c.lineItems?.reduce?.(
        (sum, li) => sum + Number(li.quantity ?? 0),
        0
      ),
      content_ids:
        c.lineItems?.map?.((li) =>
          li.variant?.product?.id ? String(li.variant.product.id) : null
        ).filter(Boolean) ?? [],
    });
  });

  // payment_info_submitted → AddPaymentInfo. Same checkout.token as InitiateCheckout
  // but a different event_id (event-name is part of the deterministic key).
  analytics.subscribe("payment_info_submitted", (event) => {
    const c = event?.data?.checkout;
    const eventId = c?.token
      ? deterministicId("AddPaymentInfo", c.token)
      : fallbackId("payment_info_submitted");
    track("payment_info_submitted", eventId, {
      value: Number(c?.totalPrice?.amount ?? 0),
      currency: c?.totalPrice?.currencyCode,
    });
  });

  // checkout_completed → Purchase. The MOST critical event_id to get right —
  // this is the one Meta optimizes against. Use order.id (always present in
  // the completed-checkout payload) so the webhook-driven Purchase
  // (orders/paid) generates the IDENTICAL event_id and Meta deduplicates.
  analytics.subscribe("checkout_completed", (event) => {
    const c = event?.data?.checkout;
    if (!c) return;
    const orderId = c.order?.id;
    const eventId = orderId
      ? deterministicId("Purchase", orderId)
      : fallbackId("checkout_completed");
    track("checkout_completed", eventId, {
      value: Number(c.totalPrice?.amount ?? 0),
      currency: c.totalPrice?.currencyCode,
      num_items: c.lineItems?.reduce?.(
        (sum, li) => sum + Number(li.quantity ?? 0),
        0
      ),
      content_ids:
        c.lineItems?.map?.((li) =>
          li.variant?.product?.id ? String(li.variant.product.id) : null
        ).filter(Boolean) ?? [],
      email: c.email,
      phone: c.phone,
      external_id: c.order?.customer?.id ? String(c.order.customer.id) : undefined,
    });
  });
});
