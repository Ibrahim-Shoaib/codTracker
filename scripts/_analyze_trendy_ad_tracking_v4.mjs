// Schema-aware version. Inspect columns first.
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
const PKT = 5 * 60 * 60 * 1000;
const now = new Date();
const today = new Date(now.getTime() + PKT).toISOString().slice(0, 10);
const startTodayUtc = new Date(`${today}T00:00:00Z`).getTime() - PKT;
const startWeekUtc = startTodayUtc - 6 * 86400000;
const last24Iso = new Date(now.getTime() - 86400000).toISOString();

// Probe a single row from each table to learn columns
const probe = async (table) => {
  const { data, error } = await sb.from(table).select("*").eq("store_id", SHOP).limit(1);
  if (error) return { error };
  return { columns: data?.[0] ? Object.keys(data[0]) : null };
};

head("0. Schema probe (columns from sample rows)");
for (const t of ["order_attribution", "orders", "emq_snapshots", "capi_delivery_log", "visitor_events"]) {
  console.log(`  ${pad(t, 24)} ${JSON.stringify((await probe(t)).columns)}`);
}

// ── Order attribution ──
head("1. ORDER ATTRIBUTION");
// columns unknown — inspect first row
const { data: oaProbe } = await sb.from("order_attribution").select("*").eq("store_id", SHOP).limit(1);
const oaCols = oaProbe?.[0] ? Object.keys(oaProbe[0]) : [];
console.log("columns:", oaCols.join(", "));
if (oaCols.length) console.log("sample row:", JSON.stringify(oaProbe[0], null, 2));

// time field
const oaTimeField = ["created_at", "ordered_at", "purchase_at", "order_created_at", "purchased_at", "inserted_at"].find((c) => oaCols.includes(c)) ?? oaCols.find((c) => /at$/.test(c));
console.log("inferred time field:", oaTimeField);

const { data: oa, count: oaCount } = await sb
  .from("order_attribution")
  .select("*", { count: "exact" })
  .eq("store_id", SHOP)
  .order(oaTimeField ?? oaCols[0], { ascending: false })
  .limit(50);
console.log("count:", oaCount, "rows fetched:", oa?.length);

// breakdown last 7d
const recent = (oa ?? []).filter((r) => new Date(r[oaTimeField]).getTime() >= startWeekUtc);
console.log(`7d rows (in latest 50): ${recent.length}`);
const byCh = {};
for (const a of recent) {
  byCh[a.channel] ??= { count: 0, capi: 0, fbclid: 0, vid: 0 };
  byCh[a.channel].count++;
  if (a.capi_sent_at) byCh[a.channel].capi++;
  if (a.fbclid) byCh[a.channel].fbclid++;
  if (a.visitor_id) byCh[a.channel].vid++;
}
console.log(`  ${pad("channel", 18)} ${pad("orders", 7)} ${pad("capi", 5)} ${pad("fbclid", 7)} visitor_id`);
for (const [k, v] of Object.entries(byCh)) {
  console.log(`  ${pad(k, 18)} ${pad(v.count, 7)} ${pad(v.capi, 5)} ${pad(v.fbclid, 7)} ${v.vid}`);
}

// today only
const todayRows = (oa ?? []).filter((r) => new Date(r[oaTimeField]).getTime() >= startTodayUtc);
console.log(`\nToday PKT rows (in latest 50): ${todayRows.length}`);
for (const a of todayRows.slice(0, 15)) {
  console.log(`  ${a[oaTimeField]} ${pad(a.channel, 16)} fbclid=${a.fbclid ? "y" : "n"} vid=${a.visitor_id ? "y" : "n"} capi_sent=${a.capi_sent_at ?? "—"}`);
}

// orders missing CAPI fire
const missing = (oa ?? []).filter((r) => !r.capi_sent_at);
console.log(`\n  Recent orders MISSING capi_sent_at: ${missing.length}`);
for (const m of missing.slice(0, 5)) {
  console.log(`    ${m[oaTimeField]} ${pad(m.channel, 16)} ${m.order_name ?? m.order_id}`);
}

// ── orders table ──
head("2. ORDERS — recent activity");
const { data: ordProbe } = await sb.from("orders").select("*").eq("store_id", SHOP).limit(1);
const ordCols = ordProbe?.[0] ? Object.keys(ordProbe[0]) : [];
console.log("columns:", ordCols.join(", "));

const ordTime = ordCols.includes("transaction_date") ? "transaction_date" : ordCols.find((c) => /date$/.test(c));
const { data: ord, count: ordCount } = await sb
  .from("orders")
  .select("order_ref_number, " + ordTime + ", transaction_status, is_delivered, is_returned, is_in_transit, invoice_payment", { count: "exact" })
  .eq("store_id", SHOP)
  .gte(ordTime, last24Iso)
  .order(ordTime, { ascending: false })
  .limit(20);
console.log(`  Last 24h count: ${ordCount}, fetched: ${ord?.length}`);
for (const o of ord ?? []) {
  const flag = o.is_delivered ? "DELIV" : o.is_returned ? "RET  " : o.is_in_transit ? "TRAN " : "?    ";
  console.log(`  ${o[ordTime]}  ref=${pad(o.order_ref_number, 8)} ${flag} pay=${o.invoice_payment} status=${o.transaction_status}`);
}

// today
const { data: ordToday, count: ordTodayCount } = await sb
  .from("orders")
  .select("*", { count: "exact", head: true })
  .eq("store_id", SHOP)
  .gte(ordTime, new Date(startTodayUtc).toISOString());
console.log(`  Today PKT (${today}) order count: ${ordTodayCount}`);

// ── EMQ ──
head("3. EMQ SNAPSHOTS");
const { data: emqProbe } = await sb.from("emq_snapshots").select("*").eq("store_id", SHOP).limit(1);
const emqCols = emqProbe?.[0] ? Object.keys(emqProbe[0]) : [];
console.log("columns:", emqCols.join(", "));
if (emqProbe?.[0]) console.log("sample:", JSON.stringify(emqProbe[0], null, 2));
const emqDate = emqCols.includes("snapshot_date") ? "snapshot_date" : emqCols.find((c) => /date$/.test(c)) ?? emqCols.find((c) => /at$/.test(c));
const { data: emq } = await sb
  .from("emq_snapshots")
  .select("*")
  .eq("store_id", SHOP)
  .order(emqDate ?? emqCols[0], { ascending: false })
  .limit(10);
console.log(`Latest 10 by ${emqDate}:`);
for (const e of emq ?? []) {
  console.log(`  ${e[emqDate]}  dataset=${e.dataset_id}  overall=${e.overall_emq ?? e.overall_score ?? "?"}`);
  if (e.event_scores) console.log(`    event_scores=${JSON.stringify(e.event_scores)}`);
}

// ── CAPI delivery log details ──
head("4. CAPI DELIVERY LOG — details");
const { data: capiProbe } = await sb.from("capi_delivery_log").select("*").eq("store_id", SHOP).limit(1);
const capiCols = capiProbe?.[0] ? Object.keys(capiProbe[0]) : [];
console.log("columns:", capiCols.join(", "));

const { data: log24 } = await sb
  .from("capi_delivery_log")
  .select("event_name, status, http_status, sent_at, event_id, error_msg")
  .eq("store_id", SHOP)
  .gte("sent_at", last24Iso)
  .order("sent_at", { ascending: false });
console.log(`\nLast 24h: ${log24?.length ?? 0} rows`);
const dist24 = {};
for (const r of log24 ?? []) {
  dist24[r.event_name] ??= { sent: 0, failed: 0, distinct: new Set() };
  if (r.status === "sent") dist24[r.event_name].sent++;
  else dist24[r.event_name].failed++;
  dist24[r.event_name].distinct.add(r.event_id);
}
for (const [k, v] of Object.entries(dist24)) {
  console.log(`  ${pad(k, 20)} sent=${v.sent} failed=${v.failed} distinct=${v.distinct.size}`);
}

// Purchase rows specifically (last 7d if window has them)
const { data: purchAll } = await sb
  .from("capi_delivery_log")
  .select("event_id, status, http_status, sent_at, error_msg")
  .eq("store_id", SHOP)
  .eq("event_name", "Purchase")
  .order("sent_at", { ascending: false })
  .limit(50);
console.log(`\nPurchase events (in 500-cap window): ${purchAll?.length}`);
for (const r of purchAll ?? []) {
  console.log(`  ${r.sent_at}  ${pad(r.status, 7)} http=${r.http_status ?? "?"} ${r.event_id}`);
}

// Failures across all events
const { data: failAll } = await sb
  .from("capi_delivery_log")
  .select("event_name, status, http_status, error_msg, sent_at")
  .eq("store_id", SHOP)
  .neq("status", "sent")
  .order("sent_at", { ascending: false })
  .limit(20);
console.log(`\nNon-sent rows in window: ${failAll?.length}`);
for (const r of failAll ?? []) {
  console.log(`  ${r.sent_at} ${pad(r.event_name, 18)} ${r.status} http=${r.http_status ?? "?"} ${(r.error_msg ?? "").slice(0,100)}`);
}

// ── Visitor events ──
head("5. VISITOR EVENTS — last 24h");
const { data: veProbe } = await sb.from("visitor_events").select("*").eq("store_id", SHOP).limit(1);
const veCols = veProbe?.[0] ? Object.keys(veProbe[0]) : [];
console.log("columns:", veCols.join(", "));
const veTime = veCols.includes("created_at") ? "created_at" : veCols.find((c) => /at$/.test(c));
console.log("time field:", veTime);

const { data: ve } = await sb
  .from("visitor_events")
  .select("event_name, " + veTime)
  .eq("store_id", SHOP)
  .gte(veTime, last24Iso);
console.log(`Last 24h count: ${ve?.length}`);
const veDist = {};
for (const r of ve ?? []) veDist[r.event_name] = (veDist[r.event_name] ?? 0) + 1;
for (const [k, v] of Object.entries(veDist)) console.log(`  ${pad(k, 22)} ${v}`);

// ── Visitor identity coverage ──
head("6. VISITOR IDENTITY COVERAGE — last 7d");
const { data: visitors, count: vCount } = await sb
  .from("visitors")
  .select("visitor_id, em_hash, ph_hash, fn_hash, ln_hash, ct_hash, latest_fbp, latest_fbc, fbc_history, utm_history, last_seen_at", { count: "exact" })
  .eq("store_id", SHOP)
  .gte("last_seen_at", new Date(startWeekUtc).toISOString())
  .limit(5000);
console.log(`Total visitors active in 7d: ${vCount}, fetched: ${visitors?.length}`);
let em=0, ph=0, fn=0, ln=0, ct=0, fbp=0, fbc=0, fbcH=0, utmH=0;
for (const r of visitors ?? []) {
  if (r.em_hash) em++;
  if (r.ph_hash) ph++;
  if (r.fn_hash) fn++;
  if (r.ln_hash) ln++;
  if (r.ct_hash) ct++;
  if (r.latest_fbp) fbp++;
  if (r.latest_fbc) fbc++;
  if (r.fbc_history?.length) fbcH++;
  if (r.utm_history?.length) utmH++;
}
const n = visitors?.length ?? 0;
const p = (x) => n ? `${((x/n)*100).toFixed(0)}%` : "—";
console.log(`  em_hash      ${em}/${n} (${p(em)})  -- email captured`);
console.log(`  ph_hash      ${ph}/${n} (${p(ph)})  -- phone captured`);
console.log(`  fn_hash      ${fn}/${n} (${p(fn)})  -- first name`);
console.log(`  ln_hash      ${ln}/${n} (${p(ln)})  -- last name`);
console.log(`  ct_hash      ${ct}/${n} (${p(ct)})  -- city`);
console.log(`  latest_fbp   ${fbp}/${n} (${p(fbp)}) -- _fbp cookie`);
console.log(`  latest_fbc   ${fbc}/${n} (${p(fbc)}) -- click ID`);
console.log(`  fbc_history  ${fbcH}/${n} (${p(fbcH)}) -- multi-click history`);
console.log(`  utm_history  ${utmH}/${n} (${p(utmH)})`);
