-- ============================================================
-- Migration 027: per-store timezone
-- ============================================================
-- Every "what day is it" decision (dashboard Today/Yesterday/MTD cards,
-- trend & stats APIs, Meta ad-spend crons, and the RPC day-bucketing) used
-- to assume Pakistan time (PKT, UTC+5). That is wrong for any store in a
-- different country — e.g. the GBP/UK store, whose day was rolling over at
-- PKT midnight.
--
-- This column is the source of truth for a store's local calendar day. It is
-- an IANA zone name (e.g. 'Asia/Karachi', 'Europe/London') so the app and the
-- RPCs can compute DST-correct day boundaries via Intl / AT TIME ZONE.
--
-- Default 'Asia/Karachi' keeps legacy rows byte-identical to the previous PKT
-- behaviour — same zero-impact pattern migration 018 used for currency. New
-- installs populate it from Shopify shop.json (iana_timezone) in afterAuth.

ALTER TABLE stores
  ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Karachi';

COMMENT ON COLUMN stores.timezone IS
  'IANA timezone from Shopify shop.json (iana_timezone), e.g. Asia/Karachi, Europe/London. Source of truth for the store''s local calendar day in both the app (dates.server.js) and the dashboard RPCs (AT TIME ZONE).';

-- Backfill the one known non-PKT store. Currency was already GBP for it; the
-- timezone is Europe/London. Every other existing row is a PKR/Pakistan store
-- and correctly keeps the Asia/Karachi default.
UPDATE stores SET timezone = 'Europe/London'
  WHERE store_id = '0rq01u-da.myshopify.com';
