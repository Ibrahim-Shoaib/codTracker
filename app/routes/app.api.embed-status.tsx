import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getEmbedActivationStatus } from "../lib/theme-embed.server.js";

// Read-only endpoint that the Ad Tracking page polls every few seconds while
// it's waiting for the merchant to save the app embed in the theme editor.
// As soon as activation is detected, the UI flips from "Action needed" →
// "Browser pixel: Active" without the merchant having to come back to our
// app — same UX as wetracked.io / Triple Whale / Klaviyo.
//
// We don't cache the response: polling cadence is on the client side, and
// the underlying GraphQL call is one round-trip to Shopify Admin (~150ms).
// The merchant-facing UI shows this as a passive status indicator, not a
// blocking step.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const status = await getEmbedActivationStatus({
    shop: session.shop,
    accessToken: session.accessToken ?? "",
  });
  return json(status, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
};
