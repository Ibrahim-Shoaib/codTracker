-- ============================================================
-- Migration 021: order_date — customer-side order placement date
-- ============================================================
-- Adds the column the dashboard SHOULD bucket by. PostEx's transaction_date
-- means "when PostEx accepted the consignment" — which ≠ "when the customer
-- placed the order on Shopify" any time the merchant batch-uploads. A
-- merchant who ships once a week sees ALL their unshipped orders collapse
-- onto today on the KPI cards. order_date is the fix.
--
-- Population strategy:
--   - PostEx upsert paths (sync.server.js, backfill.server.js) DO NOT
--     touch order_date. They never include it in the upsert object, and
--     the BEFORE UPDATE trigger below preserves any existing non-NULL
--     value defensively.
--   - enrichOrdersWithShopify (already runs on every cron tick + onboarding)
--     gets extended: when it has a Shopify match for an order, it writes
--     order_date = shopify created_at. When it doesn't have a match, it
--     increments order_date_attempts. After 5 attempts, a finalize sweep
--     writes order_date = transaction_date as the permanent fallback.
--   - Demo fabricator left alone (per merchant instruction) — demo orders
--     have order_date = NULL, dashboard COALESCEs to transaction_date.
--
-- This deliberately introduces zero new Shopify API calls. The existing
-- getOrdersLineItemMap call (one paginated request per cron tick) just
-- gains an extra field on its response.

ALTER TABLE orders
  ADD COLUMN order_date          timestamptz,
  ADD COLUMN order_date_attempts smallint NOT NULL DEFAULT 0;

CREATE INDEX idx_orders_order_date
  ON orders(store_id, order_date DESC);

-- Defensive write-once trigger.
--
-- Why: the existing PostEx upsert is a bulk write that overwrites every
-- column on conflict. We DON'T currently put order_date in the row object,
-- so this trigger is belt-and-braces — if any future code path mistakenly
-- includes order_date in a PostEx-side upsert, it can't clobber a value
-- that's already been resolved from Shopify.
--
-- Allows order_date to be UPDATEd from NULL → set (for late-fill via
-- enrichment), and from set → set (for the rare case where enrichment
-- corrects a value, e.g. fallback finalize).
CREATE OR REPLACE FUNCTION preserve_order_date() RETURNS trigger AS $$
BEGIN
  -- Only preserve if old value is set AND new value is NULL — i.e. caller
  -- is trying to wipe a resolved date. Updates that explicitly write a
  -- new non-NULL value (enrichment, finalize sweep) pass through.
  IF OLD.order_date IS NOT NULL AND NEW.order_date IS NULL THEN
    NEW.order_date := OLD.order_date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_preserve_order_date
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION preserve_order_date();

COMMENT ON COLUMN orders.order_date IS
  'Customer-side order placement date. Filled by enrichOrdersWithShopify from Shopify created_at; falls back to transaction_date after 5 unsuccessful enrichment attempts. Dashboard date-bucketing should use COALESCE(order_date, transaction_date).';
COMMENT ON COLUMN orders.order_date_attempts IS
  'Number of cron ticks that have tried and failed to find this order in Shopify. >=5 means the finalize sweep has fallen back to transaction_date.';
