// COD Tracker — Cart Identity Relay (storefront).
//
// Runs on every storefront page load (theme app embed). Reads the _fbp and
// _fbc cookies our Custom Web Pixel sets, plus a fresh fbclid from the URL,
// and writes them as cart attributes via /cart/update.js. When the customer
// places an order, those values arrive on the order webhook in
// `note_attributes` — and our server-side CAPI relay reads them straight off
// the order without needing any per-visitor database.

(function () {
  "use strict";

  function getCookie(name) {
    const m = document.cookie.match(
      new RegExp("(?:^|; )" + name.replace(/[.$?*|{}()[\]\\\/+^]/g, "\\$&") + "=([^;]*)")
    );
    return m ? decodeURIComponent(m[1]) : null;
  }

  function setCookie(name, value, days) {
    const exp = new Date();
    exp.setTime(exp.getTime() + days * 86400 * 1000);
    document.cookie =
      name + "=" + encodeURIComponent(value) + "; expires=" + exp.toUTCString() + "; path=/; SameSite=Lax";
  }

  // ── Capture fbclid → _fbc on every visit (the Custom Web Pixel does this
  //    too, but it doesn't run on every page; this is a belt-and-suspenders
  //    that also covers theme blocks where the pixel hasn't fired yet).
  try {
    const params = new URLSearchParams(window.location.search);
    const fbclid = params.get("fbclid");
    if (fbclid && !getCookie("_fbc")) {
      setCookie("_fbc", "fb.1." + Date.now() + "." + fbclid, 90);
    }
  } catch (_) { /* swallow */ }

  // ── Compute the bundle of identity attributes to mirror onto the cart.
  function readIdentity() {
    const fbp = getCookie("_fbp");
    const fbc = getCookie("_fbc");
    const fbclid = (function () {
      try { return new URLSearchParams(window.location.search).get("fbclid"); }
      catch (_) { return null; }
    })();
    const ua = navigator.userAgent;
    // Long-lived visitor id, set on /apps/tracking/config response by
    // the server. The cookie is HttpOnly so we can't read it from JS;
    // we read it off window.__codprofitVisitorId, which the meta-pixel
    // theme block stages globally during its bootstrap. Both blocks
    // run on every page so by the time identity-relay's first
    // pushIfChanged fires, the visitor id is usually present. If not,
    // the cart-attribute write happens without it and the server
    // joins on the cookie at order time instead.
    const visitorId = window.__codprofitVisitorId || null;

    const out = {};
    if (fbp)       out["_fbp"]              = fbp;
    if (fbc)       out["_fbc"]              = fbc;
    if (fbclid)    out["_fbclid"]           = fbclid;
    if (ua)        out["_client_ua"]        = ua;
    if (visitorId) out["_cod_visitor_id"]   = visitorId;
    return out;
  }

  // ── Resolve the visitor id, in priority order:
  //    1. window.__codprofitVisitorId (staged by meta-pixel.js)
  //    2. document.cookie cod_visitor_id (set by meta-pixel.js bootstrap)
  //    3. localStorage cod_visitor_id (same source, redundancy for
  //       cookie-clearing visitors)
  //    4. fetch /apps/tracking/config?vid=<existing> as last resort
  //
  // Race-safe: on first page load identity-relay can DOMContentLoaded-
  // fire before meta-pixel.js's async config fetch resolves. We don't
  // want the cart write to miss the visitor id, so we re-read the
  // persistence layer here too.
  function readPersistedVid() {
    const m = document.cookie.match(/(?:^|;\s*)cod_visitor_id=([a-f0-9-]{32,40})/i);
    if (m) return m[1];
    try {
      const v = window.localStorage && window.localStorage.getItem("cod_visitor_id");
      if (v && /^[a-f0-9-]{32,40}$/i.test(v)) return v;
    } catch (_) {}
    return null;
  }
  async function ensureVisitorId() {
    if (window.__codprofitVisitorId) return window.__codprofitVisitorId;
    const persisted = readPersistedVid();
    if (persisted) {
      window.__codprofitVisitorId = persisted;
      return persisted;
    }
    // Last resort: round-trip to /apps/tracking/config (echoes any vid
    // we don't have, otherwise mints one).
    try {
      const res = await fetch("/apps/tracking/config", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const cfg = await res.json();
        if (cfg && cfg.visitor_id) {
          window.__codprofitVisitorId = cfg.visitor_id;
          // Persist for next page load.
          setCookie("cod_visitor_id", cfg.visitor_id, 365);
          try { window.localStorage && window.localStorage.setItem("cod_visitor_id", cfg.visitor_id); } catch (_) {}
          return cfg.visitor_id;
        }
      }
    } catch (_) {
      /* swallow */
    }
    return null;
  }

  // ── Push attributes to the cart only when they've changed since last write.
  //    Saves a network call on every page load and avoids stomping on other
  //    apps that also read note_attributes.
  let lastSig = null;
  async function pushIfChanged() {
    await ensureVisitorId();
    const ident = readIdentity();
    const keys = Object.keys(ident);
    if (keys.length === 0) return;

    const sig = keys.sort().map((k) => k + "=" + ident[k]).join("|");
    if (sig === lastSig) return;
    lastSig = sig;

    // keepalive lets this fetch survive page navigation. Critical for fast-tap
    // visitors and Instagram/Facebook in-app browsers — without it, the
    // cart-update fetch is aborted the moment the customer taps a product or
    // checkout link, and none of our identity attrs reach the cart.
    fetch("/cart/update.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attributes: ident }),
      credentials: "same-origin",
      keepalive: true,
    }).catch(function () { /* offline / 404 — non-fatal */ });
  }

  // First push on initial load.
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(pushIfChanged, 0);
  } else {
    document.addEventListener("DOMContentLoaded", pushIfChanged);
  }

  // Push again on the next page load — fbp may have just been generated by
  // our Web Pixel during this same page view, so re-pushing covers that race.
  window.addEventListener("pageshow", pushIfChanged);
})();
