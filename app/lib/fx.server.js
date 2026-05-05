// FX rate cache + on-demand fetcher. Used at INGEST time by the Meta
// spend pipeline when the ad account's currency differs from the
// store's currency (e.g. a Pakistani merchant who set up their Meta
// ad account in USD).
//
// Stripe-style architecture: convert ONCE at the moment of ingest,
// store the converted amount in ad_spend.amount, and never touch FX
// at display time. This freezes historical numbers — yesterday's
// "Rs 50,000" stays Rs 50,000 even if the USD/PKR rate moves
// tomorrow. The dashboard renders directly from store currency.
//
// Source: open.er-api.com/v6/latest/<base> — free, no API key, daily
// updates. Returns `rates: { PKR: 281.5, EUR: 0.92, ... }`.
//
// Cache layer: fx_rates table, one row per (base, quote) pair,
// refreshed lazily. Stale-rate policy:
//   - Fresh (<24h): use directly
//   - Stale (24h–7d): use but log a warning
//   - Very stale (>7d): use but flag for surfacing in UI
//   - Missing: live fetch from open.er-api; on failure fall back to
//     stale cache; on full failure return null and let caller decide

import { createClient } from "@supabase/supabase-js";

function adminClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

const FX_API = "https://open.er-api.com/v6/latest";
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h
const VERY_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7d
const FETCH_TIMEOUT_MS = 5_000;

function ageMs(fetchedAt) {
  return Date.now() - new Date(fetchedAt).getTime();
}

async function refreshRates(base) {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${FX_API}/${base}`, { signal: ctl.signal });
    if (!res.ok) {
      console.warn(`[fx] ${base} fetch failed HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    if (json?.result !== "success" || !json.rates) {
      console.warn(`[fx] ${base} response shape unexpected`, json?.result);
      return null;
    }
    const supabase = adminClient();
    const rows = [];
    for (const [quote, rate] of Object.entries(json.rates)) {
      if (!Number.isFinite(rate) || rate <= 0) continue;
      rows.push({ base, quote, rate, fetched_at: new Date().toISOString() });
    }
    if (rows.length) {
      await supabase.from("fx_rates").upsert(rows, { onConflict: "base,quote" });
    }
    return json.rates;
  } catch (err) {
    console.warn(`[fx] ${base} fetch error:`, err?.message ?? err);
    return null;
  } finally {
    clearTimeout(tid);
  }
}

async function readCachedRate(base, quote) {
  const supabase = adminClient();
  const { data } = await supabase
    .from("fx_rates")
    .select("rate, fetched_at")
    .eq("base", base)
    .eq("quote", quote)
    .maybeSingle();
  return data ?? null;
}

// Get rate from `from` to `to`. Returns
//   { rate, fetchedAt, source: "cache"|"live"|"identity", stale: boolean }
// or null on no-data.
export async function getFxRate(from, to) {
  const f = String(from || "").toUpperCase();
  const t = String(to || "").toUpperCase();
  if (!f || !t) return null;
  if (f === t) {
    return { rate: 1, fetchedAt: new Date().toISOString(), source: "identity", stale: false };
  }

  let cached = await readCachedRate(f, t);
  if (cached && ageMs(cached.fetched_at) < STALE_AFTER_MS) {
    return { rate: Number(cached.rate), fetchedAt: cached.fetched_at, source: "cache", stale: false };
  }

  const rates = await refreshRates(f);
  if (rates && rates[t] != null) {
    return { rate: Number(rates[t]), fetchedAt: new Date().toISOString(), source: "live", stale: false };
  }

  if (cached) {
    const stale = ageMs(cached.fetched_at) > VERY_STALE_AFTER_MS;
    if (stale) {
      console.warn(
        `[fx] ${f}→${t} using very-stale rate (age ${Math.round(ageMs(cached.fetched_at) / 86400000)}d)`
      );
    }
    return { rate: Number(cached.rate), fetchedAt: cached.fetched_at, source: "cache", stale };
  }

  // Last resort: invert reverse-direction cached rate.
  const inverse = await readCachedRate(t, f);
  if (inverse && Number(inverse.rate) > 0) {
    return {
      rate: 1 / Number(inverse.rate),
      fetchedAt: inverse.fetched_at,
      source: "cache",
      stale: ageMs(inverse.fetched_at) > VERY_STALE_AFTER_MS,
    };
  }

  return null;
}

// Convert `amount` from `from` to `to`. Identity passthrough when
// from===to. Returns { amount, rate, fetchedAt, source, stale } or
// { amount: null, ... } on FX failure.
export async function convertAmount(amount, from, to) {
  const r = await getFxRate(from, to);
  if (!r) return { amount: null, rate: null, fetchedAt: null, source: null, stale: true };
  return {
    amount: Number(amount ?? 0) * r.rate,
    rate: r.rate,
    fetchedAt: r.fetchedAt,
    source: r.source,
    stale: r.stale,
  };
}
