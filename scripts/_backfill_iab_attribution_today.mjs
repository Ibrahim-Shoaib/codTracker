// Backfill order_attribution for today's orders that were classified as
// direct_organic before the URL-fallback fix landed. Re-runs
// recordOrderAttribution with the new landingSite param so IAB Meta orders
// flip to facebook_ads / instagram_ads.
//
// Idempotent: order_attribution upserts on (store_id, shopify_order_id), so
// re-running this is safe.
import { createClient } from "@supabase/supabase-js";
import { recordOrderAttribution } from "../app/lib/channel-attribution.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: sessions } = await sb
  .from("shopify_sessions")
  .select("accessToken")
  .eq("shop", SHOP)
  .eq("isOnline", false);
const accessToken = sessions[0].accessToken;

// Pull all rows currently classified as direct_organic for this shop in
// the last 36 hours — that's where the IAB-driven misclassifications live.
const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
const { data: rows } = await sb
  .from("order_attribution")
  .select("shopify_order_id, channel, attributed_at")
  .eq("store_id", SHOP)
  .eq("channel", "direct_organic")
  .gte("attributed_at", since);

console.log(`Found ${rows?.length ?? 0} direct_organic rows in last 36h. Inspecting...\n`);

let flipped = 0;
let stayed = 0;
let missing = 0;

for (const row of rows ?? []) {
  // Pull the order to get landing_site.
  const r = await fetch(
    `https://${SHOP}/admin/api/2025-01/orders/${row.shopify_order_id}.json?fields=id,name,landing_site,processed_at,created_at,note_attributes`,
    { headers: { "X-Shopify-Access-Token": accessToken } }
  );
  if (!r.ok) {
    console.log(`  ✗ ${row.shopify_order_id} — Shopify ${r.status}`);
    missing++;
    continue;
  }
  const { order } = await r.json();
  if (!order) {
    console.log(`  ✗ ${row.shopify_order_id} — order not found in Shopify`);
    missing++;
    continue;
  }

  // Use the same visitor_id discovery the webhook handler used; for these
  // backfilled rows the cart-attr visitor_id wasn't there at conversion
  // time anyway, so passing null is correct.
  const visitorAttr = (order.note_attributes ?? []).find(
    (a) => a.name === "_cod_visitor_id" || a.key === "_cod_visitor_id"
  );
  const visitorId = visitorAttr?.value ?? null;

  await recordOrderAttribution({
    storeId: SHOP,
    shopifyOrderId: order.id,
    visitorId,
    landingSite: order.landing_site ?? null,
    attributedAt: order.processed_at
      ? new Date(order.processed_at)
      : order.created_at
      ? new Date(order.created_at)
      : new Date(),
  });

  // Read back to see whether it changed.
  const { data: updated } = await sb
    .from("order_attribution")
    .select("channel, utm_source")
    .eq("store_id", SHOP)
    .eq("shopify_order_id", String(order.id))
    .maybeSingle();

  if (updated && updated.channel !== "direct_organic") {
    flipped++;
    console.log(`  ✓ ${order.name.padEnd(8)} ${row.shopify_order_id.padEnd(16)} direct_organic → ${updated.channel}${updated.utm_source ? ` (utm_source=${updated.utm_source})` : ""}`);
  } else {
    stayed++;
    console.log(`  · ${order.name.padEnd(8)} ${row.shopify_order_id.padEnd(16)} stays direct_organic (no fbclid in landing_site)`);
  }
}

console.log(`\n─── Summary ───`);
console.log(`  Inspected: ${rows?.length ?? 0}`);
console.log(`  Flipped to ad-attributed: ${flipped}`);
console.log(`  Stayed direct_organic:    ${stayed}`);
console.log(`  Order not found:          ${missing}`);
