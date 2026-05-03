-- ============================================================
-- Migration 012: bucketed trend series for the Shopify-style chart
-- ============================================================
-- Returns one row per bucket (day | month | year) over [from, to]. Used by
-- the dashboard's "Revenue & Profit" line chart to support short-range
-- (daily) and long-range (monthly / yearly) views without overplotting.
--
-- Reuses the same metric definitions as get_dashboard_stats so a SUM across
-- buckets reconciles with the KPI cards. Specifically: orders = delivered
-- + returned, returned COGS counted only at the unsellable %, and the same
-- expense allocation rules.
--
-- Granularity affects bucket size and monthly-expense allocation:
--   * 'day'   — bucket = 1 day; monthly expense charged on day-of-month = 1
--   * 'month' — bucket = 1 month; monthly expense charged once per bucket
--   * 'year'  — bucket = 1 year;  monthly expense × 12 per bucket
-- Per-order expenses are always × delivered orders in that bucket.
--
-- Performance: bounded by idx_orders_store_date and idx_ad_spend_store_date.
-- For a 90-day daily window or a 5-year monthly window, sub-100ms.

CREATE OR REPLACE FUNCTION get_trend_series(
  p_store_id              text,
  p_from_date             date,
  p_to_date               date,
  p_monthly_expenses      numeric,
  p_per_order_expenses    numeric,
  p_granularity           text DEFAULT 'day'   -- 'day' | 'month' | 'year'
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
  v_monthly_per_bucket numeric;  -- how many monthly-expense charges per bucket
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
      date_trunc(v_trunc, o.transaction_date)::date AS bs,
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
      AND o.transaction_date >= p_from_date::timestamptz
      AND o.transaction_date <  (p_to_date + 1)::timestamptz
    GROUP BY date_trunc(v_trunc, o.transaction_date)
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
    -- expenses: monthly amount allocated per bucket + per-order × delivered
    (CASE
       WHEN p_granularity = 'day'   AND EXTRACT(DAY FROM buckets.bs) = 1 THEN p_monthly_expenses
       WHEN p_granularity = 'month'                                      THEN p_monthly_expenses
       WHEN p_granularity = 'year'                                       THEN p_monthly_expenses * 12
       ELSE 0
     END)
     + (p_per_order_expenses * COALESCE(ord.delivered, 0))              AS expenses,
    -- total_cost = COGS + delivery + ad spend + return loss + ops expenses
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
    -- net_profit = sales - delivery - cogs - ad - expenses (matches dashboard math)
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
