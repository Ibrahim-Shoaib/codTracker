// Try to identify the OTHER integration firing Purchase events to this
// Meta Pixel. Checks (1) Meta's connected_partners on the dataset,
// (2) Shopify's installed apps and registered Web Pixels.
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../app/lib/crypto.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: conn } = await sb
  .from("meta_pixel_connections")
  .select("dataset_id, bisu_token")
  .eq("store_id", SHOP)
  .single();
const token = decryptSecret(conn.bisu_token);
const ds = conn.dataset_id;

// 1. Probe Meta dataset metadata
console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(" Meta dataset metadata + connected sources");
console.log("═══════════════════════════════════════════════════════════════════════════");

const dsRes = await fetch(
  `https://graph.facebook.com/v24.0/${ds}?` +
    new URLSearchParams({
      access_token: token,
      fields: "name,owner_business,owner_ad_account,creation_time,data_use_setting,enable_automatic_matching,automatic_matching_fields,first_party_cookie_status,can_proxy",
    })
);
console.log("\n─── Pixel/dataset details ───");
console.log(JSON.stringify(await dsRes.json(), null, 2));

// 2. Try connected_partners (may or may not be exposed)
console.log("\n─── Connected partners (if exposed) ───");
const partnersRes = await fetch(
  `https://graph.facebook.com/v24.0/${ds}/connected_partners?access_token=${token}`
);
console.log(`HTTP ${partnersRes.status}`);
console.log((await partnersRes.text()).slice(0, 1500));

// 3. Try /shared_accounts
console.log("\n─── Shared accounts ───");
const sharedRes = await fetch(
  `https://graph.facebook.com/v24.0/${ds}/shared_accounts?access_token=${token}`
);
console.log(`HTTP ${sharedRes.status}`);
console.log((await sharedRes.text()).slice(0, 1500));

// 4. event_source breakdown by partner_action / hour for Purchase events today
console.log("\n─── event_source values for today (full list) ───");
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const todayPktDate = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
const startUtc = new Date(`${todayPktDate}T00:00:00Z`).getTime() - PKT_OFFSET_MS;

const sourceRes = await fetch(
  `https://graph.facebook.com/v24.0/${ds}/stats?` +
    new URLSearchParams({ access_token: token, aggregation: "event_source" })
);
const sourceJson = await sourceRes.json();
const allValues = new Set();
for (const bucket of sourceJson.data ?? []) {
  for (const row of bucket.data ?? []) {
    allValues.add(row.value);
  }
}
console.log(`Unique event_source values seen by this dataset: ${[...allValues].join(", ")}`);

// 5. Now look at OUR Shopify-side: what apps are installed + what Web Pixels are registered
console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
console.log(" Shopify side — installed apps and registered Web Pixels");
console.log("═══════════════════════════════════════════════════════════════════════════");

const { data: sessions } = await sb
  .from("shopify_sessions")
  .select("accessToken")
  .eq("shop", SHOP)
  .eq("isOnline", false);
const sToken = sessions[0].accessToken;

// Web Pixels registered on the storefront via Admin GraphQL
console.log("\n─── Custom Web Pixels (Shopify admin → Settings → Customer events) ───");
const gql = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": sToken,
  },
  body: JSON.stringify({
    query: `{
      webPixel { id settings }
    }`,
  }),
});
const gqlJson = await gql.json();
console.log(JSON.stringify(gqlJson, null, 2));

// Also list our app's webPixel from the connection record (we know one)
console.log(`\nOur app's web pixel id (from meta_pixel_connections): gid://shopify/WebPixel/2453668156`);
console.log(`If the Shopify GraphQL query above returns a DIFFERENT id, that's another web pixel.`);

// (Note: webPixel query returns the CURRENT app's pixel. Listing other apps' pixels
//  requires per-app context — not available from our token. Best path is via UI.)

console.log("\n\n═══════════════════════════════════════════════════════════════════════════");
console.log(" Summary + manual-check next step");
console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(`
The Meta API doesn't directly tell us "which apps are sending events to this
dataset" via Graph endpoints. The info IS visible in the Events Manager UI:

  Events Manager → your dataset (179347178505127) → Settings tab →
    look at "Conversions API → Active integrations"
  AND
    "Diagnostics tab" → look for any duplicate-events warnings or
    integration-mismatch warnings.

Most likely culprits for the extra Purchase events:
  1. Shopify's "Facebook & Instagram" sales channel (auto-fires CAPI when
     you have your Pixel ID configured in Shopify admin → Apps → Facebook
     & Instagram → Settings).
  2. A separately-installed app (PixelYourSite, Trackify, Pixel Perfect,
     Conversions API by Trackify, etc.).
  3. A hardcoded fbq() snippet in the theme code.

To enumerate Shopify-side: Shopify admin → Apps → look for any "Facebook",
"Meta", "Pixel", or "Conversions" named apps.
`);
