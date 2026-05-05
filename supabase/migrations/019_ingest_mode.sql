-- ============================================================
-- Migration 019: ingest_mode (Shopify-direct fallback)
-- ============================================================
-- Adds the per-store data-source flag the dashboard adapter
-- (app/lib/stats-adapter.server.js) dispatches on. Two values:
--
--   'postex'          — existing flow. PostEx cron populates orders
--                       table; dashboard reads aggregates via RPC.
--                       Pakistani COD merchants. Default for legacy
--                       rows so this migration is zero-impact.
--
--   'shopify_direct'  — no logistics integration. orders table stays
--                       empty; dashboard hits Shopify Admin API live
--                       at request time with a 60s in-memory cache.
--                       For prepaid international merchants who don't
--                       use PostEx but still want the dashboard.
--
-- Switching modes later is supported but historical data is
-- mode-bound (PostEx aggregates ≠ Shopify aggregates by design —
-- different inclusion rules, different statuses). New data flows
-- through the new path; old data stays where it was.

ALTER TABLE stores
  ADD COLUMN ingest_mode text NOT NULL DEFAULT 'postex'
    CHECK (ingest_mode IN ('postex', 'shopify_direct'));

COMMENT ON COLUMN stores.ingest_mode IS
  'Data-source mode for the dashboard. postex = aggregate from orders table populated by PostEx cron. shopify_direct = live Shopify Admin API with caching (no courier integration).';
