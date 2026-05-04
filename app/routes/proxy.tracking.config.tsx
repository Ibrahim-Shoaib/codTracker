import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { verifyAppProxySignature } from "../lib/app-proxy-verify.server.js";

// Public-but-signed endpoint that the theme app embed calls on every page
// load to discover the merchant's connected Pixel ID. We can't just dump it
// in Liquid (would require a write_metafields scope re-auth for every
// existing install), so we serve it from the App Proxy where Shopify HMAC
// authenticates the request for free.
//
// Path: /proxy/tracking/config  (rewritten by Shopify from /apps/tracking/config)
//
// Response: { ok: true, pixel_id: "1793...", connected: true }
//          | { ok: true, pixel_id: null, connected: false }
//
// We deliberately return 200 + connected:false for unconnected shops so the
// theme embed can no-op cleanly without throwing in fbevents bootstrap.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!verifyAppProxySignature(request.url)) {
    return new Response("invalid signature", { status: 401 });
  }

  const u = new URL(request.url);
  const shop = u.searchParams.get("shop");
  if (!shop) {
    return new Response("missing shop", { status: 400 });
  }

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

  // Cache for 60s on the merchant's Shopify CDN edge — the pixel id rarely
  // changes (only on disconnect/reconnect), so polling on every page load is
  // wasteful. Theme embed clients cache via standard browser cache headers.
  return json(
    {
      ok: true,
      pixel_id: data?.dataset_id ?? null,
      connected: !!data?.dataset_id,
      // Echo back the canonical .myshopify.com domain so the theme block can
      // build deterministic event_ids that match the server-side CAPI fire,
      // even on stores where window.Shopify.shop isn't reachable from the
      // app-embed context (rare but happens on heavily customized themes).
      shop,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60",
      },
    }
  );
};
