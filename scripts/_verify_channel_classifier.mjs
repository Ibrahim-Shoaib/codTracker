// Synthetic-input verification for the URL-fallback addition to
// recordOrderAttribution. We can't easily mock Supabase from here, so this
// script writes test rows into order_attribution under a sentinel
// shopify_order_id range and reads them back to confirm classification.
//
// Cleanup: deletes all sentinel rows at the end.
import { createClient } from "@supabase/supabase-js";
import { recordOrderAttribution } from "../app/lib/channel-attribution.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Sentinel id range — well above any real Shopify order id, easy to clean.
const SENTINEL_BASE = "9999999999000";
const cases = [
  {
    label: "IAB Instagram order, no visitor, fbclid+utm in landing_site (#9387 shape)",
    args: {
      visitorId: null,
      landingSite:
        "/collections/home-decor?utm_medium=paid&utm_source=ig&utm_campaign=120249346068950242&fbclid=PAZX...",
    },
    expect: { channel: "instagram_ads", utmSource: "ig" },
  },
  {
    label: "IAB Facebook order, no visitor, fbclid+utm_source=facebook",
    args: {
      visitorId: null,
      landingSite:
        "/products/lamp?utm_source=facebook&utm_campaign=summer&fbclid=PAZX...",
    },
    expect: { channel: "facebook_ads", utmSource: "facebook" },
  },
  {
    label: "Meta-tagged URL, no utm_source — fbclid alone defaults to facebook_ads (#9386 shape)",
    args: {
      visitorId: null,
      landingSite:
        "/collections/home-decor?utm_medium=paid&utm_id=120249346068950242&utm_campaign=120249346068950242&fbclid=PAZX...",
    },
    expect: { channel: "facebook_ads", utmSource: null },
  },
  {
    label: "Truly organic order — no fbclid, no utm",
    args: {
      visitorId: null,
      landingSite: "/products/sofa",
    },
    expect: { channel: "direct_organic" },
  },
  {
    label: "No landing_site at all (replay path)",
    args: { visitorId: null, landingSite: null },
    expect: { channel: "direct_organic" },
  },
];

let allPass = true;
const writtenIds = [];

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const orderId = SENTINEL_BASE + String(i).padStart(2, "0");
  writtenIds.push(orderId);

  await recordOrderAttribution({
    storeId: SHOP,
    shopifyOrderId: orderId,
    visitorId: c.args.visitorId,
    landingSite: c.args.landingSite,
    attributedAt: new Date(),
  });

  const { data: row } = await sb
    .from("order_attribution")
    .select("channel, utm_source, utm_medium, utm_campaign, first_touch_url")
    .eq("store_id", SHOP)
    .eq("shopify_order_id", orderId)
    .maybeSingle();

  const channelOk = row?.channel === c.expect.channel;
  const utmOk =
    c.expect.utmSource === undefined ||
    (c.expect.utmSource === null
      ? row?.utm_source == null
      : row?.utm_source === c.expect.utmSource);
  const ok = channelOk && utmOk;
  if (!ok) allPass = false;

  console.log(`${ok ? "✓" : "✗"} ${c.label}`);
  console.log(`   expected: channel=${c.expect.channel}${c.expect.utmSource !== undefined ? ` utm_source=${c.expect.utmSource}` : ""}`);
  console.log(`   actual:   channel=${row?.channel} utm_source=${row?.utm_source ?? "null"}  url=${row?.first_touch_url ? row.first_touch_url.slice(0, 60) + "..." : "null"}`);
}

// Cleanup.
console.log(`\nCleaning up ${writtenIds.length} sentinel rows...`);
await sb.from("order_attribution").delete().in("shopify_order_id", writtenIds).eq("store_id", SHOP);

console.log(`\n${allPass ? "✓ All cases passed." : "✗ Some cases failed."}`);
process.exit(allPass ? 0 : 1);
