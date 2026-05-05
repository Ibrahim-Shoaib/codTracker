-- ============================================================
-- Migration 018: Store currency + FX rate cache
-- ============================================================
-- Adds the per-store currency settings the dashboard needs to render
-- money in the merchant's actual currency (instead of hardcoded PKR),
-- AND the FX rate cache the meta-spend pipeline uses to convert ad
-- spend at INGEST TIME when the ad account currency differs from
-- the store currency.
--
-- Architecture: convert-at-ingest (Stripe-style frozen historical
-- rates). Cron pulls Meta spend in account currency, converts to
-- store currency using today's FX rate, stores converted amount in
-- ad_spend.amount. Display is then trivial — no FX at render time,
-- no historical-number drift as FX moves.
--
-- Defaults are PKR / "Rs.{{amount}}" because:
--   - All currently-installed stores are PKR (verified via Shopify
--     shop.json on each existing store_id).
--   - Existing dashboard hardcoded "PKR" / "Rs." expects PKR rendering.
--   - Backfilling defaults this way means migration is zero-impact for
--     legacy rows. Non-PKR merchants are populated by the install
--     hook (new installs) and the backfill script (existing onboards).

ALTER TABLE stores
  ADD COLUMN currency text NOT NULL DEFAULT 'PKR',
  ADD COLUMN money_format text NOT NULL DEFAULT 'Rs.{{amount}}',
  ADD COLUMN meta_ad_account_currency text;

COMMENT ON COLUMN stores.currency IS
  'ISO 4217 code from Shopify shop.json (e.g. PKR, USD, EUR). Source of truth for dashboard money rendering.';
COMMENT ON COLUMN stores.money_format IS
  'Shopify money_format template (e.g. "Rs.{{amount}}", "${{amount}}"). Used as a fallback hint; primary rendering uses Intl.NumberFormat.';
COMMENT ON COLUMN stores.meta_ad_account_currency IS
  'ISO 4217 code from Meta /act_*/?fields=currency. When != stores.currency, the spend converter (app/lib/meta.server.js fetchSpendInStoreCurrency) applies an FX conversion at ingest time using fx_rates.';


-- ============================================================
-- fx_rates — daily-cached exchange rates
-- ============================================================
-- Source: open.er-api.com/v6/latest/<base>. Free, no API key, daily
-- updates. We cache one row per (base, quote) — keyed for fast lookup.
-- The on-demand fetcher in app/lib/fx.server.js refreshes when cache
-- is stale (>24h) and falls back to last-known-good rate when the
-- live API is unavailable.
--
-- Design: rates are stored as `1 base = rate * quote`. So to convert
-- amount from currency A → currency B:
--   rate(A→B) = fx_rates.rate WHERE base=A AND quote=B
--   converted = amount * rate
--
-- Identity rates (USD→USD = 1.0) are NOT inserted; the converter
-- short-circuits at the same-code check.

CREATE TABLE fx_rates (
  base       text NOT NULL,
  quote      text NOT NULL,
  rate       numeric(20,10) NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (base, quote)
);

CREATE INDEX idx_fx_rates_fetched ON fx_rates(fetched_at DESC);

-- fx_rates is shared across all stores (FX is global). RLS is
-- intentionally permissive: read-only SELECT for all authenticated
-- contexts; writes happen only via the service-role client.
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fx_rates_readable_to_all"
  ON fx_rates FOR SELECT USING (true);
