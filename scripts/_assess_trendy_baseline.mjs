// Baseline for the ad-tracking assessment: connection health, store config,
// the "shift" date (when this store moved onto our pixel), Meta ads token
// status, and a schema peek at the pipeline tables. Read-only.
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
const head = (s) => console.log("\n" + "=".repeat(78) + "\n " + s + "\n" + "=".repeat(78));

head("meta_pixel_connections");
const { data: conn, error: ce } = await sb.from("meta_pixel_connections").select("*").eq("store_id", SHOP).maybeSingle();
if (ce) console.log("err", ce.message);
if (!conn) console.log("NO CONNECTION ROW");
else {
  const tokenOk = (() => { try { const t = decryptSecret(conn.bisu_token); return t ? `decrypts OK (len ${t.length})` : "empty"; } catch (e) { return `DECRYPT FAIL: ${e.message}`; } })();
  console.log({
    status: conn.status, status_reason: conn.status_reason ?? conn.status_detail ?? null,
    dataset_id: conn.dataset_id, business_id: conn.business_id,
    web_pixel_id: conn.web_pixel_id, manual_entry_required: conn.manual_entry_required,
    created_at: conn.created_at, updated_at: conn.updated_at,
    last_event_sent_at: conn.last_event_sent_at,
    bisu_token: tokenOk,
    all_columns: Object.keys(conn),
  });
}

head("stores (config relevant to ROAS + ads)");
const { data: store } = await sb.from("stores").select("*").eq("store_id", SHOP).maybeSingle();
if (store) {
  console.log({
    currency: store.currency, money_format: store.money_format,
    ingest_mode: store.ingest_mode, is_demo: store.is_demo,
    onboarding_complete: store.onboarding_complete,
    meta_ad_account_id: store.meta_ad_account_id,
    meta_ad_account_name: store.meta_ad_account_name,
    meta_ad_account_currency: store.meta_ad_account_currency,
    meta_token_expires_at: store.meta_token_expires_at,
    has_meta_access_token: !!store.meta_access_token,
    meta_sync_error: store.meta_sync_error,
    last_postex_sync_at: store.last_postex_sync_at,
    created_at: store.created_at,
  });
}

head("Custom Web Pixel + theme-embed activation (if tracked on stores)");
console.log({
  web_pixel_id: conn?.web_pixel_id ?? "(none)",
  theme_embed_cols: store ? Object.keys(store).filter(k => /embed|theme|pixel/i.test(k)).reduce((a,k)=>(a[k]=store[k],a),{}) : {},
});

// Schema peek — one recent row from each pipeline table to learn columns
for (const tbl of ["order_attribution", "capi_delivery_log", "capi_retries", "visitors", "visitor_events", "emq_snapshots", "ad_spend"]) {
  head(`schema peek: ${tbl}`);
  const { data, error } = await sb.from(tbl).select("*").eq("store_id", SHOP).limit(1);
  if (error) { console.log("err", error.message); continue; }
  console.log("columns:", data?.[0] ? Object.keys(data[0]) : "(no rows)");
  if (data?.[0]) console.log("sample:", JSON.stringify(data[0], (k, v) => (typeof v === "string" && v.length > 60 ? v.slice(0, 60) + "…" : v), 1));
}

// EMQ snapshot recent trend (local proxy — context only)
head("emq_snapshots — last 14 rows (LOCAL PROXY, not Meta's real EMQ)");
const { data: emq } = await sb.from("emq_snapshots").select("*").eq("store_id", SHOP).order("snapshot_date", { ascending: false }).limit(14);
for (const e of emq ?? []) console.log(e.snapshot_date, "overall=", e.overall_emq, "purchase=", e.purchase_emq ?? "-", JSON.stringify(e.event_scores ?? e.per_event ?? {}));
