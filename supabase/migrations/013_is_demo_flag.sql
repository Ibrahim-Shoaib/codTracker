-- ============================================================
-- Migration 013: stores.is_demo flag
-- ============================================================
-- Marks a store as a demo: its data is fabricated locally instead of
-- pulled from PostEx, and the Meta cron skips it (the real OAuth is still
-- performed during onboarding so the connected-account UX is intact, but
-- no Meta API calls are made afterwards).
--
-- Default false + NOT NULL → existing stores are unaffected. Every code
-- path that branches on this flag treats `false` (the default) as the
-- real-merchant path, so this column is purely additive.

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

-- Cron filters use `WHERE is_demo = false` (or `<> true`) — index supports
-- the common case where there are far more real stores than demo stores.
CREATE INDEX IF NOT EXISTS idx_stores_is_demo ON stores(is_demo) WHERE is_demo = true;
