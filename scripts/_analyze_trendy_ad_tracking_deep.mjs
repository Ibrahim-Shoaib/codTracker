// Deep dive — was tracking ever working for Trendy Homes? Look further back.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const head = (s) => console.log("\n" + "═".repeat(80) + "\n " + s + "\n" + "═".repeat(80));
const pad = (s, n) => String(s ?? "").padEnd(n);

// 1. Pixel connection — any row, any status? including soft-deleted?
head("1. meta_pixel_connections — full row dump (any status)");
const { data: pix, error: pErr } = await sb
  .from("meta_pixel_connections")
  .select("*")
  .eq("store_id", SHOP);
console.log("err:", pErr);
console.log("rows:", pix?.length ?? 0);
for (const r of pix ?? []) {
  console.log(JSON.stringify({ ...r, bisu_token: r.bisu_token ? "<encrypted>" : null }, null, 2));
}

// 2. capi_delivery_log — all-time totals, latest row, oldest row
head("2. capi_delivery_log — all-time stats");
const { data: capiAll, count: capiCount } = await sb
  .from("capi_delivery_log")
  .select("event_name, status, sent_at, event_id, error_msg, http_status", { count: "exact" })
  .eq("store_id", SHOP)
  .order("sent_at", { ascending: false })
  .limit(20);
console.log("Total rows in log:", capiCount);
console.log("Latest 20 rows:");
for (const r of capiAll ?? []) {
  console.log(`  ${r.sent_at}  ${pad(r.event_name, 18)} ${pad(r.status, 7)} http=${r.http_status ?? "?"} ${(r.error_msg ?? "").slice(0, 80)}`);
}

const { data: capiOldest } = await sb
  .from("capi_delivery_log")
  .select("sent_at, event_name, status")
  .eq("store_id", SHOP)
  .order("sent_at", { ascending: true })
  .limit(1);
console.log("Oldest in log:", capiOldest?.[0]);

// 3. order_attribution — any time
head("3. order_attribution — all-time stats");
const { data: oaAll, count: oaCount } = await sb
  .from("order_attribution")
  .select("channel, capi_sent_at, created_at, fbclid, visitor_id, order_name", { count: "exact" })
  .eq("store_id", SHOP)
  .order("created_at", { ascending: false })
  .limit(20);
console.log("Total rows:", oaCount);
console.log("Latest 20:");
for (const r of oaAll ?? []) {
  console.log(`  ${r.created_at}  ${pad(r.channel, 16)} capi_sent=${r.capi_sent_at ?? "—"}  fbclid=${r.fbclid ? "y" : "n"}  vid=${r.visitor_id ? "y" : "n"}  ${r.order_name}`);
}
const { data: oaOldest } = await sb
  .from("order_attribution")
  .select("created_at, channel")
  .eq("store_id", SHOP)
  .order("created_at", { ascending: true })
  .limit(1);
console.log("Oldest:", oaOldest?.[0]);

// 4. visitors — any time
head("4. visitors — all-time stats");
const { data: vAll, count: vCount } = await sb
  .from("visitors")
  .select("cod_visitor_id, last_seen_at, first_seen_at", { count: "exact" })
  .eq("store_id", SHOP)
  .order("last_seen_at", { ascending: false })
  .limit(5);
console.log("Total visitor rows:", vCount);
console.log("Latest 5:");
for (const r of vAll ?? []) {
  console.log(`  last=${r.last_seen_at}  first=${r.first_seen_at}  vid=${r.cod_visitor_id?.slice(0, 12)}…`);
}

// 5. visitor_events — any time, latest 5
head("5. visitor_events — latest 5");
const { data: veAll, count: veCount } = await sb
  .from("visitor_events")
  .select("event_name, created_at, cod_visitor_id", { count: "exact" })
  .eq("store_id", SHOP)
  .order("created_at", { ascending: false })
  .limit(5);
console.log("Total visitor_events rows:", veCount);
for (const r of veAll ?? []) {
  console.log(`  ${r.created_at}  ${pad(r.event_name, 22)} vid=${r.cod_visitor_id?.slice(0, 12)}…`);
}

// 6. emq_snapshots — all-time
head("6. emq_snapshots — all-time");
const { data: emq } = await sb
  .from("emq_snapshots")
  .select("snapshot_date, dataset_id, overall_emq")
  .eq("store_id", SHOP)
  .order("snapshot_date", { ascending: false })
  .limit(10);
console.log("Latest 10:");
for (const r of emq ?? []) {
  console.log(`  ${r.snapshot_date}  dataset=${r.dataset_id}  overall=${r.overall_emq}`);
}

// 7. capi_retries
head("7. capi_retries");
const { data: rt, count: rtCount } = await sb
  .from("capi_retries")
  .select("event_name, attempt_count, last_error, created_at", { count: "exact" })
  .eq("store_id", SHOP);
console.log("Total:", rtCount);
for (const r of rt ?? []) console.log(JSON.stringify(r));

// 8. orders — recent
head("8. orders — last 7 days");
const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
const { data: ords, count: ordCount } = await sb
  .from("orders")
  .select("order_ref_number, transaction_date, transaction_status, is_delivered, is_returned, invoice_payment, shopify_order_id", { count: "exact" })
  .eq("store_id", SHOP)
  .gte("transaction_date", since7)
  .order("transaction_date", { ascending: false })
  .limit(20);
console.log(`Orders in last 7d: ${ordCount}`);
for (const o of ords ?? []) {
  console.log(`  ${o.transaction_date}  ${pad(o.order_ref_number, 10)}  ${pad(o.transaction_status, 14)}  pay=${o.invoice_payment}  shopify=${o.shopify_order_id ?? "—"}`);
}

// 9. ad_spend last 30d
head("9. ad_spend — last 30 days");
const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const { data: spend } = await sb
  .from("ad_spend")
  .select("spend_date, amount")
  .eq("store_id", SHOP)
  .gte("spend_date", since30)
  .order("spend_date", { ascending: true });
let total = 0;
for (const s of spend ?? []) {
  total += Number(s.amount) || 0;
  console.log(`  ${s.spend_date}  ${Number(s.amount).toLocaleString()}`);
}
console.log(`30d total: ${total.toLocaleString()} PKR`);
