import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { exchangeCodeForToken, getAdAccounts } from "../lib/meta.server.js";
import { metaOAuthSession } from "../lib/meta-session.server.js";

// Handles Meta OAuth callback. Not inside the Shopify app layout — no authenticate.admin().
// Meta redirects here after the merchant grants ads_read scope.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const cookieHeader = request.headers.get("Cookie");
  const oauthSession = await metaOAuthSession.getSession(cookieHeader);
  const savedState: string | null = oauthSession.get("state") ?? null;

  // returnTo is set by the initiating route (onboarding step 2 or settings)
  const returnTo: string =
    oauthSession.get("returnTo") ?? "/app/onboarding/step2-meta";

  // On error or state mismatch: clear session and send back to the originating route
  if (error || !code || !savedState || state !== savedState) {
    console.error("Meta OAuth callback failed:", { error, stateMatch: state === savedState });
    const setCookie = await metaOAuthSession.destroySession(oauthSession);
    return redirect(returnTo, { headers: { "Set-Cookie": setCookie } });
  }

  try {
    const { access_token } = await exchangeCodeForToken(code);
    const adAccounts = await getAdAccounts(access_token);

    oauthSession.unset("state");
    oauthSession.set("meta_access_token", access_token);
    oauthSession.set("meta_ad_accounts", adAccounts);

    const setCookie = await metaOAuthSession.commitSession(oauthSession);
    return redirect(returnTo, { headers: { "Set-Cookie": setCookie } });
  } catch (err) {
    console.error("Meta OAuth token exchange failed:", err);
    const setCookie = await metaOAuthSession.destroySession(oauthSession);
    return redirect(returnTo, { headers: { "Set-Cookie": setCookie } });
  }
};
