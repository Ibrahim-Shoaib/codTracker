-- ============================================================
-- Migration: COGS match source + per-store match lock
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================

-- orders: track WHICH matching tier produced the COGS
-- 'none'  = no match  (cogs_matched=false)
-- 'sku'   = tier 1: exact SKU
-- 'exact' = tier 2: exact normalized title/variant
-- 'fuzzy' = tier 3: fuzzy title  (shown to merchant for review)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS cogs_match_source text DEFAULT 'none'
  CHECK (cogs_match_source IN ('none','sku','exact','fuzzy'));

-- Backfill source based on the legacy boolean, so existing matched rows
-- read as 'exact' (they were produced by the old exact-title matcher).
UPDATE orders
  SET cogs_match_source = CASE
        WHEN cogs_matched THEN 'exact'
        ELSE 'none'
      END
  WHERE cogs_match_source IS NULL
     OR (cogs_matched = true  AND cogs_match_source = 'none')
     OR (cogs_matched = false AND cogs_match_source <> 'none');

-- stores: per-store mutex so that concurrent save/cron/manual rematches
-- don't race on the same rows.
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS cogs_match_in_progress boolean DEFAULT false;

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS cogs_match_started_at timestamptz;

-- Index so the dashboard "N fuzzy / N unmatched" counts stay cheap.
CREATE INDEX IF NOT EXISTS idx_orders_store_match_source
  ON orders(store_id, cogs_match_source);
