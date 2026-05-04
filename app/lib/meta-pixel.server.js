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
//
// Returns the full Meta response (NOT just access_token). For FBL4B
// "Pixel Tracking" / Conversions API templates, this can also include
// `client_business_id` — the canonical Business id we'd otherwise have to
// resolve via debug_token.granular_scopes. The callback should consume
// every key it can.
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
  const body = await res.json();
  // Log the response shape (minus the actual token) so future template
  // changes are immediately visible in Railway logs.
  const safe = { ...body };
  if (typeof safe.access_token === "string") {
    safe.access_token = safe.access_token.slice(0, 8) + "…";
  }
  console.log("[meta-pixel] BISU exchange response (token redacted):", safe);
  return body;
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

// ─── Pixel auto-discovery (granular_scopes-driven) ───────────────────────────

// For FBL4B "Pixel Tracking" / Conversions API templates, Meta exposes the
// merchant's granted Pixel/Dataset IDs as `target_ids` inside debug_token's
// `granular_scopes` array — specifically under the `ads_management` and/or
// `business_management` scope entries (Meta's official Get Started docs +
// confirmed by the AdsPixel SDK schema).
//
// The BISU's own `user_id` is NOT a Pixel — it's the auto-provisioned
// system-user id Meta creates for the app on first grant. Its query shape
// happens to coincide with a Pixel's "no `business` field" error pattern,
// which is misleading; do NOT treat user_id as a Pixel candidate.
//
// Validation: probe each candidate via `GET /{id}?fields=id,name,owner_business`.
//   - If it's a Pixel/Dataset: 200 with { id, name, owner_business: { id, name } }.
//   - If it's a Business / SystemUser / Ad-account: 400 with
//     "Tried accessing nonexisting field (owner_business)" — clean drop.
// `owner_business` is the safest single discriminator per Meta's AdsPixel
// schema. `last_fired_time` is also Pixel-only but null for fresh pixels and
// some templates omit it; `owner_business` is always present.
export async function discoverPixelsFromBISU(accessToken, tokenInfo) {
  const seen = new Set();
  const candidateIds = [];

  function addCandidate(maybeId) {
    if (maybeId == null) return;
    const v = String(maybeId).trim();
    // Numeric ids only. Length filter is permissive (10–20) — the probe is
    // the real gate, the regex just keeps obvious non-asset strings out
    // (e.g. `act_<n>` ad-account ids, app GIDs).
    if (!/^\d{10,20}$/.test(v)) return;
    if (seen.has(v)) return;
    seen.add(v);
    candidateIds.push(v);
  }

  // Walk every target_id across every scope. Don't restrict to specific
  // scope names — Meta's template variants put the Pixel id under different
  // scopes (sometimes `ads_management`, sometimes `business_management`,
  // occasionally a dedicated pixel scope). Probing them all is cheap and
  // future-proof.
  const scopes = tokenInfo?.granular_scopes ?? [];
  for (const s of scopes) {
    for (const id of s?.target_ids ?? []) {
      addCandidate(id);
    }
  }

  if (!candidateIds.length) return [];

  const results = await Promise.all(
    candidateIds.map(async (id) => {
      try {
        const params = new URLSearchParams({
          fields: "id,name,owner_business",
          access_token: accessToken,
        });
        const res = await fetch(`${GRAPH_BASE}/${id}?${params}`);
        if (!res.ok) {
          // Optional verbose-debug hook — surface the actual rejection
          // shape so Railway logs let us spot future template changes.
          try {
            const errBody = await res.json();
            console.log(
              `[meta-pixel] candidate ${id} rejected: ${
                errBody?.error?.message ?? `HTTP ${res.status}`
              }`
            );
          } catch {
            /* swallow */
          }
          return null;
        }
        const data = await res.json().catch(() => null);
        if (!data?.id || String(data.id) !== id) return null;
        // owner_business present (or even null) confirms Pixel object type.
        // If the field came back at all in the response, it's a Pixel — Meta
        // wouldn't have returned 200 if owner_business didn't exist on the
        // schema (that's the "nonexisting field" 400 case above).
        return {
          id: String(data.id),
          name: data.name ?? null,
          owner_business: data.owner_business ?? null,
          owned: true,
        };
      } catch (err) {
        console.log(
          `[meta-pixel] candidate ${id} probe threw:`,
          String(err?.message ?? err)
        );
        return null;
      }
    })
  );

  return results.filter(Boolean);
}

// ─── Ad-account-driven discovery ──────────────────────────────────────────────

// For FBL4B "Pixel Tracking" templates that issue an Admin System User BISU
// (one system user per app, NOT per merchant), the granted Pixel is NOT
// exposed through:
//   - granular_scopes target_ids  (Meta returns scopes with no targets)
//   - /me/businesses              (returns empty, no business binding)
//   - /{system_user_id}?fields=business  (System User has no `business` field)
//
// But the BISU's `ads_read` permission lets it list ad accounts assigned to
// it via /me/adaccounts, and from each ad account we can pull its associated
// AdsPixels via /{ad_account_id}/adspixels. This is the documented path
// per Meta's Marketing API reference.
//
// Returns array of { id, name } for every Pixel found across every accessible
// ad account, deduped.
export async function discoverPixelsViaAdAccounts(accessToken) {
  // Step 1: list ad accounts the BISU can read.
  const accountsParams = new URLSearchParams({
    fields: "id,name",
    access_token: accessToken,
    limit: "100",
  });
  let accountsBody;
  try {
    const res = await fetch(`${GRAPH_BASE}/me/adaccounts?${accountsParams}`);
    accountsBody = await res.json().catch(() => null);
    console.log(
      `[meta-pixel] /me/adaccounts (status ${res.status}):`,
      JSON.stringify(accountsBody)
    );
    if (!res.ok) return [];
  } catch (err) {
    console.log("[meta-pixel] /me/adaccounts threw:", String(err));
    return [];
  }

  const accounts = accountsBody?.data ?? [];
  if (!accounts.length) return [];

  // Step 2: for each ad account, list its associated AdsPixels in parallel.
  const seen = new Set();
  const out = [];
  await Promise.all(
    accounts.map(async (acc) => {
      try {
        const params = new URLSearchParams({
          fields: "id,name,owner_business",
          access_token: accessToken,
          limit: "100",
        });
        const res = await fetch(`${GRAPH_BASE}/${acc.id}/adspixels?${params}`);
        const body = await res.json().catch(() => null);
        console.log(
          `[meta-pixel] /${acc.id}/adspixels (status ${res.status}):`,
          JSON.stringify(body)
        );
        if (!res.ok) return;
        for (const p of body?.data ?? []) {
          const id = String(p?.id ?? "");
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push({
            id,
            name: p?.name ?? null,
            owner_business: p?.owner_business ?? null,
            owned: true,
            via_ad_account: acc.id,
          });
        }
      } catch (err) {
        console.log(
          `[meta-pixel] /${acc.id}/adspixels threw:`,
          String(err)
        );
      }
    })
  );

  return out;
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
