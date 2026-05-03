// COD Tracker — Custom Web Pixel.
//
// Runs in Shopify's strict-mode (LavaMoat) sandbox on the storefront and
// checkout. Captures customer events and beacons them to our App Proxy
// endpoint (/apps/tracking/track) so the server-side CAPI relay can fire
// matching events with the highest possible Event Match Quality.
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
    // No shop id → can't route the beacon. Bail silently rather than throw.
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
    // Format: fb.1.<unix_ms>.<10-digit-random>
    const rand = Math.floor(Math.random() * 1e10);
    return `fb.1.${Date.now()}.${rand}`;
  }

  function captureFbclid() {
    const search = init.context.window.location.search ?? "";
    const m = search.match(/[?&]fbclid=([^&#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Read or initialize _fbp / _fbc cookies on the storefront domain.
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

  // Generate or reuse a per-event UUID. Same event_id is also written to cart
  // attributes by the Theme App Extension snippet — that's how the server-side
  // Purchase event from the order webhook dedups against our beacon Purchase.
  function uuid() {
    // RFC4122 v4-ish — sandbox doesn't expose crypto.randomUUID reliably.
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // Persist the current Purchase event_id under a cart attribute so the
  // order webhook handler can match. localStorage backup in case the user
  // navigates away without a cart yet.
  async function setEventId(eventId) {
    try {
      await browser.localStorage.setItem("_cod_event_id", eventId);
    } catch (_) {
      /* storage might be blocked — beacons still work */
    }
  }

  // ─── Beacon ─────────────────────────────────────────────────────────────────

  function send(payload) {
    try {
      const body = JSON.stringify(payload);
      // sendBeacon is fire-and-forget and survives the page unload that
      // happens immediately after checkout_completed.
      browser.sendBeacon(beaconBase, body);
    } catch (err) {
      // Last-resort fallback; sendBeacon errors are swallowed by spec.
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

  async function track(eventName, customData = {}) {
    const { fbp, fbc } = await ensureFbCookies();
    const eventId = uuid();
    if (eventName === "checkout_completed") {
      await setEventId(eventId);
    }
    send({
      event: eventName,
      event_id: eventId,
      event_time: Date.now(),
      url: init.context.window.location.href,
      fbp,
      fbc,
      user_agent: init.context.navigator?.userAgent,
      ...customData,
    });
  }

  // ─── Subscribe to standard customer events ─────────────────────────────────
  // Skipping page_viewed entirely — it's noisy and Meta's algorithm doesn't
  // optimize on it for ecom Purchase campaigns.

  analytics.subscribe("product_viewed", (event) => {
    const variant = event?.data?.productVariant;
    if (!variant) return;
    track("product_viewed", {
      content_ids: variant.product?.id ? [String(variant.product.id)] : [],
      value: Number(variant.price?.amount ?? 0),
      currency: variant.price?.currencyCode,
      num_items: 1,
    });
  });

  analytics.subscribe("product_added_to_cart", (event) => {
    const item = event?.data?.cartLine;
    const merch = item?.merchandise;
    track("product_added_to_cart", {
      content_ids: merch?.product?.id ? [String(merch.product.id)] : [],
      value: Number(item?.cost?.totalAmount?.amount ?? 0),
      currency: item?.cost?.totalAmount?.currencyCode,
      num_items: Number(item?.quantity ?? 1),
    });
  });

  analytics.subscribe("search_submitted", (event) => {
    const query = event?.data?.searchResult?.query;
    if (!query) return;
    track("search_submitted", { search_string: query });
  });

  analytics.subscribe("checkout_started", (event) => {
    const c = event?.data?.checkout;
    if (!c) return;
    track("checkout_started", {
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

  analytics.subscribe("payment_info_submitted", (event) => {
    const c = event?.data?.checkout;
    track("payment_info_submitted", {
      value: Number(c?.totalPrice?.amount ?? 0),
      currency: c?.totalPrice?.currencyCode,
    });
  });

  analytics.subscribe("checkout_completed", (event) => {
    const c = event?.data?.checkout;
    if (!c) return;
    // Identity hints on completed checkout — Shopify provides hashed-able
    // email/phone here; we forward unhashed and let the server hash with
    // the correct normalization.
    track("checkout_completed", {
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
