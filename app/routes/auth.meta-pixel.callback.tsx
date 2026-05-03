import type { LoaderFunctionArgs } from "@remix-run/node";
import {
  exchangeCodeForBISU,
  debugToken,
  listDatasets,
  listAdAccounts,
} from "../lib/meta-pixel.server.js";
import { metaPixelOAuthSession } from "../lib/meta-pixel-session.server.js";

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const cookieHeader = request.headers.get("Cookie");
  const oauthSession = await metaPixelOAuthSession.getSession(cookieHeader);
  const savedState: string | null = oauthSession.get("state") ?? null;
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

    // Inspect the BISU token to find the business it grants access to.
    // For BISU tokens the business id lives in `profile_id`.
    const tokenInfo = await debugToken(access_token);
    const businessId = tokenInfo.profile_id ?? tokenInfo.target_ids?.[0];
    if (!businessId) {
      throw new Error("BISU token has no associated business — re-grant required.");
    }

    // List datasets + ad accounts for the merchant to pick from.
    const [datasets, adAccounts] = await Promise.all([
      listDatasets(access_token, businessId),
      listAdAccounts(access_token, businessId),
    ]);

    if (!datasets.length) {
      // Merchant skipped the Pixel asset selection during consent —
      // recoverable, but they need to redo the flow with a Pixel chosen.
      const setCookie = await metaPixelOAuthSession.destroySession(oauthSession);
      return htmlResponse(
        { type: "meta_pixel_oauth_error", reason: "no_pixel_granted" },
        returnTo,
        setCookie
      );
    }

    oauthSession.unset("state");
    oauthSession.set("bisu_token", access_token);
    oauthSession.set("business_id", businessId);
    oauthSession.set("datasets", datasets);
    oauthSession.set("ad_accounts", adAccounts);

    const setCookie = await metaPixelOAuthSession.commitSession(oauthSession);
    return htmlResponse(
      { type: "meta_pixel_oauth_complete" },
      returnTo,
      setCookie
    );
  } catch (err) {
    // Surface the actual Meta error message into the UI rather than just
    // "token_exchange". Meta returns specific strings like "redirect_uri does
    // not match" or "Invalid client secret" that the merchant (or their
    // developer support) can act on directly without pulling Railway logs.
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
