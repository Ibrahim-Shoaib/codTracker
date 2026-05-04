// Theme app-embed activation detector.
//
// `themeFilesUpsert` (the only mutation that could auto-activate an embed
// without a merchant click) is gated behind a Shopify-granted exemption that
// tracking apps don't qualify for — see the OAuth research doc. The closest
// thing to "automatic" we can ship is:
//   1. Surface a one-click deep link that opens the theme editor with the
//      embed pre-toggled (merchant clicks Save).
//   2. Poll this read-only function from the connected UI to auto-detect
//      the moment the merchant saves, and flip the status without them
//      having to come back to our app.
//
// Read-only access uses the standard `read_themes` scope (no exemption) and
// the `theme.files` query introduced in Admin GraphQL 2024-10. We fetch the
// active theme's `config/settings_data.json`, parse `current.blocks`, and
// look for our `meta-pixel` block path with `disabled: false`.
//
// This is the same pattern Klaviyo, Triple Whale, and TrackBee use to drive
// the "Connected" pill in their dashboards once the merchant clicks Save.

const API_VERSION = "2025-10";

// The block path Shopify writes into settings_data.json when our embed is
// active. Format:
//   shopify://apps/<app-handle>/blocks/<block-name>/<extension-uuid>
// `<app-handle>` is the Partner-Dashboard slug (NOT the API key), and the
// extension UUID is the `uid` field in shopify.extension.toml.
const META_PIXEL_BLOCK_TYPE_RE =
  /^shopify:\/\/apps\/[^/]+\/blocks\/meta-pixel\/[a-f0-9-]+$/i;
const CART_RELAY_BLOCK_TYPE_RE =
  /^shopify:\/\/apps\/[^/]+\/blocks\/cart-identity-relay\/[a-f0-9-]+$/i;

function adminUrl(shop) {
  return `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
}

async function adminGraphQL(shop, accessToken, query, variables) {
  const res = await fetch(adminUrl(shop), {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    const msg =
      json.errors?.[0]?.message ?? `Theme admin call failed: ${res.status}`;
    throw new Error(msg);
  }
  return json.data;
}

// Fetch the active (published) theme's id. We never inspect draft themes —
// only the live theme matters for whether the embed is firing on visitor
// pageloads.
async function getMainThemeId(shop, accessToken) {
  const query = /* GraphQL */ `
    query MainTheme {
      themes(first: 1, roles: [MAIN]) {
        nodes { id name }
      }
    }
  `;
  const data = await adminGraphQL(shop, accessToken, query, {});
  return data?.themes?.nodes?.[0]?.id ?? null;
}

// Read-only fetch of `config/settings_data.json` from the live theme via the
// `theme.files` query. Returns the parsed JSON or null if the file can't be
// read for any reason (theme deleted, scope missing, parse error, etc.).
async function readSettingsData(shop, accessToken, themeId) {
  const query = /* GraphQL */ `
    query SettingsData($themeId: ID!) {
      theme(id: $themeId) {
        id
        files(filenames: ["config/settings_data.json"], first: 1) {
          nodes {
            filename
            body {
              ... on OnlineStoreThemeFileBodyText { content }
              ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
            }
          }
        }
      }
    }
  `;
  const data = await adminGraphQL(shop, accessToken, query, { themeId });
  const node = data?.theme?.files?.nodes?.[0];
  if (!node) return null;

  let raw = null;
  if (node.body?.content) {
    raw = node.body.content;
  } else if (node.body?.contentBase64) {
    raw = Buffer.from(node.body.contentBase64, "base64").toString("utf8");
  }
  if (!raw) return null;

  // settings_data.json ships with a leading `/* … */` comment block in some
  // themes — JSON.parse rejects it. Strip C-style comments before parsing.
  // We only strip leading-of-file comments to avoid corrupting anything inside
  // string values (which can't legally contain unescaped `*/` in JSON).
  const stripped = raw.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "");
  try {
    return JSON.parse(stripped);
  } catch (err) {
    console.error(
      `[theme-embed] failed to parse settings_data.json for ${shop}:`,
      err
    );
    return null;
  }
}

// Walk `current.blocks`, return the union of which of our two embeds are
// active. A block is "active" when:
//   - its `type` matches our embed path, AND
//   - `disabled !== true`
export function detectEmbedsInSettingsData(settings) {
  const result = { metaPixel: false, cartRelay: false };
  const blocks = settings?.current?.blocks ?? {};
  for (const key of Object.keys(blocks)) {
    const block = blocks[key];
    if (!block || typeof block !== "object") continue;
    if (block.disabled === true) continue;
    const type = block.type ?? "";
    if (META_PIXEL_BLOCK_TYPE_RE.test(type)) result.metaPixel = true;
    if (CART_RELAY_BLOCK_TYPE_RE.test(type)) result.cartRelay = true;
  }
  return result;
}

// Top-level: get embed activation status for the merchant's published theme.
// Returns { metaPixel: boolean, cartRelay: boolean, themeId: string|null,
// reason?: string } — `reason` is set on hard failures (e.g. scope missing)
// so the UI can surface a precise error instead of "unknown".
export async function getEmbedActivationStatus({ shop, accessToken }) {
  if (!accessToken) {
    return {
      metaPixel: false,
      cartRelay: false,
      themeId: null,
      reason: "no_access_token",
    };
  }

  let themeId = null;
  try {
    themeId = await getMainThemeId(shop, accessToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The most common error here is "Access denied — read_themes scope
    // required". Surface it cleanly so the UI can prompt re-auth.
    if (/access denied|scope/i.test(msg)) {
      return {
        metaPixel: false,
        cartRelay: false,
        themeId: null,
        reason: "missing_scope",
      };
    }
    return {
      metaPixel: false,
      cartRelay: false,
      themeId: null,
      reason: "themes_query_failed",
    };
  }
  if (!themeId) {
    return {
      metaPixel: false,
      cartRelay: false,
      themeId: null,
      reason: "no_main_theme",
    };
  }

  let settings = null;
  try {
    settings = await readSettingsData(shop, accessToken, themeId);
  } catch (err) {
    console.error(`[theme-embed] read failed for ${shop}:`, err);
    return {
      metaPixel: false,
      cartRelay: false,
      themeId,
      reason: "settings_read_failed",
    };
  }
  if (!settings) {
    return {
      metaPixel: false,
      cartRelay: false,
      themeId,
      reason: "settings_unavailable",
    };
  }

  const detected = detectEmbedsInSettingsData(settings);
  return { ...detected, themeId };
}
