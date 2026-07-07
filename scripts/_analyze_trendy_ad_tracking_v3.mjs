// Try with set_app_store, capture all errors, focus on Purchase + attribution
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
await sb.rpc("set_app_store", { store: SHOP });

const head = (s) => console.log("\n" + "═".repeat(80) + "\n " + s + "\n" + "═".repeat(80));
const pad = (s, n) => String(s ?? "").padEnd(n);

// 1. Pixel connection — re-look at last_event_sent_at gap
head("1. PIXEL — last event vs now");
const { data: pix } = await sb.from("meta_pixel_connections").select("*").eq("store_id", SHOP).single();
console.log(`  connected_at:        ${pix?.connected_at}`);
console.log(`  last_event_sent_at:  ${pix?.last_event_sent_at}`);
console.log(`  status:              ${pix?.status} / ${pix?.status_reason ?? "—"}`);

// 2. capi_delivery_log — by event_name, all-time
head("2. capi_delivery_log — distribution by event_name (all rows in 500-cap window)");
const { data: log, error: logErr } = await sb
  .from("capi_delivery_log")
  .select("event_name, status, sent_at, event_id, error_msg")
  .eq("store_id", SHOP)
  .order("sent_at", { ascending: false });
console.log("err:", logErr);
console.log("rows:", log?.length);
const dist = {};
for (const r of log ?? []) {
  dist[r.event_name] ??= { sent: 0, failed: 0, distinct: new Set() };
  if (r.status === "sent") dist[r.event_name].sent++;
  else dist[r.event_name].failed++;
  dist[r.event_name].distinct.add(r.event_id);
}
console.log(`  ${pad("event", 22)} ${pad("sent", 6)} ${pad("failed", 7)} distinct_event_ids`);
for (const [k, v] of Object.entries(dist)) {
  console.log(`  ${pad(k, 22)} ${pad(v.sent, 6)} ${pad(v.failed, 7)} ${v.distinct.size}`);
}

// 3. order_attribution with errors visible
head("3. order_attribution — explicit");
const { data: oa, error: oaErr, count: oaCount } = await sb
  .from("order_attribution")
  .select("*", { count: "exact", head: false })
  .eq("store_id", SHOP)
  .order("created_at", { ascending: false })
  .limit(10);
console.log("err:", oaErr);
console.log("count:", oaCount);
console.log("rows:", oa?.length);
if (oa?.length) console.log(JSON.stringify(oa[0], null, 2));

// 4. visitors with errors visible
head("4. visitors — explicit");
const { data: v, error: vErr, count: vCount } = await sb
  .from("visitors")
  .select("*", { count: "exact", head: false })
  .eq("store_id", SHOP)
  .order("last_seen_at", { ascending: false })
  .limit(3);
console.log("err:", vErr);
console.log("count:", vCount);
console.log("rows:", v?.length);
if (v?.length) {
  // mask PII
  const r = v[0];
  console.log(JSON.stringify({
    cod_visitor_id: r.cod_visitor_id?.slice(0, 8) + "…",
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    em_hash: r.em_hash ? "<hash>" : null,
    ph_hash: r.ph_hash ? "<hash>" : null,
    fn_hash: r.fn_hash ? "<hash>" : null,
    fbp: r.fbp ? "<present>" : null,
    fbc: r.fbc ? "<present>" : null,
    fbc_history_len: r.fbc_history?.length ?? 0,
    utm_history_len: r.utm_history?.length ?? 0,
    columns: Object.keys(r),
  }, null, 2));
}

// 5. orders — explicit
head("5. orders — explicit, last 7d");
const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
const { data: o, error: oErr, count: oCount } = await sb
  .from("orders")
  .select("order_ref_number, transaction_date, transaction_status, is_delivered, is_returned, invoice_payment, shopify_order_id", { count: "exact" })
  .eq("store_id", SHOP)
  .gte("transaction_date", since7)
  .order("transaction_date", { ascending: false })
  .limit(15);
console.log("err:", oErr);
console.log("count:", oCount);
console.log("rows:", o?.length);
for (const x of o ?? []) {
  console.log(`  ${x.transaction_date}  ref=${pad(x.order_ref_number, 8)} status=${pad(x.transaction_status, 14)} pay=${x.invoice_payment} shopify=${x.shopify_order_id ?? "—"}`);
}

// 6. capi_retries
head("6. capi_retries — explicit");
const { data: rt, error: rtErr, count: rtCount } = await sb
  .from("capi_retries")
  .select("*", { count: "exact" })
  .eq("store_id", SHOP);
console.log("err:", rtErr, "count:", rtCount, "rows:", rt?.length);
for (const r of rt ?? []) {
  console.log(`  ${r.event_name}  attempt=${r.attempt_count}  next=${r.next_attempt_at}  err=${(r.last_error ?? "").slice(0,80)}`);
}

// 7. emq_snapshots — explicit
head("7. emq_snapshots — explicit");
const { data: emq, error: emqErr, count: emqCount } = await sb
  .from("emq_snapshots")
  .select("*", { count: "exact" })
  .eq("store_id", SHOP)
  .order("snapshot_date", { ascending: false })
  .limit(10);
console.log("err:", emqErr, "count:", emqCount);
for (const r of emq ?? []) {
  console.log(`  ${r.snapshot_date}  dataset=${r.dataset_id}  overall=${r.overall_emq}  events=${JSON.stringify(r.event_scores)}`);
}

// 8. Purchase events anywhere in log (was 0 in last 24h on first script)
head("8. PURCHASE events in capi_delivery_log (filtered)");
const { data: purch, error: pErr } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, sent_at, http_status, error_msg, source")
  .eq("store_id", SHOP)
  .eq("event_name", "Purchase")
  .order("sent_at", { ascending: false })
  .limit(50);
console.log("err:", pErr, "rows:", purch?.length);
for (const r of (purch ?? []).slice(0, 30)) {
  console.log(`  ${r.sent_at}  ${pad(r.status, 7)} http=${pad(r.http_status, 4)} src=${pad(r.source ?? "—", 8)} ${r.event_id}`);
}

// 9. visitor_events explicit
head("9. visitor_events — explicit, last 24h");
const last24 = new Date(Date.now() - 86400000).toISOString();
const { data: ve, error: veErr, count: veCount } = await sb
  .from("visitor_events")
  .select("event_name, created_at, cod_visitor_id", { count: "exact" })
  .eq("store_id", SHOP)
  .gte("created_at", last24)
  .order("created_at", { ascending: false });
console.log("err:", veErr, "count:", veCount, "rows:", ve?.length);
const veDist = {};
for (const r of ve ?? []) {
  veDist[r.event_name] = (veDist[r.event_name] ?? 0) + 1;
}
console.log(JSON.stringify(veDist, null, 2));
