import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";
import { createClient } from "@supabase/supabase-js";
import {
  registerUninstallWebhook,
  registerMetaPixelWebhooks,
  getShopCurrencySettings,
} from "./lib/shopify.server.js";

if (!process.env.SUPABASE_DATABASE_URL) {
  throw new Error("SUPABASE_DATABASE_URL is not set. Add it to Railway environment variables.");
}

// Canonical scope list — must stay in sync with shopify.app.toml. The env
// override we used to allow (SHOPIFY_SCOPES) turned out to be pure footgun:
// stale Railway values quietly narrowed the scope-diff detection to a
// subset of what the toml actually grants, which triggered spurious re-auth
// prompts and made log audits misleading. Managed install reads scopes from
// the toml on grant, so runtime overrides never affected what merchants
// actually gave us — only what we *thought* they gave us. Hardcode.
const scopes = [
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

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
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

      // Pull the shop's currency + money_format from Shopify shop.json
      // and stash them on the stores row. Lets the dashboard render
      // money in the merchant's actual currency instead of hardcoded
      // PKR. Best-effort: a non-2xx response from Shopify just means
      // we keep the existing values (or the migration default of PKR
      // for legacy rows).
      try {
        const cur = await getShopCurrencySettings(session);
        if (cur?.currency || cur?.money_format) {
          const updates: Record<string, string> = {};
          if (cur.currency) updates.currency = cur.currency;
          if (cur.money_format) updates.money_format = cur.money_format;
          await supabase.from("stores").update(updates).eq("store_id", shop);
        }
      } catch (err) {
        console.error(`getShopCurrencySettings failed for ${shop}:`, err);
      }

      // Register shop-specific uninstall webhook (TOML covers app-level; this is belt-and-suspenders)
      await registerUninstallWebhook(session).catch((err) =>
        console.error(`registerUninstallWebhook failed for ${shop}:`, err)
      );

      // Re-assert ad-tracking webhook subscriptions (orders/checkouts/refunds).
      // Belt-and-suspenders: shopify.app.toml's managed-install config is
      // supposed to handle these, but we hit production cases where merchants
      // installed before the toml subs were added and Shopify never
      // retroactively registered them — every order completed without a
      // Purchase event reaching CAPI. Calling this on every auth run means
      // even a re-auth (e.g. for a new scope) is enough to repair a
      // broken subscription set.
      await registerMetaPixelWebhooks(session).catch((err) =>
        console.error(`registerMetaPixelWebhooks failed for ${shop}:`, err)
      );
    },
  },
  future: {
    // Token Exchange strategy for embedded admin — no OAuth redirect dance.
    unstable_newEmbeddedAuthStrategy: true,
    // Expiring offline tokens (60-min TTL + refresh token). Required for new
    // public apps as of 2026-04-01; existing apps must migrate by 2027-01-01.
    // When on, token exchange requests include `expiring=1` and the library
    // auto-refreshes near expiry inside authenticate.admin / authenticate.webhook
    // / unauthenticated.admin. Background jobs MUST use unauthenticated.admin(shop);
    // reading session.accessToken from sessionStorage directly bypasses the
    // refresh path and will start hitting 401s.
    expiringOfflineAccessTokens: true,
  },
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
