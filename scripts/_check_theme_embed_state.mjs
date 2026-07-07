// Verify whether the COD Tracker theme app embeds are actually saved in the
// live theme's settings_data.json — separate from the toggle UI state in the
// theme customizer. The toggle is only client-side until the merchant clicks
// Save; this hits Shopify's GraphQL Admin API to read the published state.
import { createClient } from "@supabase/supabase-js";
import { getEmbedActivationStatus, detectEmbedsInSettingsData } from "../app/lib/theme-embed.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: sessions } = await sb
  .from("shopify_sessions")
  .select("accessToken, scope")
  .eq("shop", SHOP)
  .eq("isOnline", false);
if (!sessions?.length) {
  console.error("No offline session for", SHOP);
  process.exit(1);
}
const accessToken = sessions[0].accessToken;
console.log(`Using offline session — scope: ${sessions[0].scope}\n`);

const status = await getEmbedActivationStatus({ shop: SHOP, accessToken });
console.log("getEmbedActivationStatus result:", status);

console.log("\n═══ Verdict ═══");
console.log(`  Meta Pixel embed published in live theme:  ${status.metaPixel ? "✓ ACTIVE" : "✗ NOT ACTIVE"}`);
console.log(`  Cart Relay embed published in live theme:  ${status.cartRelay ? "✓ ACTIVE" : "✗ NOT ACTIVE"}`);
if (status.reason) console.log(`  reason: ${status.reason}`);

// If both are active per Shopify, the absence of cart attrs is NOT due to a
// missing embed — it's something else (script load failure, browser blocking,
// non-cart checkout flow). Print a hint either way.
if (status.metaPixel && status.cartRelay) {
  console.log(`\n  → Embeds ARE saved in the published theme. The missing cart attrs`);
  console.log(`    on order #9386 must come from a different cause — most likely`);
  console.log(`    browser-side script blocking or a checkout flow that bypassed cart.`);
} else if (!status.metaPixel || !status.cartRelay) {
  console.log(`\n  → One or both embeds are NOT actually published. Toggling the switch`);
  console.log(`    in theme customizer is not enough — the merchant must click "Save"`);
  console.log(`    for the change to publish to the live theme.`);
}
