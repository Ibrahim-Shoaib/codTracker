import type { LoaderFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import {
  exchangeCodeForBISU,
  debugToken,
  extractBusinessId,
  discoverPixelsFromBISU,
  listDatasets,
  resolveClientBusinessId,
} from "../lib/meta-pixel.server.js";
import { metaPixelOAuthSession } from "../lib/meta-pixel-session.server.js";
import { encryptSecret } from "../lib/crypto.server.js";
import { installWebPixel } from "../lib/web-pixel-install.server.js";
import { sessionStorage } from "../shopify.server";

// Same popup-postMessage UX as auth.meta.callback — the embedded admin opens a
// popup, this route runs in the popup, broadcasts the result back to the
// iframe, and closes itself.
function htmlResponse(
  payload: Record<string, unknown>,
  returnTo: string,
  setCookie: string
) {
  return new Response(
    `<!DOCTYPE html><html><body><script>
      (function () {
        var msg = ${JSON.stringify(payload)};
        if (window.opener) {
          window.opener.postMessage(msg, window.location.origin);
        }
        if (window.name === "meta_pixel_oauth_window") {
          window.close();
        } else {
          window.location.href = ${JSON.stringify(returnTo)};
        }
      })();
    </script></body></html>`,
    { headers: { "Content-Type": "text/html", "Set-Cookie": setCookie } }
  );
}

// Persist the connection + install the Custom Web Pixel in one shot. Called
// from the callback when exactly one Pixel was discovered — bypasses the
// merchant-facing "pick a Pixel" screen entirely so onboarding is one click.
async function autoCompleteConnection(args: {
  shop: string;
  bisu: string;
  businessId: string | null;
  dataset: { id: string; name: string | null };
}) {
  const supabase = createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  );

  // Look up the Shopify Admin access token from the session store. We don't
  // have the request session here (we're in the popup callback), so we go via
  // the persisted offline session that shopify-app-remix maintains.
  const offlineSession = await sessionStorage.loadSession(
    `offline_${args.shop}`
  );

  let webPixelId: string | null = null;
  if (offlineSession?.accessToken) {
    try {
      const wp = await installWebPixel({
        shop: args.shop,
        accessToken: offlineSession.accessToken,
      });
      webPixelId = wp?.id ?? null;
    } catch (err) {
      console.error(
        `[meta-pixel oauth] Web Pixel auto-install failed for ${args.shop}:`,
        err
      );
      // Non-fatal — connection still saved, server-side CAPI will work via
      // webhooks; only the (already-redundant) browser beacon path is
      // affected.
    }
  } else {
    console.warn(
      `[meta-pixel oauth] no offline session found for ${args.shop} — skipping Web Pixel install (will retry on next admin visit)`
    );
  }

  await supabase.from("meta_pixel_connections").upsert(
    {
      store_id: args.shop,
      config_id: process.env.META_PIXEL_CONFIG_ID ?? "",
      bisu_token: encryptSecret(args.bisu),
      business_id: args.businessId ?? "",
      business_name: null,
      dataset_id: args.dataset.id,
      dataset_name: args.dataset.name,
      web_pixel_id: webPixelId,
      status: "active",
      status_reason: null,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id" }
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const cookieHeader = request.headers.get("Cookie");
  const oauthSession = await metaPixelOAuthSession.getSession(cookieHeader);
  const savedState: string | null = oauthSession.get("state") ?? null;
  const shop: string | null = oauthSession.get("shop") ?? null;
  const returnTo: string =
    oauthSession.get("returnTo") ?? "https://admin.shopify.com";

  if (error || !code || !savedState || state !== savedState) {
    console.error("Meta Pixel OAuth callback failed:", {
      error,
      stateMatch: state === savedState,
    });
    const setCookie = await metaPixelOAuthSession.destroySession(oauthSession);
    return htmlResponse(
      { type: "meta_pixel_oauth_error", reason: error ?? "state_mismatch" },
      returnTo,
      setCookie
    );
  }

  try {
    const { access_token } = await exchangeCodeForBISU(code);

    const tokenInfo = await debugToken(access_token);
    console.log(
      "[meta-pixel oauth] debug_token response:",
      JSON.stringify(tokenInfo)
    );

    // Discovery order, cheapest to most expensive. We MUST exhaust all paths
    // before giving up — failing here drops the merchant on a useless error
    // page even though they correctly granted Pixel access.
    type DiscoveredPixel = {
      id: string;
      name?: string | null;
      owned?: boolean;
      last_fired_time?: string | null;
    };
    let pixels: DiscoveredPixel[] = [];
    let businessId: string | null = null;

    // Path A — direct Pixel discovery. For FBL4B "Pixel Tracking" /
    //   Conversions API BISUs, the highest-confidence Pixel-id source is
    //   tokenInfo.user_id itself (Meta creates a per-Pixel virtual system
    //   user whose id == Pixel id). discoverPixelsFromBISU now probes
    //   user_id, /me, and every granular_scopes target_id via the
    //   `last_fired_time` discriminator — anything that verifies as a Pixel
    //   is returned. This is the fastest path: at most 1 round-trip per
    //   candidate, all fired concurrently.
    pixels = (await discoverPixelsFromBISU(
      access_token,
      tokenInfo
    )) as DiscoveredPixel[];
    console.log(
      `[meta-pixel oauth] path A: discoverPixelsFromBISU → ${pixels.length} Pixel(s)`
    );

    // Path B — business_id from granular_scopes[business_management] +
    //   listDatasets. Catches the case where a single BISU has access to
    //   multiple Pixels under a Business; Path A returns the directly-bound
    //   one but the merchant might want to pick a different Pixel from the
    //   same Business. We MERGE Path B's results onto Path A's so multi-
    //   Pixel businesses see the full list in the selection screen.
    businessId = extractBusinessId(tokenInfo);
    if (businessId) {
      const businessPixels = await listDatasets(access_token, businessId);
      console.log(
        `[meta-pixel oauth] path B: extractBusinessId=${businessId} → listDatasets → ${businessPixels.length} Pixel(s)`
      );
      // Merge, dedup by id.
      const ids = new Set(pixels.map((p) => p.id));
      for (const bp of businessPixels) {
        if (!ids.has(bp.id)) {
          pixels.push(bp as DiscoveredPixel);
          ids.add(bp.id);
        }
      }
    } else {
      console.log(
        "[meta-pixel oauth] path B: no business_management target_ids in granular_scopes"
      );
    }

    // Path C — resolve Business id via Graph API, then listDatasets.
    //   Last automated path. Only fires if A and B both yielded zero.
    if (!pixels.length) {
      const resolved = await resolveClientBusinessId(
        access_token,
        tokenInfo.user_id
      );
      if (resolved) {
        businessId = resolved;
        pixels = await listDatasets(access_token, resolved);
        console.log(
          `[meta-pixel oauth] path C: resolveClientBusinessId=${resolved} → listDatasets → ${pixels.length} Pixel(s)`
        );
      } else {
        console.log(
          "[meta-pixel oauth] path C: resolveClientBusinessId returned null"
        );
      }
    }

    // All automated discovery paths failed → fall back to manual entry.
    // The merchant DID grant a Pixel (otherwise consent wouldn't have
    // succeeded), so the right move is to ask them to paste the Pixel ID
    // rather than reject the connection. This preserves onboarding even
    // for FBL4B template variants we haven't seen yet.
    if (!pixels.length) {
      console.error(
        "[meta-pixel oauth] all automatic discovery paths failed — falling back to manual Pixel ID entry"
      );
      oauthSession.unset("state");
      oauthSession.set("bisu_token", access_token);
      oauthSession.set("business_id", businessId);
      oauthSession.set("system_user_id", tokenInfo.user_id ?? null);
      oauthSession.set("manual_entry_required", true);
      const setCookie = await metaPixelOAuthSession.commitSession(
        oauthSession
      );
      return htmlResponse(
        { type: "meta_pixel_oauth_complete" },
        returnTo,
        setCookie
      );
    }

    // Single Pixel granted (the overwhelming majority of merchants) → save
    // immediately and skip the selection screen. Onboarding becomes a single
    // click: "Connect Meta Pixel" → consent → done.
    const onlyPixel = pixels.length === 1 ? pixels[0] : null;
    if (onlyPixel && shop) {
      try {
        await autoCompleteConnection({
          shop,
          bisu: access_token,
          businessId,
          dataset: { id: onlyPixel.id, name: onlyPixel.name ?? null },
        });
      } catch (err) {
        console.error(
          "[meta-pixel oauth] auto-complete failed, falling back to selection screen:",
          err
        );
        // Stash for the manual save_dataset flow as a graceful fallback.
        oauthSession.unset("state");
        oauthSession.set("bisu_token", access_token);
        oauthSession.set("business_id", businessId);
        oauthSession.set("datasets", pixels);
        const setCookie = await metaPixelOAuthSession.commitSession(
          oauthSession
        );
        return htmlResponse(
          { type: "meta_pixel_oauth_complete" },
          returnTo,
          setCookie
        );
      }

      // Auto-complete succeeded — wipe the OAuth session and signal the
      // parent. The parent's revalidator will pick up the new active
      // connection on next loader call.
      const setCookie = await metaPixelOAuthSession.destroySession(
        oauthSession
      );
      return htmlResponse(
        { type: "meta_pixel_oauth_complete", auto: true },
        returnTo,
        setCookie
      );
    }

    // Multiple Pixels granted → ask the merchant which one to connect.
    oauthSession.unset("state");
    oauthSession.set("bisu_token", access_token);
    oauthSession.set("business_id", businessId);
    oauthSession.set("datasets", pixels);

    const setCookie = await metaPixelOAuthSession.commitSession(oauthSession);
    return htmlResponse(
      { type: "meta_pixel_oauth_complete" },
      returnTo,
      setCookie
    );
  } catch (err) {
    const detail =
      err instanceof Error
        ? err.message.replace(/^Meta BISU exchange failed:\s*/, "")
        : "unknown error";
    console.error("Meta Pixel BISU exchange failed:", err);
    const setCookie = await metaPixelOAuthSession.destroySession(oauthSession);
    return htmlResponse(
      { type: "meta_pixel_oauth_error", reason: "token_exchange", detail },
      returnTo,
      setCookie
    );
  }
};
