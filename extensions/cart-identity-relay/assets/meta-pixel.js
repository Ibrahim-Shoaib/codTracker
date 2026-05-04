// COD Tracker — Browser-Side Meta Pixel Loader.
//
// Runs on every storefront page (theme app embed). Fetches the merchant's
// connected Pixel ID from our App Proxy, then loads the standard Meta Pixel
// browser script and fires PageView with Advanced Matching, plus context-
// aware ViewContent / AddToCart / InitiateCheckout / Purchase. Designed to
// coexist with our server-side CAPI relay — both paths use deterministic
// event_ids so Meta deduplicates.
//
// Why this is more than just an init:
//   - Meta Pixel Helper only detects pixels initialized via fbq() AND only
//     verifies events that fire from the parent page. Custom Web Pixels
//     (Shopify's strict-mode sandbox) can't call fbq, so without this
//     module Pixel Helper sees PageView and nothing else — every cart add
//     and checkout looks like a SubscribedButtonClick (Meta's automatic-
//     events catch-all), which is misleading and clutters the merchant's
//     attribution.
//   - We disable automatic events (autoConfig=false) so Pixel Helper only
//     sees the canonical events we explicitly fire. No more
//     SubscribedButtonClick noise.
//   - We hook /cart/add fetch / XHR / form submissions, watch the URL for
//     product/checkout/thank-you patterns, and fire the right standard
//     event with a deterministic event_id that matches what the Custom
//     Web Pixel beacons to /apps/tracking/track. Meta dedupes the dual
//     fire.
//
// Cost: zero. Meta serves fbevents.js from their CDN, doesn't charge per
// event, and dedupes via event_id so audience/conversion counts are
// unaffected by the dual firing.

(function () {
  "use strict";

  // ── 0. Don't run twice if the embed is double-included for any reason.
  if (window.__codprofitMetaPixelLoaded) return;
  window.__codprofitMetaPixelLoaded = true;

  // ── 1. A page-scoped session id, used to compute deterministic event_ids
  //    that match what the sandboxed Custom Web Pixel emits. We persist it
  //    via cookie so the sandbox and this script share the same id across
  //    firings within a single page lifecycle (cookies are visible to both
  //    contexts; sandboxed localStorage is not).
  var COOKIE_PSID = "_codprofit_psid";

  function getCookie(name) {
    var m = document.cookie.match(
      new RegExp(
        "(?:^|; )" +
          name.replace(/[.$?*|{}()[\]\\\/+^]/g, "\\$&") +
          "=([^;]*)"
      )
    );
    return m ? decodeURIComponent(m[1]) : null;
  }

  function setCookie(name, value, seconds) {
    var exp = new Date();
    exp.setTime(exp.getTime() + seconds * 1000);
    document.cookie =
      name +
      "=" +
      encodeURIComponent(value) +
      "; expires=" +
      exp.toUTCString() +
      "; path=/; SameSite=Lax";
  }

  function getOrCreatePageSession() {
    var existing = getCookie(COOKIE_PSID);
    if (existing) return existing;
    var rand = Math.floor(Math.random() * 1e12).toString(36);
    var psid = Date.now() + "." + rand;
    setCookie(COOKIE_PSID, psid, 30 * 60);
    return psid;
  }

  // ── 2. Standard Meta Pixel install snippet, copied verbatim from
  //    https://developers.facebook.com/docs/meta-pixel/get-started.
  function loadFbq() {
    if (window.fbq) return;
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod
          ? n.callMethod.apply(n, arguments)
          : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = !0;
      n.version = "2.0";
      n.queue = [];
      t = b.createElement(e);
      t.async = !0;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(
      window,
      document,
      "script",
      "https://connect.facebook.net/en_US/fbevents.js"
    );
  }

  // Build Advanced Matching from the Liquid-staged window.__codprofitAM.
  // Drops empty entries — Meta penalizes EMQ when AM keys carry empty
  // strings ("matching attempted, no value"). Returns undefined if nothing
  // identifies the visitor; fbq init then runs without an AM block.
  function buildAdvancedMatching() {
    var am = window.__codprofitAM || {};
    var out = {};
    var keys = ["em", "ph", "fn", "ln", "ct", "st", "zp", "country", "external_id"];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = am[k];
      if (v == null) continue;
      v = String(v).trim();
      if (!v) continue;
      out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }

  // ── 3. Event firing helpers. Each event uses a deterministic event_id
  //    matching what the sandboxed Custom Web Pixel emits, so Meta dedupes
  //    the dual fire (browser fbq + server CAPI from the beacon).
  function fireEvent(eventName, eventId, customData) {
    try {
      window.fbq("track", eventName, customData || {}, { eventID: eventId });
    } catch (_) {
      /* swallow */
    }
  }

  function getCurrency() {
    return (
      (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) ||
      undefined
    );
  }

  // Wire InitiateCheckout firing to "user is heading to checkout" intent.
  // Theme app embeds don't run on the new Shopify checkout runtime
  // (Checkout Extensibility), so we can't fire from the checkout page —
  // we have to catch the click that's about to navigate there. Three
  // shapes covered:
  //   - <button name="checkout">           (Shopify default cart form)
  //   - <input type="submit" name="checkout">
  //   - <a href="/checkout"> / <a href="/checkouts/...">  (text links,
  //     custom themes, ajax cart drawers)
  //   - <form action="/checkout"> submission (some themes wrap the
  //     button in a form that POSTs to /checkout)
  //
  // Idempotent within a session: psid-based event_id matches what the
  // sandboxed Custom Web Pixel emits via fallbackId("checkout_started"),
  // so Meta dedupes the dual fire (theme block fbq + server CAPI from
  // beacon).
  function installCheckoutClickHooks(shop, psid) {
    var fired = false;
    function fireOnce() {
      if (fired) return;
      fired = true;
      var customData = { currency: getCurrency() };
      // Match the Custom Web Pixel's fallbackId("checkout_started") so
      // server CAPI from the beacon dedupes with this fbq fire.
      var eventId = "checkout_started:" + shop + ":" + psid;
      fireEvent("InitiateCheckout", eventId, customData);
    }

    var checkoutPathRe = /^\/(checkout|checkouts\/)/i;

    function isCheckoutTrigger(node) {
      if (!node || node.nodeType !== 1) return false;
      // <button name="checkout"> / <input name="checkout"> — the
      // canonical Shopify cart-form submit button.
      if (
        (node.tagName === "BUTTON" || node.tagName === "INPUT") &&
        node.getAttribute &&
        node.getAttribute("name") === "checkout"
      ) {
        return true;
      }
      // <a href="/checkout"> or /checkouts/...
      if (node.tagName === "A") {
        var href = node.getAttribute && node.getAttribute("href");
        if (href && checkoutPathRe.test(href)) return true;
      }
      return false;
    }

    document.addEventListener(
      "click",
      function (ev) {
        // Walk up — the click target is often a child of the button
        // (e.g. an inner <span> inside <button name="checkout">).
        var node = ev.target;
        for (var i = 0; node && i < 5; i++) {
          if (isCheckoutTrigger(node)) {
            fireOnce();
            return;
          }
          node = node.parentNode;
        }
      },
      true
    );

    // Form-submit shape: <form action="/checkout">. Some themes don't
    // give the button a name="checkout" and rely on the form action.
    document.addEventListener(
      "submit",
      function (ev) {
        var form = ev.target;
        if (form && form.action && checkoutPathRe.test(new URL(form.action, location.href).pathname)) {
          fireOnce();
        }
      },
      true
    );
  }

  // Wire AddToCart firing to actual cart-add network calls. Three hooks
  // because Shopify themes use any of these:
  //   - fetch() to /cart/add.js (most modern themes)
  //   - XHR to /cart/add (older themes, jQuery-based)
  //   - form submission to /cart/add (no-AJAX themes)
  function installCartAddHooks(shop, psid) {
    var fired = false;
    function fireOnce() {
      // Same event_id within a session matches Custom Web Pixel beacon
      // for product_added_to_cart so Meta dedupes. Multiple add-to-cart
      // actions in the same session collapse to one event in Meta — same
      // behavior as the sandboxed pixel; not optimal for tracking
      // distinct items but consistent with existing dedup expectations.
      var eventId = "product_added_to_cart:" + shop + ":" + psid;
      fireEvent("AddToCart", eventId, { currency: getCurrency() });
      fired = true;
    }

    var addToCartUrl = /\/cart\/add(\.[a-z]+)?(\?|$)/i;

    // Hook fetch.
    var origFetch = window.fetch;
    if (origFetch && !origFetch.__codprofitWrapped) {
      window.fetch = function (input, init) {
        var url = typeof input === "string" ? input : input && input.url;
        var matches = url && addToCartUrl.test(url);
        var ret = origFetch.apply(this, arguments);
        if (matches && ret && typeof ret.then === "function") {
          ret
            .then(function (r) {
              if (r && r.ok) fireOnce();
            })
            .catch(function () {});
        }
        return ret;
      };
      window.fetch.__codprofitWrapped = true;
    }

    // Hook XHR.
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && !XHR.prototype.__codprofitWrapped) {
      var origOpen = XHR.prototype.open;
      var origSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__codprofitUrl = url;
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        var self = this;
        if (self.__codprofitUrl && addToCartUrl.test(self.__codprofitUrl)) {
          self.addEventListener("load", function () {
            if (self.status >= 200 && self.status < 300) fireOnce();
          });
        }
        return origSend.apply(this, arguments);
      };
      XHR.prototype.__codprofitWrapped = true;
    }

    // Hook form submit (non-AJAX add-to-cart forms).
    document.addEventListener(
      "submit",
      function (ev) {
        var form = ev.target;
        if (
          form &&
          form.action &&
          addToCartUrl.test(form.action) &&
          !fired
        ) {
          // The browser is about to navigate; fire synchronously so the
          // beacon goes out before unload.
          fireOnce();
        }
      },
      true
    );
  }

  // ── 4. Bootstrap. Fetch connected Pixel ID, init fbq, fire context-
  //    appropriate events.
  function bootstrap() {
    fetch("/apps/tracking/config", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (cfg) {
        if (!cfg || !cfg.connected || !cfg.pixel_id) return;

        loadFbq();
        var pixelId = String(cfg.pixel_id);

        // Disable automatic events (the source of SubscribedButtonClick
        // showing up for cart/checkout buttons in Pixel Helper). MUST be
        // set before init for the pixel to honor it.
        window.fbq("set", "autoConfig", "false", pixelId);

        // Init with Advanced Matching staged by the Liquid block. AM
        // applies to every subsequent track call.
        var am = buildAdvancedMatching();
        if (am) window.fbq("init", pixelId, am);
        else window.fbq("init", pixelId);

        // Resolve canonical .myshopify.com host for event_id derivation.
        // We never fall back to window.location.hostname — on a custom
        // domain that returns the vanity host, breaking dedup with the
        // sandboxed Custom Web Pixel which always uses the .myshopify.com
        // form.
        var shop =
          (window.Shopify && window.Shopify.shop) || (cfg && cfg.shop);
        if (!shop) return;
        var psid = getOrCreatePageSession();
        var path = window.location.pathname || "";

        // ── PageView (always)
        fireEvent("PageView", "pageview:" + shop + ":" + psid);

        // ── ViewContent on product pages.
        // /products/<handle>[/...] is the canonical Shopify product URL.
        // window.ShopifyAnalytics?.meta?.product is exposed on product
        // templates — read content_ids from it for accurate matching.
        var productMatch = path.match(/^\/products\/([^/?#]+)/);
        if (productMatch) {
          var product =
            (window.ShopifyAnalytics &&
              window.ShopifyAnalytics.meta &&
              window.ShopifyAnalytics.meta.product) ||
            null;
          var variant = (product && product.variants && product.variants[0]) || null;
          var customData = { content_type: "product", currency: getCurrency() };
          if (product && product.id) {
            customData.content_ids = [String(product.id)];
          }
          if (variant && variant.price != null) {
            // Shopify exposes prices in cents on the analytics meta.
            customData.value = Number(variant.price) / 100;
          }
          // Match Custom Web Pixel's fallbackId("product_viewed").
          fireEvent(
            "ViewContent",
            "product_viewed:" + shop + ":" + psid,
            customData
          );
        }

        // ── InitiateCheckout: fire BEFORE navigation to checkout.
        // Modern Shopify (post Checkout Extensibility, Aug 2024) renders
        // /checkouts/c/<token> in a separate runtime that doesn't load
        // theme app embeds — so we can't fire from the checkout page
        // itself. Hooking the click on the checkout button while still on
        // the storefront/cart page is the only browser-side path to get
        // InitiateCheckout into Pixel Helper.
        installCheckoutClickHooks(shop, psid);

        // ── Purchase: SERVER-SIDE ONLY.
        // Post-purchase / thank-you pages also run in the new checkout
        // runtime — theme app embeds don't load there. We rely entirely
        // on the orders/paid webhook → server CAPI for Purchase events.
        // Pixel Helper won't see a Purchase row (this is the same trade-
        // off Triple Whale, Klaviyo, and wetracked.io accept), but Meta
        // gets a fully-identified Purchase event with the merchant's
        // hashed PII via the webhook path. Order-page event_id is
        // purchase:<shop>:<order_id>, deterministic for dedup with the
        // Custom Web Pixel beacon's checkout_completed fire.

        // ── AddToCart hooks. Wire once; fires whenever /cart/add hits.
        installCartAddHooks(shop, psid);
      })
      .catch(function () {
        // Silent failure — never crash the merchant's storefront.
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
