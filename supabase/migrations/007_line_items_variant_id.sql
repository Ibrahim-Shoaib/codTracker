-- ============================================================
-- Migration 007: variant_id-based COGS matching infrastructure
-- ============================================================
-- Adds the canonical Shopify line-item link to orders so COGS can be resolved
-- by variant_id direct join instead of reverse-engineering products from the
-- PostEx orderDetail text. Existing rows get NULL line_items and continue to
-- be matched by the existing 5-tier text matcher until the first sync after
-- deploy auto-backfills them.
--
-- Safe to re-run: every statement is IF NOT EXISTS or DROP/CREATE.

-- 1) orders.line_items: per-order Shopify line items as JSONB.
--    Shape: [{"variant_id":"123","quantity":1}, ...]
--    NULL  = order not yet enriched, OR no Shopify counterpart
--            (e.g., DM/WhatsApp orders booked manually in PostEx)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS line_items JSONB;

-- 2) GIN index for `line_items @> '[{"variant_id":"…"}]'::jsonb` containment.
--    Used by the targeted retroactive recompute when a single product cost
--    changes — turns a full-table scan into an index lookup.
CREATE INDEX IF NOT EXISTS idx_orders_line_items_gin
  ON orders USING gin (line_items jsonb_path_ops);

-- 3) Add 'variant_id' as the highest-confidence match source.
--    All previously valid sources remain accepted.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_cogs_match_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_cogs_match_source_check
  CHECK (cogs_match_source IN (
    'none',
    'sku',
    'exact',
    'fuzzy',
    'sibling_avg',
    'fallback_avg',
    'variant_id'
  ));

-- 4) stores.line_items_backfilled_at: one-shot flag.
--    NULL => historical line_items backfill has not run for this store yet.
--    Set to now() once the first cron tick after deploy completes a full
--    lifetime enrichment + COGS rematch. Subsequent ticks skip the backfill.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS line_items_backfilled_at TIMESTAMPTZ;

-- 5) Batch update RPC for line_items enrichment — same pattern as
--    apply_cogs_batch. Lets the enrichment job push thousands of updates
--    in one round-trip.
--    p_updates shape:
--      [{"tracking_number":"…","line_items":[{"variant_id":"…","quantity":1}]}, …]
CREATE OR REPLACE FUNCTION apply_line_items_batch(
  p_store_id text,
  p_updates  jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  affected integer;
BEGIN
  WITH u AS (
    SELECT *
    FROM jsonb_to_recordset(p_updates) AS u(
      tracking_number text,
      line_items      jsonb
    )
  ),
  done AS (
    UPDATE orders o
    SET line_items = u.line_items,
        updated_at = now()
    FROM u
    WHERE o.store_id        = p_store_id
      AND o.tracking_number = u.tracking_number
    RETURNING 1
  )
  SELECT count(*)::int INTO affected FROM done;

  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION apply_line_items_batch(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_line_items_batch(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION apply_line_items_batch(text, jsonb) TO authenticated;
