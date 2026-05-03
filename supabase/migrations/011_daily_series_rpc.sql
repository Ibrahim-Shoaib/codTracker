-- ============================================================
-- Migration 011: per-day series for the dashboard trend chart
-- ============================================================
-- Returns one row per day in [p_from_date, p_to_date], with the same metric
-- definitions used by get_dashboard_stats so a SUM across rows reconciles
-- with the KPI cards. Used by the "Revenue & Profit" trend chart and the
-- "Cost Composition" stacked bar.
--
-- Conventions (matched to get_dashboard_stats):
--   * Day bucket = transaction_date::date in the session timezone (UTC).
--     We deliberately don't shift to PKT here so per-day buckets sum back
--     to the existing card aggregates byte-for-byte.
--   * orders = delivered + returned (matches the displayed orders count).
--   * sellable_returns_pct comes from stores.sellable_returns_pct (default 85).
--   * Monthly expenses are charged once on the 1st of each in-range month.
--   * Per-order expenses are charged on the day the delivered order lands.
--   * net_profit = sales - cogs - delivery_cost - ad_spend - expenses.
--
-- Performance note: bounded by idx_orders_store_date (store_id, transaction_date)
-- and idx_ad_spend_store_date (store_id, spend_date). For a 90-day range on a
-- 6k-order shop this is sub-50ms.

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

  -- Coalesce defaults so missing config still produces a chart
  v_sellable_returns_pct := COALESCE(v_sellable_returns_pct, 85);

  RETURN QUERY
  WITH days AS (
    SELECT generate_series(p_from_date, p_to_date, '1 day'::interval)::date AS d
  ),
  -- Per-day order aggregates using the same formulas as get_dashboard_stats
  ord AS (
    SELECT
      o.transaction_date::date AS d,
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
    GROUP BY o.transaction_date::date
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
    -- Expenses: monthly amount once on the 1st, per-order × delivered every day
    (CASE WHEN EXTRACT(DAY FROM days.d) = 1 THEN p_monthly_expenses ELSE 0 END)
      + (p_per_order_expenses * COALESCE(ord.delivered, 0))             AS expenses,
    -- gross_profit = sales - delivery_cost - cogs (matches get_dashboard_stats)
    (COALESCE(ord.sales, 0) - COALESCE(ord.delivery_cost, 0) - COALESCE(ord.cogs, 0))
                                                                        AS gross_profit,
    -- net_profit = gross - ad_spend - expenses
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
