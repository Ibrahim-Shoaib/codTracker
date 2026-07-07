// Is the REAL (delivery-lag-free) performance drop caused by the app?
// 50-day daily: Shopify-placed gross + ad_spend + full Meta delivery funnel
// (impressions/reach/freq/link-clicks/CTR/CPC/CPM/purchases/cost-per-purchase).
// Plus a CAPI signal-gap trace for every order around the 2026-05-09 switch.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { decryptSecret } from "../app/lib/crypto.server.js";
try { for (const l of readFileSync(".env","utf8").split(/\r?\n/)){const m=l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2];} } catch {}

const SHOP="the-trendy-homes-pk.myshopify.com";
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
await sb.rpc("set_app_store",{store:SHOP});
const G="https://graph.facebook.com/v24.0";
const pad=(s,n)=>String(s??"").padEnd(n);
const fmt=(n)=>Number(n??0).toLocaleString("en-US",{maximumFractionDigits:0});
const pktDate=(iso)=>new Date(new Date(iso).getTime()+5*3600000).toISOString().slice(0,10);
const head=(s)=>console.log("\n"+"=".repeat(94)+"\n "+s+"\n"+"=".repeat(94));

const { data: store } = await sb.from("stores").select("meta_access_token,meta_ad_account_id").eq("store_id",SHOP).single();
const adAccount=store.meta_ad_account_id, adsToken=store.meta_access_token;

const since=new Date(Date.now()-50*86400000).toISOString().slice(0,10);
const until=new Date(Date.now()+5*3600000).toISOString().slice(0,10);
const sinceIso=new Date(Date.now()-50*86400000).toISOString();

// Meta daily funnel
const params=new URLSearchParams({
  level:"account", time_range:JSON.stringify({since,until}), time_increment:"1",
  fields:"spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,actions,action_values,cost_per_action_type,purchase_roas",
  access_token:adsToken,
});
const r=await fetch(`${G}/${adAccount}/insights?${params}`);
const j=await r.json().catch(()=>({}));
if(!r.ok) console.log("insights http",r.status,JSON.stringify(j).slice(0,300));
const pick=(arr,t)=>Number((arr??[]).find(a=>a.action_type===t)?.value??0);
const meta={};
for(const row of j.data??[]){
  const d=row.date_start;
  const pur=pick(row.actions,"offsite_conversion.fb_pixel_purchase")||pick(row.actions,"purchase")||pick(row.actions,"omni_purchase");
  meta[d]={spend:+row.spend||0,impr:+row.impressions||0,reach:+row.reach||0,freq:+row.frequency||0,
    lc:+(row.inline_link_clicks||row.clicks)||0,ctr:+row.ctr||0,cpc:+row.cpc||0,cpm:+row.cpm||0,
    pur, cpp:pur?(+row.spend/pur):0};
}

// ad_spend table + Shopify gross
const { data: sp } = await sb.from("ad_spend").select("spend_date,amount").eq("store_id",SHOP).gte("spend_date",since);
const spendByDay=Object.fromEntries((sp??[]).map(x=>[x.spend_date,+x.amount||0]));
const { data: sess } = await sb.from("shopify_sessions").select("accessToken").eq("shop",SHOP).eq("isOnline",false).limit(1);
const stoken=sess?.[0]?.accessToken;
const fetchAll=async(url)=>{const all=[];while(url){const rr=await fetch(url,{headers:{"X-Shopify-Access-Token":stoken}});if(!rr.ok)break;const b=await rr.json();all.push(...(b.orders??[]));const m=(rr.headers.get("link")??"").match(/<([^>]+)>;\s*rel="next"/);url=m?m[1]:null;}return all;};
const shopOrders=await fetchAll(`https://${SHOP}/admin/api/2025-10/orders.json?`+new URLSearchParams({created_at_min:sinceIso,status:"any",limit:"250",fields:"id,created_at,total_price,cancelled_at,processed_at"}));
const shop={};
for(const o of shopOrders){const d=pktDate(o.created_at);shop[d]??={n:0,gross:0,canc:0};shop[d].n++;shop[d].gross+=+o.total_price||0;if(o.cancelled_at)shop[d].canc++;}

head("DAILY — real sales (Shopify, lag-free) vs spend vs Meta delivery funnel  | SHIFT = 2026-05-09");
console.log(`${pad("date",11)}${pad("spend",8)}${pad("impr",8)}${pad("reach",7)}${pad("freq",5)}${pad("lclick",7)}${pad("CTR%",6)}${pad("CPC",6)}${pad("CPM",6)}${pad("Mpur",5)}${pad("CPP",7)}${pad("shop_ord",9)}${pad("shop_gross",11)}realROAS`);
const days=[...new Set([...Object.keys(meta),...Object.keys(shop),...Object.keys(spendByDay)])].sort();
for(const d of days){
  const m=meta[d]||{}; const s=shop[d]||{n:0,gross:0,canc:0}; const spv=spendByDay[d]??m.spend??0;
  const rr=spv?(s.gross/spv).toFixed(2):"—";
  const mark=d==="2026-05-09"?"  <== SHIFT":"";
  console.log(`${pad(d,11)}${pad(fmt(m.spend),8)}${pad(fmt(m.impr),8)}${pad(fmt(m.reach),7)}${pad((m.freq||0).toFixed(2),5)}${pad(fmt(m.lc),7)}${pad((m.ctr||0).toFixed(2),6)}${pad((m.cpc||0).toFixed(0),6)}${pad((m.cpm||0).toFixed(0),6)}${pad(m.pur||"—",5)}${pad(m.cpp?m.cpp.toFixed(0):"—",7)}${pad(s.n+(s.canc?`(${s.canc}c)`:""),9)}${pad(fmt(s.gross),11)}${rr}${mark}`);
}

// Rollups EXCLUDING zero-spend days (fair ROAS) — pre vs early-post vs late-post
const win=(f,t)=>{let sp=0,gr=0,no=0,im=0,lc=0,mp=0,rc=0,fd=0;for(const d of days){if(d<f||d>t)continue;const m=meta[d]||{};const s=shop[d]||{};const v=spendByDay[d]??m.spend??0;if(v>0){sp+=v;gr+=s.gross||0;no+=s.n||0;im+=m.impr||0;lc+=m.lc||0;mp+=m.pur||0;rc+=m.reach||0;fd++;}}return{sp,gr,no,im,lc,mp,rc,fd};};
head("FAIR ROLLUPS (spend>0 days only) — real ROAS = Shopify gross / spend");
for(const b of [
  {n:"Pre-shift  Apr 19–May 08", f:"2026-04-19", t:"2026-05-08"},
  {n:"Early post May 09–13",     f:"2026-05-09", t:"2026-05-13"},
  {n:"Late post  May 14–17",     f:"2026-05-14", t:"2026-05-17"},
]){
  const w=win(b.f,b.t);
  const roas=w.sp?(w.gr/w.sp).toFixed(2):"—";
  const ordPerK=w.sp?(w.no/(w.sp/1000)).toFixed(2):"—";
  const cr=w.lc?((w.no/w.lc)*100).toFixed(2):"—";
  console.log(`${pad(b.n,24)} days=${w.fd} spend=${pad(fmt(w.sp),8)} ord=${pad(w.no,4)} gross=${pad(fmt(w.gr),9)} realROAS=${pad(roas,6)} ord/1kspend=${pad(ordPerK,5)} clicks=${pad(fmt(w.lc),7)} click→order=${cr}%`);
}

// ── CAPI signal-gap trace around the switch (orders May 06 → May 14 PKT) ──
head("CAPI SIGNAL-GAP TRACE — every order 2026-05-06 → 2026-05-14 (did Purchase fire? lag?)");
const gapFrom=new Date("2026-05-05T19:00:00Z").toISOString(); // PKT 05-06 00:00
const gapTo  =new Date("2026-05-13T19:00:00Z").toISOString(); // PKT 05-14 00:00
const win2=shopOrders.filter(o=>o.created_at>=gapFrom && o.created_at<gapTo);
const ids=win2.map(o=>String(o.id));
const evIds=win2.map(o=>`purchase:${SHOP}:${o.id}`);
const attr=new Map();
for(let i=0;i<ids.length;i+=100){const {data}=await sb.from("order_attribution").select("shopify_order_id,capi_sent_at,channel").eq("store_id",SHOP).in("shopify_order_id",ids.slice(i,i+100));for(const a of data??[])attr.set(String(a.shopify_order_id),a);}
const lg=new Map();
for(let i=0;i<evIds.length;i+=100){const {data}=await sb.from("capi_delivery_log").select("event_id,status,sent_at").eq("store_id",SHOP).in("event_id",evIds.slice(i,i+100));for(const l of data??[]){const p=lg.get(l.event_id);if(!p||l.status==="sent")lg.set(l.event_id,l);}}
let fired=0,gap=0;const byDay={};
for(const o of win2.sort((a,b)=>a.created_at<b.created_at?-1:1)){
  const d=pktDate(o.created_at); byDay[d]??={n:0,fired:0};
  const a=attr.get(String(o.id)); const l=lg.get(`purchase:${SHOP}:${o.id}`);
  const sentAt=l?.status==="sent"?l.sent_at:a?.capi_sent_at;
  const ok=!!sentAt;
  byDay[d].n++; if(ok){byDay[d].fired++;fired++;}else gap++;
  const lagMin=ok?Math.round((new Date(sentAt)-new Date(o.created_at))/60000):null;
  console.log(`  ${d} #${String(o.id).slice(-5)} ${o.created_at.slice(5,16)}  capi=${ok?"SENT":"** NOT SENT **"}${ok?` lag=${lagMin}m`:""}  chan=${a?.channel??"(none)"}`);
}
console.log(`\n  Orders 05-06→05-13: ${win2.length}  CAPI fired: ${fired}  NOT sent: ${gap}`);
for(const d of Object.keys(byDay).sort()) console.log(`   ${d}: ${byDay[d].fired}/${byDay[d].n} fired`);
