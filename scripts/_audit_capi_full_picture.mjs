// READ-ONLY full-picture audit of Purchase tracking → Meta CAPI for the
// the-trendy-homes-pk store ("New Trendy" pixel 179347178505127).
//
// Three independent sources, cross-checked:
//   A. order_attribution.capi_sent_at — DURABLE per-order "confirmed sent"
//      flag (survives the 500-row capi_delivery_log trim).
//   B. capi_delivery_log — delivery status/http/emq within retained window.
//   C. Live Shopify Admin orders — ground truth for "did EVERY order fire".
// No writes. No speculation — every number is a query result.

import pg from "pg";
import fs from "node:fs";

for (const l of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const SHOP = "the-trendy-homes-pk.myshopify.com";
const PKT = 5 * 3600 * 1000;
const now = Date.now();
const pktTodayStr = new Date(now + PKT).toISOString().slice(0, 10);
const todayStartMs = new Date(`${pktTodayStr}T00:00:00Z`).getTime() - PKT;
const ydayStartMs = todayStartMs - 86400000;
const d30 = new Date(now - 30 * 86400000).toISOString();

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const q = (s, p = []) => c.query(s, p).then((r) => r.rows);
const line = (s = "") => console.log(s);
const hr = (t) => line(`\n${"─".repeat(70)}\n${t}\n${"─".repeat(70)}`);

line(`Audit @ ${new Date().toISOString()}  (PKT today = ${pktTodayStr})`);

// ─── A. Connection ───────────────────────────────────────────────────────────
hr("1. CONNECTION STATE  (meta_pixel_connections)");
const [conn] = await q(
  `select status,status_reason,dataset_id,dataset_name,connected_at,
          last_event_sent_at,last_health_check
   from meta_pixel_connections where store_id=$1`,
  [SHOP]
);
line(JSON.stringify(conn, null, 2));

// ─── B. capi_delivery_log ────────────────────────────────────────────────────
hr("2. capi_delivery_log  (NOTE: per-shop 500-row trim — old rows evicted)");
const [logSpan] = await q(
  `select count(*) n, min(sent_at) oldest, max(sent_at) newest
   from capi_delivery_log where store_id=$1`,
  [SHOP]
);
line(`retained rows: ${logSpan.n}  | window: ${logSpan.oldest} → ${logSpan.newest}`);

const evMix = await q(
  `select event_name,status,http_status,count(*) n
   from capi_delivery_log where store_id=$1
   group by 1,2,3 order by 1,2,3`,
  [SHOP]
);
line("\nevent_name / status / http_status : count");
for (const r of evMix)
  line(`  ${r.event_name} / ${r.status} / ${r.http_status ?? "-"} : ${r.n}`);

const badP = await q(
  `select sent_at,status,http_status,error_msg,event_id
   from capi_delivery_log
   where store_id=$1 and event_name='Purchase' and status<>'sent'
   order by sent_at desc`,
  [SHOP]
);
line(`\nNon-'sent' Purchase rows in retained window: ${badP.length}`);
for (const r of badP)
  line(`  ${r.sent_at} ${r.status} http=${r.http_status} "${r.error_msg}" id=${r.event_id}`);

const pById = await q(
  `select to_char(sent_at AT TIME ZONE 'UTC' + interval '5 hours','YYYY-MM-DD') d,
          count(*) sent
   from capi_delivery_log
   where store_id=$1 and event_name='Purchase' and status='sent' and sent_at>=$2
   group by 1 order by 1`,
  [SHOP, d30]
);
line("\nPurchase 'sent' log rows per PKT day (retained window only):");
for (const r of pById) line(`  ${r.d}: ${r.sent}`);

const emqStat = await q(
  `select count(emq) n, round(avg(emq),2) avg, min(emq) mn, max(emq) mx
   from capi_delivery_log
   where store_id=$1 and event_name='Purchase' and status='sent' and emq is not null`,
  [SHOP]
);
line(`\nPer-event emq on sent Purchases (Meta-returned, retained): ${JSON.stringify(emqStat[0])}`);

// ─── C. capi_retries backlog ─────────────────────────────────────────────────
hr("3. capi_retries  (stuck / pending re-send queue — should be ~0)");
const retr = await q(
  `select event_name,count(*) n,min(next_attempt_at) next_due,
          max(attempts) max_attempts,min(created_at) oldest
   from capi_retries where store_id=$1 group by 1`,
  [SHOP]
);
if (!retr.length) line("EMPTY — no stuck or pending events. ✓");
else for (const r of retr) line(`  ${JSON.stringify(r)}`);

// ─── D. order_attribution — the durable per-order signal ─────────────────────
hr("4. order_attribution  (DURABLE: capi_sent_at = confirmed delivered)");
const attrDay = await q(
  `select to_char(attributed_at AT TIME ZONE 'UTC' + interval '5 hours','YYYY-MM-DD') d,
          count(*) orders,
          count(capi_sent_at) sent,
          count(*) - count(capi_sent_at) unsent
   from order_attribution
   where store_id=$1 and attributed_at>=$2
   group by 1 order by 1`,
  [SHOP, d30]
);
line("PKT day : orders | confirmed-sent | UNSENT(capi_sent_at NULL)");
let tOrd = 0, tSent = 0, tUns = 0;
for (const r of attrDay) {
  tOrd += +r.orders; tSent += +r.sent; tUns += +r.unsent;
  line(`  ${r.d}: ${r.orders} | ${r.sent} | ${r.unsent}${+r.unsent ? "  ⚠" : ""}`);
}
line(`  ── 30d TOTAL: ${tOrd} orders | ${tSent} sent | ${tUns} unsent`);

const unsent = await q(
  `select shopify_order_id,channel,attributed_at,visitor_id
   from order_attribution
   where store_id=$1 and capi_sent_at is null and attributed_at>=$2
   order by attributed_at desc`,
  [SHOP, d30]
);
line(`\nOrders with capi_sent_at NULL (true pending/missed): ${unsent.length}`);
for (const r of unsent) {
  const ageH = ((now - new Date(r.attributed_at).getTime()) / 3600000).toFixed(1);
  line(`  order ${r.shopify_order_id} ch=${r.channel} at=${r.attributed_at} age=${ageH}h visitor=${r.visitor_id ?? "-"}`);
}

// ─── E. Today / Yesterday PKT reconcile vs the dashboard screenshot ──────────
hr("5. TODAY & YESTERDAY (PKT) — reconcile with dashboard");
for (const [lbl, lo, hi] of [
  ["TODAY", todayStartMs, now + 1],
  ["YESTERDAY", ydayStartMs, todayStartMs],
]) {
  const ch = await q(
    `select channel,count(*) n,count(capi_sent_at) sent
     from order_attribution
     where store_id=$1 and attributed_at>=$2 and attributed_at<$3
     group by 1 order by 1`,
    [SHOP, new Date(lo).toISOString(), new Date(hi).toISOString()]
  );
  const tot = ch.reduce((a, r) => a + +r.n, 0);
  const sn = ch.reduce((a, r) => a + +r.sent, 0);
  line(`${lbl}: ${tot} orders, ${sn} confirmed-sent`);
  for (const r of ch) line(`   ${r.channel}: ${r.n} (sent ${r.sent})`);
}

// ─── F. Dedup integrity ──────────────────────────────────────────────────────
hr("6. DEDUP INTEGRITY  (one logical Purchase per order)");
const dup = await q(
  `with p as (
     select event_id,
            case when event_id like 'purchase:%' then split_part(event_id,':',3) else null end oid
     from capi_delivery_log
     where store_id=$1 and event_name='Purchase' and status='sent'
   )
   select count(*) sent_rows,
          count(distinct event_id) distinct_event_ids,
          count(*) filter (where oid is null) non_deterministic_ids
   from p`,
  [SHOP]
);
line(`sent Purchase rows=${dup[0].sent_rows} distinct event_ids=${dup[0].distinct_event_ids} non-deterministic(pixel-stamped) ids=${dup[0].non_deterministic_ids}`);
const dupOrder = await q(
  `select split_part(event_id,':',3) oid, count(distinct event_id) ids
   from capi_delivery_log
   where store_id=$1 and event_name='Purchase' and status='sent' and event_id like 'purchase:%'
   group by 1 having count(distinct event_id)>1`,
  [SHOP]
);
line(`Orders with >1 distinct deterministic sent event_id (double-fire): ${dupOrder.length}`);
for (const r of dupOrder) line(`  ⚠ order ${r.oid}: ${r.ids} ids`);

// ─── G. emq_snapshots (local proxy — NOT Meta's real EMQ) ────────────────────
hr("7. emq_snapshots  (LOCAL weighted proxy, not Meta's score)");
const emq = await q(
  `select to_char(captured_at,'YYYY-MM-DD HH24:MI') t,overall_emq,per_event
   from emq_snapshots where store_id=$1 order by captured_at desc limit 6`,
  [SHOP]
);
for (const e of emq) line(`  ${e.t} overall=${e.overall_emq} ${JSON.stringify(e.per_event)}`);

await c.end();

// ─── H. LIVE SHOPIFY GROUND TRUTH ────────────────────────────────────────────
// The only source that can reveal an order with NO attribution row at all
// (worst silent miss). Pull last 14 days, cross-check each against the DB.
hr("8. LIVE SHOPIFY GROUND TRUTH (last 14 days) — definitive miss check");
const c2 = new pg.Client({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c2.connect();
const [{ accesstoken: token }] = await c2
  .query(
    `select "accessToken" accesstoken from shopify_sessions
     where shop=$1 and "isOnline"=false limit 1`,
    [SHOP]
  )
  .then((r) => r.rows);
if (!token) {
  line("No offline Shopify session token — cannot run ground-truth check.");
  await c2.end();
  process.exit(0);
}
const sinceIso = new Date(now - 14 * 86400000).toISOString();
let url =
  `https://${SHOP}/admin/api/2025-01/orders.json?` +
  new URLSearchParams({ status: "any", created_at_min: sinceIso, limit: "250" });
const orders = [];
while (url) {
  const r = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
  if (!r.ok) {
    line(`Shopify ${r.status}: ${(await r.text()).slice(0, 200)}`);
    break;
  }
  const j = await r.json();
  orders.push(...(j.orders ?? []));
  const link = r.headers.get("link") || "";
  const m = link.match(/<([^>]+)>;\s*rel="next"/);
  url = m ? m[1] : null;
}
line(`Shopify orders created in last 14d: ${orders.length}`);

const ids = orders.map((o) => String(o.id));
const detIds = ids.map((i) => `purchase:${SHOP}:${i}`);
const attrRows = await c2
  .query(
    `select shopify_order_id,capi_sent_at from order_attribution
     where store_id=$1 and shopify_order_id = any($2)`,
    [SHOP, ids]
  )
  .then((r) => r.rows);
const attrMap = new Map(attrRows.map((r) => [r.shopify_order_id, r.capi_sent_at]));
const logSent = await c2
  .query(
    `select distinct event_id from capi_delivery_log
     where store_id=$1 and event_name='Purchase' and status='sent'
       and event_id = any($2)`,
    [SHOP, detIds]
  )
  .then((r) => r.rows.map((x) => x.event_id));
const logSentSet = new Set(logSent);

let confirmed = 0, attrOnly = 0, logOnly = 0, noTrace = 0;
const misses = [];
for (const o of orders) {
  const id = String(o.id);
  const hasAttrSent = attrMap.has(id) && attrMap.get(id) != null;
  const hasAttrRow = attrMap.has(id);
  const hasLog = logSentSet.has(`purchase:${SHOP}:${id}`);
  if (hasAttrSent || hasLog) confirmed++;
  else if (hasAttrRow) {
    attrOnly++;
    misses.push({ id, name: o.name, created: o.created_at, fin: o.financial_status, why: "attr row but capi_sent_at NULL & no sent log" });
  } else {
    noTrace++;
    misses.push({ id, name: o.name, created: o.created_at, fin: o.financial_status, why: "NO attribution row & NO sent log — full silent miss" });
  }
}
line(`\nConfirmed delivered to Meta : ${confirmed}/${orders.length}`);
line(`Pending/unconfirmed         : ${attrOnly}`);
line(`Full silent miss (no trace) : ${noTrace}`);
if (misses.length) {
  line("\nUNCONFIRMED ORDERS:");
  for (const m of misses)
    line(`  #${m.name} (id ${m.id}) ${m.created} financial=${m.fin} — ${m.why}`);
} else {
  line("\n✓ Every Shopify order in the last 14 days is confirmed delivered to Meta.");
}
await c2.end();
