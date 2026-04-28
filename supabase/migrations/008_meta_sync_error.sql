-- ============================================================
-- Migration 008: surface Meta cron failures to the merchant
-- ============================================================
-- Adds a single source of truth for "is the Meta sync currently broken."
-- Meta can invalidate a long-lived token before its stored expiry timestamp
-- (password change, FB security action), so meta_token_expires_at alone is
-- not enough to know whether the cron is actually working.
--
-- Both cron actions (api.cron.meta-today, api.cron.meta-finalize) write to
-- this column on every run: NULL on success, error message on failure. The
-- settings page and dashboard banner read it to decide whether to surface a
-- "Disconnected" state to the merchant. The OAuth meta_save action clears it
-- on reconnect.
--
-- Safe to re-run.

ALTER TABLE stores ADD COLUMN IF NOT EXISTS meta_sync_error TEXT;
