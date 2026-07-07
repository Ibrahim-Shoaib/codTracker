// CAPI delivery health for the past 3 PKT days: status distribution,
// retry backlog, InitiateCheckout coverage, latest EMQ proxy trend.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
try { for (const l of readFileSync(".env","utf8").split(/\r?\n/)){const m=l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2];} } catch {}
const SHOP="the-trendy-homes-pk.myshopify.com";
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
await sb.rpc("set_app_store",{store:SHOP});
const start=new Date(Date.now()-3*86400000).toISOString();

const { data: log } = await sb.from("capi_delivery_log").select("event_name,status,http_status,error_msg,sent_at").eq("store_id",SHOP).gte("sent_at",start).order("sent_at",{ascending:false}).limit(2000);
const agg={};
for (const l of log??[]) { const k=`${l.event_name} / ${l.status}${l.http_status?` (http ${l.http_status})`:""}`; agg[k]=(agg[k]??0)+1; }
console.log(`=== capi_delivery_log — last 3 days (${(log??[]).length} rows) ===`);
for (const [k,v] of Object.entries(agg).sort()) console.log(`  ${k}: ${v}`);
const bad=(log??[]).filter(l=>l.status!=="sent");
console.log(`  non-'sent' rows: ${bad.length}`);
for (const b of bad.slice(0,20)) console.log(`   - ${b.sent_at} ${b.event_name} ${b.status} http=${b.http_status} err=${b.error_msg}`);

const { count: retryN } = await sb.from("capi_retries").select("*",{count:"exact",head:true}).eq("store_id",SHOP);
console.log(`\n=== capi_retries backlog: ${retryN ?? 0} (0 = no stuck/failed events) ===`);

const { data: emq } = await sb.from("emq_snapshots").select("captured_at,overall_emq,per_event").eq("store_id",SHOP).order("captured_at",{ascending:false}).limit(8);
console.log(`\n=== emq_snapshots (LOCAL weighted proxy, not Meta's real EMQ) ===`);
for (const e of emq??[]) console.log(`  ${e.captured_at.slice(0,10)} overall=${e.overall_emq} ${JSON.stringify(e.per_event)}`);

// InitiateCheckout coverage vs orders, past 3 days
const { data: ic } = await sb.from("capi_delivery_log").select("event_name,status,sent_at").eq("store_id",SHOP).eq("event_name","InitiateCheckout").gte("sent_at",start);
console.log(`\n=== InitiateCheckout sent (last 3d): ${(ic??[]).filter(x=>x.status==="sent").length} (server-only; often < orders — Meta 400s identity-less ICs by design) ===`);
