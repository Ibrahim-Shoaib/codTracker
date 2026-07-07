// Pull more order metadata for #9386 to determine why theme-block scripts
// didn't write cart attrs. Specifically: User-Agent (to spot in-app browsers),
// referring_site (to see if they came directly from FB/IG IAB), and the
// checkout token / processing_method (to spot Buy-It-Now flows).
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: sessions } = await sb.from("shopify_sessions").select("accessToken").eq("shop", SHOP).eq("isOnline", false);
const accessToken = sessions[0].accessToken;

const url = `https://${SHOP}/admin/api/2025-01/orders/7659046601020.json`;
const r = await fetch(url, { headers: { "X-Shopify-Access-Token": accessToken } });
const { order: o } = await r.json();

console.log("═══ Order #9386 deep inspection ═══\n");
console.log("client_details:", JSON.stringify(o.client_details, null, 2));
console.log("\nlanding_site:    ", o.landing_site);
console.log("referring_site:  ", o.referring_site);
console.log("source_name:     ", o.source_name);
console.log("source_identifier:", o.source_identifier);
console.log("source_url:      ", o.source_url);
console.log("processing_method:", o.processing_method);
console.log("checkout_token:  ", o.checkout_token);
console.log("cart_token:      ", o.cart_token);
console.log("device_id:       ", o.device_id);
console.log("browser_ip:      ", o.browser_ip);

console.log("\n═══ Note attributes (cart attrs that survived) ═══");
console.log(JSON.stringify(o.note_attributes, null, 2));

console.log("\n═══ Raw cart_token analysis ═══");
console.log("cart_token present:", !!o.cart_token, "→", o.cart_token ?? "NONE");
console.log("If cart_token is null, the order did NOT go through the persistent cart object —");
console.log("which means /cart/update.js writes from our theme block never reached this order,");
console.log("regardless of whether the script ran.");
