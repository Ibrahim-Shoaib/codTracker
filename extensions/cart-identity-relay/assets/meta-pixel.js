// COD Tracker — Browser-Side Meta Pixel Loader.
//
// Runs on every storefront page (theme app embed). Fetches the merchant's
// connected Pixel ID from our App Proxy, then loads the standard Meta Pixel
// browser script and fires PageView with Advanced Matching. Designed to
// coexist with our server-side CAPI relay — both paths use deterministic
// event_ids so Meta deduplicates.
//
// Why this exists:
//   - Meta Pixel Helper only detects pixels initialized via fbq() on the
//     parent page. Custom Web Pixels (sandboxed) can't call fbq(), so without
//     this, Pixel Helper shows "no pixels found" even though server CAPI is
//     firing perfectly. That's a trust/verification UX gap for merchants.
//   - Hybrid (browser + server) firing pushes EMQ from ~7 to ~9 because Meta
//     merges browser-side fbp cookie + native UA/IP + Advanced Matching
//     hashes (em, ph, fn, ln, ct, st, zp, country, external_id) with the
//     server-side hashed PII into a single rich identity profile.
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
  //    that match what the server-side Web Pixel emits. We persist it via
  //    cookie so the sandboxed Web Pixel and this script share the same id
  //    across firings within a single page lifecycle (cookies are visible to
  //    both contexts; sandboxed localStorage is not).
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
  //    https://developers.facebook.com/docs/meta-pixel/get-started. Loads
  //    fbevents.js asynchronously and stubs fbq() so calls made before the
  //    script loads queue up correctly.
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

  // Build the Advanced Matching payload from values the Liquid block staged
  // onto window.__codprofitAM. Drops empty/null entries so we don't send
  // {em: ""} (which Meta treats as "matching attempted, no value" and
  // penalizes EMQ for). Returns undefined if nothing identifies the visitor
  // — fbq init then fires without an AM block, which is fine.
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

  // ── 3. Bootstrap. Fetch the connected Pixel ID from our App Proxy, then
  //    init fbq with Advanced Matching and fire PageView.
  function bootstrap() {
    fetch("/apps/tracking/config", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (cfg) {
        if (!cfg || !cfg.connected || !cfg.pixel_id) {
          // Merchant hasn't connected their Pixel yet — silently no-op.
          // We don't init fbq with a fake id (Pixel Helper would flag it).
          return;
        }
        loadFbq();
        var pixelId = String(cfg.pixel_id);

        // Pass Advanced Matching INTO init so it applies to every track call
        // that follows (PageView + any future ViewContent / AddToCart). Meta
        // hashes client-side with their canonical normalization; sending raw
        // values is the documented spec.
        var am = buildAdvancedMatching();
        if (am) {
          window.fbq("init", pixelId, am);
        } else {
          window.fbq("init", pixelId);
        }

        // PageView event_id MUST match the server-side Web Pixel beacon's
        // page_viewed id so Meta dedupes. Web Pixel uses
        //   fallbackId("page_viewed") = `pageview:<shop>:<psid>`
        // (lowercased event-name colon shop colon page-session-id). The
        // canonical .myshopify.com domain is preferred — the Custom Web
        // Pixel uses init.context.window.location.origin which Shopify maps
        // to the .myshopify.com host inside its sandbox. window.Shopify.shop
        // exposes the same value to us here. If it's missing for any reason,
        // we still fire PageView with a synthesized id (worst case: the
        // pageview is double-counted on Meta's side, which is far less bad
        // than not firing at all).
        var shop =
          (window.Shopify && window.Shopify.shop) ||
          (cfg && cfg.shop) ||
          window.location.hostname;
        var psid = getOrCreatePageSession();
        var eventId = "pageview:" + shop + ":" + psid;

        window.fbq("track", "PageView", {}, { eventID: eventId });
      })
      .catch(function () {
        // Silent failure — we never want a tracking error to crash the
        // merchant's storefront.
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
