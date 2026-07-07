// Quick state check for the trendy homes — current Meta Pixel + Meta Ads
// connection state in our DB. Decides whether the merchant has to reconnect
// before we can replay.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: pixel } = await sb
  .from("meta_pixel_connections")
  .select("store_id, status, status_reason, dataset_id, business_id, web_pixel_id, last_event_sent_at, created_at, updated_at")
  .eq("store_id", SHOP);

console.log("meta_pixel_connections rows:", pixel?.length ?? 0);
if (pixel?.length) console.log(pixel);

const { data: stores } = await sb
  .from("stores")
  .select("store_id, meta_access_token, meta_token_expires_at, meta_ad_account_id, meta_ad_account_name, meta_ad_account_currency, meta_sync_error")
  .eq("store_id", SHOP);
console.log("\nstores row (Meta Ads side):");
if (stores?.length) {
  const s = stores[0];
  console.log({
    store_id: s.store_id,
    has_access_token: !!s.meta_access_token,
    expires_at: s.meta_token_expires_at,
    ad_account_id: s.meta_ad_account_id,
    ad_account_name: s.meta_ad_account_name,
    ad_account_currency: s.meta_ad_account_currency,
    meta_sync_error: s.meta_sync_error,
  });
}

// Look for any visitor rows that could enrich the 7 orders
const startUtc = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
const { count: visitorCount } = await sb
  .from("visitors")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP)
  .gte("last_seen_at", startUtc);
console.log(`\nvisitors with last_seen_at in last 36h for this shop: ${visitorCount ?? 0}`);

const { count: capiCount } = await sb
  .from("capi_delivery_log")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP)
  .gte("sent_at", startUtc);
console.log(`capi_delivery_log rows in last 36h for this shop: ${capiCount ?? 0}`);

const { count: retryCount } = await sb
  .from("capi_retries")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP);
console.log(`capi_retries rows for this shop: ${retryCount ?? 0}`);
