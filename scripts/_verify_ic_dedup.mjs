// Quantify the InitiateCheckout dedup gap.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data } = await sb
  .from("capi_delivery_log")
  .select("event_id")
  .eq("store_id", SHOP)
  .eq("event_name", "InitiateCheckout");

let browserSidePsid = 0;
let serverSideToken = 0;
const seenIds = new Set();
for (const r of data ?? []) {
  if (seenIds.has(r.event_id)) continue;
  seenIds.add(r.event_id);
  if (r.event_id.startsWith("checkout_started:")) browserSidePsid++;
  else if (r.event_id.startsWith("initiatecheckout:")) serverSideToken++;
}
console.log(`InitiateCheckout unique event_ids:`);
console.log(`  browser-side (checkout_started:psid format): ${browserSidePsid}`);
console.log(`  server-side  (initiatecheckout:token format): ${serverSideToken}`);
console.log(`  total unique events Meta will count: ${browserSidePsid + serverSideToken}`);
console.log(`  → if these were deduped, count would be: ${Math.max(browserSidePsid, serverSideToken)}`);

// Same audit for Purchase
const { data: pData } = await sb
  .from("capi_delivery_log")
  .select("event_id")
  .eq("store_id", SHOP)
  .eq("event_name", "Purchase");

const purchaseIds = new Set();
for (const r of pData ?? []) purchaseIds.add(r.event_id);
console.log(`\nPurchase unique event_ids: ${purchaseIds.size}`);
for (const id of purchaseIds) console.log(`  ${id}`);

// Test event_ids (catch any leftover test-scaffold ids)
const { data: tests } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, sent_at")
  .eq("store_id", SHOP)
  .like("event_id", "test:%");
console.log(`\nTest events (event_id starting with "test:"): ${tests?.length ?? 0}`);
