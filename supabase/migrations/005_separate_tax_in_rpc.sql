-- ============================================================
-- Migration 005: surface Tax separately in the dashboard RPC
-- ============================================================
-- The Detail Panel now renders three independent rows:
--   Shipping costs = transaction_fee  (delivered + returned)
--   Reversal costs = reversal_fee     (returned only)
--   Tax            = transaction_tax + reversal_tax  (delivered + returned)
--
-- Invariants preserved by this migration:
--   * delivery_cost is unchanged — still the full
--       SUM(transaction_fee + transaction_tax + reversal_fee + reversal_tax)
--     across delivered + returned. v_gross_profit and roi_pct continue to use
--     it as the single shipping-side cost number, so profit math is identical
--     to the pre-migration RPC down to the byte.
--   * reversal_cost is narrowed to FEES ONLY (reversal_fee, returned only).
--     Tax that used to live in this column is now exposed in `tax`.
--   * Sum of the three displayed rows = delivery_cost, by construction.
--
-- Only consumer of reversal_cost in app code is app/components/DetailPanel.jsx,
-- which is updated in lockstep with this migration.

DROP FUNCTION IF EXISTS get_dashboard_stats(text, date, date, numeric, numeric);

CREATE FUNCTION get_dashboard_stats(
  p_store_id              text,
  p_from_date             date,
  p_to_date               date,
  p_monthly_expenses      numeric,
  p_per_order_expenses    numeric
)
RETURNS TABLE (
  sales          numeric,
  orders         bigint,
  units          bigint,
  returns        bigint,
  in_transit     bigint,
  delivery_cost  numeric,   -- full total (fees + taxes) — drives profit math
  reversal_cost  numeric,   -- reversal_fee only, returned (NEW semantics)
  tax            numeric,   -- transaction_tax + reversal_tax, delivered + returned
  cogs           numeric,
  ad_spend       numeric,
  expenses       numeric,
  gross_profit   numeric,
  net_profit     numeric,
  roas           numeric,
  poas           numeric,
  cac            numeric,
  aov            numeric,
  margin_pct     numeric,
  roi_pct        numeric,
  refund_pct     numeric
) AS $$
DECLARE
  v_sales          numeric;
  v_delivered      bigint;
  v_units          bigint;
  v_returns        bigint;
  v_in_transit     bigint;
  v_delivery_cost  numeric;   -- full total, used for profit calc
  v_reversal_cost  numeric;   -- reversal_fee only (returned)
  v_tax            numeric;   -- transaction_tax + reversal_tax (delivered + returned)
  v_cogs           numeric;
  v_ad_spend       numeric;
  v_expenses       numeric;
  v_gross_profit          numeric;
  v_net_profit            numeric;
  v_sellable_returns_pct  numeric;
  v_month_count           integer;
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
    -- delivery_cost: full shipping-side total, unchanged
    COALESCE(SUM(
      CASE WHEN o.is_delivered OR o.is_returned
        THEN o.transaction_fee + o.transaction_tax + o.reversal_fee + o.reversal_tax
        ELSE 0
      END
    ), 0),
    -- reversal_cost: fees only on returned shipments (was fee + tax)
    COALESCE(SUM(
      CASE WHEN o.is_returned
        THEN o.reversal_fee
        ELSE 0
      END
    ), 0),
    -- tax: forward + reverse tax, on every terminated shipment
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
    ), 0)
  INTO
    v_sales, v_delivered, v_units, v_returns, v_in_transit,
    v_delivery_cost, v_reversal_cost, v_tax, v_cogs
  FROM orders o
  WHERE o.store_id = p_store_id
    AND o.transaction_date >= p_from_date::timestamptz
    AND o.transaction_date <  (p_to_date + 1)::timestamptz;

  SELECT COALESCE(SUM(a.amount), 0)
  INTO v_ad_spend
  FROM ad_spend a
  WHERE a.store_id = p_store_id
    AND a.spend_date >= p_from_date
    AND a.spend_date <= p_to_date;

  v_expenses := (p_monthly_expenses * v_month_count)
              + (p_per_order_expenses * v_delivered);

  -- Profit math uses the unchanged full v_delivery_cost — identical to migration 003.
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
    CASE WHEN v_ad_spend = 0 THEN NULL ELSE v_sales / v_ad_spend END,
    CASE WHEN v_ad_spend = 0 THEN NULL ELSE v_net_profit / v_ad_spend END,
    CASE WHEN v_ad_spend = 0 OR v_delivered = 0 THEN NULL ELSE v_ad_spend / v_delivered END,
    CASE WHEN v_delivered = 0 THEN NULL ELSE v_sales / v_delivered END,
    CASE WHEN v_sales = 0 THEN NULL ELSE (v_net_profit / v_sales) * 100 END,
    CASE WHEN (v_cogs + v_ad_spend + v_delivery_cost) = 0 THEN NULL
         ELSE (v_net_profit / (v_cogs + v_ad_spend + v_delivery_cost)) * 100 END,
    CASE WHEN (v_delivered + v_returns) = 0 THEN 0::numeric
         ELSE (v_returns::numeric / (v_delivered + v_returns)) * 100 END;
END;
$$ LANGUAGE plpgsql;
