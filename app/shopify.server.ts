import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";
import { createClient } from "@supabase/supabase-js";
import { registerUninstallWebhook } from "./lib/shopify.server.js";

if (!process.env.SUPABASE_DATABASE_URL) {
  throw new Error("SUPABASE_DATABASE_URL is not set. Add it to Railway environment variables.");
}

// Canonical scope list — must stay in sync with shopify.app.toml. Hardcoded
// (rather than read from process.env.SHOPIFY_SCOPES) so a stale Railway env
// var can't silently leave the app requesting fewer scopes than the code
// requires. When the toml changes, update this list — both must match
// exactly or shopify-app-remix's scope-diff detection won't trigger re-auth
// for existing merchants on the Ad Tracking page.
const CANONICAL_SCOPES = [
  "read_orders",
  "read_products",
  "read_inventory",
  "read_customers",
  "read_checkouts",
  "write_pixels",
  "read_pixels",
  "read_customer_events",
  "read_themes",
];

// Allow env override for dev/staging where you might want to test with fewer
// scopes — but never silently fall back to "no scopes" if the env var is
// unset, which is what the previous `process.env.SHOPIFY_SCOPES?.split(",")`
// pattern did.
const scopes = process.env.SHOPIFY_SCOPES
  ? process.env.SHOPIFY_SCOPES.split(",").map((s) => s.trim()).filter(Boolean)
  : CANONICAL_SCOPES;

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes,
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PostgreSQLSessionStorage(process.env.SUPABASE_DATABASE_URL as string),
  distribution: AppDistribution.AppStore,
  hooks: {
    afterAuth: async ({ session }) => {
      const { shop } = session;

      // Create stores row on first install — ignoreDuplicates prevents overwriting
      // existing credentials on reinstall
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      );
      await supabase.from("stores").upsert(
        { store_id: shop, onboarding_complete: false, onboarding_step: 1 },
        { onConflict: "store_id", ignoreDuplicates: true }
      );

      // Register shop-specific uninstall webhook (TOML covers app-level; this is belt-and-suspenders)
      await registerUninstallWebhook(session).catch((err) =>
        console.error(`registerUninstallWebhook failed for ${shop}:`, err)
      );
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
