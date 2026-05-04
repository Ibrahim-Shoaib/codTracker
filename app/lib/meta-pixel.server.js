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

// Resolve the client Business ID for a BISU token via a direct Graph call.
// Some FBL4B template variations issue a valid BISU but don't populate
// target_ids inside granular_scopes — we still need the Business ID to list
// datasets, so we query Meta directly using the system user id we got
// from debug_token.
//
// Tries multiple paths in order. Each path's full response is logged so
// future unexpected shapes are one log line away from being diagnosed.
export async function resolveClientBusinessId(accessToken, systemUserId) {
  // Path 1: GET /{system_user_id}?fields=business — Meta's documented path
  // for FBL4B Conversions-API templates.
  if (systemUserId) {
    try {
      const params = new URLSearchParams({
        fields: "id,name,business",
        access_token: accessToken,
      });
      const url = `${GRAPH_BASE}/${encodeURIComponent(systemUserId)}?${params}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      console.log(`[meta-pixel] resolve path1 GET /${systemUserId}?fields=business`, JSON.stringify(data));
      if (data?.business?.id) return data.business.id;
    } catch (err) {
      console.log("[meta-pixel] resolve path1 threw:", String(err));
    }
  }

  // Path 2: GET /me?fields=business — alternative form, some templates use it.
  try {
    const params = new URLSearchParams({
      fields: "id,name,business",
      access_token: accessToken,
    });
    const res = await fetch(`${GRAPH_BASE}/me?${params}`);
    const data = await res.json().catch(() => ({}));
    console.log("[meta-pixel] resolve path2 GET /me?fields=business", JSON.stringify(data));
    if (data?.business?.id) return data.business.id;
  } catch (err) {
    console.log("[meta-pixel] resolve path2 threw:", String(err));
  }

  // Path 3: query the system user with the App access token (not the BISU).
  // Some BISUs can't introspect their own owning Business, but the App can.
  if (systemUserId && process.env.META_APP_ID && process.env.META_APP_SECRET) {
    try {
      const appToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
      const params = new URLSearchParams({
        fields: "id,name,business",
        access_token: appToken,
      });
      const url = `${GRAPH_BASE}/${encodeURIComponent(systemUserId)}?${params}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      console.log(`[meta-pixel] resolve path3 GET /${systemUserId} (app token)`, JSON.stringify(data));
      if (data?.business?.id) return data.business.id;
    } catch (err) {
      console.log("[meta-pixel] resolve path3 threw:", String(err));
    }
  }

  // Path 4: list businesses the system user has access to.
  if (systemUserId) {
    try {
      const params = new URLSearchParams({
        fields: "id,name",
        access_token: accessToken,
      });
      const url = `${GRAPH_BASE}/${encodeURIComponent(systemUserId)}/businesses?${params}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      console.log(`[meta-pixel] resolve path4 GET /${systemUserId}/businesses`, JSON.stringify(data));
      if (data?.data?.[0]?.id) return data.data[0].id;
    } catch (err) {
      console.log("[meta-pixel] resolve path4 threw:", String(err));
    }
  }

  return null;
}

// ─── Business id extraction (cheapest path) ──────────────────────────────────

// Pull the granted Business id straight out of debug_token's granular_scopes.
// For FBL4B "Pixel Tracking" BISUs, the `business_management` scope's
// target_ids[0] is the merchant's Business Manager id — Meta exposes it here
// even when the BISU has no other way to introspect itself (e.g. when it's a
// "client" system user shared in from another business).
//
// This was the workhorse path in the original implementation. It's the one
// that matters for FBL4B Conversions API templates: the business_id lets us
// call /{business}/owned_pixels + /{business}/client_pixels and find the
// granted Pixel reliably.
//
// `profile_id` is a legacy fallback used by older FBL templates that set the
// Business id at the top level of debug_token's response.
export function extractBusinessId(tokenInfo) {
  const scopes = tokenInfo?.granular_scopes ?? [];
  // Prefer business_management — its target_ids[0] is the canonical Business id.
  for (const s of scopes) {
    if (s?.scope === "business_management" && s?.target_ids?.length) {
      return String(s.target_ids[0]);
    }
  }
  // Some legacy tokens still set profile_id at the top level.
  if (tokenInfo?.profile_id) return String(tokenInfo.profile_id);
  return null;
}

// ─── Pixel auto-discovery (preferred path) ───────────────────────────────────

// Probe the BISU token directly for the granted Pixel(s). This works WITHOUT
// needing a business_id, which is the right primitive for FBL4B "Pixel
// Tracking" templates — the BISU is scoped to the asset (Pixel), not to a
// Business Manager.
//
// Strategy:
//   1. Walk every `target_id` across all `granular_scopes` returned by
//      debug_token. For Pixel-Tracking BISUs the granted Pixel ID typically
//      shows up as a target_id under one of the scopes (commonly
//      `ads_management` or a dedicated Pixel scope).
//   2. For each candidate that looks like a numeric Meta asset id (15–17
//      digits), probe `GET /{id}?fields=id,name,last_fired_time` with the
//      BISU. If the response is 200 and shape matches a Pixel/Dataset, keep it.
//   3. De-dup by id, return the verified set.
//
// This replaces the legacy "find business_id → list owned/client_pixels"
// path for any BISU where business resolution fails (the common case for
// non-business-owned Pixels).
export async function discoverPixelsFromBISU(accessToken, tokenInfo) {
  const seen = new Set();
  const candidateIds = [];
  const scopes = tokenInfo?.granular_scopes ?? [];
  for (const s of scopes) {
    const ids = s?.target_ids ?? [];
    for (const id of ids) {
      const v = String(id).trim();
      // Pixel/Dataset ids are 15–17 digit numeric strings. Ad account ids
      // (act_xxx) and business ids (10-digit) are filtered out by this regex.
      if (!/^\d{14,18}$/.test(v)) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      candidateIds.push(v);
    }
  }

  if (!candidateIds.length) return [];

  // Probe each candidate concurrently. Endpoints that return non-Pixel objects
  // (e.g. a business id snuck through the digit filter) just don't have the
  // expected shape and get filtered out — no need to be clever about which
  // type each id is up front.
  const results = await Promise.all(
    candidateIds.map(async (id) => {
      try {
        const params = new URLSearchParams({
          fields: "id,name,last_fired_time",
          access_token: accessToken,
        });
        const res = await fetch(`${GRAPH_BASE}/${id}?${params}`);
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        // A real Pixel response always has id matching what we queried.
        // Datasets also expose `last_fired_time` (we requested it). If the
        // returned object lacks it, it's probably a different asset type.
        if (!data?.id || data.id !== id) return null;
        return {
          id: data.id,
          name: data.name ?? null,
          last_fired_time: data.last_fired_time ?? null,
          owned: true,
        };
      } catch {
        return null;
      }
    })
  );

  return results.filter(Boolean);
}

// ─── Business assets (legacy path — kept as fallback) ────────────────────────

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
