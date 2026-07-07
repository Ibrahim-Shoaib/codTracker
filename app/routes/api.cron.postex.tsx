import type { ActionFunctionArgs } from "@remix-run/node";
import { verifyCronSecret } from "../lib/cron-auth.server.js";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { syncStore, retroactiveCOGSMatch } from "../lib/sync.server.js";
import { fixZeroInvoicePayments } from "../lib/invoice-fix.server.js";
import { unauthenticated } from "../shopify.server";

const CONCURRENCY = 5;

// Railway cron: 0 1,13 * * * (UTC) = 6 AM + 6 PM PKT
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!verifyCronSecret(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: stores } = await adminClient
    .from("stores")
    .select("store_id, postex_token, line_items_backfilled_at, timezone")
    .not("postex_token", "is", null)
    // Demo stores carry a magic-key token but their data is fabricated locally;
    // hitting PostEx with the magic key returns 401 and would pollute the row.
    .neq("is_demo", true);

  if (!stores?.length) {
    return json({ synced: 0, errors: 0 });
  }

  let synced = 0;
  let errors = 0;

  for (let i = 0; i < stores.length; i += CONCURRENCY) {
    const batch = stores.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (store) => {
        const supabase = await getSupabaseForStore(store.store_id);
        await syncStore(store, supabase);
        void retroactiveCOGSMatch(supabase, store.store_id);
        // unauthenticated.admin(shop) loads the offline session AND refreshes
        // the access token if it's near expiry. Do not call sessionStorage.loadSession
        // directly here — that path skips the refresh helper and returns stale tokens
        // once expiringOfflineAccessTokens is on.
        try {
          const { session: offlineSession } = await unauthenticated.admin(store.store_id);
          if (offlineSession) {
            void fixZeroInvoicePayments(supabase, store.store_id, offlineSession);
          }
        } catch (err) {
          console.warn(`[cron.postex] no valid offline session for ${store.store_id}:`, err);
        }
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        synced++;
      } else {
        console.error("PostEx sync failed:", result.reason);
        errors++;
      }
    }
  }

  return json({ synced, errors });
};
