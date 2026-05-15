import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { verifyAppProxySignature } from "../lib/app-proxy-verify.server.js";
import {
  buildCAPIEvent,
  sendCAPIEventsForShop,
  shopifyEventToMeta,
} from "../lib/meta-capi.server.js";
import { buildUserData } from "../lib/meta-hash.server.js";
import {
  resolveVisitorId,
  visitorCookieHeader,
  upsertVisitor,
  recordVisitorEvent,
} from "../lib/visitors.server.js";

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

  // Defend against null/non-object bodies. parseBody can return null when the
  // request body is the literal `null` JSON, and accessing `body.event` on it
  // would 500 instead of cleanly rejecting.
  if (body == null || typeof body !== "object") {
    return new Response("invalid body", { status: 400 });
  }

  // Resolve the visitor id from cookie OR from the explicit field on
  // the beacon payload (theme block sends it from /apps/tracking/config's
  // response). We always Set-Cookie back on the response so the cookie
  // gets refreshed and Safari ITP doesn't run the Max-Age down.
  const cookieHeader = request.headers.get("Cookie");
  const explicitVisitorId =
    typeof body.visitor_id === "string" && /^[a-f0-9-]{32,40}$/i.test(body.visitor_id)
      ? body.visitor_id
      : null;
  const { visitorId } = explicitVisitorId
    ? { visitorId: explicitVisitorId }
    : resolveVisitorId(cookieHeader);

  // Network identity needed for both the visitor upsert AND the CAPI fire,
  // so extract it BEFORE we decide whether this beacon results in a Meta
  // event. The browser doesn't know its own public IP — Shopify forwards
  // it via X-Forwarded-For on App Proxy requests.
  const clientIp = extractClientIp(request) ?? undefined;
  const clientUa =
    body.user_agent ?? request.headers.get("user-agent") ?? undefined;

  // UPSERT the visitor row FIRST — runs for every signed beacon, even
  // identity-only events (`checkout_contact_info_submitted`,
  // `checkout_address_info_submitted`) that don't map to a Meta standard
  // event. This is the Match-Strength fix: when the buyer types their
  // email/phone in checkout, the Web Pixel beacons it here with no Meta
  // event mapping, and we still persist em_hash/ph_hash on the visitor row.
  // Subsequent browse events from the same visitor pick up the stored PII
  // (the Web Pixel attaches its localStorage identity cache to every
  // beacon body), so PageView/ViewContent/AddToCart EMQ rises after the
  // first checkout-info event in a session.
  await upsertVisitor({
    storeId: shop,
    visitorId,
    input: {
      email: body.email,
      phone: body.phone,
      firstName: body.first_name,
      lastName: body.last_name,
      city: body.city,
      state: body.state,
      zip: body.zip,
      country: body.country,
      externalId: body.external_id,
      fbp: body.fbp,
      fbc: body.fbc,
      fbclid: body.fbclid,
      ip: clientIp,
      ua: clientUa,
      utmSource: body.utm_source,
      utmCampaign: body.utm_campaign,
      utmContent: body.utm_content,
    },
  }).catch(() => {});

  // Map Shopify customer-event name → Meta standard event. Unknown / skipped
  // events (including `checkout_contact_info_submitted` etc) return null —
  // we 204 those AFTER the visitor upsert above so identity still persists.
  const metaEventName = shopifyEventToMeta(body.event);
  if (!metaEventName) {
    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": visitorCookieHeader(visitorId) },
    });
  }

  if (!body.event_id || typeof body.event_id !== "string") {
    return new Response("missing event_id", {
      status: 400,
      headers: { "Set-Cookie": visitorCookieHeader(visitorId) },
    });
  }

  // Build external_id list. Two slots, deduped:
  //   1. body.external_id  — what the browser fbq fired with (this is
  //      customer.id when the visitor is logged in, otherwise the same
  //      visitor_id we minted; theme block stages it into __codprofitAM).
  //   2. visitorId         — our minted cross-session UUID, always present.
  //
  // For anonymous visitors both slots collapse to the same value (deduped
  // inside buildUserData). For logged-in customers we get TWO match keys:
  // customer.id (account identity) AND visitor_id (browser identity), and
  // Meta tries to match against either one. This is the single biggest EMQ
  // lever for COD/anonymous-browser stores per Meta's CAPI docs — every
  // server event now has at least one stable external_id, where most events
  // previously had none.
  const externalIds = [];
  if (typeof body.external_id === "string" && body.external_id) {
    externalIds.push(body.external_id);
  }
  if (visitorId && !externalIds.includes(visitorId)) {
    externalIds.push(visitorId);
  }

  const userData = buildUserData({
    fbp: body.fbp,
    fbc: body.fbc,
    clientUa,
    clientIp,
    email: body.email,
    phone: body.phone,
    // Web Pixel attaches cached identity from localStorage to every beacon
    // (set after a prior checkout_contact/address_info event), so these
    // fields are typically present on PageView/ViewContent etc. once the
    // buyer has entered them anywhere in the session.
    firstName: body.first_name,
    lastName: body.last_name,
    city: body.city,
    state: body.state,
    zip: body.zip,
    country: body.country,
    externalId: externalIds.length ? externalIds : undefined,
  });

  // Per-event breadcrumb for the 30-day audit trail. Best-effort.
  recordVisitorEvent({
    storeId: shop,
    visitorId,
    eventName: metaEventName,
    eventId: body.event_id,
    url: body.url,
    ip: clientIp,
    ua: clientUa,
    fbp: body.fbp,
    fbc: body.fbc,
    utmSource: body.utm_source,
    utmCampaign: body.utm_campaign,
    utmContent: body.utm_content,
  }).catch(() => {});

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
    {
      status: 200,
      headers: { "Set-Cookie": visitorCookieHeader(visitorId) },
    }
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
  event_id?: string;        // UUID for dedup with server-side; absent on identity-only beacons
  event_time?: number;      // unix ms or s
  url?: string;
  fbp?: string;
  fbc?: string;
  fbclid?: string;
  user_agent?: string;
  // Identity fields. The Web Pixel captures these from
  // checkout_contact_info_submitted / checkout_address_info_submitted /
  // checkout_completed events and caches them in localStorage so EVERY
  // subsequent beacon (PageView, ViewContent, AddToCart) carries them.
  // The server hashes via meta-hash and writes em_hash/ph_hash/etc to the
  // visitor row.
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  external_id?: string;
  visitor_id?: string;      // long-lived cod_visitor_id (echoed by theme block from /apps/tracking/config)
  utm_source?: string;
  utm_campaign?: string;
  utm_content?: string;
  value?: number | string;
  currency?: string;
  content_ids?: string[];
  num_items?: number;
  search_string?: string;
};
