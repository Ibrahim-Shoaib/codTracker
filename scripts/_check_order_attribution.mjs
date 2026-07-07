import { createClient } from "@supabase/supabase-js";
const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data, error } = await sb
  .from("order_attribution")
  .select("shopify_order_id, channel, visitor_id, utm_source, utm_campaign, attributed_at")
  .eq("store_id", SHOP)
  .order("attributed_at", { ascending: false })
  .limit(15);
if (error) {
  console.error("error:", error);
  process.exit(1);
}
console.log("Latest order_attribution rows for", SHOP);
console.table(data);

const ids = ["7659046601020", "7658731929916", "7658619633980", "7658553114940", "7658124837180", "7657997402428", "7657150316860", "7657073049916"];
const labels = { "7659046601020": "9386 (live)", "7658731929916": "9385 (replay draft)", "7658619633980": "9384 (replay)", "7658553114940": "9383 (replay)", "7658124837180": "9382 (replay)", "7657997402428": "9381 (replay)", "7657150316860": "9380 (replay)", "7657073049916": "9379 (replay)" };
const have = new Set((data ?? []).map((r) => r.shopify_order_id));
console.log("\nPresence check:");
for (const id of ids) {
  console.log(`  ${labels[id].padEnd(22)} ${id.padEnd(20)} ${have.has(id) ? "✓ has row" : "✗ MISSING"}`);
}
