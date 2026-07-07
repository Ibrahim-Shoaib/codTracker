// Query Meta Graph API directly for Trendy's dataset:
//   - validate token + dataset accessible
//   - fetch latest events stats
//   - fetch diagnostics issues
//   - fetch EMQ breakdown with field-level coverage
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
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const head = (s) => console.log("\n" + "═".repeat(80) + "\n " + s + "\n" + "═".repeat(80));

const { data: pix } = await sb.from("meta_pixel_connections").select("*").eq("store_id", SHOP).single();
const datasetId = pix.dataset_id;
const accessToken = decryptSecret(pix.bisu_token);

console.log(`dataset_id: ${datasetId}`);
console.log(`access token: ${accessToken.slice(0, 20)}…${accessToken.slice(-8)} (length=${accessToken.length})`);

const G = "https://graph.facebook.com/v24.0";
const tryGet = async (path, params = {}) => {
  const u = new URL(G + path);
  u.searchParams.set("access_token", accessToken);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
};

// 1. Token introspection — who is this BISU?
head("1. Token introspection (/me)");
console.log(JSON.stringify(await tryGet("/me", { fields: "id,name,permissions" }), null, 2));

// 2. Dataset details
head("2. Dataset details");
const ds = await tryGet(`/${datasetId}`, { fields: "id,name,owner_business,owner_ad_account,event_stats,duplicate_entries,creation_time,last_fired_time,can_proxy,is_unavailable" });
console.log(JSON.stringify(ds, null, 2));

// 3. Stats — recent activity
head("3. Dataset stats (last 24h)");
const sinceUnix = Math.floor(Date.now() / 1000) - 86400;
const stats = await tryGet(`/${datasetId}/stats`, {
  start_time: sinceUnix,
  end_time: Math.floor(Date.now() / 1000),
  aggregation: "count",
});
console.log(JSON.stringify(stats, null, 2));

// 4. Server events list
head("4. /server_events_received");
console.log(JSON.stringify(await tryGet(`/${datasetId}/server_events_received`), null, 2));

// 5. Activities (event types received)
head("5. /activities");
console.log(JSON.stringify(await tryGet(`/${datasetId}/activities`, {
  start_time: sinceUnix,
  end_time: Math.floor(Date.now() / 1000),
}), null, 2));

// 6. da_check / event_match_quality_score
head("6. /da_check (data quality diagnostics)");
console.log(JSON.stringify(await tryGet(`/${datasetId}/da_check`), null, 2));

// 7. Active integrations on the dataset (this is what determines if our integration is registered)
head("7. /shared_accounts");
console.log(JSON.stringify(await tryGet(`/${datasetId}/shared_accounts`), null, 2));

head("8. /assigned_users");
console.log(JSON.stringify(await tryGet(`/${datasetId}/assigned_users`), null, 2));

head("9. Send a test event with test_event_code TEST123 (should appear in Test Events tab)");
const testEvent = {
  data: [
    {
      event_name: "PageView",
      event_time: Math.floor(Date.now() / 1000),
      event_id: `test:${Date.now()}`,
      action_source: "website",
      event_source_url: "https://thetrendyhome.pk/test",
      user_data: {
        em: ["7b17fb0bd173f625b58636fb796407c22b3d16fc78302d79f0fd30c2fc2fc068"], // test hash
        client_ip_address: "1.1.1.1",
        client_user_agent: "Mozilla/5.0 diagnostic",
      },
    },
  ],
  test_event_code: "TEST123",
};
const tu = new URL(`${G}/${datasetId}/events`);
const tr = await fetch(tu, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify(testEvent),
});
const tb = await tr.json().catch(() => null);
console.log("status:", tr.status);
console.log("body:", JSON.stringify(tb, null, 2));
