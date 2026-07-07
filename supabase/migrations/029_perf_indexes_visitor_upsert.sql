-- ============================================================
-- Migration 027 — performance pass (2026-07)
--
-- 1. Indexes for the Purchase-webhook visitor-recovery lookups:
--      - findVisitorByFbclid does `latest_fbc ILIKE '%<fbclid>%'`
--        (leading wildcard) → needs a pg_trgm GIN index.
--      - findRecentVisitorByIpUa filters (store_id, latest_ip, last_seen_at).
--    Both previously seq-scanned `visitors` on every cart-attribute-less
--    purchase/checkout webhook.
--
-- 2. upsert_visitor_merge(): server-side merge for the visitor identity
--    upsert. Replaces the app's SELECT → merge-in-JS → UPSERT (two round
--    trips + a lost-update race between concurrent beacons) with a single
--    atomic INSERT ... ON CONFLICT. Semantics mirror app/lib/visitors.server.js
--    exactly: COALESCE(new, old) per column ("never null-out"), history
--    arrays append-deduped-capped at 5, first_seen_at preserved.
--
-- 3. capi_delivery_log trim: the per-row AFTER INSERT trigger ran a
--    DELETE-with-subselect on EVERY insert (every storefront beacon).
--    Re-created with a `WHEN (random() < 0.02)` sampling clause so the
--    sweep runs ~1-in-50 inserts; a nightly full sweep function
--    (trim_capi_delivery_log_all) backstops it from the trim cron.
-- ============================================================

-- ── 1. Indexes ──────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_visitors_fbc_trgm
  ON visitors USING gin (latest_fbc gin_trgm_ops)
  WHERE latest_fbc IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_visitors_ip_seen
  ON visitors (store_id, latest_ip, last_seen_at DESC)
  WHERE latest_ip IS NOT NULL;

-- ── 2. Visitor merge helpers ────────────────────────────────

-- Append `entry` to jsonb array `existing` unless an entry with identical
-- content (ignoring seen_at) already exists; keep only the newest `cap`
-- entries. Mirrors appendHistory() in app/lib/visitors.server.js.
CREATE OR REPLACE FUNCTION jsonb_append_capped(existing jsonb, entry jsonb, cap int)
RETURNS jsonb AS $$
DECLARE
  arr jsonb := coalesce(existing, '[]'::jsonb);
  merged jsonb;
BEGIN
  IF entry IS NULL THEN RETURN arr; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(arr) e
    WHERE (e.value - 'seen_at') = (entry - 'seen_at')
  ) THEN
    RETURN arr;
  END IF;
  merged := arr || jsonb_build_array(entry);
  IF jsonb_array_length(merged) > cap THEN
    SELECT coalesce(jsonb_agg(elem ORDER BY ord), '[]'::jsonb) INTO merged
    FROM (
      SELECT t.elem, t.ord
      FROM jsonb_array_elements(merged) WITH ORDINALITY AS t(elem, ord)
      WHERE t.ord > jsonb_array_length(merged) - cap
    ) s;
  END IF;
  RETURN merged;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION upsert_visitor_merge(
  p_store_id         text,
  p_visitor_id       text,
  p_em_hash          text DEFAULT NULL,
  p_ph_hash          text DEFAULT NULL,
  p_fn_hash          text DEFAULT NULL,
  p_ln_hash          text DEFAULT NULL,
  p_ct_hash          text DEFAULT NULL,
  p_st_hash          text DEFAULT NULL,
  p_zp_hash          text DEFAULT NULL,
  p_country_hash     text DEFAULT NULL,
  p_external_id_hash text DEFAULT NULL,
  p_fbp              text DEFAULT NULL,
  p_fbc              text DEFAULT NULL,
  p_fbclid           text DEFAULT NULL,
  p_ip               text DEFAULT NULL,
  p_ua               text DEFAULT NULL,
  p_utm_source       text DEFAULT NULL,
  p_utm_campaign     text DEFAULT NULL,
  p_utm_content      text DEFAULT NULL
) RETURNS void AS $$
DECLARE
  v_now       timestamptz := now();
  v_fbc_entry jsonb := CASE WHEN p_fbc IS NULL THEN NULL
    ELSE jsonb_build_object('value', p_fbc, 'fbclid', p_fbclid, 'seen_at', v_now) END;
  v_utm_entry jsonb := CASE
    WHEN p_utm_source IS NULL AND p_utm_campaign IS NULL AND p_utm_content IS NULL THEN NULL
    ELSE jsonb_build_object('source', p_utm_source, 'campaign', p_utm_campaign,
                            'content', p_utm_content, 'seen_at', v_now) END;
BEGIN
  INSERT INTO visitors AS v (
    store_id, visitor_id,
    em_hash, ph_hash, fn_hash, ln_hash, ct_hash, st_hash, zp_hash,
    country_hash, external_id_hash,
    latest_fbp, latest_fbc, latest_ip, latest_ua,
    fbc_history, utm_history,
    first_seen_at, last_seen_at
  ) VALUES (
    p_store_id, p_visitor_id,
    p_em_hash, p_ph_hash, p_fn_hash, p_ln_hash, p_ct_hash, p_st_hash, p_zp_hash,
    p_country_hash, p_external_id_hash,
    p_fbp, p_fbc, p_ip, p_ua,
    coalesce(jsonb_append_capped('[]'::jsonb, v_fbc_entry, 5), '[]'::jsonb),
    coalesce(jsonb_append_capped('[]'::jsonb, v_utm_entry, 5), '[]'::jsonb),
    v_now, v_now
  )
  ON CONFLICT (store_id, visitor_id) DO UPDATE SET
    em_hash          = coalesce(EXCLUDED.em_hash,          v.em_hash),
    ph_hash          = coalesce(EXCLUDED.ph_hash,          v.ph_hash),
    fn_hash          = coalesce(EXCLUDED.fn_hash,          v.fn_hash),
    ln_hash          = coalesce(EXCLUDED.ln_hash,          v.ln_hash),
    ct_hash          = coalesce(EXCLUDED.ct_hash,          v.ct_hash),
    st_hash          = coalesce(EXCLUDED.st_hash,          v.st_hash),
    zp_hash          = coalesce(EXCLUDED.zp_hash,          v.zp_hash),
    country_hash     = coalesce(EXCLUDED.country_hash,     v.country_hash),
    external_id_hash = coalesce(EXCLUDED.external_id_hash, v.external_id_hash),
    latest_fbp       = coalesce(EXCLUDED.latest_fbp,       v.latest_fbp),
    latest_fbc       = coalesce(EXCLUDED.latest_fbc,       v.latest_fbc),
    latest_ip        = coalesce(EXCLUDED.latest_ip,        v.latest_ip),
    latest_ua        = coalesce(EXCLUDED.latest_ua,        v.latest_ua),
    fbc_history      = jsonb_append_capped(v.fbc_history, v_fbc_entry, 5),
    utm_history      = jsonb_append_capped(v.utm_history, v_utm_entry, 5),
    last_seen_at     = v_now;
END;
$$ LANGUAGE plpgsql;

-- ── 3. Delivery-log trim ────────────────────────────────────

DROP TRIGGER IF EXISTS trg_capi_delivery_log_cap ON capi_delivery_log;

-- Same trim function, now fired on ~2% of inserts instead of all of them.
CREATE TRIGGER trg_capi_delivery_log_cap
AFTER INSERT ON capi_delivery_log
FOR EACH ROW
WHEN (random() < 0.02)
EXECUTE FUNCTION trim_capi_delivery_log();

-- Nightly full sweep (called from /api/cron/visitors-trim) so the sampled
-- trigger never lets a shop's tail drift far past the cap.
CREATE OR REPLACE FUNCTION trim_capi_delivery_log_all(p_keep int DEFAULT 500)
RETURNS bigint AS $$
DECLARE deleted bigint;
BEGIN
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY store_id ORDER BY id DESC) AS rn
    FROM capi_delivery_log
  ),
  del AS (
    DELETE FROM capi_delivery_log
    WHERE id IN (SELECT id FROM ranked WHERE rn > p_keep)
    RETURNING 1
  )
  SELECT count(*) INTO deleted FROM del;
  RETURN coalesce(deleted, 0);
END;
$$ LANGUAGE plpgsql;
