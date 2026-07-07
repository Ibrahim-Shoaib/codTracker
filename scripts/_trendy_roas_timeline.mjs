// Daily ROAS — ad_spend vs delivered-order revenue, last 30 days, plus
// Shopify-side daily revenue cross-check (Shopify Admin API for last 14d).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
await sb.rpc("set_app_store", { store: SHOP });
const head = (s) => console.log("\n" + "═".repeat(80) + "\n " + s + "\n" + "═".repeat(80));
const pad = (s, n) => String(s ?? "").padEnd(n);
const fmt = (n) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

// 30-day window
const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

// Ad spend by day
const { data: spend } = await sb
  .from("ad_spend")
  .select("spend_date, amount")
  .eq("store_id", SHOP)
  .gte("spend_date", since30)
  .order("spend_date", { ascending: true });
const spendByDay = Object.fromEntries((spend ?? []).map((r) => [r.spend_date, Number(r.amount) || 0]));

// Orders by transaction_date — delivered/booked/etc, with invoice_payment
// We want ATTRIBUTED revenue per day (date the order was placed on Shopify
// = order_date if available, else transaction_date)
const { data: orders } = await sb
  .from("orders")
  .select("order_ref_number, transaction_date, order_date, transaction_status, is_delivered, is_returned, is_in_transit, invoice_payment")
  .eq("store_id", SHOP)
  .gte("transaction_date", new Date(Date.now() - 30 * 86400000).toISOString())
  .order("transaction_date", { ascending: true });

// Bucket by PKT date of (order_date || transaction_date)
const pktDate = (iso) => {
  const t = new Date(iso).getTime() + 5 * 3600000;
  return new Date(t).toISOString().slice(0, 10);
};
const dailyRev = {}; // { date: { delivered_rev, booked_count, delivered_count, returned_count, total_count, total_potential_rev } }
for (const o of orders ?? []) {
  const dt = o.order_date ?? o.transaction_date;
  const d = pktDate(dt);
  dailyRev[d] ??= { delivered_rev: 0, total_potential_rev: 0, delivered: 0, returned: 0, in_transit: 0, total: 0 };
  const v = Number(o.invoice_payment) || 0;
  dailyRev[d].total++;
  dailyRev[d].total_potential_rev += v;
  if (o.is_delivered) {
    dailyRev[d].delivered_rev += v;
    dailyRev[d].delivered++;
  } else if (o.is_returned) dailyRev[d].returned++;
  else if (o.is_in_transit) dailyRev[d].in_transit++;
}

head("Daily ROAS table (last 30d) — uses PostEx orders");
console.log(`${pad("date", 12)} ${pad("ad_spend", 11)} ${pad("orders", 7)} ${pad("delivered", 10)} ${pad("returned", 9)} ${pad("transit", 8)} ${pad("delivered_rev", 14)} ${pad("potential_rev", 14)} ${pad("ROAS_deliv", 11)} ROAS_pot`);
const allDays = new Set([...Object.keys(spendByDay), ...Object.keys(dailyRev)]);
const sortedDays = [...allDays].sort();
let weekSpend = 0, weekRev = 0;
for (const d of sortedDays) {
  const s = spendByDay[d] ?? 0;
  const r = dailyRev[d] ?? { delivered_rev: 0, total_potential_rev: 0, delivered: 0, returned: 0, in_transit: 0, total: 0 };
  const roasD = s ? (r.delivered_rev / s).toFixed(2) : "—";
  const roasP = s ? (r.total_potential_rev / s).toFixed(2) : "—";
  console.log(`${pad(d, 12)} ${pad(fmt(s), 11)} ${pad(r.total, 7)} ${pad(r.delivered, 10)} ${pad(r.returned, 9)} ${pad(r.in_transit, 8)} ${pad(fmt(r.delivered_rev), 14)} ${pad(fmt(r.total_potential_rev), 14)} ${pad(roasD, 11)} ${roasP}`);
}

// Roll up to 7-day windows
head("7-day window comparison (potential ROAS = total_revenue / spend; delivered may be biased low for recent days because deliveries lag)");
const today = new Date().toISOString().slice(0, 10);
const buckets = [
  { name: "Last 7d (May 09→May 15)", from: "2026-05-09", to: "2026-05-15" },
  { name: "Prior 7d (May 02→May 08)", from: "2026-05-02", to: "2026-05-08" },
  { name: "14d ago (Apr 25→May 01)", from: "2026-04-25", to: "2026-05-01" },
  { name: "21d ago (Apr 18→Apr 24)", from: "2026-04-18", to: "2026-04-24" },
];
for (const b of buckets) {
  let s = 0, dr = 0, pr = 0, deliv = 0, ret = 0, total = 0;
  for (const d of sortedDays) {
    if (d < b.from || d > b.to) continue;
    s += spendByDay[d] ?? 0;
    const r = dailyRev[d] ?? {};
    dr += r.delivered_rev ?? 0;
    pr += r.total_potential_rev ?? 0;
    deliv += r.delivered ?? 0;
    ret += r.returned ?? 0;
    total += r.total ?? 0;
  }
  const roasD = s ? (dr / s).toFixed(2) : "—";
  const roasP = s ? (pr / s).toFixed(2) : "—";
  console.log(`  ${pad(b.name, 30)} spend=${pad(fmt(s), 9)} orders=${pad(total, 4)} deliv=${pad(deliv, 4)} ret=${pad(ret, 4)} deliv_rev=${pad(fmt(dr), 9)} pot_rev=${pad(fmt(pr), 9)} ROAS_deliv=${pad(roasD, 6)} ROAS_pot=${roasP}`);
}

// Pull Shopify-side gross revenue for the past 14d to ground-truth
head("Shopify Admin API ground truth (last 14d, gross order value)");
const { data: sess } = await sb.from("shopify_sessions").select("accessToken").eq("shop", SHOP).eq("isOnline", false);
const token = sess?.[0]?.accessToken;
const since14 = new Date(Date.now() - 14 * 86400000).toISOString();

const fetchAll = async (url) => {
  const all = [];
  while (url) {
    const r = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    if (!r.ok) throw new Error(`Shopify ${r.status}`);
    const body = await r.json();
    all.push(...(body.orders ?? []));
    const link = r.headers.get("link") ?? "";
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return all;
};

const shopOrders = await fetchAll(
  `https://${SHOP}/admin/api/2025-10/orders.json?` +
  new URLSearchParams({ created_at_min: since14, status: "any", limit: "250", fields: "id,created_at,total_price,cancelled_at,financial_status" })
);

const shopByDay = {};
for (const o of shopOrders) {
  const d = pktDate(o.created_at);
  shopByDay[d] ??= { count: 0, gross: 0, cancelled: 0 };
  shopByDay[d].count++;
  shopByDay[d].gross += Number(o.total_price) || 0;
  if (o.cancelled_at) shopByDay[d].cancelled++;
}

console.log(`${pad("date", 12)} ${pad("ad_spend", 11)} ${pad("shop_orders", 12)} ${pad("cancelled", 10)} ${pad("shop_gross", 12)} ROAS_shop`);
const shopDays = [...new Set([...Object.keys(spendByDay), ...Object.keys(shopByDay)])].sort();
let totalSpend14 = 0, totalGross14 = 0;
for (const d of shopDays) {
  if (d < since14.slice(0, 10)) continue;
  const s = spendByDay[d] ?? 0;
  const r = shopByDay[d] ?? { count: 0, gross: 0, cancelled: 0 };
  totalSpend14 += s;
  totalGross14 += r.gross;
  const roas = s ? (r.gross / s).toFixed(2) : "—";
  console.log(`${pad(d, 12)} ${pad(fmt(s), 11)} ${pad(r.count, 12)} ${pad(r.cancelled, 10)} ${pad(fmt(r.gross), 12)} ${roas}`);
}
console.log(`\n14d totals: spend=${fmt(totalSpend14)} PKR, shop_gross=${fmt(totalGross14)} PKR, ROAS=${(totalGross14/totalSpend14).toFixed(2)}x`);

// Pre-pixel-install vs post-pixel-install comparison
const PIXEL_INSTALL = "2026-05-09";
let preSpend = 0, postSpend = 0, preGross = 0, postGross = 0, preOrd = 0, postOrd = 0;
for (const d of shopDays) {
  if (d < since14.slice(0, 10)) continue;
  const s = spendByDay[d] ?? 0;
  const r = shopByDay[d] ?? { count: 0, gross: 0 };
  if (d < PIXEL_INSTALL) {
    preSpend += s; preGross += r.gross; preOrd += r.count;
  } else {
    postSpend += s; postGross += r.gross; postOrd += r.count;
  }
}
console.log(`\nPRE-pixel-install (last 14d up to May 8):`);
console.log(`  spend=${fmt(preSpend)} gross=${fmt(preGross)} orders=${preOrd} ROAS=${preSpend ? (preGross/preSpend).toFixed(2) + "x" : "—"}`);
console.log(`POST-pixel-install (May 9 onward):`);
console.log(`  spend=${fmt(postSpend)} gross=${fmt(postGross)} orders=${postOrd} ROAS=${postSpend ? (postGross/postSpend).toFixed(2) + "x" : "—"}`);
