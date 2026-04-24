-- ============================================================
-- COD Tracker — Supabase Schema
-- Run this entire file in the Supabase SQL editor in one go.
-- ============================================================


-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text UNIQUE NOT NULL,           -- .myshopify.com domain
  postex_token text,
  meta_access_token text,
  meta_ad_account_id text,
  meta_token_expires_at timestamptz,       -- Meta long-lived tokens expire after 60 days
  expenses_amount numeric DEFAULT 0,
  expenses_type text CHECK (expenses_type IN ('monthly', 'per_order')),
  sellable_returns_pct numeric DEFAULT 100,
  onboarding_complete boolean DEFAULT false,
  onboarding_step integer DEFAULT 1,       -- 1=postex, 2=meta, 3=cogs, 4=expenses
  last_postex_sync_at timestamptz,
  last_meta_sync_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  tracking_number text NOT NULL,
  order_ref_number text,                   -- normalized: # stripped, matches Shopify order number
  transaction_status text,                 -- raw status string from PostEx e.g. "Delivered"
  status_code text,                        -- mapped code: '0001'-'0013'
  invoice_payment numeric DEFAULT 0,       -- GROSS amount customer paid, NOT what merchant receives
  transaction_fee numeric DEFAULT 0,
  transaction_tax numeric DEFAULT 0,
  reversal_fee numeric DEFAULT 0,
  reversal_tax numeric DEFAULT 0,
  upfront_payment numeric DEFAULT 0,
  reserve_payment numeric DEFAULT 0,
  balance_payment numeric DEFAULT 0,
  items integer DEFAULT 1,
  invoice_division integer DEFAULT 1,
  city_name text,
  customer_name text,
  customer_phone text,
  delivery_address text,
  order_detail text,
  transaction_notes text,
  pickup_address text,
  return_address text,
  actual_weight numeric,
  booking_weight numeric,
  merchant_name text,
  shopify_order_id text,
  cogs_total numeric DEFAULT 0,            -- SUM(unit_cost × quantity) for all line items
  cogs_matched boolean DEFAULT false,      -- true = matched to Shopify; false = defaulted to 0
  is_delivered boolean DEFAULT false,      -- status_code = '0005'
  is_returned boolean DEFAULT false,       -- status_code IN ('0002','0006','0007')
  is_in_transit boolean DEFAULT true,      -- everything else
  transaction_date timestamptz,            -- order creation date — used for rolling window logic
  order_pickup_date timestamptz,
  order_delivery_date timestamptz,
  upfront_payment_date timestamptz,
  reserve_payment_date timestamptz,
  raw_metadata jsonb,                      -- full PostEx API response stored here
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(store_id, tracking_number)
);

CREATE TABLE product_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  shopify_variant_id text NOT NULL,
  shopify_product_id text NOT NULL,
  sku text,
  product_title text,
  variant_title text,
  unit_cost numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(store_id, shopify_variant_id)
);

CREATE TABLE ad_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  spend_date date NOT NULL,
  amount numeric DEFAULT 0,
  source text DEFAULT 'meta',              -- 'meta' always for now
  meta_campaign_data jsonb,               -- raw Meta API response for future use
  updated_at timestamptz DEFAULT now(),
  UNIQUE(store_id, spend_date)
);

CREATE TABLE store_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  name text NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  type text NOT NULL CHECK (type IN ('monthly', 'per_order')),
  created_at timestamptz DEFAULT now()
);

-- NEVER purged. Used for period-over-period % change calculations.
CREATE TABLE daily_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  total_sales numeric DEFAULT 0,
  total_orders integer DEFAULT 0,
  total_units integer DEFAULT 0,
  total_returns integer DEFAULT 0,
  total_in_transit integer DEFAULT 0,
  total_delivery_cost numeric DEFAULT 0,
  total_cogs numeric DEFAULT 0,
  total_ad_spend numeric DEFAULT 0,
  total_expenses numeric DEFAULT 0,
  gross_profit numeric DEFAULT 0,
  net_profit numeric DEFAULT 0,
  UNIQUE(store_id, snapshot_date)
);


-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_orders_store_date    ON orders(store_id, transaction_date);
CREATE INDEX idx_orders_store_flags   ON orders(store_id, is_delivered, is_returned, is_in_transit);
CREATE INDEX idx_orders_ref           ON orders(store_id, order_ref_number);
CREATE INDEX idx_orders_status        ON orders(store_id, status_code);
CREATE INDEX idx_product_costs_variant  ON product_costs(store_id, shopify_variant_id);
CREATE INDEX idx_ad_spend_store_date    ON ad_spend(store_id, spend_date);
CREATE INDEX idx_snapshots_store_date   ON daily_snapshots(store_id, snapshot_date);
CREATE INDEX idx_store_expenses_store   ON store_expenses(store_id);


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
-- USING  → controls SELECT / UPDATE / DELETE (which rows are visible)
-- WITH CHECK → controls INSERT / UPDATE (which rows can be written)
-- Both are required — missing WITH CHECK causes inserts to silently fail.

ALTER TABLE stores          ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_costs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_spend        ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "store_isolation" ON stores
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));

CREATE POLICY "store_isolation" ON orders
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));

CREATE POLICY "store_isolation" ON product_costs
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));

CREATE POLICY "store_isolation" ON ad_spend
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));

CREATE POLICY "store_isolation" ON daily_snapshots
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));

ALTER TABLE store_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "store_isolation" ON store_expenses
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));


-- ============================================================
-- RPC FUNCTIONS
-- ============================================================

-- Sets RLS context — must be called before every Supabase query server-side
CREATE OR REPLACE FUNCTION set_app_store(store text)
RETURNS void AS $$
  SELECT set_config('app.current_store_id', store, true);
$$ LANGUAGE sql;


-- Main dashboard stats for a period.
-- Returns one row. NULL for ratio metrics when denominator = 0 (show "N/A" in UI).
-- Expenses split into monthly (prorated) and per_order (× delivered orders).
CREATE OR REPLACE FUNCTION get_dashboard_stats(
  p_store_id              text,
  p_from_date             date,
  p_to_date               date,
  p_monthly_expenses      numeric,
  p_per_order_expenses    numeric
  -- Note: p_days_in_period was removed; monthly cost uses v_month_count instead
)
RETURNS TABLE (
  sales          numeric,
  orders         bigint,
  units          bigint,
  returns        bigint,
  in_transit     bigint,
  delivery_cost  numeric,
  reversal_cost  numeric,
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
  v_orders         bigint;
  v_units          bigint;
  v_returns        bigint;
  v_in_transit     bigint;
  v_delivery_cost  numeric;
  v_reversal_cost  numeric;
  v_cogs           numeric;
  v_ad_spend       numeric;
  v_expenses       numeric;
  v_gross_profit          numeric;
  v_net_profit            numeric;
  v_sellable_returns_pct  numeric;
  v_month_count           integer;
BEGIN
  -- Read sellable returns % from store config (default 85 if missing)
  SELECT COALESCE(s.sellable_returns_pct, 85)
  INTO v_sellable_returns_pct
  FROM stores s
  WHERE s.store_id = p_store_id;

  -- Count how many month-starts (1st of month) fall within the period.
  -- Monthly expenses are charged once per month, on the 1st.
  SELECT COUNT(*)::integer
  INTO v_month_count
  FROM generate_series(
    date_trunc('month', p_from_date)::date,
    date_trunc('month', p_to_date)::date,
    '1 month'::interval
  ) AS ms
  WHERE ms::date BETWEEN p_from_date AND p_to_date;

  -- Aggregate order metrics
  SELECT
    COALESCE(SUM(CASE WHEN o.is_delivered THEN o.invoice_payment ELSE 0 END), 0),
    COALESCE(COUNT(*) FILTER (WHERE o.is_delivered), 0),
    COALESCE(SUM(CASE WHEN o.is_delivered THEN o.items ELSE 0 END), 0),
    COALESCE(COUNT(*) FILTER (WHERE o.is_returned), 0),
    COALESCE(COUNT(*) FILTER (WHERE o.is_in_transit), 0),
    -- delivery_cost: transaction_fee + transaction_tax for delivered + returned
    COALESCE(SUM(
      CASE WHEN o.is_delivered OR o.is_returned
        THEN o.transaction_fee + o.transaction_tax + o.reversal_fee + o.reversal_tax
        ELSE 0
      END
    ), 0),
    -- reversal_cost: reversal_fee + reversal_tax for returned only
    COALESCE(SUM(
      CASE WHEN o.is_returned
        THEN o.reversal_fee + o.reversal_tax
        ELSE 0
      END
    ), 0),
    -- cogs: full for delivered; only unsellable portion for returned
    -- (85% resellable → only 15% of returned COGS is a real loss)
    COALESCE(SUM(
      CASE
        WHEN o.is_delivered THEN o.cogs_total
        WHEN o.is_returned  THEN o.cogs_total * (1 - v_sellable_returns_pct / 100.0)
        ELSE 0
      END
    ), 0)
  INTO
    v_sales, v_orders, v_units, v_returns, v_in_transit,
    v_delivery_cost, v_reversal_cost, v_cogs
  FROM orders o
  WHERE o.store_id = p_store_id
    AND o.transaction_date >= p_from_date::timestamptz
    AND o.transaction_date <  (p_to_date + 1)::timestamptz;

  -- Ad spend for the period
  SELECT COALESCE(SUM(a.amount), 0)
  INTO v_ad_spend
  FROM ad_spend a
  WHERE a.store_id = p_store_id
    AND a.spend_date >= p_from_date
    AND a.spend_date <= p_to_date;

  -- Monthly expenses: full amount on the 1st of each month, zero all other days.
  -- Per-order expenses: always multiplied by delivered orders.
  -- Monthly expenses × number of month-starts in window; per-order × delivered orders
  v_expenses := (p_monthly_expenses * v_month_count)
              + (p_per_order_expenses * v_orders);

  v_gross_profit := v_sales - v_delivery_cost - v_cogs;
  v_net_profit   := v_gross_profit - v_ad_spend - v_expenses;

  RETURN QUERY SELECT
    v_sales,
    v_orders,
    v_units,
    v_returns,
    v_in_transit,
    v_delivery_cost,
    v_reversal_cost,
    v_cogs,
    v_ad_spend,
    v_expenses,
    v_gross_profit,
    v_net_profit,
    -- ratio metrics: NULL when denominator = 0 (UI shows "N/A")
    CASE WHEN v_ad_spend = 0 THEN NULL ELSE v_sales / v_ad_spend END,
    CASE WHEN v_ad_spend = 0 THEN NULL ELSE v_net_profit / v_ad_spend END,
    CASE WHEN v_ad_spend = 0 OR v_orders = 0 THEN NULL ELSE v_ad_spend / v_orders END,
    CASE WHEN v_orders = 0 THEN NULL ELSE v_sales / v_orders END,
    CASE WHEN v_sales = 0 THEN NULL ELSE (v_net_profit / v_sales) * 100 END,
    CASE WHEN (v_cogs + v_ad_spend + v_delivery_cost) = 0 THEN NULL
         ELSE (v_net_profit / (v_cogs + v_ad_spend + v_delivery_cost)) * 100 END,
    CASE WHEN (v_orders + v_returns) = 0 THEN 0::numeric
         ELSE (v_returns::numeric / (v_orders + v_returns)) * 100 END;
END;
$$ LANGUAGE plpgsql;


-- Period comparison using daily_snapshots (for % change badges on cards).
-- Do NOT call for Last Month card — no prior period data exists.
CREATE OR REPLACE FUNCTION get_period_comparison(
  p_store_id      text,
  p_current_from  date,
  p_current_to    date,
  p_prior_from    date,
  p_prior_to      date
)
RETURNS TABLE (
  current_sales    numeric,
  prior_sales      numeric,
  sales_pct_change numeric,
  current_profit   numeric,
  prior_profit     numeric,
  profit_pct_change numeric
) AS $$
DECLARE
  v_cur_sales   numeric;
  v_prior_sales numeric;
  v_cur_profit  numeric;
  v_prior_profit numeric;
BEGIN
  SELECT COALESCE(SUM(total_sales), 0), COALESCE(SUM(net_profit), 0)
  INTO v_cur_sales, v_cur_profit
  FROM daily_snapshots
  WHERE store_id = p_store_id
    AND snapshot_date >= p_current_from
    AND snapshot_date <= p_current_to;

  SELECT COALESCE(SUM(total_sales), 0), COALESCE(SUM(net_profit), 0)
  INTO v_prior_sales, v_prior_profit
  FROM daily_snapshots
  WHERE store_id = p_store_id
    AND snapshot_date >= p_prior_from
    AND snapshot_date <= p_prior_to;

  RETURN QUERY SELECT
    v_cur_sales,
    v_prior_sales,
    CASE WHEN v_prior_sales = 0 THEN NULL
         ELSE ((v_cur_sales - v_prior_sales) / v_prior_sales) * 100 END,
    v_cur_profit,
    v_prior_profit,
    CASE WHEN v_prior_profit = 0 THEN NULL
         ELSE ((v_cur_profit - v_prior_profit) / v_prior_profit) * 100 END;
END;
$$ LANGUAGE plpgsql;


-- Paginated drill-down orders for a period.
-- p_status_filter: 'delivered' | 'returned' | 'in_transit' | 'all'
CREATE OR REPLACE FUNCTION get_orders_for_period(
  p_store_id      text,
  p_from_date     date,
  p_to_date       date,
  p_status_filter text,
  p_limit         integer DEFAULT 50,
  p_offset        integer DEFAULT 0
)
RETURNS TABLE (
  tracking_number  text,
  order_ref_number text,
  customer_name    text,
  city_name        text,
  transaction_date timestamptz,
  invoice_payment  numeric,
  delivery_cost    numeric,
  reversal_cost    numeric,
  cogs_total       numeric,
  transaction_status text,
  items            integer,
  cogs_matched     boolean
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.tracking_number,
    o.order_ref_number,
    o.customer_name,
    o.city_name,
    o.transaction_date,
    o.invoice_payment,
    o.transaction_fee + o.transaction_tax  AS delivery_cost,
    o.reversal_fee   + o.reversal_tax      AS reversal_cost,
    o.cogs_total,
    o.transaction_status,
    o.items,
    o.cogs_matched
  FROM orders o
  WHERE o.store_id = p_store_id
    AND o.transaction_date >= p_from_date::timestamptz
    AND o.transaction_date <  (p_to_date + 1)::timestamptz
    AND CASE p_status_filter
          WHEN 'delivered'  THEN o.is_delivered
          WHEN 'returned'   THEN o.is_returned
          WHEN 'in_transit' THEN o.is_in_transit
          ELSE true
        END
  ORDER BY o.transaction_date DESC
  LIMIT  p_limit
  OFFSET p_offset;
END;
$$ LANGUAGE plpgsql;
