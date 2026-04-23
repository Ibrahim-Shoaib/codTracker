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

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SHOPIFY_SCOPES?.split(","),
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
  future: {},
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
