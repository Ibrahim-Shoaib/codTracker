// One-shot backfill: pull store currency from Shopify shop API and ad
// account currency from Meta for every existing store. Idempotent.
//
// Run after migration 018 applies. Future installs are populated by
// the install hook (shopify.server.js afterAuth) and Meta OAuth
// callback, so this script only needs to run once for legacy rows.
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

console.log("─── Pull all stores ───");
const { data: stores } = await sb
  .from("stores")
  .select("store_id, currency, money_format, meta_access_token, meta_ad_account_id, meta_ad_account_currency")
  .neq("store_id", "__codprofit_demo_pool__");

console.log(`Found ${stores?.length ?? 0} stores to process\n`);

let updated = 0, skipped = 0, errored = 0;

for (const s of stores ?? []) {
  console.log(`▶ ${s.store_id}`);

  // Get the Shopify offline session (has the access token)
  const { data: sessions } = await sb
    .from("shopify_sessions")
    .select("accessToken")
    .eq("shop", s.store_id)
    .eq("isOnline", false)
    .limit(1);
  const accessToken = sessions?.[0]?.accessToken;
  if (!accessToken) {
    console.log(`  ⚠ no offline session — skipping`);
    skipped++;
    continue;
  }

  const updates = {};

  // Shop currency + money_format
  try {
    const r = await fetch(`https://${s.store_id}/admin/api/2025-01/shop.json`, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    if (r.ok) {
      const { shop } = await r.json();
      if (shop?.currency && shop.currency !== s.currency) {
        updates.currency = shop.currency;
      }
      if (shop?.money_format && shop.money_format !== s.money_format) {
        updates.money_format = shop.money_format;
      }
      console.log(
        `  shop currency=${shop?.currency} money_format="${shop?.money_format}"`
      );
    } else {
      console.log(`  ⚠ Shopify shop API HTTP ${r.status}`);
    }
  } catch (err) {
    console.log(`  ⚠ Shopify shop fetch error: ${err?.message}`);
  }

  // Meta ad account currency (only if ad account is connected)
  if (s.meta_access_token && s.meta_ad_account_id) {
    try {
      const params = new URLSearchParams({
        fields: "currency",
        access_token: s.meta_access_token,
      });
      const r = await fetch(
        `https://graph.facebook.com/v21.0/${s.meta_ad_account_id}?${params}`
      );
      if (r.ok) {
        const j = await r.json();
        if (j?.currency && j.currency !== s.meta_ad_account_currency) {
          updates.meta_ad_account_currency = j.currency;
        }
        console.log(`  ad account currency=${j?.currency}`);
      } else {
        console.log(`  ⚠ Meta ad-account API HTTP ${r.status}`);
      }
    } catch (err) {
      console.log(`  ⚠ Meta ad-account fetch error: ${err?.message}`);
    }
  } else {
    console.log(`  (no Meta ad account connected)`);
  }

  if (Object.keys(updates).length === 0) {
    console.log(`  → no changes\n`);
    skipped++;
    continue;
  }

  console.log(`  → applying:`, updates);
  const { error } = await sb.from("stores").update(updates).eq("store_id", s.store_id);
  if (error) {
    console.log(`  ✗ update failed: ${error.message}\n`);
    errored++;
  } else {
    console.log(`  ✓ updated\n`);
    updated++;
  }
}

console.log("─── Summary ───");
console.log(`  updated:  ${updated}`);
console.log(`  skipped:  ${skipped}`);
console.log(`  errored:  ${errored}`);
