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

  // Read existing cookie if present, otherwise mint a fresh visitor id.
  const cookieHeader = request.headers.get("Cookie");
  const { visitorId } = resolveVisitorId(cookieHeader);

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

  // Set-Cookie always — re-asserts the cookie's Max-Age on every page
  // load so a returning visitor's TTL gets refreshed instead of running
  // down. Without this, a visitor who returns at month 11 would have
  // 1 month left; with it, every page view resets back to 12 months.
  const headers = new Headers();
  headers.set("Set-Cookie", visitorCookieHeader(visitorId));
  // Cache-control deliberately NOT public — visitor_id is per-visitor
  // and the cookie must be re-set on every request so a Safari ITP
  // visitor whose previous cookie was truncated gets a fresh one.
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
