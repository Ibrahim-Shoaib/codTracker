// Nail the cutover timeline: connection created/connected, and the exact
// capi_sent_at state of every order May 06–10 (was the blackout real & durable,
// or just rotated out of the 500-cap log?). order_attribution.capi_sent_at is
// the authoritative "was it sent" signal (independent of event_id form).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
try { for (const l of readFileSync(".env","utf8").split(/\r?\n/)){const m=l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2];} } catch {}
const SHOP="the-trendy-homes-pk.myshopify.com";
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
await sb.rpc("set_app_store",{store:SHOP});

const { data: c } = await sb.from("meta_pixel_connections").select("status,created_at,connected_at,updated_at,last_event_sent_at,last_health_check").eq("store_id",SHOP).single();
console.log("=== meta_pixel_connections timeline ===");
console.log(c);
console.log("created_at PKT  =", new Date(new Date(c.created_at).getTime()+5*3600000).toISOString());
console.log("connected_at PKT=", c.connected_at?new Date(new Date(c.connected_at).getTime()+5*3600000).toISOString():"(null)");

// Every order_attribution row May 05 -> May 11 (PKT) with capi_sent_at state
const from=new Date("2026-05-04T19:00:00Z").toISOString();
const to  =new Date("2026-05-11T19:00:00Z").toISOString();
const { data: rows } = await sb.from("order_attribution")
  .select("shopify_order_id,channel,attributed_at,capi_sent_at")
  .eq("store_id",SHOP).gte("attributed_at",from).lt("attributed_at",to)
  .order("attributed_at",{ascending:true});
console.log(`\n=== order_attribution rows ${from.slice(0,10)}→ : ${rows?.length??0} ===`);
const day=(iso)=>new Date(new Date(iso).getTime()+5*3600000).toISOString().slice(0,10);
const agg={};
for(const r of rows??[]){
  const d=day(r.attributed_at); agg[d]??={n:0,sent:0};
  agg[d].n++; if(r.capi_sent_at) agg[d].sent++;
}
for(const d of Object.keys(agg).sort())
  console.log(`  ${d}: ${agg[d].sent}/${agg[d].n} have capi_sent_at  (${agg[d].n-agg[d].sent} never confirmed sent)`);

// Total never-sent in the blackout window vs spend at risk
const blackout=(rows??[]).filter(r=>!r.capi_sent_at && day(r.attributed_at)>="2026-05-06" && day(r.attributed_at)<="2026-05-09");
console.log(`\nBLACKOUT (May 06–09) orders with NO capi_sent_at: ${blackout.length}`);
console.log("Their channels:", blackout.reduce((a,r)=>{a[r.channel]=(a[r.channel]||0)+1;return a;},{}));
