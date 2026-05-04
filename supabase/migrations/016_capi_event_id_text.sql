-- ============================================================
-- Migration 016: capi_* event_id columns are TEXT, not UUID
-- ============================================================
-- Migration 015 typed `event_id` as `uuid` on both `capi_retries` and
-- `capi_delivery_log`. That was a mistake: our CAPI events use deterministic
-- string IDs of the form `<event>:<shop>:<resource>` (e.g.
-- `purchase:my-store.myshopify.com:5512345678`). Meta's CAPI accepts any
-- string ≤ 100 chars; UUID-format ids are merely one option.
--
-- The bug: every successful CAPI delivery silently failed to log because the
-- INSERT into capi_delivery_log rejected the non-UUID value. The dashboard's
-- "Recent events" tail was empty for that reason — no client-facing
-- corruption, but the merchant couldn't see anything was firing.
--
-- This migration:
--   - drops the unique index on capi_retries.event_id (re-created at end)
--   - alters event_id to TEXT NOT NULL on both tables
--   - re-creates the unique index (TEXT works the same as UUID for dedup)

ALTER INDEX IF EXISTS idx_capi_retries_event_id RENAME TO idx_capi_retries_event_id_legacy;

ALTER TABLE capi_retries
  ALTER COLUMN event_id TYPE text USING event_id::text;

ALTER TABLE capi_delivery_log
  ALTER COLUMN event_id TYPE text USING event_id::text;

DROP INDEX IF EXISTS idx_capi_retries_event_id_legacy;
CREATE UNIQUE INDEX idx_capi_retries_event_id ON capi_retries(event_id);
