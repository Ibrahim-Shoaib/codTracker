-- ============================================================
-- Migration 002: expand cogs_match_source + batch apply RPC
-- ============================================================

-- 1) Allow two new "estimated" tiers so the matcher can hit ~100% coverage
--    without silently picking the wrong variant.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_cogs_match_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_cogs_match_source_check
  CHECK (cogs_match_source IN (
    'none',
    'sku',
    'exact',
    'fuzzy',
    'sibling_avg',     -- averaged across a known sibling family
    'fallback_avg'     -- used store-wide median unit_cost
  ));

-- 2) Bulk update RPC — lets retroactiveCOGSMatch push thousands of rows
--    in one round-trip instead of one PostgREST call per row.
--    p_updates shape:
--      [{"tracking_number":"…","cogs_total":…,"cogs_matched":true|false,"cogs_match_source":"…"}, …]
CREATE OR REPLACE FUNCTION apply_cogs_batch(
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
      tracking_number   text,
      cogs_total        numeric,
      cogs_matched      boolean,
      cogs_match_source text
    )
  ),
  done AS (
    UPDATE orders o
    SET cogs_total        = u.cogs_total,
        cogs_matched      = u.cogs_matched,
        cogs_match_source = u.cogs_match_source,
        updated_at        = now()
    FROM u
    WHERE o.store_id        = p_store_id
      AND o.tracking_number = u.tracking_number
    RETURNING 1
  )
  SELECT count(*)::int INTO affected FROM done;

  RETURN affected;
END;
$$;

-- Let service_role and authenticated callers execute the RPC.
REVOKE ALL ON FUNCTION apply_cogs_batch(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_cogs_batch(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION apply_cogs_batch(text, jsonb) TO authenticated;
