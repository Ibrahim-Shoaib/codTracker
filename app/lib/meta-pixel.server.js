// Meta Pixel Tracking — Facebook Login for Business (FBL4B) flow + Graph helpers.
//
// Distinct from app/lib/meta.server.js, which handles the older `ads_read`
// user-token flow used for spend reporting. This module handles the newer
// FBL4B configuration that issues Business Integration System User (BISU)
// tokens. BISU tokens never expire and have permission on the merchant's
// dataset (pixel) — they're the right token type for production Conversions
// API relay.
//
// Flow:
//   1. /auth/meta-pixel  → builds the FBL4B dialog URL with config_id
//   2. user grants access in Meta's UI → Meta redirects with ?code=...
//   3. /auth/meta-pixel/callback → exchangeCodeForBISU(code)
//   4. listDatasets(token, business_id) → merchant picks one
//   5. saved + Web Pixel installed via Admin GraphQL

const GRAPH_VERSION = "v24.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DIALOG_BASE = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

// Configuration ID from Meta App Dashboard → Facebook Login for Business →
// Configurations → "Pixel Tracking" (created from the Conversions API template).
// Permissions baked in: ads_read, ads_management, business_management.
// Asset types: Ad accounts (ANALYZE) + Pixels (MANAGE), both required.
function getConfigId() {
  const id = process.env.META_PIXEL_CONFIG_ID;
  if (!id) {
    throw new Error(
      "META_PIXEL_CONFIG_ID is not set. Add the Pixel Tracking config_id from Meta App Dashboard."
    );
  }
  return id;
}

function getRedirectUri() {
  const uri = process.env.META_PIXEL_REDIRECT_URI;
  if (!uri) {
    throw new Error(
      "META_PIXEL_REDIRECT_URI is not set. Set it to {SHOPIFY_APP_URL}/auth/meta-pixel/callback."
    );
  }
  return uri;
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

// Build the FBL4B dialog URL. The merchant lands here, Meta walks them
// through Business + Pixel selection, then redirects back with ?code=...
export function getMetaPixelAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    config_id: getConfigId(),
    redirect_uri: getRedirectUri(),
    response_type: "code",
    state,
    override_default_response_type: "true",
  });
  return `${DIALOG_BASE}?${params}`;
}

// Exchange the auth code for a BISU access token (no expiry).
// Returns { access_token, token_type } — note that expires_in is 0/missing
// for BISU tokens since they're long-lived.
export async function exchangeCodeForBISU(code) {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    redirect_uri: getRedirectUri(),
    code,
  });
  const res = await fetch(`${GRAPH_BASE}/oauth/access_token?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      `Meta BISU exchange failed: ${err.error?.message ?? res.status}`
    );
  }
  return res.json();
}

// Inspect the BISU token to find the granted business_id and the user_id of
// the system user. Used to scope subsequent dataset / ad-account queries.
export async function debugToken(accessToken) {
  const params = new URLSearchParams({
    input_token: accessToken,
    access_token: `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`,
  });
  const res = await fetch(`${GRAPH_BASE}/debug_token?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Meta debug_token failed: ${err.error?.message ?? res.status}`);
  }
  const data = await res.json();
  // Shape: { data: { app_id, type, application, expires_at, is_valid, scopes,
  //                  user_id, profile_id (business id for system users), ... } }
  return data.data ?? {};
}

// Fetch the granular permission grants on the BISU token. We use this to
// confirm the merchant actually granted Pixel + ads_management before saving.
export async function listGranularScopes(accessToken) {
  const res = await fetch(
    `${GRAPH_BASE}/me/permissions?access_token=${encodeURIComponent(accessToken)}`
  );
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return data.data ?? [];
}

// ─── Business assets ──────────────────────────────────────────────────────────

// List all datasets (a.k.a. pixels) owned by the business associated with the
// BISU token. Merchant picks one in the UI.
export async function listDatasets(accessToken, businessId) {
  const params = new URLSearchParams({
    fields: "id,name,code,last_fired_time",
    access_token: accessToken,
    limit: "100",
  });
  // Owned + client (shared-in) pixels — merge both lists.
  const [ownedRes, clientRes] = await Promise.all([
    fetch(`${GRAPH_BASE}/${businessId}/owned_pixels?${params}`),
    fetch(`${GRAPH_BASE}/${businessId}/client_pixels?${params}`),
  ]);

  const owned = ownedRes.ok ? (await ownedRes.json()).data ?? [] : [];
  const client = clientRes.ok ? (await clientRes.json()).data ?? [] : [];

  // Dedupe by id; mark ownership for the UI.
  const seen = new Set();
  const out = [];
  for (const p of owned) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      out.push({ ...p, owned: true });
    }
  }
  for (const p of client) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      out.push({ ...p, owned: false });
    }
  }
  return out;
}

// List ad accounts the business has — surfaced for cross-reference in the UI
// (e.g. "this dataset is used by ad account act_123 spending PKR 4,500/day").
export async function listAdAccounts(accessToken, businessId) {
  const params = new URLSearchParams({
    fields: "id,name,currency,account_status",
    access_token: accessToken,
    limit: "100",
  });
  const res = await fetch(`${GRAPH_BASE}/${businessId}/owned_ad_accounts?${params}`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return data.data ?? [];
}

// ─── Token revocation ─────────────────────────────────────────────────────────

// Revoke the BISU token's access to the dataset (DELETE /me/permissions).
// Best-effort — even if this fails, we still clear the local DB row.
export async function revokeBISU(accessToken) {
  try {
    const res = await fetch(
      `${GRAPH_BASE}/me/permissions?access_token=${encodeURIComponent(accessToken)}`,
      { method: "DELETE" }
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ─── EMQ (Event Match Quality) ────────────────────────────────────────────────

// Fetch per-event EMQ for the past N days for a dataset. Returns null if the
// dataset is too new (no events yet) — Meta returns 400 in that case.
export async function fetchEMQ(accessToken, datasetId) {
  const params = new URLSearchParams({
    access_token: accessToken,
    aggregation: "event_match_quality_per_event_name",
  });
  const res = await fetch(`${GRAPH_BASE}/${datasetId}/stats?${params}`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.data ?? null;
}
