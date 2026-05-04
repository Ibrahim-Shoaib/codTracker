-- ============================================================
-- Migration 017: Cross-session visitor identity store
-- ============================================================
-- Foundation for the multi-session attribution feature. Without this,
-- the CAPI Purchase event is enriched only from the live order webhook
-- payload — anything captured in earlier sessions (the original ad
-- click's fbc, intermediate fbp rotations, an email seen at a
-- pre-checkout step) is invisible at conversion time.
--
-- With this:
--   1. Every storefront page load hits /apps/tracking/config which
--      mints (or recognizes) a `cod_visitor_id` cookie via Set-Cookie
--      HTTP header — same-origin first-party context, so Safari ITP
--      grants the full Max-Age (1 year) instead of truncating to 7
--      days the way it does for `document.cookie`-set cookies.
--   2. Every event POST to /apps/tracking/track UPSERTs the visitor's
--      row with latest fbp/fbc/ip/ua + any newly-hashed email/phone.
--      fbc_history accumulates as a jsonb array so a visitor who
--      clicks two ads days apart keeps both click_ids.
--   3. The theme block also writes `_cod_visitor_id` into Shopify cart
--      attributes via /cart/update.js, so it rides through to the
--      order webhook payload. The Purchase webhook handler joins on
--      visitor_id and merges enriched fields into user_data BEFORE
--      firing CAPI — Meta receives the union of every signal we ever
--      saw for that visitor, not just what's in the live order.
--
-- Retention design:
--   - visitor_events: 30-day raw trail. After 30d the per-event detail
--     is gone but the parent visitors row keeps the aggregated
--     identity columns. 30d covers Meta's longest attribution window
--     (28d) plus a buffer.
--   - visitors: 180-day rolling, indexed on last_seen_at. Pruned when
--     a visitor stops returning. 180d = 6× Meta's max attribution
--     window, comfortable for COD slow-burn purchases.
--   - All hashed PII at rest (privacy-safe for indefinite retention),
--     raw IP/UA only on the latest_* columns (not in event detail).
--
-- Scaled estimate: at 1000 storefront page views/day per shop, the
-- event table grows ~30k rows/30d/shop. With 1000 merchants that's
-- ~30M rows steady-state — index-friendly, well within Supabase free
-- tier. visitors table is much smaller (one row per unique browser).

-- ============================================================
-- visitors
-- ============================================================
-- One row per unique cod_visitor_id (per-browser-per-store identity).
-- Fields fall into three groups:
--   - identity hashes (hashed PII per Meta CAPI spec, indefinite retention)
--   - raw last-seen (fbp, fbc, ip, ua) for direct CAPI passthrough
--   - history (jsonb arrays of fbcs/utms/emails seen) — small, capped
-- All fields are nullable except the natural keys + first_seen_at.

CREATE TABLE visitors (
  visitor_id        text NOT NULL,                 -- our minted UUID
  store_id          text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,

  -- Hashed identity (SHA-256 hex). Indefinite retention — already privacy-safe.
  em_hash           text,
  ph_hash           text,
  fn_hash           text,
  ln_hash           text,
  ct_hash           text,
  st_hash           text,
  zp_hash           text,
  country_hash      text,
  external_id_hash  text,

  -- Raw last-seen (Meta CAPI sends these unhashed). Refreshed on every event.
  latest_fbp        text,
  latest_fbc        text,
  latest_ip         text,
  latest_ua         text,

  -- History — accumulated across sessions. Capped at 5 entries via app
  -- code so the row size stays bounded. Stored as jsonb arrays of
  -- {value, seen_at} so we can later choose the most-recent or
  -- highest-confidence value at Purchase time.
  fbc_history       jsonb NOT NULL DEFAULT '[]',
  utm_history       jsonb NOT NULL DEFAULT '[]',

  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (store_id, visitor_id)
);

CREATE INDEX idx_visitors_last_seen ON visitors(store_id, last_seen_at DESC);
CREATE INDEX idx_visitors_em_hash ON visitors(store_id, em_hash) WHERE em_hash IS NOT NULL;
CREATE INDEX idx_visitors_ph_hash ON visitors(store_id, ph_hash) WHERE ph_hash IS NOT NULL;

ALTER TABLE visitors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "store_isolation" ON visitors
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));


-- ============================================================
-- visitor_events
-- ============================================================
-- Per-event breadcrumb trail with 30-day retention. Lets us audit
-- which events contributed to a visitor's identity (and gives the
-- merchant-facing dashboard a per-session view if/when we ship it).
-- Not joined at Purchase time — that path uses the aggregated columns
-- on `visitors` directly for speed.
--
-- Intentionally minimal columns. Anything the Purchase enrichment
-- might need lives on `visitors`; this table is purely for diagnostics
-- and the future "session timeline" UI. Drop the raw IP/UA after 30d
-- to limit privacy exposure.

CREATE TABLE visitor_events (
  id            bigserial PRIMARY KEY,
  visitor_id    text NOT NULL,
  store_id      text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  event_name    text NOT NULL,                    -- "PageView", "ViewContent", ...
  event_id      text,                             -- the deterministic id we sent to CAPI
  url           text,
  ip            text,                             -- 30-day retention, then trimmed
  ua            text,                             -- 30-day retention, then trimmed
  fbp           text,
  fbc           text,
  utm_source    text,
  utm_campaign  text,
  utm_content   text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_visitor_events_lookup ON visitor_events(store_id, visitor_id, occurred_at DESC);
-- Plain b-tree on occurred_at — partial-with-now() index is rejected by
-- Postgres (now() is not IMMUTABLE). The retention cron's range scan is
-- still cheap because deletions only ever target the tail.
CREATE INDEX idx_visitor_events_age ON visitor_events(occurred_at);

ALTER TABLE visitor_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "store_isolation" ON visitor_events
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));


-- ============================================================
-- emq_snapshots — retroactively add the 90-day TTL the original
-- migration 015 promised in a comment but never enforced. The cron
-- function is created here; it's invoked by /api/cron/visitors-trim
-- on the same schedule.
-- ============================================================

CREATE OR REPLACE FUNCTION trim_emq_snapshots()
RETURNS integer AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM emq_snapshots
   WHERE captured_at < now() - interval '90 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;
