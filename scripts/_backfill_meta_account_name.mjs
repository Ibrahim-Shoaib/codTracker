// Backfill stores.meta_ad_account_name for stores connected before migration 009.
// Run with: node --env-file=.env scripts/_backfill_meta_account_name.mjs
import { createClient } from "@supabase/supabase-js";
import { getAdAccounts } from "../app/lib/meta.server.js";

const adminClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const { data: stores, error } = await adminClient
  .from("stores")
  .select("store_id, meta_access_token, meta_ad_account_id, meta_ad_account_name")
  .not("meta_access_token", "is", null)
  .is("meta_ad_account_name", null);

if (error) { console.error(error); process.exit(1); }
console.log(`stores needing backfill: ${stores?.length ?? 0}`);
if (!stores?.length) process.exit(0);

for (const s of stores) {
  console.log(`\n[${s.store_id}] ad_account_id=${s.meta_ad_account_id}`);
  try {
    const accounts = await getAdAccounts(s.meta_access_token);
    const match = accounts.find((a) => a.id === s.meta_ad_account_id);
    if (!match) {
      console.log(`  ✗ no matching account in Meta response (got ${accounts.length} accounts)`);
      continue;
    }
    console.log(`  → name: ${match.name}`);
    const { error: updErr } = await adminClient
      .from("stores")
      .update({ meta_ad_account_name: match.name })
      .eq("store_id", s.store_id);
    if (updErr) {
      console.log(`  ✗ update failed: ${updErr.message}`);
    } else {
      console.log(`  ✓ updated`);
    }
  } catch (err) {
    console.log(`  ✗ Meta API call failed: ${err.message ?? err}`);
  }
}
