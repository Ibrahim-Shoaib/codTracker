import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { verifyAppProxySignature } from "../lib/app-proxy-verify.server.js";
import {
  resolveVisitorId,
  visitorCookieHeader,
} from "../lib/visitors.server.js";

// Public-but-signed endpoint that the theme app embed calls on every page
// load to discover the merchant's connected Pixel ID AND a long-lived
// first-party visitor id.
//
// Path: /proxy/tracking/config  (rewritten by Shopify from /apps/tracking/config)
//
// Response: {
//   ok: true,
//   pixel_id: "1793..." | null,
//   connected: true | false,
//   shop: "<shop>.myshopify.com",
//   visitor_id: "<uuid>"
// }
//
// Plus a Set-Cookie header that mints (or re-asserts) the
// `cod_visitor_id` cookie for 1 year. Same-origin first-party context
// from the visitor's perspective, so Safari ITP grants the full
// Max-Age — no 7-day truncation as happens with document.cookie writes.
//
// We deliberately return 200 + connected:false for unconnected shops so
// the theme embed can no-op cleanly without throwing in fbevents
// bootstrap. The visitor_id is minted regardless of connection status —
// even merchants without a connected Pixel still benefit from us
// recording the visitor for when they DO connect.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!verifyAppProxySignature(request.url)) {
    return new Response("invalid signature", { status: 401 });
  }

  const u = new URL(request.url);
  const shop = u.searchParams.get("shop");
  if (!shop) {
    return new Response("missing shop", { status: 400 });
  }

  // Resolve visitor_id. CRITICAL: Shopify's App Proxy strips both
  // incoming Cookie and outgoing Set-Cookie headers (verified
  // empirically). So cookies are useless for cross-session identity
  // through this endpoint. Instead, the theme block stores
  // visitor_id in localStorage + document.cookie on the storefront
  // origin (which Shopify doesn't strip — those are visitor's-browser-
  // local), and echoes the value back to us via the `vid` query
  // parameter on subsequent calls. We mint a fresh id only when the
  // theme block doesn't supply one (first visit).
  //
  // The `vid` round-trip is invisible to the merchant or visitor —
  // it's a JS-level handoff between our theme block and our server.
  const echoedVid = u.searchParams.get("vid");
  const isValidVid =
    typeof echoedVid === "string" && /^[a-f0-9-]{32,40}$/i.test(echoedVid);
  const { visitorId } = isValidVid
    ? { visitorId: echoedVid }
    : resolveVisitorId(null); // mints fresh

  const supabase = createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  );

  const { data } = await supabase
    .from("meta_pixel_connections")
    .select("dataset_id, status")
    .eq("store_id", shop)
    .eq("status", "active")
    .maybeSingle();

  const headers = new Headers();
  // We still emit Set-Cookie for any non-App-Proxy callers (admin
  // routes, direct Railway tests). Shopify's App Proxy will strip it.
  headers.set("Set-Cookie", visitorCookieHeader(visitorId));
  // Cache-control deliberately NOT public — visitor_id is per-visitor
  // and the response must be fresh per request (otherwise a CDN cache
  // would serve one merchant's visitor_id to another).
  headers.set("Cache-Control", "no-store, private");
  headers.set("Content-Type", "application/json");

  return new Response(
    JSON.stringify({
      ok: true,
      pixel_id: data?.dataset_id ?? null,
      connected: !!data?.dataset_id,
      shop,
      visitor_id: visitorId,
    }),
    { status: 200, headers }
  );
};
