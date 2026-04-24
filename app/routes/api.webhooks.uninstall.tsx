import type { ActionFunctionArgs } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { authenticate, sessionStorage } from "../shopify.server";

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
    // Delete app data — CASCADE removes orders, product_costs, ad_spend, etc.
    await supabase.from("stores").delete().eq("store_id", shop);

    // Delete Shopify session so a future reinstall always gets a fresh OAuth token
    // rather than reusing the revoked access token and hitting 401s.
    await sessionStorage.deleteSession(`offline_${shop}`);
  } catch (err) {
    console.error(`Uninstall cleanup failed for ${shop}:`, err);
  }

  // Always return 200 — Shopify retries if it doesn't receive 200 within 5 seconds
  return new Response(null, { status: 200 });
};
