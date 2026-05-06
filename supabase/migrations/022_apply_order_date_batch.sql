-- ============================================================
-- Migration 022: apply_order_date_batch + apply_order_date_attempts_batch
-- ============================================================
-- Bulk-update RPCs for order_date enrichment, mirroring the
-- apply_line_items_batch pattern from migration 007. Each cron tick
-- builds an in-memory list of {tracking_number, order_date} updates and
-- pushes them in a single round-trip. Without this we'd be doing
-- N PostgREST UPDATE calls per cron tick (one per matched order),
-- which is 6k+ round-trips for the Trendy Homes one-shot backfill.
--
-- The trigger from migration 021 still fires on these UPDATEs — it
-- preserves order_date ONLY when NEW.order_date IS NULL. Since we
-- always pass non-NULL values here, the trigger lets the writes through.

CREATE OR REPLACE FUNCTION apply_order_date_batch(
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
      order_date      timestamptz
    )
  ),
  done AS (
    UPDATE orders o
    SET order_date = u.order_date,
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

REVOKE ALL ON FUNCTION apply_order_date_batch(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_order_date_batch(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION apply_order_date_batch(text, jsonb) TO authenticated;

COMMENT ON FUNCTION apply_order_date_batch(text, jsonb) IS
  'Bulk update orders.order_date by tracking_number. p_updates shape: [{"tracking_number":"…","order_date":"2026-05-01T10:00:00Z"}, …]';

-- ────────────────────────────────────────────────────────────
-- Increment-attempts RPC. Used when a candidate row didn't get
-- a Shopify match on this tick — we increment the attempt counter
-- so the row eventually drops out of the candidate pool after 5
-- failed enrichment runs.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION apply_order_date_attempts_batch(
  p_store_id        text,
  p_tracking_numbers text[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  affected integer;
BEGIN
  WITH done AS (
    UPDATE orders
    SET order_date_attempts = order_date_attempts + 1,
        updated_at          = now()
    WHERE store_id        = p_store_id
      AND tracking_number = ANY(p_tracking_numbers)
      AND order_date IS NULL
    RETURNING 1
  )
  SELECT count(*)::int INTO affected FROM done;

  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION apply_order_date_attempts_batch(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_order_date_attempts_batch(text, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION apply_order_date_attempts_batch(text, text[]) TO authenticated;

COMMENT ON FUNCTION apply_order_date_attempts_batch(text, text[]) IS
  'Increment order_date_attempts on rows that did not get a Shopify match on this enrichment run. Skips rows that already have order_date set (defensive — they should already be excluded from the candidate query).';

-- ────────────────────────────────────────────────────────────
-- Finalize sweep RPC. Rows where Shopify never returned a match
-- after 5 attempts (PostEx-only orders, deleted Shopify orders,
-- pre-Shopify-install history) get their order_date filled with
-- transaction_date as a permanent fallback so the dashboard can
-- still bucket them.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION finalize_order_date_fallbacks(
  p_store_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  affected integer;
BEGIN
  WITH done AS (
    UPDATE orders
    SET order_date = transaction_date
    WHERE store_id            = p_store_id
      AND order_date          IS NULL
      AND transaction_date    IS NOT NULL
      AND order_date_attempts >= 5
    RETURNING 1
  )
  SELECT count(*)::int INTO affected FROM done;

  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION finalize_order_date_fallbacks(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finalize_order_date_fallbacks(text) TO service_role;
GRANT EXECUTE ON FUNCTION finalize_order_date_fallbacks(text) TO authenticated;

COMMENT ON FUNCTION finalize_order_date_fallbacks(text) IS
  'After 5 failed Shopify enrichment attempts, fall back to transaction_date as permanent order_date. Idempotent — rows already filled (order_date NOT NULL) are skipped.';
