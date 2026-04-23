import type { LoaderFunctionArgs } from "@remix-run/node";
import { exchangeCodeForToken, getAdAccounts } from "../lib/meta.server.js";
import { metaOAuthSession } from "../lib/meta-session.server.js";

// Returns an HTML page that:
//  - Broadcasts the result to any same-origin BroadcastChannel listener (the app iframe)
//  - Closes itself if it was opened as a popup (window.name === "meta_oauth_window")
//  - Redirects to returnTo if it ended up as a full-page navigation (popup blocked fallback)
function htmlResponse(
  payload: Record<string, string>,
  returnTo: string,
  setCookie: string
) {
  return new Response(
    `<!DOCTYPE html><html><body><script>
      (function () {
        var ch = new BroadcastChannel("meta_oauth");
        ch.postMessage(${JSON.stringify(payload)});
        ch.close();
        if (window.name === "meta_oauth_window") {
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
  const oauthSession = await metaOAuthSession.getSession(cookieHeader);
  const savedState: string | null = oauthSession.get("state") ?? null;
  const returnTo: string =
    oauthSession.get("returnTo") ?? "https://admin.shopify.com";

  if (error || !code || !savedState || state !== savedState) {
    console.error("Meta OAuth callback failed:", { error, stateMatch: state === savedState });
    const setCookie = await metaOAuthSession.destroySession(oauthSession);
    return htmlResponse(
      { type: "meta_oauth_error", reason: error ?? "state_mismatch" },
      returnTo,
      setCookie
    );
  }

  try {
    const { access_token } = await exchangeCodeForToken(code);
    const adAccounts = await getAdAccounts(access_token);

    oauthSession.unset("state");
    oauthSession.set("meta_access_token", access_token);
    oauthSession.set("meta_ad_accounts", adAccounts);

    const setCookie = await metaOAuthSession.commitSession(oauthSession);
    return htmlResponse({ type: "meta_oauth_complete" }, returnTo, setCookie);
  } catch (err) {
    console.error("Meta OAuth token exchange failed:", err);
    const setCookie = await metaOAuthSession.destroySession(oauthSession);
    return htmlResponse(
      { type: "meta_oauth_error", reason: "token_exchange" },
      returnTo,
      setCookie
    );
  }
};
