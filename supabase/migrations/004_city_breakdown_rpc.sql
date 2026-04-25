-- ============================================================
-- Migration 004: city-level return loss breakdown
-- ============================================================
-- Powers the "Where you're losing money to returns" panel.
-- Single aggregation over the orders table — no joins, no per-row
-- post-processing on the app server.

-- Partial index keeps the GROUP BY cheap once a store has tens of
-- thousands of orders. Only indexes terminated shipments (delivered
-- or returned), which is what the panel filters on.
CREATE INDEX IF NOT EXISTS idx_orders_city_terminal
  ON orders(store_id, city_name)
  WHERE is_delivered OR is_returned;

DROP FUNCTION IF EXISTS get_city_breakdown(text, date, date);

CREATE FUNCTION get_city_breakdown(
  p_store_id  text,
  p_from_date date,
  p_to_date   date
)
RETURNS TABLE (
  city          text,
  delivered     bigint,
  returned      bigint,
  total_orders  bigint,   -- delivered + returned (matches dashboard "orders")
  return_loss   numeric,  -- PKR cost incurred on returned shipments
  return_pct    numeric   -- returned / (delivered + returned) × 100
) AS $$
DECLARE
  v_sellable_pct numeric;
BEGIN
  -- Same sellable-on-return % the main dashboard uses, so the loss number
  -- here is consistent with the COGS hit in `get_dashboard_stats`.
  SELECT COALESCE(s.sellable_returns_pct, 85)
  INTO v_sellable_pct
  FROM stores s
  WHERE s.store_id = p_store_id;

  RETURN QUERY
  WITH agg AS (
    SELECT
      -- INITCAP collapses case variants ("BANNU" / "bannu" / "Bannu") into one
      -- bucket and gives a clean display label in one step.
      COALESCE(NULLIF(INITCAP(TRIM(o.city_name)), ''), 'Unknown') AS city,
      COUNT(*) FILTER (WHERE o.is_delivered)::bigint AS delivered,
      COUNT(*) FILTER (WHERE o.is_returned)::bigint  AS returned,
      -- Real PKR cost of each returned shipment:
      --   forward shipping wasted + reverse shipping paid + unsellable inventory
      COALESCE(SUM(
        CASE WHEN o.is_returned
          THEN (o.transaction_fee + o.transaction_tax + o.reversal_fee + o.reversal_tax)
             + (o.cogs_total * (1 - v_sellable_pct / 100.0))
          ELSE 0
        END
      ), 0) AS return_loss
    FROM orders o
    WHERE o.store_id = p_store_id
      AND o.transaction_date >= p_from_date::timestamptz
      AND o.transaction_date <  (p_to_date + 1)::timestamptz
      AND (o.is_delivered OR o.is_returned)
    GROUP BY 1
  )
  SELECT
    agg.city,
    agg.delivered,
    agg.returned,
    (agg.delivered + agg.returned) AS total_orders,
    agg.return_loss,
    CASE
      WHEN (agg.delivered + agg.returned) = 0 THEN 0::numeric
      ELSE (agg.returned::numeric / (agg.delivered + agg.returned)) * 100
    END AS return_pct
  FROM agg
  -- Hard cap so a store with hundreds of long-tail cities can't bloat the
  -- payload. Top 50 by volume covers >99% of any merchant's revenue.
  ORDER BY (agg.delivered + agg.returned) DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;
