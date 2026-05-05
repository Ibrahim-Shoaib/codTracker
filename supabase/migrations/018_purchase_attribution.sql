-- ============================================================
-- Migration 018: Purchase Attribution
-- ============================================================
-- Permanently links every Purchase event to (a) the visitor_id that
-- produced it, (b) the Shopify customer_id, and (c) which lookup tier
-- of the webhook handler was used to recover the link. Also stores
-- the ad-attribution context derived from visitor_events at the time
-- the Purchase fired, so the dashboard doesn't have to re-run the
-- three-tier lookup or re-aggregate touches per query.
--
-- Why a dedicated table:
--   - capi_delivery_log is capped at 500 rows/store and rolls.
--   - visitor_events has a 30-day retention.
--   - We want attribution data to outlive both for cohort/LTV reporting.
--
-- Population:
--   - Going forward: handleOrderPaid in api.webhooks.meta-pixel.tsx
--     inserts one row per successful Purchase fire (idempotent on
--     (store_id, order_id) so webhook retries don't duplicate).
--   - Historical: scripts/backfill-purchase-attribution.mjs pulls the
--     last N days of Shopify orders, runs the three-tier lookup, and
--     bulk-upserts. Invoked once after migration deploy.
--
-- Storage estimate: at 50 orders/day per shop, 1 row/order, 100 bytes
-- avg = 1.8 MB/year/shop. At 5,000 merchants ≈ 9 GB/year — trivial
-- on Supabase Pro. We do NOT auto-purge — the whole point is
-- multi-quarter attribution analysis.

CREATE TABLE purchase_attribution (
  id              bigserial PRIMARY KEY,
  store_id        text   NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  order_id        text   NOT NULL,                 -- Shopify order id (numeric, stored as text for forward-compat)
  visitor_id      text,                            -- our minted UUID, NULL when no visitor row could be linked
  customer_id     text,                            -- Shopify customer.id (NULL for guest checkouts)
  -- Which tier of the visitor lookup chain produced the visitor_id:
  --   cart_attribute | fbclid | ip_ua | none
  recovered_via   text   NOT NULL DEFAULT 'none'
                  CHECK (recovered_via IN ('cart_attribute','fbclid','ip_ua','none')),

  -- Snapshot of order facts so the dashboard doesn't have to re-fetch
  -- them from Shopify on every query. Currency is presentment_currency
  -- (PKR for COD, but we don't assume).
  order_value     numeric(14,2),
  currency        text,
  order_created_at timestamptz NOT NULL,

  -- Ad-attribution context derived from the LAST touch before this
  -- Purchase (per visitor_events at fire time). The dashboard uses
  -- this for the simplest "last-touch" model without scanning
  -- visitor_events for every chart render. For multi-touch models
  -- (linear, time-decay, position-based) the dashboard joins to
  -- visitor_events directly.
  last_touch_utm_source     text,
  last_touch_utm_campaign   text,
  last_touch_utm_content    text,
  last_touch_referrer       text,
  last_touch_landing        text,
  -- Number of distinct touches the visitor had within the 30-day
  -- visitor_events window leading to this Purchase. Used for the
  -- "single-touch vs multi-touch" conversion-path summary.
  touch_count     integer NOT NULL DEFAULT 0,
  -- Time from first observed touch to Purchase, in seconds. Used for
  -- the time-to-conversion histogram. NULL when visitor_id is null.
  time_to_convert_sec integer,

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Idempotency: webhook retries (orders/create + orders/paid both
  -- route to the same handler) MUST not produce duplicate rows.
  UNIQUE (store_id, order_id)
);

CREATE INDEX idx_purchase_attribution_store_created
  ON purchase_attribution(store_id, order_created_at DESC);
CREATE INDEX idx_purchase_attribution_visitor
  ON purchase_attribution(store_id, visitor_id)
  WHERE visitor_id IS NOT NULL;
CREATE INDEX idx_purchase_attribution_customer
  ON purchase_attribution(store_id, customer_id)
  WHERE customer_id IS NOT NULL;
-- For campaign-level dashboards (last-touch model). Filtered to non-null
-- so it's compact even at scale.
CREATE INDEX idx_purchase_attribution_campaign
  ON purchase_attribution(store_id, last_touch_utm_campaign, order_created_at DESC)
  WHERE last_touch_utm_campaign IS NOT NULL;

ALTER TABLE purchase_attribution ENABLE ROW LEVEL SECURITY;

CREATE POLICY "store_isolation" ON purchase_attribution
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));


-- ============================================================
-- RPC: get_attribution_summary
-- ============================================================
-- Top-level dashboard aggregate. Returns totals + per-campaign
-- breakdown for the last-touch model (cheapest to compute, served
-- straight from purchase_attribution without joining visitor_events).
-- Multi-touch models (linear, time-decay, position-based) require
-- visitor_events join and are computed in JS via app/lib/attribution.

CREATE OR REPLACE FUNCTION get_attribution_summary(
  p_store_id   text,
  p_from_date  timestamptz,
  p_to_date    timestamptz
)
RETURNS TABLE (
  total_orders          bigint,
  total_revenue         numeric,
  attributed_orders     bigint,        -- orders with non-null visitor_id
  attributed_revenue    numeric,
  recovered_via_cart    bigint,
  recovered_via_fbclid  bigint,
  recovered_via_ip_ua   bigint,
  unattributed          bigint,
  multi_touch_orders    bigint,        -- touch_count > 1
  single_touch_orders   bigint,        -- touch_count = 1
  zero_touch_orders     bigint,        -- touch_count = 0 (direct/no-track)
  median_time_to_convert_sec numeric
) AS $$
  SELECT
    COUNT(*)                                                    AS total_orders,
    COALESCE(SUM(order_value), 0)                              AS total_revenue,
    COUNT(*) FILTER (WHERE visitor_id IS NOT NULL)             AS attributed_orders,
    COALESCE(SUM(order_value) FILTER (WHERE visitor_id IS NOT NULL), 0) AS attributed_revenue,
    COUNT(*) FILTER (WHERE recovered_via = 'cart_attribute')   AS recovered_via_cart,
    COUNT(*) FILTER (WHERE recovered_via = 'fbclid')           AS recovered_via_fbclid,
    COUNT(*) FILTER (WHERE recovered_via = 'ip_ua')            AS recovered_via_ip_ua,
    COUNT(*) FILTER (WHERE recovered_via = 'none')             AS unattributed,
    COUNT(*) FILTER (WHERE touch_count > 1)                    AS multi_touch_orders,
    COUNT(*) FILTER (WHERE touch_count = 1)                    AS single_touch_orders,
    COUNT(*) FILTER (WHERE touch_count = 0)                    AS zero_touch_orders,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY time_to_convert_sec)
                          FILTER (WHERE time_to_convert_sec IS NOT NULL)  AS median_time_to_convert_sec
  FROM purchase_attribution
  WHERE store_id = p_store_id
    AND order_created_at >= p_from_date
    AND order_created_at <  p_to_date;
$$ LANGUAGE sql STABLE;


-- ============================================================
-- RPC: get_last_touch_attribution
-- ============================================================
-- Per-campaign revenue for the last-touch model. One row per
-- (utm_source, utm_campaign) combo, with order count and revenue
-- summed.

CREATE OR REPLACE FUNCTION get_last_touch_attribution(
  p_store_id   text,
  p_from_date  timestamptz,
  p_to_date    timestamptz
)
RETURNS TABLE (
  utm_source    text,
  utm_campaign  text,
  utm_content   text,
  orders        bigint,
  revenue       numeric,
  avg_order_value numeric
) AS $$
  SELECT
    COALESCE(last_touch_utm_source,   '(direct)') AS utm_source,
    COALESCE(last_touch_utm_campaign, '(none)')   AS utm_campaign,
    COALESCE(last_touch_utm_content,  '(none)')   AS utm_content,
    COUNT(*)                                      AS orders,
    COALESCE(SUM(order_value), 0)                 AS revenue,
    COALESCE(AVG(order_value), 0)                 AS avg_order_value
  FROM purchase_attribution
  WHERE store_id = p_store_id
    AND order_created_at >= p_from_date
    AND order_created_at <  p_to_date
  GROUP BY last_touch_utm_source, last_touch_utm_campaign, last_touch_utm_content
  ORDER BY revenue DESC;
$$ LANGUAGE sql STABLE;


-- ============================================================
-- RPC: get_buyer_journeys
-- ============================================================
-- Per-buyer touch journey for drill-down. Joins purchase_attribution
-- to visitor_events to return ordered touches per Purchase. Limited
-- to a paginated window so the UI doesn't pull 10,000 rows at once.

CREATE OR REPLACE FUNCTION get_buyer_journeys(
  p_store_id   text,
  p_from_date  timestamptz,
  p_to_date    timestamptz,
  p_limit      integer DEFAULT 50,
  p_offset     integer DEFAULT 0
)
RETURNS TABLE (
  order_id          text,
  order_created_at  timestamptz,
  order_value       numeric,
  visitor_id        text,
  customer_id       text,
  recovered_via     text,
  touch_count       integer,
  time_to_convert_sec integer,
  touches           jsonb         -- [{event_name, occurred_at, utm_source, utm_campaign, utm_content, fbc, fbp}]
) AS $$
  SELECT
    pa.order_id,
    pa.order_created_at,
    pa.order_value,
    pa.visitor_id,
    pa.customer_id,
    pa.recovered_via,
    pa.touch_count,
    pa.time_to_convert_sec,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'event_name', ve.event_name,
          'occurred_at', ve.occurred_at,
          'utm_source', ve.utm_source,
          'utm_campaign', ve.utm_campaign,
          'utm_content', ve.utm_content,
          'fbc', ve.fbc,
          'fbp', ve.fbp
        ) ORDER BY ve.occurred_at
      )
      FROM visitor_events ve
      WHERE ve.store_id = pa.store_id
        AND ve.visitor_id = pa.visitor_id
        AND ve.occurred_at <= pa.order_created_at
    ), '[]'::jsonb) AS touches
  FROM purchase_attribution pa
  WHERE pa.store_id = p_store_id
    AND pa.order_created_at >= p_from_date
    AND pa.order_created_at <  p_to_date
  ORDER BY pa.order_created_at DESC
  LIMIT p_limit OFFSET p_offset;
$$ LANGUAGE sql STABLE;
