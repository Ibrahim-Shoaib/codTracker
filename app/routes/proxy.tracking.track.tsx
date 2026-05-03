import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { verifyAppProxySignature } from "../lib/app-proxy-verify.server.js";
import {
  buildCAPIEvent,
  sendCAPIEventsForShop,
  shopifyEventToMeta,
} from "../lib/meta-capi.server.js";
import { buildUserData } from "../lib/meta-hash.server.js";

// App Proxy beacon. Receives events from the Custom Web Pixel running on the
// merchant's storefront. Shopify signs the request and includes ?shop=… so
// we know which connection to use.
//
// Signed by Shopify with HMAC-SHA256 over query params (signature query
// param). We reject anything without a valid signature — without it we'd
// accept arbitrary CAPI events from anyone on the internet.
//
// Path: /proxy/tracking/track  (configured via [app_proxy] in shopify.app.toml)

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Some pixels send navigator.sendBeacon as POST; older browsers might use GET.
  // Both routes converge on the same handler.
  return handle(request);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return handle(request);
};

async function handle(request: Request) {
  const url = request.url;

  if (!verifyAppProxySignature(url)) {
    return new Response("invalid signature", { status: 401 });
  }

  const u = new URL(url);
  const shop = u.searchParams.get("shop");
  if (!shop) {
    return new Response("missing shop", { status: 400 });
  }

  // Body can arrive as JSON (preferred) or form-encoded (sendBeacon fallback).
  let body: BeaconPayload;
  try {
    body = await parseBody(request);
  } catch {
    return new Response("invalid body", { status: 400 });
  }

  // Map Shopify customer-event name → Meta standard event. Unknown / skipped
  // events return null — we just 204 those without doing any work.
  const metaEventName = shopifyEventToMeta(body.event);
  if (!metaEventName) {
    return new Response(null, { status: 204 });
  }

  if (!body.event_id) {
    return new Response("missing event_id", { status: 400 });
  }

  const userData = buildUserData({
    fbp: body.fbp,
    fbc: body.fbc,
    clientUa: body.user_agent ?? request.headers.get("user-agent") ?? undefined,
    // The browser doesn't know its own public IP — Shopify forwards it via
    // X-Forwarded-For on App Proxy requests.
    clientIp: extractClientIp(request) ?? undefined,
    email: body.email,
    phone: body.phone,
    externalId: body.external_id,
  });

  const customData: Record<string, unknown> = {};
  if (body.value != null) customData.value = Number(body.value);
  if (body.currency) customData.currency = body.currency;
  if (body.content_ids?.length) {
    customData.content_ids = body.content_ids;
    customData.content_type = "product";
  }
  if (body.num_items != null) customData.num_items = Number(body.num_items);
  if (body.search_string) customData.search_string = body.search_string;

  const event = buildCAPIEvent({
    eventName: metaEventName,
    eventId: body.event_id,
    eventTime: body.event_time ?? Date.now(),
    eventSourceUrl: body.url ?? undefined,
    userData,
    customData,
  });

  const result = await sendCAPIEventsForShop({
    storeId: shop,
    events: [event],
  });

  return json(
    { ok: result.ok, reason: "reason" in result ? result.reason : undefined },
    { status: 200 }
  );
}

async function parseBody(request: Request): Promise<BeaconPayload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await request.json()) as BeaconPayload;
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const raw: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) raw[k] = v;
    // sendBeacon often nests JSON under a single field.
    if (typeof raw.payload === "string") {
      return JSON.parse(raw.payload) as BeaconPayload;
    }
    return raw as BeaconPayload;
  }
  // Last resort: read as text and try JSON.parse.
  const text = await request.text();
  return JSON.parse(text) as BeaconPayload;
}

function extractClientIp(request: Request): string | null {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || null;
  return request.headers.get("x-real-ip") ?? null;
}

type BeaconPayload = {
  event: string;            // Shopify customer-event name (e.g. "product_added_to_cart")
  event_id: string;         // UUID for dedup with server-side
  event_time?: number;      // unix ms or s
  url?: string;
  fbp?: string;
  fbc?: string;
  user_agent?: string;
  email?: string;
  phone?: string;
  external_id?: string;
  value?: number | string;
  currency?: string;
  content_ids?: string[];
  num_items?: number;
  search_string?: string;
};
