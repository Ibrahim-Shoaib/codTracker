const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE    = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DIALOG_BASE   = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

// ─── OAuth ────────────────────────────────────────────────────────────────────

export function getMetaAuthUrl(state) {
  const params = new URLSearchParams({
    client_id:     process.env.META_APP_ID,
    redirect_uri:  process.env.META_REDIRECT_URI,
    scope:         'ads_read',
    response_type: 'code',
    state,
  });
  return `${DIALOG_BASE}?${params}`;
}

// Exchanges the OAuth code for a long-lived token (valid ~60 days).
// Step 1: code → short-lived token
// Step 2: short-lived → long-lived token
export async function exchangeCodeForToken(code) {
  // Step 1: code → short-lived token
  const shortParams = new URLSearchParams({
    client_id:     process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    redirect_uri:  process.env.META_REDIRECT_URI,
    code,
  });
  const shortRes = await fetch(`${GRAPH_BASE}/oauth/access_token?${shortParams}`);
  if (!shortRes.ok) {
    const err = await shortRes.json().catch(() => ({}));
    throw new Error(`Meta token exchange failed: ${err.error?.message ?? shortRes.status}`);
  }
  const { access_token: shortToken } = await shortRes.json();

  // Step 2: short-lived → long-lived token (~60 days)
  const longParams = new URLSearchParams({
    grant_type:          'fb_exchange_token',
    client_id:           process.env.META_APP_ID,
    client_secret:       process.env.META_APP_SECRET,
    fb_exchange_token:   shortToken,
  });
  const longRes = await fetch(`${GRAPH_BASE}/oauth/access_token?${longParams}`);
  if (!longRes.ok) {
    const err = await longRes.json().catch(() => ({}));
    throw new Error(`Meta long-lived token exchange failed: ${err.error?.message ?? longRes.status}`);
  }
  const { access_token, expires_in } = await longRes.json();
  return { access_token, expires_in }; // expires_in in seconds (~5_183_944 ≈ 60 days)
}

// Returns ad accounts the user has access to — shown as dropdown in onboarding step 2
export async function getAdAccounts(accessToken) {
  const params = new URLSearchParams({
    fields:       'id,name,currency,account_status',
    access_token: accessToken,
  });
  const res = await fetch(`${GRAPH_BASE}/me/adaccounts?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Meta getAdAccounts failed: ${err.error?.message ?? res.status}`);
  }
  const data = await res.json();
  return data.data || []; // [{ id: 'act_123', name: '...' }, ...]
}

// ─── Spend data ───────────────────────────────────────────────────────────────

// Returns total spend (number, PKR) for the given date range.
// sinceDate / untilDate: 'YYYY-MM-DD' strings in PKT
export async function fetchSpend(accessToken, adAccountId, sinceDate, untilDate) {
  const timeRange = JSON.stringify({ since: sinceDate, until: untilDate });
  const params = new URLSearchParams({
    fields:       'spend',
    time_range:   timeRange,
    level:        'account',
    access_token: accessToken,
  });
  const res = await fetch(`${GRAPH_BASE}/${adAccountId}/insights?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Meta fetchSpend failed: ${err.error?.message ?? res.status}`);
  }
  const data = await res.json();
  return Number(data.data?.[0]?.spend ?? 0);
}

// Returns per-day spend array for a date range.
// Follows paging.next so chunks larger than Meta's default page size return fully.
// Returns [{ date: 'YYYY-MM-DD', spend: number }, ...]
export async function fetchDailySpend(accessToken, adAccountId, sinceDate, untilDate) {
  const timeRange = JSON.stringify({ since: sinceDate, until: untilDate });
  const params = new URLSearchParams({
    fields:         'spend',
    time_range:     timeRange,
    time_increment: '1',
    level:          'account',
    limit:          '500',
    access_token:   accessToken,
  });
  let url = `${GRAPH_BASE}/${adAccountId}/insights?${params}`;
  const out = [];
  // Hard cap to prevent runaway pagination on a malformed cursor.
  for (let page = 0; page < 50 && url; page++) {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Meta fetchDailySpend failed: ${err.error?.message ?? res.status}`);
    }
    const data = await res.json();
    for (const d of (data.data ?? [])) {
      out.push({ date: d.date_start, spend: Number(d.spend ?? 0) });
    }
    url = data.paging?.next ?? null;
  }
  return out;
}

// ─── Token expiry helpers ─────────────────────────────────────────────────────

export function isTokenExpired(metaTokenExpiresAt) {
  if (!metaTokenExpiresAt) return false;
  return new Date(metaTokenExpiresAt) <= new Date();
}

export function isTokenExpiringSoon(metaTokenExpiresAt) {
  if (!metaTokenExpiresAt) return false;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return new Date(metaTokenExpiresAt) <= new Date(Date.now() + sevenDaysMs);
}
