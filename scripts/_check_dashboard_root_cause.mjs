// Two suspicions to verify:
//   A. capi_delivery_log row-cap (500/shop) evicted #9394's Purchase rows so
//      the dashboard's "X sent to Meta today" undercounts.
//   B. #9393's order_attribution shows direct_organic because the original
//      orders/create webhook at 19:44Z ran an OLD deployed build (pre-
//      URL-fallback classifier from eab2644). Fix: re-run the classifier on
//      the existing landing_site.
import { createClient } from "@supabase/supabase-js";
const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// A. Total rows + oldest/newest sent_at + count of each event_name
console.log("─── A. capi_delivery_log rolling window ───");
const { count: total } = await sb
  .from("capi_delivery_log")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP);
console.log(`Total rows for shop: ${total}`);

const { data: oldest } = await sb
  .from("capi_delivery_log")
  .select("event_name, status, sent_at")
  .eq("store_id", SHOP)
  .order("sent_at", { ascending: true })
  .limit(3);
const { data: newest } = await sb
  .from("capi_delivery_log")
  .select("event_name, status, sent_at")
  .eq("store_id", SHOP)
  .order("sent_at", { ascending: false })
  .limit(3);
console.log("oldest 3:", oldest);
console.log("newest 3:", newest);

// Per-event-name counts
const { data: events } = await sb
  .from("capi_delivery_log")
  .select("event_name, status")
  .eq("store_id", SHOP);
const counts = {};
for (const r of events ?? []) {
  const k = `${r.event_name}/${r.status}`;
  counts[k] = (counts[k] ?? 0) + 1;
}
console.log("by event_name/status:", counts);

// Specifically: any rows for #9394 (id=7660580307260)?
const { data: rows9394 } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, sent_at")
  .eq("store_id", SHOP)
  .eq("event_id", "purchase:the-trendy-homes-pk.myshopify.com:7660580307260");
console.log(`\n#9394 rows currently in capi_delivery_log: ${rows9394?.length ?? 0}`);

// B. Pull #9393's landing_site from Shopify and run the URL classifier on it
console.log("\n─── B. #9393 attribution re-classification ───");
const { data: sessions } = await sb
  .from("shopify_sessions").select("accessToken").eq("shop", SHOP).eq("isOnline", false);
const r = await fetch(`https://${SHOP}/admin/api/2025-01/orders/7660041437500.json`, {
  headers: { "X-Shopify-Access-Token": sessions[0].accessToken },
});
const { order } = await r.json();
console.log("landing_site:", order.landing_site);
console.log("referring_site:", order.referring_site);

const { classifyUrlChannel } = await import("../app/lib/channel-attribution.server.js");
const classified = classifyUrlChannel(order.landing_site);
console.log("classifyUrlChannel(landing_site) →", classified);

const refClassified = order.referring_site ? classifyUrlChannel(order.referring_site) : null;
console.log("classifyUrlChannel(referring_site) →", refClassified);
