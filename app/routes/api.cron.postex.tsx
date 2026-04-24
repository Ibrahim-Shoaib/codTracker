import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { syncStore, retroactiveCOGSMatch } from "../lib/sync.server.js";

const CONCURRENCY = 5;

// Railway cron: 0 1,13 * * * (UTC) = 6 AM + 6 PM PKT
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: stores } = await adminClient
    .from("stores")
    .select("store_id, postex_token")
    .not("postex_token", "is", null);

  if (!stores?.length) {
    return json({ synced: 0, errors: 0 });
  }

  let synced = 0;
  let errors = 0;

  // Process in batches of CONCURRENCY — limits simultaneous PostEx + Supabase connections
  for (let i = 0; i < stores.length; i += CONCURRENCY) {
    const batch = stores.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (store) => {
        const supabase = await getSupabaseForStore(store.store_id);
        await syncStore(store, supabase);
        void retroactiveCOGSMatch(supabase, store.store_id);
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
