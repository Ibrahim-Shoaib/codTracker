-- ============================================================
-- Migration 023: dashboard RPCs bucket by order_date, not transaction_date
-- ============================================================
-- Phase B of the order_date work. Migration 021 added the column +
-- backfilled it; the cron + onboarding enrichment now populates it for
-- new orders going forward. This migration switches the dashboard's three
-- stat RPCs to bucket by COALESCE(order_date, transaction_date) so the
-- merchant sees orders on the day the customer placed them, not the day
-- they happened to be uploaded into PostEx.
--
-- Concretely fixes the symptom merchants see when they batch-ship after
-- a delay: 10 days of unshipped orders no longer collapse onto today's
-- KPI cards.
--
-- COALESCE means rows with NULL order_date (pre-backfill demo data, or
-- new orders before enrichment runs) silently fall back to transaction_date
-- — same behaviour as today, never broken.
--
-- Functional index added so the WHERE clauses still use an index
-- (the existing idx_orders_store_date on transaction_date alone won't help
-- a COALESCE expression).

CREATE INDEX IF NOT EXISTS idx_orders_dashboard_date
  ON orders(store_id, COALESCE(order_date, transaction_date) DESC);

-- ────────────────────────────────────────────────────────────
-- get_dashboard_stats
-- ────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS get_dashboard_stats(text, date, date, numeric, numeric);

CREATE OR REPLACE FUNCTION get_dashboard_stats(
  p_store_id              text,
  p_from_date             date,
  p_to_date               date,
  p_monthly_expenses      numeric,
  p_per_order_expenses    numeric
)
RETURNS TABLE (
  sales            numeric,
  orders           bigint,
  units            bigint,
  returns          bigint,
  in_transit       bigint,
  delivery_cost    numeric,
  reversal_cost    numeric,
  tax              numeric,
  cogs             numeric,
  ad_spend         numeric,
  expenses         numeric,
  gross_profit     numeric,
  net_profit       numeric,
  return_loss      numeric,
  roas             numeric,
  poas             numeric,
  cac              numeric,
  aov              numeric,
  margin_pct       numeric,
  roi_pct          numeric,
  refund_pct       numeric,
  in_transit_value numeric
) AS $$
DECLARE
  v_sales          numeric;
  v_delivered      bigint;
  v_units          bigint;
  v_returns        bigint;
  v_in_transit     bigint;
  v_delivery_cost  numeric;
  v_reversal_cost  numeric;
  v_tax            numeric;
  v_cogs           numeric;
  v_return_loss    numeric;
  v_in_transit_value numeric;
  v_ad_spend       numeric;
  v_expenses       numeric;
  v_gross_profit   numeric;
  v_net_profit     numeric;
  v_sellable_returns_pct numeric;
  v_month_count    integer;
BEGIN
  SELECT COALESCE(s.sellable_returns_pct, 85)
  INTO v_sellable_returns_pct
  FROM stores s
  WHERE s.store_id = p_store_id;

  SELECT COUNT(*)::integer
  INTO v_month_count
  FROM generate_series(
    date_trunc('month', p_from_date)::date,
    date_trunc('month', p_to_date)::date,
    '1 month'::interval
  ) AS ms
  WHERE ms::date BETWEEN p_from_date AND p_to_date;

  SELECT
    COALESCE(SUM(CASE WHEN o.is_delivered THEN o.invoice_payment ELSE 0 END), 0),
    COALESCE(COUNT(*) FILTER (WHERE o.is_delivered), 0),
    COALESCE(SUM(CASE WHEN o.is_delivered THEN o.items ELSE 0 END), 0),
    COALESCE(COUNT(*) FILTER (WHERE o.is_returned), 0),
    COALESCE(COUNT(*) FILTER (WHERE o.is_in_transit), 0),
    COALESCE(SUM(
      CASE WHEN o.is_delivered OR o.is_returned
        THEN o.transaction_fee + o.transaction_tax + o.reversal_fee + o.reversal_tax
        ELSE 0
      END
    ), 0),
    COALESCE(SUM(
      CASE WHEN o.is_returned THEN o.reversal_fee ELSE 0 END
    ), 0),
    COALESCE(SUM(
      CASE WHEN o.is_delivered OR o.is_returned
        THEN o.transaction_tax + o.reversal_tax
        ELSE 0
      END
    ), 0),
    COALESCE(SUM(
      CASE
        WHEN o.is_delivered THEN o.cogs_total
        WHEN o.is_returned  THEN o.cogs_total * (1 - v_sellable_returns_pct / 100.0)
        ELSE 0
      END
    ), 0),
    COALESCE(SUM(
      CASE WHEN o.is_returned
        THEN (o.transaction_fee + o.transaction_tax + o.reversal_fee + o.reversal_tax)
           + (o.cogs_total * (1 - v_sellable_returns_pct / 100.0))
        ELSE 0
      END
    ), 0),
    COALESCE(SUM(
      CASE WHEN NOT o.is_delivered
            AND NOT o.is_returned
            AND COALESCE(o.transaction_status, '') NOT IN ('Cancelled', 'Transferred')
        THEN o.invoice_payment
        ELSE 0
      END
    ), 0)
  INTO
    v_sales, v_delivered, v_units, v_returns, v_in_transit,
    v_delivery_cost, v_reversal_cost, v_tax, v_cogs, v_return_loss,
    v_in_transit_value
  FROM orders o
  WHERE o.store_id = p_store_id
    AND COALESCE(o.order_date, o.transaction_date) >= p_from_date::timestamptz
    AND COALESCE(o.order_date, o.transaction_date) <  (p_to_date + 1)::timestamptz;

  SELECT COALESCE(SUM(a.amount), 0)
  INTO v_ad_spend
  FROM ad_spend a
  WHERE a.store_id = p_store_id
    AND a.spend_date >= p_from_date
    AND a.spend_date <= p_to_date;

  v_expenses := (p_monthly_expenses * v_month_count)
              + (p_per_order_expenses * v_delivered);

  v_gross_profit := v_sales - v_delivery_cost - v_cogs;
  v_net_profit   := v_gross_profit - v_ad_spend - v_expenses;

  RETURN QUERY SELECT
    v_sales,
    (v_delivered + v_returns)::bigint,
    v_units,
    v_returns,
    v_in_transit,
    v_delivery_cost,
    v_reversal_cost,
    v_tax,
    v_cogs,
    v_ad_spend,
    v_expenses,
    v_gross_profit,
    v_net_profit,
    v_return_loss,
    CASE WHEN v_ad_spend = 0 THEN NULL ELSE v_sales / v_ad_spend END,
    CASE WHEN v_ad_spend = 0 THEN NULL ELSE v_net_profit / v_ad_spend END,
    CASE WHEN v_ad_spend = 0 OR v_delivered = 0 THEN NULL ELSE v_ad_spend / v_delivered END,
    CASE WHEN v_delivered = 0 THEN NULL ELSE v_sales / v_delivered END,
    CASE WHEN v_sales = 0 THEN NULL ELSE (v_net_profit / v_sales) * 100 END,
    CASE WHEN (v_cogs + v_ad_spend + v_delivery_cost) = 0 THEN NULL
         ELSE (v_net_profit / (v_cogs + v_ad_spend + v_delivery_cost)) * 100 END,
    CASE WHEN (v_delivered + v_returns) = 0 THEN 0::numeric
         ELSE (v_returns::numeric / (v_delivered + v_returns)) * 100 END,
    v_in_transit_value;
END;
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────────────────────
-- get_daily_series
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_daily_series(
  p_store_id              text,
  p_from_date             date,
  p_to_date               date,
  p_monthly_expenses      numeric,
  p_per_order_expenses    numeric
)
RETURNS TABLE (
  day            date,
  sales          numeric,
  orders         bigint,
  delivered      bigint,
  returns        bigint,
  cogs           numeric,
  delivery_cost  numeric,
  ad_spend       numeric,
  return_loss    numeric,
  expenses       numeric,
  gross_profit   numeric,
  net_profit     numeric
) AS $$
DECLARE
  v_sellable_returns_pct numeric;
BEGIN
  SELECT COALESCE(s.sellable_returns_pct, 85)
  INTO v_sellable_returns_pct
  FROM stores s
  WHERE s.store_id = p_store_id;

  v_sellable_returns_pct := COALESCE(v_sellable_returns_pct, 85);

  RETURN QUERY
  WITH days AS (
    SELECT generate_series(p_from_date, p_to_date, '1 day'::interval)::date AS d
  ),
  ord AS (
    SELECT
      COALESCE(o.order_date, o.transaction_date)::date AS d,
      COALESCE(SUM(CASE WHEN o.is_delivered THEN o.invoice_payment ELSE 0 END), 0)            AS sales,
      COUNT(*) FILTER (WHERE o.is_delivered)                                                  AS delivered,
      COUNT(*) FILTER (WHERE o.is_returned)                                                   AS returns,
      COALESCE(SUM(
        CASE
          WHEN o.is_delivered THEN o.cogs_total
          WHEN o.is_returned  THEN o.cogs_total * (1 - v_sellable_returns_pct / 100.0)
          ELSE 0
        END
      ), 0)                                                                                   AS cogs,
      COALESCE(SUM(
        CASE WHEN o.is_delivered OR o.is_returned
          THEN o.transaction_fee + o.transaction_tax + o.reversal_fee + o.reversal_tax
          ELSE 0
        END
      ), 0)                                                                                   AS delivery_cost,
      COALESCE(SUM(
        CASE WHEN o.is_returned
          THEN (o.transaction_fee + o.transaction_tax + o.reversal_fee + o.reversal_tax)
             + (o.cogs_total * (1 - v_sellable_returns_pct / 100.0))
          ELSE 0
        END
      ), 0)                                                                                   AS return_loss
    FROM orders o
    WHERE o.store_id = p_store_id
      AND COALESCE(o.order_date, o.transaction_date) >= p_from_date::timestamptz
      AND COALESCE(o.order_date, o.transaction_date) <  (p_to_date + 1)::timestamptz
    GROUP BY COALESCE(o.order_date, o.transaction_date)::date
  ),
  ads AS (
    SELECT a.spend_date AS d, COALESCE(SUM(a.amount), 0) AS ad_spend
    FROM ad_spend a
    WHERE a.store_id = p_store_id
      AND a.spend_date BETWEEN p_from_date AND p_to_date
    GROUP BY a.spend_date
  )
  SELECT
    days.d                                                              AS day,
    COALESCE(ord.sales, 0)                                              AS sales,
    (COALESCE(ord.delivered, 0) + COALESCE(ord.returns, 0))::bigint     AS orders,
    COALESCE(ord.delivered, 0)::bigint                                  AS delivered,
    COALESCE(ord.returns,   0)::bigint                                  AS returns,
    COALESCE(ord.cogs, 0)                                               AS cogs,
    COALESCE(ord.delivery_cost, 0)                                      AS delivery_cost,
    COALESCE(ads.ad_spend, 0)                                           AS ad_spend,
    COALESCE(ord.return_loss, 0)                                        AS return_loss,
    (CASE WHEN EXTRACT(DAY FROM days.d) = 1 THEN p_monthly_expenses ELSE 0 END)
      + (p_per_order_expenses * COALESCE(ord.delivered, 0))             AS expenses,
    (COALESCE(ord.sales, 0) - COALESCE(ord.delivery_cost, 0) - COALESCE(ord.cogs, 0))
                                                                        AS gross_profit,
    (COALESCE(ord.sales, 0)
       - COALESCE(ord.delivery_cost, 0)
       - COALESCE(ord.cogs, 0)
       - COALESCE(ads.ad_spend, 0)
       - ((CASE WHEN EXTRACT(DAY FROM days.d) = 1 THEN p_monthly_expenses ELSE 0 END)
            + (p_per_order_expenses * COALESCE(ord.delivered, 0))))     AS net_profit
  FROM days
  LEFT JOIN ord ON ord.d = days.d
  LEFT JOIN ads ON ads.d = days.d
  ORDER BY days.d;
END;
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────────────────────
-- get_trend_series
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_trend_series(
  p_store_id              text,
  p_from_date             date,
  p_to_date               date,
  p_monthly_expenses      numeric,
  p_per_order_expenses    numeric,
  p_granularity           text DEFAULT 'day'
)
RETURNS TABLE (
  bucket_start   date,
  sales          numeric,
  orders         bigint,
  delivered      bigint,
  returns        bigint,
  cogs           numeric,
  delivery_cost  numeric,
  ad_spend       numeric,
  return_loss    numeric,
  expenses       numeric,
  total_cost     numeric,
  net_profit     numeric
) AS $$
DECLARE
  v_sellable_returns_pct numeric;
  v_step interval;
  v_trunc text;
BEGIN
  IF p_granularity NOT IN ('day','month','year') THEN
    RAISE EXCEPTION 'invalid granularity: %', p_granularity;
  END IF;

  SELECT COALESCE(s.sellable_returns_pct, 85)
  INTO v_sellable_returns_pct
  FROM stores s
  WHERE s.store_id = p_store_id;
  v_sellable_returns_pct := COALESCE(v_sellable_returns_pct, 85);

  v_step  := ('1 ' || p_granularity)::interval;
  v_trunc := p_granularity;

  RETURN QUERY
  WITH buckets AS (
    SELECT date_trunc(v_trunc, gs)::date AS bs
    FROM generate_series(
      date_trunc(v_trunc, p_from_date::timestamp),
      date_trunc(v_trunc, p_to_date::timestamp),
      v_step
    ) AS gs
  ),
  ord AS (
    SELECT
      date_trunc(v_trunc, COALESCE(o.order_date, o.transaction_date))::date AS bs,
      COALESCE(SUM(CASE WHEN o.is_delivered THEN o.invoice_payment ELSE 0 END), 0)            AS sales,
      COUNT(*) FILTER (WHERE o.is_delivered)                                                  AS delivered,
      COUNT(*) FILTER (WHERE o.is_returned)                                                   AS returns,
      COALESCE(SUM(
        CASE
          WHEN o.is_delivered THEN o.cogs_total
          WHEN o.is_returned  THEN o.cogs_total * (1 - v_sellable_returns_pct / 100.0)
          ELSE 0
        END
      ), 0)                                                                                   AS cogs,
      COALESCE(SUM(
        CASE WHEN o.is_delivered OR o.is_returned
          THEN o.transaction_fee + o.transaction_tax + o.reversal_fee + o.reversal_tax
          ELSE 0
        END
      ), 0)                                                                                   AS delivery_cost,
      COALESCE(SUM(
        CASE WHEN o.is_returned
          THEN (o.transaction_fee + o.transaction_tax + o.reversal_fee + o.reversal_tax)
             + (o.cogs_total * (1 - v_sellable_returns_pct / 100.0))
          ELSE 0
        END
      ), 0)                                                                                   AS return_loss
    FROM orders o
    WHERE o.store_id = p_store_id
      AND COALESCE(o.order_date, o.transaction_date) >= p_from_date::timestamptz
      AND COALESCE(o.order_date, o.transaction_date) <  (p_to_date + 1)::timestamptz
    GROUP BY date_trunc(v_trunc, COALESCE(o.order_date, o.transaction_date))
  ),
  ads AS (
    SELECT date_trunc(v_trunc, a.spend_date::timestamp)::date AS bs,
           COALESCE(SUM(a.amount), 0) AS ad_spend
    FROM ad_spend a
    WHERE a.store_id = p_store_id
      AND a.spend_date BETWEEN p_from_date AND p_to_date
    GROUP BY date_trunc(v_trunc, a.spend_date::timestamp)
  )
  SELECT
    buckets.bs                                                          AS bucket_start,
    COALESCE(ord.sales, 0)                                              AS sales,
    (COALESCE(ord.delivered, 0) + COALESCE(ord.returns, 0))::bigint     AS orders,
    COALESCE(ord.delivered, 0)::bigint                                  AS delivered,
    COALESCE(ord.returns,   0)::bigint                                  AS returns,
    COALESCE(ord.cogs, 0)                                               AS cogs,
    COALESCE(ord.delivery_cost, 0)                                      AS delivery_cost,
    COALESCE(ads.ad_spend, 0)                                           AS ad_spend,
    COALESCE(ord.return_loss, 0)                                        AS return_loss,
    (CASE
       WHEN p_granularity = 'day'   AND EXTRACT(DAY FROM buckets.bs) = 1 THEN p_monthly_expenses
       WHEN p_granularity = 'month'                                      THEN p_monthly_expenses
       WHEN p_granularity = 'year'                                       THEN p_monthly_expenses * 12
       ELSE 0
     END)
     + (p_per_order_expenses * COALESCE(ord.delivered, 0))              AS expenses,
    (COALESCE(ord.cogs, 0)
       + COALESCE(ord.delivery_cost, 0)
       + COALESCE(ads.ad_spend, 0)
       + COALESCE(ord.return_loss, 0)
       + (CASE
            WHEN p_granularity = 'day'   AND EXTRACT(DAY FROM buckets.bs) = 1 THEN p_monthly_expenses
            WHEN p_granularity = 'month'                                      THEN p_monthly_expenses
            WHEN p_granularity = 'year'                                       THEN p_monthly_expenses * 12
            ELSE 0
          END)
       + (p_per_order_expenses * COALESCE(ord.delivered, 0)))           AS total_cost,
    (COALESCE(ord.sales, 0)
       - COALESCE(ord.delivery_cost, 0)
       - COALESCE(ord.cogs, 0)
       - COALESCE(ads.ad_spend, 0)
       - ((CASE
             WHEN p_granularity = 'day'   AND EXTRACT(DAY FROM buckets.bs) = 1 THEN p_monthly_expenses
             WHEN p_granularity = 'month'                                      THEN p_monthly_expenses
             WHEN p_granularity = 'year'                                       THEN p_monthly_expenses * 12
             ELSE 0
           END)
          + (p_per_order_expenses * COALESCE(ord.delivered, 0))))       AS net_profit
  FROM buckets
  LEFT JOIN ord ON ord.bs = buckets.bs
  LEFT JOIN ads ON ads.bs = buckets.bs
  ORDER BY buckets.bs;
END;
$$ LANGUAGE plpgsql;
