// Replicates app/routes/api.cron.meta-today.tsx locally — including the new
// meta_sync_error set/clear behavior — so we can verify the disconnected
// signal lands in the DB before the cron next fires in production.
// Run with: node --env-file=.env scripts/_run_meta_today.mjs
import { createClient } from "@supabase/supabase-js";
import { fetchSpend, isTokenExpired } from "../app/lib/meta.server.js";
import { getTodayPKT, formatPKTDate } from "../app/lib/dates.server.js";

const adminClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const { data: stores, error: storesErr } = await adminClient
  .from("stores")
  .select("store_id, meta_access_token, meta_ad_account_id, meta_token_expires_at, last_meta_sync_at, meta_sync_error")
  .not("meta_access_token", "is", null);

if (storesErr) {
  console.error("Stores query error:", storesErr);
  process.exit(1);
}

console.log(`stores with meta_access_token: ${stores?.length ?? 0}`);
if (!stores?.length) {
  console.log(JSON.stringify({ synced: 0, skipped: 0, errors: 0 }, null, 2));
  process.exit(0);
}

const today = getTodayPKT();
const todayStr = formatPKTDate(today.start);
console.log(`todayStr (PKT): ${todayStr}`);

let synced = 0;
let skipped = 0;
let errors = 0;
const perStore = [];

for (const store of stores) {
  const row = {
    store_id: store.store_id,
    expires_at: store.meta_token_expires_at,
    last_meta_sync_at: store.last_meta_sync_at,
    prev_error: store.meta_sync_error,
  };

  if (isTokenExpired(store.meta_token_expires_at)) {
    await adminClient
      .from("stores")
      .update({ meta_sync_error: "Meta token expired. Reconnect to resume sync." })
      .eq("store_id", store.store_id);
    skipped++;
    row.result = "skipped: token expired";
    perStore.push(row);
    continue;
  }
  try {
    const amount = await fetchSpend(
      store.meta_access_token,
      store.meta_ad_account_id,
      todayStr,
      todayStr
    );
    const { error: upsertErr } = await adminClient.from("ad_spend").upsert(
      {
        store_id:   store.store_id,
        spend_date: todayStr,
        amount,
        source:     "meta",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_id,spend_date" }
    );
    if (upsertErr) throw new Error(`upsert: ${upsertErr.message}`);
    await adminClient
      .from("stores")
      .update({
        last_meta_sync_at: new Date().toISOString(),
        meta_sync_error:   null,
      })
      .eq("store_id", store.store_id);
    synced++;
    row.result = "synced";
    row.amount = amount;
  } catch (err) {
    const message = (err?.message ?? String(err)).replace(/^Meta fetchSpend failed:\s*/, "");
    await adminClient
      .from("stores")
      .update({ meta_sync_error: message })
      .eq("store_id", store.store_id);
    errors++;
    row.result = `error: ${message}`;
  }
  perStore.push(row);
}

console.log("\nper-store:");
console.log(JSON.stringify(perStore, null, 2));

// Re-read so we can confirm what landed in the DB.
const { data: after } = await adminClient
  .from("stores")
  .select("store_id, meta_sync_error, last_meta_sync_at")
  .not("meta_access_token", "is", null);
console.log("\npost-run DB state:");
console.log(JSON.stringify(after, null, 2));

console.log("\nresult:");
console.log(JSON.stringify({ synced, skipped, errors }, null, 2));
