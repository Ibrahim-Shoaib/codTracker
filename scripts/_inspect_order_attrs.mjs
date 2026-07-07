// Dump full note_attributes for today's orders to see what identity is
// actually flowing through and confirm whether our cart-relay theme block
// is writing _cod_visitor_id, _fbp, _fbc as designed.
import { createClient } from "@supabase/supabase-js";

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
const token = sessions[0].accessToken;

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const todayPktDate = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
const startUtc = new Date(`${todayPktDate}T00:00:00Z`).getTime() - PKT_OFFSET_MS;
const startIso = new Date(startUtc).toISOString();

const url = `https://${SHOP}/admin/api/2025-01/orders.json?` +
  new URLSearchParams({
    created_at_min: startIso,
    status: "any",
    limit: "20",
    fields: "id,name,created_at,total_price,note_attributes,landing_site,referring_site,client_details,source_name,customer",
  });

const res = await fetch(url, {
  headers: { "X-Shopify-Access-Token": token },
});
const { orders } = await res.json();

for (const o of orders) {
  console.log("═".repeat(80));
  console.log(` ${o.name} — ${o.created_at}  (${o.source_name})  PKR ${o.total_price}`);
  console.log("═".repeat(80));
  console.log(`  customer.id: ${o.customer?.id ?? "(null)"}`);
  console.log(`  customer.email: ${o.customer?.email ?? "(null)"}`);
  console.log(`  landing_site: ${o.landing_site ?? "(null)"}`);
  console.log(`  referring_site: ${o.referring_site ?? "(null)"}`);
  console.log(`  client_details.user_agent: ${o.client_details?.user_agent?.slice(0, 80) ?? "(null)"}`);
  console.log(`  client_details.browser_ip: ${o.client_details?.browser_ip ?? "(null)"}`);
  console.log(`\n  note_attributes (${(o.note_attributes ?? []).length} items):`);
  for (const a of o.note_attributes ?? []) {
    const v = String(a.value ?? "").length > 80 ? String(a.value).slice(0, 77) + "..." : a.value;
    console.log(`    ${(a.name ?? a.key ?? "?").padEnd(28)} = ${v}`);
  }
  console.log();
}
