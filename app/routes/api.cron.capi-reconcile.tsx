import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildCAPIEvent,
  sendCAPIEventsForShop,
} from "../lib/meta-capi.server.js";
import { buildUserData } from "../lib/meta-hash.server.js";
import {
  extractIdentityFromOrder,
  extractCustomerIdentity,
} from "../lib/cart-attributes.server.js";
import {
  getVisitor,
  findVisitorByFbclid,
  findRecentVisitorByIpUa,
  pickBestFbc,
} from "../lib/visitors.server.js";
import { recordOrderAttribution } from "../lib/channel-attribution.server.js";

// Railway cron: 0 * * * * (UTC) = every hour, on the hour.
//
// Safety net for Purchase events the live webhook path missed. The original
// failure (the-trendy-homes-pk #9393, 2026-05-09 19:44 UTC) was a 12-hour
// silent silent-drop at sendCAPIEventsForShop's no_connection branch. Even
// with the always-log-drops change in meta-capi.server.js, drops can still
// happen for transient reasons we haven't identified — this cron pulls the
// last 2h of Shopify orders for every active connection and re-fires any
// Purchase that has no `sent` row in capi_delivery_log.
//
// Idempotency: deterministic event_id `purchase:<shop>:<order.id>` ensures
// Meta dedupes if the original webhook eventually arrives or if this cron
// fires twice. So replays are safe.
//
// Cost shape (per hourly run):
//   N active connections × (1 Shopify Admin REST call + 1 Supabase select +
//   1 CAPI call per missed order). Typical: <100 Shopify calls/hr/shop,
//   well under 40 calls/sec leaky-bucket. CAPI sends only happen on misses.
//
// Auth: x-cron-secret header (matches existing api.cron.* pattern).

const LOOKBACK_MS = 2 * 60 * 60 * 1000;

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: connections } = await supabase
    .from("meta_pixel_connections")
    .select("store_id")
    .eq("status", "active");

  const sinceIso = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const summary = {
    shops: 0,
    ordersChecked: 0,
    missing: 0,
    replayed: 0,
    replayFailed: 0,
    shopErrors: 0,
  };

  for (const { store_id: shop } of connections ?? []) {
    summary.shops++;
    try {
      const result = await reconcileShop({ supabase, shop, sinceIso });
      summary.ordersChecked += result.ordersChecked;
      summary.missing += result.missing;
      summary.replayed += result.replayed;
      summary.replayFailed += result.replayFailed;
    } catch (err) {
      console.error(`[capi-reconcile ${shop}]`, err);
      summary.shopErrors++;
    }
  }

  return json(summary);
};

async function reconcileShop({
  supabase,
  shop,
  sinceIso,
}: {
  supabase: SupabaseClient;
  shop: string;
  sinceIso: string;
}) {
  const stat = { ordersChecked: 0, missing: 0, replayed: 0, replayFailed: 0 };

  const { data: sessions } = await supabase
    .from("shopify_sessions")
    .select("accessToken")
    .eq("shop", shop)
    .eq("isOnline", false)
    .limit(1);
  const accessToken = (sessions?.[0] as { accessToken?: string } | undefined)?.accessToken;
  if (!accessToken) {
    console.warn(`[capi-reconcile ${shop}] no offline session — skipping`);
    return stat;
  }

  const url =
    `https://${shop}/admin/api/2025-01/orders.json?` +
    new URLSearchParams({
      created_at_min: sinceIso,
      status: "any",
      limit: "100",
    });

  const r = await fetch(url, {
    headers: { "X-Shopify-Access-Token": accessToken },
  });
  if (!r.ok) {
    console.warn(`[capi-reconcile ${shop}] Shopify ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return stat;
  }
  const { orders } = (await r.json()) as { orders: ShopifyOrder[] };
  stat.ordersChecked = orders.length;
  if (!orders.length) return stat;

  // Cross-reference: which deterministic Purchase event_ids already have a
  // `sent` row? We only consider `sent` — `failed` and `dropped` rows mean
  // the event never reached Meta, so we should still replay them.
  const eventIds = orders.map((o) => `purchase:${shop}:${o.id}`);
  const { data: logs } = await supabase
    .from("capi_delivery_log")
    .select("event_id, status")
    .eq("store_id", shop)
    .eq("event_name", "Purchase")
    .in("event_id", eventIds);
  const sentSet = new Set<string>();
  for (const l of (logs ?? []) as Array<{ event_id: string; status: string }>) {
    if (l.status === "sent") sentSet.add(l.event_id);
  }

  const missingOrders = orders.filter(
    (o) => !sentSet.has(`purchase:${shop}:${o.id}`)
  );
  stat.missing = missingOrders.length;

  for (const order of missingOrders) {
    try {
      const ok = await replayPurchase({ shop, order });
      if (ok) stat.replayed++;
      else stat.replayFailed++;
    } catch (err) {
      console.error(`[capi-reconcile ${shop} replay #${order.name}]`, err);
      stat.replayFailed++;
    }
  }

  return stat;
}

// Mirror of handleOrderPaid in api.webhooks.meta-pixel.tsx — same three-tier
// visitor lookup, same event payload shape, same deterministic event_id.
async function replayPurchase({
  shop,
  order,
}: {
  shop: string;
  order: ShopifyOrder;
}): Promise<boolean> {
  const identityHints = extractIdentityFromOrder(order);
  const customer = extractCustomerIdentity(order);

  let visitor = null;
  let recoveredVisitorId = identityHints.visitorId;
  if (recoveredVisitorId) {
    visitor = await getVisitor({ storeId: shop, visitorId: recoveredVisitorId });
  } else if (identityHints.fbclid) {
    visitor = await findVisitorByFbclid({ storeId: shop, fbclid: identityHints.fbclid });
    if (visitor) recoveredVisitorId = visitor.visitor_id;
  }
  if (!visitor && identityHints.clientIp && identityHints.clientUa) {
    visitor = await findRecentVisitorByIpUa({
      storeId: shop,
      ip: identityHints.clientIp,
      ua: identityHints.clientUa,
      referenceTime: order.processed_at ?? order.created_at,
      windowMinutes: 60,
    });
    if (visitor) recoveredVisitorId = visitor.visitor_id;
  }

  const { fbc: bestFbc } = pickBestFbc({
    cartAttrFbc: identityHints.fbc,
    visitor,
  });

  const externalIds: string[] = [];
  if (recoveredVisitorId) externalIds.push(recoveredVisitorId);
  if (customer.externalId) externalIds.push(customer.externalId);

  const userData = buildUserData({
    ...customer,
    externalId: externalIds.length ? externalIds : undefined,
    fbp: identityHints.fbp ?? visitor?.latest_fbp ?? undefined,
    fbc: bestFbc ?? undefined,
    clientIp: identityHints.clientIp ?? visitor?.latest_ip ?? undefined,
    clientUa: identityHints.clientUa ?? visitor?.latest_ua ?? undefined,
  });

  const eventId =
    identityHints.eventId ?? `purchase:${shop}:${order.id}`;

  const value = Number(order.current_total_price ?? order.total_price ?? 0);
  const currency = order.presentment_currency ?? order.currency ?? "USD";
  const contentIds = (order.line_items ?? [])
    .map((li) => (li.product_id ? String(li.product_id) : null))
    .filter(Boolean) as string[];
  const numItems = (order.line_items ?? []).reduce(
    (sum, li) => sum + (li.quantity ?? 0),
    0
  );

  const eventTime = order.processed_at
    ? new Date(order.processed_at)
    : new Date(order.created_at);

  const event = buildCAPIEvent({
    eventName: "Purchase",
    eventId,
    eventTime,
    eventSourceUrl: order.order_status_url ?? undefined,
    userData,
    customData: {
      currency,
      value,
      content_ids: contentIds,
      content_type: "product",
      num_items: numItems,
      order_id: String(order.id),
    },
  });

  const result = await sendCAPIEventsForShop({ storeId: shop, events: [event] });
  if (!result.ok) {
    console.warn(`[capi-reconcile ${shop} #${order.name}] send failed: ${result.reason}`);
    return false;
  }

  // Mirror the live webhook: write the attribution row if it's missing.
  // recordOrderAttribution is idempotent on (store_id, shopify_order_id),
  // so a second call when the webhook already wrote the row is a no-op.
  try {
    await recordOrderAttribution({
      storeId: shop,
      shopifyOrderId: order.id,
      visitorId: recoveredVisitorId ?? null,
      landingSite: order.landing_site ?? null,
      attributedAt: order.processed_at
        ? new Date(order.processed_at)
        : new Date(),
    });
  } catch (err) {
    console.warn(
      `[capi-reconcile ${shop} #${order.name}] recordOrderAttribution failed:`,
      err
    );
  }

  return true;
}

// Minimal shape we touch on the order payload — Shopify Admin REST returns
// far more fields, but we only depend on these.
type ShopifyOrder = {
  id: number | string;
  name: string;
  created_at: string;
  processed_at?: string | null;
  total_price?: string;
  current_total_price?: string;
  currency?: string;
  presentment_currency?: string;
  order_status_url?: string;
  landing_site?: string | null;
  line_items?: Array<{ product_id?: number | string | null; quantity?: number }>;
};
