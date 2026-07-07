import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";

// Lightweight polling target for the dashboard's "backfill in progress"
// state. The old behavior revalidated the ENTIRE dashboard loader (17 RPCs)
// every 4 seconds while the first PostEx sync ran; this endpoint is one
// indexed single-row select. The dashboard calls revalidate() exactly once,
// when `done` flips to true.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const supabase = await getSupabaseForStore(session.shop);

  const { data: store } = await supabase
    .from("stores")
    .select("last_postex_sync_at")
    .eq("store_id", session.shop)
    .maybeSingle();

  return json(
    { done: !!store?.last_postex_sync_at },
    { headers: { "Cache-Control": "no-store" } }
  );
};
