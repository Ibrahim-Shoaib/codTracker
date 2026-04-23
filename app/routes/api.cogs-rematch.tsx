import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import { retroactiveCOGSMatch } from "../lib/sync.server.js";
import { sessionStorage } from "../shopify.server";

// POST /api/cogs-rematch — re-runs retroactive COGS matching for all unmatched orders.
// Protected by CRON_SECRET. Call once after fixing COGS costs.
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
    .select("store_id")
    .not("postex_token", "is", null);

  if (!stores?.length) {
    return json({ matched: 0, errors: 0 });
  }

  let matched = 0;
  const errors: Array<{ store: string; error: string }> = [];

  for (const store of stores) {
    try {
      const supabase = await getSupabaseForStore(store.store_id);
      const offlineSession = await sessionStorage.loadSession(`offline_${store.store_id}`);
      if (!offlineSession) {
        errors.push({ store: store.store_id, error: "no offline session found" });
        continue;
      }
      await retroactiveCOGSMatch(supabase, store.store_id, offlineSession);
      matched++;
    } catch (err) {
      errors.push({ store: store.store_id, error: String(err) });
    }
  }

  return json({ matched, errors });
};
