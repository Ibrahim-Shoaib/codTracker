-- ============================================================
-- Migration 028: dashboard RPCs bucket in the store's timezone
-- ============================================================
-- Companion to migration 027 (stores.timezone). Until now these RPCs cast
-- order timestamps to ::date in the DB session timezone (UTC) and compared the
-- date-range params as UTC midnight (p_from_date::timestamptz). That made every
-- store's day boundaries effectively UTC, regardless of country.
--
-- This migration reads the store's IANA timezone and does both the range
-- filter and the day/period bucketing AT TIME ZONE that timezone:
--   (p_from_date::timestamp AT TIME ZONE v_tz)  -> UTC instant of local midnight
--   (ts AT TIME ZONE v_tz)::date                -> the store-local calendar date
--
-- ONLY the filter/bucket expressions change. Every metric + expense-allocation
-- formula is byte-identical to migration 025, so KPI cards, trend buckets and
-- the expense breakdown still reconcile. Function signatures are unchanged
-- (CREATE OR REPLACE), so this is safe to apply before/with the app redeploy.
--
-- For Asia/Karachi (no DST) stores this is a near no-op — only orders placed
-- 00:00–05:00 PKT re-attribute from the prior UTC day to the correct PKT day.
-- For the Europe/London store it makes London the day boundary, DST-correct.
--
-- ⚠ Deploy this migration together with the matching app build (migration 027
-- adds stores.timezone; the app threads it into dates.server.js).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- get_dashboard_stats  (base: migration 025)
CREATE OR REPLACE FUNCTION public.get_dashboard_stats(
  p_store_id text,
  p_from_date date,
  p_to_date date,
  p_monthly_expenses numeric DEFAULT 0,     -- ignored (kept for rollout compat)
  p_per_order_expenses numeric DEFAULT 0,   -- ignored (kept for rollout compat)
  p_expense_store_id text DEFAULT NULL
)
RETURNS TABLE(sales numeric, orders bigint, units bigint, returns bigint, in_transit bigint, delivery_cost numeric, reversal_cost numeric, tax numeric, cogs numeric, ad_spend numeric, expenses numeric, gross_profit numeric, net_profit numeric, return_loss numeric, roas numeric, poas numeric, cac numeric, aov numeric, margin_pct numeric, roi_pct numeric, refund_pct numeric, in_transit_value numeric)
LANGUAGE plpgsql
AS $function$
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
  v_tz             text;
BEGIN
  SELECT COALESCE(s.sellable_returns_pct, 85), COALESCE(s.timezone, 'Asia/Karachi')
  INTO v_sellable_returns_pct, v_tz
  FROM stores s
  WHERE s.store_id = p_store_id;
  v_tz := COALESCE(v_tz, 'Asia/Karachi');

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
    AND COALESCE(o.order_date, o.transaction_date) >= (p_from_date::timestamp AT TIME ZONE v_tz)
    AND COALESCE(o.order_date, o.transaction_date) <  ((p_to_date + 1)::timestamp AT TIME ZONE v_tz);

  SELECT COALESCE(SUM(a.amount), 0)
  INTO v_ad_spend
  FROM ad_spend a
  WHERE a.store_id = p_store_id
    AND a.spend_date >= p_from_date
    AND a.spend_date <= p_to_date;

  -- ── Expenses: table-driven (segments + percent), windowed ────────────────
  SELECT COALESCE(SUM(
    CASE
      WHEN e.kind = 'fixed' THEN e.amount * (
        SELECT COUNT(*)::int
        FROM generate_series(
               date_trunc('month', p_from_date)::date,
               date_trunc('month', p_to_date)::date,
               '1 month'::interval) AS ms
        WHERE ms::date BETWEEN p_from_date AND p_to_date
          AND (e.effective_from IS NULL OR ms::date >= e.effective_from)
          AND (e.effective_to   IS NULL OR ms::date <= e.effective_to)
      )
      WHEN e.kind = 'per_order'
           AND (e.effective_from IS NULL OR e.effective_from <= p_to_date)
           AND (e.effective_to   IS NULL OR e.effective_to   >= p_from_date)
        THEN e.amount * v_delivered
      WHEN e.kind = 'percent' AND e.pct_base = 'ad_spend'
           AND (e.effective_from IS NULL OR e.effective_from <= p_to_date)
           AND (e.effective_to   IS NULL OR e.effective_to   >= p_from_date)
        THEN e.amount / 100.0 * v_ad_spend
      WHEN e.kind = 'percent' AND e.pct_base = 'net_sales'
           AND (e.effective_from IS NULL OR e.effective_from <= p_to_date)
           AND (e.effective_to   IS NULL OR e.effective_to   >= p_from_date)
        THEN e.amount / 100.0 * v_sales
      ELSE 0
    END
  ), 0)
  INTO v_expenses
  FROM store_expenses e
  WHERE e.store_id = COALESCE(p_expense_store_id, p_store_id);

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
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- get_daily_series  (base: migration 025)
CREATE OR REPLACE FUNCTION public.get_daily_series(
  p_store_id text,
  p_from_date date,
  p_to_date date,
  p_monthly_expenses numeric DEFAULT 0,     -- ignored
  p_per_order_expenses numeric DEFAULT 0,   -- ignored
  p_expense_store_id text DEFAULT NULL
)
RETURNS TABLE(day date, sales numeric, orders bigint, delivered bigint, returns bigint, cogs numeric, delivery_cost numeric, ad_spend numeric, return_loss numeric, expenses numeric, gross_profit numeric, net_profit numeric)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_sellable_returns_pct numeric;
  v_tz text;
BEGIN
  SELECT COALESCE(s.sellable_returns_pct, 85), COALESCE(s.timezone, 'Asia/Karachi')
  INTO v_sellable_returns_pct, v_tz
  FROM stores s
  WHERE s.store_id = p_store_id;
  v_sellable_returns_pct := COALESCE(v_sellable_returns_pct, 85);
  v_tz := COALESCE(v_tz, 'Asia/Karachi');

  RETURN QUERY
  WITH days AS (
    SELECT generate_series(p_from_date, p_to_date, '1 day'::interval)::date AS d
  ),
  ord AS (
    SELECT
      (COALESCE(o.order_date, o.transaction_date) AT TIME ZONE v_tz)::date AS d,
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
      AND COALESCE(o.order_date, o.transaction_date) >= (p_from_date::timestamp AT TIME ZONE v_tz)
      AND COALESCE(o.order_date, o.transaction_date) <  ((p_to_date + 1)::timestamp AT TIME ZONE v_tz)
    GROUP BY (COALESCE(o.order_date, o.transaction_date) AT TIME ZONE v_tz)::date
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
    exp.amount                                                          AS expenses,
    (COALESCE(ord.sales, 0) - COALESCE(ord.delivery_cost, 0) - COALESCE(ord.cogs, 0))
                                                                        AS gross_profit,
    (COALESCE(ord.sales, 0)
       - COALESCE(ord.delivery_cost, 0)
       - COALESCE(ord.cogs, 0)
       - COALESCE(ads.ad_spend, 0)
       - exp.amount)                                                    AS net_profit
  FROM days
  LEFT JOIN ord ON ord.d = days.d
  LEFT JOIN ads ON ads.d = days.d
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(
      CASE
        WHEN e.kind = 'fixed'
             AND EXTRACT(DAY FROM days.d) = 1
             AND (e.effective_from IS NULL OR days.d >= e.effective_from)
             AND (e.effective_to   IS NULL OR days.d <= e.effective_to)
          THEN e.amount
        WHEN e.kind = 'per_order'
             AND (e.effective_from IS NULL OR e.effective_from <= days.d)
             AND (e.effective_to   IS NULL OR e.effective_to   >= days.d)
          THEN e.amount * COALESCE(ord.delivered, 0)
        WHEN e.kind = 'percent' AND e.pct_base = 'ad_spend'
             AND (e.effective_from IS NULL OR e.effective_from <= days.d)
             AND (e.effective_to   IS NULL OR e.effective_to   >= days.d)
          THEN e.amount / 100.0 * COALESCE(ads.ad_spend, 0)
        WHEN e.kind = 'percent' AND e.pct_base = 'net_sales'
             AND (e.effective_from IS NULL OR e.effective_from <= days.d)
             AND (e.effective_to   IS NULL OR e.effective_to   >= days.d)
          THEN e.amount / 100.0 * COALESCE(ord.sales, 0)
        ELSE 0
      END
    ), 0) AS amount
    FROM store_expenses e
    WHERE e.store_id = COALESCE(p_expense_store_id, p_store_id)
  ) exp ON true
  ORDER BY days.d;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- get_trend_series  (base: migration 025)
CREATE OR REPLACE FUNCTION public.get_trend_series(
  p_store_id text,
  p_from_date date,
  p_to_date date,
  p_monthly_expenses numeric DEFAULT 0,     -- ignored
  p_per_order_expenses numeric DEFAULT 0,   -- ignored
  p_granularity text DEFAULT 'day',
  p_expense_store_id text DEFAULT NULL
)
RETURNS TABLE(bucket_start date, sales numeric, orders bigint, delivered bigint, returns bigint, cogs numeric, delivery_cost numeric, ad_spend numeric, return_loss numeric, expenses numeric, total_cost numeric, net_profit numeric)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_sellable_returns_pct numeric;
  v_step interval;
  v_trunc text;
  v_tz text;
BEGIN
  IF p_granularity NOT IN ('day','month','year') THEN
    RAISE EXCEPTION 'invalid granularity: %', p_granularity;
  END IF;

  SELECT COALESCE(s.sellable_returns_pct, 85), COALESCE(s.timezone, 'Asia/Karachi')
  INTO v_sellable_returns_pct, v_tz
  FROM stores s
  WHERE s.store_id = p_store_id;
  v_sellable_returns_pct := COALESCE(v_sellable_returns_pct, 85);
  v_tz := COALESCE(v_tz, 'Asia/Karachi');

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
      date_trunc(v_trunc, COALESCE(o.order_date, o.transaction_date) AT TIME ZONE v_tz)::date AS bs,
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
      AND COALESCE(o.order_date, o.transaction_date) >= (p_from_date::timestamp AT TIME ZONE v_tz)
      AND COALESCE(o.order_date, o.transaction_date) <  ((p_to_date + 1)::timestamp AT TIME ZONE v_tz)
    GROUP BY date_trunc(v_trunc, COALESCE(o.order_date, o.transaction_date) AT TIME ZONE v_tz)
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
    exp.amount                                                          AS expenses,
    (COALESCE(ord.cogs, 0)
       + COALESCE(ord.delivery_cost, 0)
       + COALESCE(ads.ad_spend, 0)
       + COALESCE(ord.return_loss, 0)
       + exp.amount)                                                    AS total_cost,
    (COALESCE(ord.sales, 0)
       - COALESCE(ord.delivery_cost, 0)
       - COALESCE(ord.cogs, 0)
       - COALESCE(ads.ad_spend, 0)
       - exp.amount)                                                    AS net_profit
  FROM buckets
  LEFT JOIN ord ON ord.bs = buckets.bs
  LEFT JOIN ads ON ads.bs = buckets.bs
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(
      CASE
        WHEN e.kind = 'fixed' THEN e.amount * (
          CASE p_granularity
            WHEN 'day' THEN
              CASE WHEN EXTRACT(DAY FROM buckets.bs) = 1
                        AND (e.effective_from IS NULL OR buckets.bs >= e.effective_from)
                        AND (e.effective_to   IS NULL OR buckets.bs <= e.effective_to)
                   THEN 1 ELSE 0 END
            WHEN 'month' THEN
              CASE WHEN (e.effective_from IS NULL OR buckets.bs >= e.effective_from)
                        AND (e.effective_to   IS NULL OR buckets.bs <= e.effective_to)
                   THEN 1 ELSE 0 END
            WHEN 'year' THEN (
              SELECT COUNT(*)::int
              FROM generate_series(
                     buckets.bs,
                     (buckets.bs + interval '1 year' - interval '1 month')::date,
                     '1 month'::interval) AS ym
              WHERE (e.effective_from IS NULL OR ym::date >= e.effective_from)
                AND (e.effective_to   IS NULL OR ym::date <= e.effective_to)
            )
          END
        )
        WHEN e.kind = 'per_order'
             AND (e.effective_from IS NULL OR e.effective_from <= (buckets.bs + v_step - interval '1 day')::date)
             AND (e.effective_to   IS NULL OR e.effective_to   >= buckets.bs)
          THEN e.amount * COALESCE(ord.delivered, 0)
        WHEN e.kind = 'percent' AND e.pct_base = 'ad_spend'
             AND (e.effective_from IS NULL OR e.effective_from <= (buckets.bs + v_step - interval '1 day')::date)
             AND (e.effective_to   IS NULL OR e.effective_to   >= buckets.bs)
          THEN e.amount / 100.0 * COALESCE(ads.ad_spend, 0)
        WHEN e.kind = 'percent' AND e.pct_base = 'net_sales'
             AND (e.effective_from IS NULL OR e.effective_from <= (buckets.bs + v_step - interval '1 day')::date)
             AND (e.effective_to   IS NULL OR e.effective_to   >= buckets.bs)
          THEN e.amount / 100.0 * COALESCE(ord.sales, 0)
        ELSE 0
      END
    ), 0) AS amount
    FROM store_expenses e
    WHERE e.store_id = COALESCE(p_expense_store_id, p_store_id)
  ) exp ON true
  ORDER BY buckets.bs;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- get_expense_breakdown  (base: migration 025) — order window made tz-aware
CREATE OR REPLACE FUNCTION public.get_expense_breakdown(
  p_store_id text,
  p_from_date date,
  p_to_date date,
  p_expense_store_id text DEFAULT NULL
)
RETURNS TABLE(series_id uuid, name text, kind text, is_variable boolean, pct_base text, value numeric, estimated boolean)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_delivered bigint;
  v_sales     numeric;
  v_ad_spend  numeric;
  v_max_month date;
  v_tz        text;
BEGIN
  SELECT COALESCE(s.timezone, 'Asia/Karachi') INTO v_tz
  FROM stores s WHERE s.store_id = p_store_id;
  v_tz := COALESCE(v_tz, 'Asia/Karachi');

  SELECT COALESCE(COUNT(*) FILTER (WHERE o.is_delivered), 0),
         COALESCE(SUM(CASE WHEN o.is_delivered THEN o.invoice_payment ELSE 0 END), 0)
    INTO v_delivered, v_sales
  FROM orders o
  WHERE o.store_id = p_store_id
    AND COALESCE(o.order_date, o.transaction_date) >= (p_from_date::timestamp AT TIME ZONE v_tz)
    AND COALESCE(o.order_date, o.transaction_date) <  ((p_to_date + 1)::timestamp AT TIME ZONE v_tz);

  SELECT COALESCE(SUM(a.amount), 0) INTO v_ad_spend
  FROM ad_spend a
  WHERE a.store_id = p_store_id AND a.spend_date BETWEEN p_from_date AND p_to_date;

  SELECT MAX(ms)::date INTO v_max_month
  FROM generate_series(date_trunc('month', p_from_date)::date,
                       date_trunc('month', p_to_date)::date,
                       '1 month'::interval) ms
  WHERE ms::date BETWEEN p_from_date AND p_to_date;

  RETURN QUERY
  SELECT
    e.series_id, e.name, e.kind, e.is_variable, e.pct_base,
    CASE
      WHEN e.kind = 'fixed' THEN e.amount * (
        SELECT COUNT(*)::int
        FROM generate_series(
               date_trunc('month', p_from_date)::date,
               date_trunc('month', p_to_date)::date,
               '1 month'::interval) AS ms
        WHERE ms::date BETWEEN p_from_date AND p_to_date
          AND (e.effective_from IS NULL OR ms::date >= e.effective_from)
          AND (e.effective_to   IS NULL OR ms::date <= e.effective_to)
      )
      WHEN e.kind = 'per_order'
           AND (e.effective_from IS NULL OR e.effective_from <= p_to_date)
           AND (e.effective_to   IS NULL OR e.effective_to   >= p_from_date)
        THEN e.amount * v_delivered
      WHEN e.kind = 'percent' AND e.pct_base = 'ad_spend'
           AND (e.effective_from IS NULL OR e.effective_from <= p_to_date)
           AND (e.effective_to   IS NULL OR e.effective_to   >= p_from_date)
        THEN e.amount / 100.0 * v_ad_spend
      WHEN e.kind = 'percent' AND e.pct_base = 'net_sales'
           AND (e.effective_from IS NULL OR e.effective_from <= p_to_date)
           AND (e.effective_to   IS NULL OR e.effective_to   >= p_from_date)
        THEN e.amount / 100.0 * v_sales
      ELSE 0
    END AS value,
    (e.kind = 'fixed' AND e.is_variable AND e.effective_to IS NULL
       AND v_max_month IS NOT NULL
       AND (e.effective_from IS NULL OR v_max_month > e.effective_from)) AS estimated
  FROM store_expenses e
  WHERE e.store_id = COALESCE(p_expense_store_id, p_store_id)
  ORDER BY e.created_at;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- get_city_breakdown  (base: migration 004) — range filter made tz-aware
CREATE OR REPLACE FUNCTION get_city_breakdown(
  p_store_id  text,
  p_from_date date,
  p_to_date   date
)
RETURNS TABLE (
  city          text,
  delivered     bigint,
  returned      bigint,
  total_orders  bigint,
  return_loss   numeric,
  return_pct    numeric
) AS $$
DECLARE
  v_sellable_pct numeric;
  v_tz text;
BEGIN
  SELECT COALESCE(s.sellable_returns_pct, 85), COALESCE(s.timezone, 'Asia/Karachi')
  INTO v_sellable_pct, v_tz
  FROM stores s
  WHERE s.store_id = p_store_id;
  v_tz := COALESCE(v_tz, 'Asia/Karachi');

  RETURN QUERY
  WITH agg AS (
    SELECT
      COALESCE(NULLIF(INITCAP(TRIM(o.city_name)), ''), 'Unknown') AS city,
      COUNT(*) FILTER (WHERE o.is_delivered)::bigint AS delivered,
      COUNT(*) FILTER (WHERE o.is_returned)::bigint  AS returned,
      COALESCE(SUM(
        CASE WHEN o.is_returned
          THEN (o.transaction_fee + o.transaction_tax + o.reversal_fee + o.reversal_tax)
             + (o.cogs_total * (1 - v_sellable_pct / 100.0))
          ELSE 0
        END
      ), 0) AS return_loss
    FROM orders o
    WHERE o.store_id = p_store_id
      AND o.transaction_date >= (p_from_date::timestamp AT TIME ZONE v_tz)
      AND o.transaction_date <  ((p_to_date + 1)::timestamp AT TIME ZONE v_tz)
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
  ORDER BY (agg.delivered + agg.returned) DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql;

COMMIT;
