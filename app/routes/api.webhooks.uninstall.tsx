import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { authenticate, sessionStorage } from "../shopify.server";
import { DEMO_POOL_STORE_ID } from "../lib/demo-pool.server.js";

// Handles Shopify app/uninstalled webhook.
// authenticate.webhook verifies the HMAC signature and throws a 401 Response if invalid.
// Do NOT use getSupabaseForStore — service role bypasses RLS for this store-level delete.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  if (topic !== "APP_UNINSTALLED") {
    return new Response(null, { status: 200 });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    // Look up the row before deleting so we can tell whether the store
    // we just lost was a demo merchant — drives the pool-cleanup branch.
    const { data: storeRow } = await supabase
      .from("stores")
      .select("is_demo")
      .eq("store_id", shop)
      .single();
    const wasDemo = !!storeRow?.is_demo;

    // Delete app data — CASCADE removes orders, product_costs, ad_spend, etc.
    await supabase.from("stores").delete().eq("store_id", shop);

    // Delete Shopify session so a future reinstall always gets a fresh OAuth token
    // rather than reusing the revoked access token and hitting 401s.
    await sessionStorage.deleteSession(`offline_${shop}`);

    // Demo pool cleanup: if this was the last is_demo merchant, wipe the
    // shared pool's orders + ad_spend (the sentinel row itself stays so
    // the next demo onboarding doesn't have to recreate it). Pool gets
    // re-seeded automatically the moment another merchant enters the
    // demo key in step 1 (ensurePoolSeeded fires there).
    if (wasDemo) {
      const { count: remainingDemos } = await supabase
        .from("stores")
        .select("store_id", { count: "exact", head: true })
        .eq("is_demo", true)
        .neq("store_id", DEMO_POOL_STORE_ID);

      if ((remainingDemos ?? 0) === 0) {
        await supabase.from("orders").delete().eq("store_id", DEMO_POOL_STORE_ID);
        await supabase.from("ad_spend").delete().eq("store_id", DEMO_POOL_STORE_ID);
        console.log(`[uninstall ${shop}] last demo store removed — pool data wiped`);
      }
    }
  } catch (err) {
    console.error(`Uninstall cleanup failed for ${shop}:`, err);
  }

  // Always return 200 — Shopify retries if it doesn't receive 200 within 5 seconds
  return new Response(null, { status: 200 });
};
