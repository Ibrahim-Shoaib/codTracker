// Pulls today's Ads Insights for the connected ad account to see how many of
// the 7 replayed Purchase events Meta has actually attributed to campaigns.
//
// This is what Ads Manager shows as the "Purchases" column. Two related
// action_types matter:
//   - "purchase"                              — generic purchase actions
//   - "offsite_conversion.fb_pixel_purchase"  — pixel/CAPI-attributed purchases
//
// Latency: CAPI events typically appear in Ads Insights within 15min–1h of
// ingest. If counts are still 0 right after sending, wait and re-run.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: stores } = await sb
  .from("stores")
  .select("meta_access_token, meta_ad_account_id, meta_ad_account_currency")
  .eq("store_id", SHOP);
if (!stores?.length || !stores[0].meta_access_token) {
  console.error("No Meta Ads token for", SHOP);
  process.exit(1);
}
const { meta_access_token: token, meta_ad_account_id: adAccountId, meta_ad_account_currency: ccy } = stores[0];

// Today PKT date string for Meta's time_range (Meta interprets this in the
// ad account's timezone — which for this account is presumably set to Asia/Karachi).
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const todayPkt = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);

async function fetchInsights({ level, breakdowns }) {
  const params = new URLSearchParams({
    fields: "campaign_name,adset_name,ad_name,spend,actions,action_values",
    time_range: JSON.stringify({ since: todayPkt, until: todayPkt }),
    level,
    action_breakdowns: "action_type",
    access_token: token,
  });
  const url = `https://graph.facebook.com/v24.0/${adAccountId}/insights?${params}`;
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    console.error(`Meta Insights ${res.status}:`, JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body.data ?? [];
}

function summarize(rows, label) {
  console.log(`\n═══ ${label} (${todayPkt}, ${ccy}) ═══`);
  let totalPurchaseCount = 0;
  let totalPurchaseValue = 0;
  let totalSpend = 0;
  for (const r of rows) {
    const purchases = (r.actions ?? []).filter(
      (a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase"
    );
    const purchaseValues = (r.action_values ?? []).filter(
      (a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase"
    );
    const cnt = purchases.reduce((s, a) => s + Number(a.value || 0), 0);
    const val = purchaseValues.reduce((s, a) => s + Number(a.value || 0), 0);
    totalPurchaseCount += cnt;
    totalPurchaseValue += val;
    totalSpend += Number(r.spend || 0);

    const name = r.ad_name || r.adset_name || r.campaign_name || "(account total)";
    if (cnt > 0 || (r.spend && Number(r.spend) > 0)) {
      console.log(`  ${name.padEnd(50)} spend=${(r.spend ?? "0").padStart(8)} purchases=${cnt} value=${val.toFixed(0)}`);
      // Show breakdown of action_types so we see the distinction
      for (const a of (r.actions ?? [])) {
        if (a.action_type.includes("purchase") || a.action_type.includes("conversion")) {
          console.log(`     → ${a.action_type}: ${a.value}`);
        }
      }
    }
  }
  console.log(`  ─────────────────────────────────────`);
  console.log(`  TOTAL  spend=${totalSpend.toFixed(2)}  attributed_purchases=${totalPurchaseCount}  value=${totalPurchaseValue.toFixed(0)} ${ccy}`);
}

const accountRows = await fetchInsights({ level: "account" });
summarize(accountRows, "Account-level (totals)");

const campaignRows = await fetchInsights({ level: "campaign" });
summarize(campaignRows, "By Campaign");

console.log(`\nWe sent 7 Purchase events totalling 41,691 ${ccy} ~13min ago.`);
console.log(`Meta typically takes 15min–1h to surface CAPI events in Ads Insights.`);
console.log(`If attributed_purchases is still 0, re-run in 30 minutes.`);
