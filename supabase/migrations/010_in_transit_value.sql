-- ============================================================
-- Migration 010: pipeline value alongside dashboard stats
-- ============================================================
-- Adds `in_transit_value` to get_dashboard_stats so the dashboard can show
-- "PKR <amount> · In Transit" pills under the Sales number on each KPI card.
-- Defined as SUM(invoice_payment) for orders not yet terminal — i.e. not
-- delivered, not returned, and whose raw PostEx transaction_status is not
-- 'Cancelled' or 'Transferred'. This intentionally INCLUDES 'Unbooked'
-- — the codebase's boolean flags treat it as terminal-cancelled, but for the
-- merchant's "money in flight" view it's still pipeline value.
--
-- We filter on transaction_status (the raw PostEx string) rather than
-- status_code because the live orders table only carries the boolean flags
-- and the raw status text — there's no status_code column.
--
-- Profit, ROAS, margin, AOV — all still computed off the existing v_sales
-- (delivered-only). This column is purely a display metric.
--
-- Adding a column to RETURNS TABLE requires DROP + CREATE; CREATE OR REPLACE
-- alone can't change the function signature.

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
    -- in_transit_value: invoice_payment of orders still in flight
    -- (anything not Delivered, Returned, Cancelled, or Transferred —
    -- includes Booked, Unbooked, OFD, Under Verification, Attempted)
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
