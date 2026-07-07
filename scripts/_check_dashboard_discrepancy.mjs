// Why does dashboard show "6 orders sent to Meta today" + 4 fb / 0 ig / 3 direct?
// We expect 7 + 4 fb / 1 ig / 2 direct based on the per-order audit.
import { createClient } from "@supabase/supabase-js";
const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const PKT_OFFSET_MS = 5 * 3600 * 1000;
const todayPkt = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
const startUtc = new Date(`${todayPkt}T00:00:00Z`).getTime() - PKT_OFFSET_MS;
const endUtc = startUtc + 24 * 3600 * 1000;
const startIso = new Date(startUtc).toISOString();
const endIso = new Date(endUtc).toISOString();
console.log(`PKT today: ${todayPkt}; UTC window: ${startIso} → ${endIso}\n`);

// 1. Distinct sent Purchase event_ids today
const { data: capiToday } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, sent_at")
  .eq("store_id", SHOP)
  .eq("event_name", "Purchase")
  .eq("status", "sent")
  .gte("sent_at", startIso)
  .lt("sent_at", endIso);
const ids = new Set();
for (const r of capiToday ?? []) ids.add(r.event_id);
console.log(`distinct sent Purchase event_ids today (count by sent_at): ${ids.size}`);
for (const id of [...ids].sort()) console.log("  ", id);

// 2. Order attribution rows today (by attributed_at)
const { data: attrToday } = await sb
  .from("order_attribution")
  .select("shopify_order_id, channel, attributed_at, utm_source, utm_medium")
  .eq("store_id", SHOP)
  .gte("attributed_at", startIso)
  .lt("attributed_at", endIso)
  .order("attributed_at", { ascending: true });
console.log(`\norder_attribution rows today: ${attrToday?.length ?? 0}`);
const channels = {};
for (const r of attrToday ?? []) {
  channels[r.channel] = (channels[r.channel] ?? 0) + 1;
  console.log(`  ${r.shopify_order_id} | channel=${r.channel} | utm=${r.utm_source}/${r.utm_medium} | ${r.attributed_at}`);
}
console.log("by channel:", channels);

// 3. The hero copy "6 orders sent to Meta today" — where does it come from?
// Likely counts distinct event_ids in capi_delivery_log Purchase with status='sent'.
// Our distinct count should now be 7 since #9393 was just replayed.

// 4. The "0 Instagram Ads" — maybe the loader is bucketing differently. Let me
// also check if #9393's order_attribution row is the one we expect.
const { data: a9393 } = await sb
  .from("order_attribution")
  .select("*")
  .eq("store_id", SHOP)
  .eq("shopify_order_id", "7660041437500")
  .maybeSingle();
console.log("\n#9393 attribution row:", a9393);
