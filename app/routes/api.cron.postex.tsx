import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { syncStore, retroactiveCOGSMatch } from "../lib/sync.server.js";

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

  // Sequential for now; parallelize with max 5 concurrent at 50+ stores
  for (const store of stores) {
    try {
      const supabase = await getSupabaseForStore(store.store_id);
      await syncStore(store, supabase);
      void retroactiveCOGSMatch(supabase, store.store_id);
      synced++;
    } catch (err) {
      console.error(`PostEx sync failed for ${store.store_id}:`, err);
      errors++;
    }
  }

  return json({ synced, errors });
};
