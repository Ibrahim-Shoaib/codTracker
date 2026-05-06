-- ============================================================
-- Migration 020: order_attribution
-- ============================================================
-- One row per Shopify order, written at Purchase-webhook time after the
-- visitor lookup completes. Pre-classifies the order's first-touch
-- channel so the Ad Tracking dashboard can render Today / 7d / 30d
-- breakdowns from a single small indexed query (no joins to the
-- 500-row-capped capi_delivery_log, which is too aggressive a tail to
-- support windowed reporting).
--
-- Storage:
--   - 30-day rolling TTL via trim_order_attribution() (called from
--     the existing api.cron.visitors-trim nightly schedule).
--   - PRIMARY KEY (store_id, shopify_order_id) makes webhook writes
--     idempotent — orders/create + orders/paid both fire handleOrderPaid
--     and we want them to converge on the same row.
--
-- Channel taxonomy (locked to three buckets — keep the dashboard clear):
--   'facebook_ads'    — fbclid present + utm_source=facebook (or no utm)
--   'instagram_ads'   — fbclid present + utm_source=instagram
--   'direct_organic'  — no fbclid (organic, direct, or non-Meta source)
--
-- We deliberately do NOT split out organic-Meta vs true-direct in v1.
-- Without ad-spend cross-reference (Meta API), the bucket is informational
-- only and a fourth row crowds the card without earning its weight.

CREATE TABLE order_attribution (
  store_id          text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  shopify_order_id  text NOT NULL,
  visitor_id        text,
  channel           text NOT NULL CHECK (channel IN ('facebook_ads', 'instagram_ads', 'direct_organic')),
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  first_touch_url   text,
  attributed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, shopify_order_id)
);

-- Powers the dashboard's windowed group-by-channel queries. Sorting
-- DESC matches "show the most recent X days" access pattern.
CREATE INDEX idx_order_attribution_window
  ON order_attribution(store_id, attributed_at DESC);

ALTER TABLE order_attribution ENABLE ROW LEVEL SECURITY;

CREATE POLICY "store_isolation" ON order_attribution
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));

-- Nightly TTL. Returns the deleted row count for cron-job logging.
CREATE OR REPLACE FUNCTION trim_order_attribution() RETURNS bigint AS $$
DECLARE
  deleted_count bigint;
BEGIN
  DELETE FROM order_attribution
  WHERE attributed_at < now() - INTERVAL '30 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE order_attribution IS
  'Pre-classified channel + UTM provenance per Shopify order. Written at Purchase-webhook time, trimmed to 30 days nightly. Powers the Ad Tracking dashboard channel breakdown.';
COMMENT ON FUNCTION trim_order_attribution() IS
  'Drops rows older than 30 days. Called from api.cron.visitors-trim.';
