// Meta's REAL server-side view (dataset /stats via BISU) + Meta Ads
// Manager's attributed Purchases/ROAS (ads insights via ads_read token)
// + the app's own ad_spend-vs-revenue ROAS timeline. Pins down whether a
// ROAS drop is tracking-caused or sales/spend/delivery-lag-caused.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { decryptSecret } from "../app/lib/crypto.server.js";
try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
await sb.rpc("set_app_store", { store: SHOP });
const head = (s) => console.log("\n" + "=".repeat(80) + "\n " + s + "\n" + "=".repeat(80));
const fmt = (n) => Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pad = (s, n) => String(s ?? "").padEnd(n);
const G = "https://graph.facebook.com/v24.0";

const { data: conn } = await sb.from("meta_pixel_connections").select("dataset_id,bisu_token").eq("store_id", SHOP).single();
const { data: store } = await sb.from("stores").select("meta_access_token,meta_ad_account_id,meta_ad_account_currency,currency").eq("store_id", SHOP).single();
const datasetId = conn.dataset_id;
const bisu = decryptSecret(conn.bisu_token);
const adsToken = store.meta_access_token;
const adAccount = store.meta_ad_account_id;

// ── 1. Meta's real server-side received-events view (dataset /stats) ──────
head("META DATASET /stats — what Meta ACTUALLY received (BISU view)");
const nowS = Math.floor(Date.now() / 1000);
const tryGet = async (path, params = {}) => {
  const u = new URL(G + path);
  u.searchParams.set("access_token", bisu);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, b };
};
for (const r of [{ n: "last 48h", s: nowS - 2 * 86400 }, { n: "last 7d", s: nowS - 7 * 86400 }]) {
  for (const agg of ["event", "event_source"]) {
    const o = await tryGet(`/${datasetId}/stats`, { aggregation: agg, start_time: r.s, end_time: nowS });
    console.log(`\n[stats agg=${agg} ${r.n}] http=${o.status}`);
    if (o.b?.data) console.log(JSON.stringify(o.b.data, null, 1));
    else console.log(JSON.stringify(o.b, null, 1));
  }
}

// ── 2. Meta Ads Manager attributed Purchases + ROAS, day by day ──────────
head("META ADS INSIGHTS — attributed purchases & purchase_roas (the number in Ads Manager)");
const since = new Date(Date.now() - 24 * 86400000).toISOString().slice(0, 10);
const until = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
const insParams = new URLSearchParams({
  level: "account",
  time_range: JSON.stringify({ since, until }),
  time_increment: "1",
  fields: "spend,purchase_roas,action_values,actions,impressions,clicks",
  access_token: adsToken,
});
const insRes = await fetch(`${G}/${adAccount}/insights?${insParams}`);
const insJson = await insRes.json().catch(() => ({}));
if (!insRes.ok) console.log("ads insights http", insRes.status, JSON.stringify(insJson));
const byDayMeta = {};
const pick = (arr, type) => Number((arr ?? []).find((a) => a.action_type === type)?.value ?? 0);
for (const row of insJson.data ?? []) {
  const d = row.date_start;
  const spend = Number(row.spend ?? 0);
  const roas = Number((row.purchase_roas ?? []).find(() => true)?.value ?? 0);
  const pVal = pick(row.action_values, "offsite_conversion.fb_pixel_purchase") || pick(row.action_values, "purchase") || pick(row.action_values, "omni_purchase");
  const pCnt = pick(row.actions, "offsite_conversion.fb_pixel_purchase") || pick(row.actions, "purchase") || pick(row.actions, "omni_purchase");
  byDayMeta[d] = { spend, roas, pVal, pCnt, clicks: Number(row.clicks ?? 0), impr: Number(row.impressions ?? 0) };
}

// ── 3. App-side ad_spend + orders revenue (PostEx) + Shopify gross ───────
const sinceIso = new Date(Date.now() - 24 * 86400000).toISOString();
const { data: spendRows } = await sb.from("ad_spend").select("spend_date,amount").eq("store_id", SHOP).gte("spend_date", since).order("spend_date");
const spendByDay = Object.fromEntries((spendRows ?? []).map((r) => [r.spend_date, Number(r.amount) || 0]));
const { data: ords } = await sb.from("orders").select("order_date,transaction_date,is_delivered,is_returned,is_in_transit,invoice_payment").eq("store_id", SHOP).gte("transaction_date", sinceIso);
const pktDate = (iso) => new Date(new Date(iso).getTime() + 5 * 3600000).toISOString().slice(0, 10);
const ordByDay = {};
for (const o of ords ?? []) {
  const d = pktDate(o.order_date ?? o.transaction_date);
  ordByDay[d] ??= { n: 0, deliv: 0, ret: 0, transit: 0, delivRev: 0, potRev: 0 };
  const v = Number(o.invoice_payment) || 0;
  ordByDay[d].n++; ordByDay[d].potRev += v;
  if (o.is_delivered) { ordByDay[d].deliv++; ordByDay[d].delivRev += v; }
  else if (o.is_returned) ordByDay[d].ret++;
  else if (o.is_in_transit) ordByDay[d].transit++;
}

// Shopify gross by day (ground truth for orders placed, independent of COD delivery)
const { data: sess } = await sb.from("shopify_sessions").select("accessToken").eq("shop", SHOP).eq("isOnline", false).limit(1);
const stoken = sess?.[0]?.accessToken;
const fetchAll = async (url) => { const all = []; while (url) { const r = await fetch(url, { headers: { "X-Shopify-Access-Token": stoken } }); if (!r.ok) break; const b = await r.json(); all.push(...(b.orders ?? [])); const m = (r.headers.get("link") ?? "").match(/<([^>]+)>;\s*rel="next"/); url = m ? m[1] : null; } return all; };
const shopOrders = await fetchAll(`https://${SHOP}/admin/api/2025-10/orders.json?` + new URLSearchParams({ created_at_min: sinceIso, status: "any", limit: "250", fields: "id,created_at,total_price,cancelled_at" }));
const shopByDay = {};
for (const o of shopOrders) { const d = pktDate(o.created_at); shopByDay[d] ??= { n: 0, gross: 0, canc: 0 }; shopByDay[d].n++; shopByDay[d].gross += Number(o.total_price) || 0; if (o.cancelled_at) shopByDay[d].canc++; }

head("DAILY: spend vs Shopify-placed orders vs PostEx-delivered vs Meta-attributed");
console.log(`${pad("date", 11)} ${pad("ad_spend", 10)} ${pad("shop_ord", 9)} ${pad("shop_gross", 11)} ${pad("px_deliv", 9)} ${pad("px_delivRev", 12)} ${pad("ROAS_shop", 10)} ${pad("Meta_ROAS", 10)} ${pad("Meta_pur", 9)} Meta_purVal`);
const days = [...new Set([...Object.keys(spendByDay), ...Object.keys(ordByDay), ...Object.keys(shopByDay), ...Object.keys(byDayMeta)])].sort();
for (const d of days) {
  const sp = spendByDay[d] ?? 0;
  const so = shopByDay[d] ?? { n: 0, gross: 0, canc: 0 };
  const po = ordByDay[d] ?? { deliv: 0, delivRev: 0 };
  const m = byDayMeta[d] ?? { roas: 0, pVal: 0, pCnt: 0 };
  const rShop = sp ? (so.gross / sp).toFixed(2) : "—";
  console.log(`${pad(d, 11)} ${pad(fmt(sp), 10)} ${pad(so.n + (so.canc ? `(${so.canc}c)` : ""), 9)} ${pad(fmt(so.gross), 11)} ${pad(po.deliv, 9)} ${pad(fmt(po.delivRev), 12)} ${pad(rShop, 10)} ${pad(m.roas ? m.roas.toFixed(2) : "—", 10)} ${pad(m.pCnt || "—", 9)} ${fmt(m.pVal)}`);
}

const sumRange = (from, to) => {
  let sp = 0, sg = 0, sn = 0, mp = 0, mv = 0, mspend = 0;
  for (const d of days) { if (d < from || d > to) continue; sp += spendByDay[d] ?? 0; const so = shopByDay[d] ?? {}; sg += so.gross ?? 0; sn += so.n ?? 0; const m = byDayMeta[d] ?? {}; mp += m.pCnt ?? 0; mv += m.pVal ?? 0; mspend += m.spend ?? 0; }
  return { sp, sg, sn, mp, mv, mspend };
};
head("WINDOW ROLLUPS (Shopify-placed = orders placed that day, delivery-lag-free)");
for (const b of [
  { n: "Past 2 days  (May 16–17)", f: "2026-05-16", t: "2026-05-17" },
  { n: "Prior 2 days (May 14–15)", f: "2026-05-14", t: "2026-05-15" },
  { n: "Post-shift   (May 09–17)", f: "2026-05-09", t: "2026-05-17" },
  { n: "Pre-shift    (Apr 30–May 08)", f: "2026-04-30", t: "2026-05-08" },
]) {
  const s = sumRange(b.f, b.t);
  const rShop = s.sp ? (s.sg / s.sp).toFixed(2) : "—";
  const rMeta = s.mspend ? (s.mv / s.mspend).toFixed(2) : "—";
  console.log(`${pad(b.n, 28)} spend=${pad(fmt(s.sp), 9)} shop_ord=${pad(s.sn, 4)} shop_gross=${pad(fmt(s.sg), 9)} ROAS_shop=${pad(rShop, 6)}  |  Meta: spend=${pad(fmt(s.mspend), 9)} pur=${pad(s.mp, 4)} purVal=${pad(fmt(s.mv), 9)} ROAS_meta=${rMeta}`);
}
console.log(`\nNote: ad account currency=${store.meta_ad_account_currency}, store currency=${store.currency}. ad_spend table is FX-converted at ingest; Meta insights spend is raw account currency.`);
