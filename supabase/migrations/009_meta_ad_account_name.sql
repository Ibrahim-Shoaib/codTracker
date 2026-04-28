-- ============================================================
-- Migration 009: store the connected Meta ad account's display name
-- ============================================================
-- We already store meta_ad_account_id (e.g. "act_1224674772151444") which is
-- opaque to merchants. Persist the human-readable name selected during OAuth
-- so the settings page can show "Trendy Homes Ads" instead of the raw id.
--
-- NULL is allowed for stores connected before this migration ran — the UI
-- falls back to the id until the merchant reconnects.
--
-- Safe to re-run.

ALTER TABLE stores ADD COLUMN IF NOT EXISTS meta_ad_account_name TEXT;
