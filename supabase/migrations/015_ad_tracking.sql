-- ============================================================
-- Migration 015: Ad Tracking (Meta Pixel + CAPI relay)
-- ============================================================
-- Adds the persistence layer for the Ad Tracking page.
--
-- Storage strategy (deliberately minimal):
--  - meta_pixel_connections: 1 row per shop, BISU token + dataset id
--  - capi_retries: ONLY failed CAPI events awaiting backoff retry
--  - capi_delivery_log: capped 500-row tail per shop for the dashboard
--      "Recent events" list (rolling, trigger-trimmed — no time-based TTL)
--  - emq_snapshots: daily Event Match Quality scores per dataset, 90-day TTL
--
-- We deliberately DO NOT mirror every browser pixel event into Postgres —
-- identity rides on Shopify cart attributes (note_attributes) into the order
-- webhook, so the CAPI worker reads fbp/fbc/fbclid straight off the order
-- without a session lookup.

-- ============================================================
-- meta_pixel_connections
-- ============================================================
-- One row per shop that has connected the Pixel Tracking config.
-- Distinct from the existing stores.meta_access_token (which is the ads_read
-- user token used for spend reporting). The two coexist; merchants can have
-- one, the other, both, or neither.

CREATE TABLE meta_pixel_connections (
  store_id            text PRIMARY KEY REFERENCES stores(store_id) ON DELETE CASCADE,
  config_id           text NOT NULL,                  -- FBL4B configuration id
  bisu_token          text NOT NULL,                  -- encrypted at rest (AES-256-GCM)
  business_id         text NOT NULL,
  business_name       text,
  dataset_id          text NOT NULL,                  -- Meta Pixel / Dataset id
  dataset_name        text,
  ad_account_id       text,                           -- optional cross-ref
  web_pixel_id        text,                           -- Shopify Admin GraphQL id of the installed Custom Web Pixel
  status              text NOT NULL DEFAULT 'active'  -- active|revoked|error
                      CHECK (status IN ('active','revoked','error')),
  status_reason       text,                           -- last error string when status != 'active'
  connected_at        timestamptz NOT NULL DEFAULT now(),
  last_health_check   timestamptz,
  last_event_sent_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_meta_pixel_connections_status ON meta_pixel_connections(status);

ALTER TABLE meta_pixel_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "store_isolation" ON meta_pixel_connections
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));


-- ============================================================
-- capi_retries
-- ============================================================
-- Failed CAPI events awaiting retry. Steady-state size is tiny — most events
-- succeed first try and never write here. Rows are deleted on success or
-- after capi_attempts >= 5 (Meta won't accept events older than 7 days anyway).

CREATE TABLE capi_retries (
  id                bigserial PRIMARY KEY,
  store_id          text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  dataset_id        text NOT NULL,
  event_id          uuid NOT NULL,
  event_name        text NOT NULL,
  event_time        timestamptz NOT NULL,
  payload           jsonb NOT NULL,                   -- full CAPI body, ready to POST
  attempts          int  NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_capi_retries_event_id ON capi_retries(event_id);
CREATE INDEX idx_capi_retries_due ON capi_retries(next_attempt_at) WHERE attempts < 5;

ALTER TABLE capi_retries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "store_isolation" ON capi_retries
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));


-- ============================================================
-- capi_delivery_log
-- ============================================================
-- Rolling tail of recently-sent CAPI events for the dashboard "Recent events"
-- table. Capped at 500 rows per shop via a trigger so the table size scales
-- with shop count (not event count). At 5,000 merchants this is ~2.5M rows
-- and ~1 GB — trivial.

CREATE TABLE capi_delivery_log (
  id          bigserial PRIMARY KEY,
  store_id    text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  event_id    uuid NOT NULL,
  event_name  text NOT NULL,
  status      text NOT NULL CHECK (status IN ('sent','failed')),
  trace_id    text,                                   -- Meta fbtrace_id for support
  emq         numeric(3,1),                           -- per-event EMQ if Meta returned one
  http_status int,
  error_msg   text,
  sent_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_capi_delivery_log_store_sent ON capi_delivery_log(store_id, sent_at DESC);

ALTER TABLE capi_delivery_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "store_isolation" ON capi_delivery_log
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));

-- Per-shop row cap: trim so each store_id keeps only its 500 most-recent rows.
-- Using a window-based DELETE keeps this O(1) on insert at any scale.
CREATE OR REPLACE FUNCTION trim_capi_delivery_log() RETURNS trigger AS $$
BEGIN
  DELETE FROM capi_delivery_log
  WHERE store_id = NEW.store_id
    AND id IN (
      SELECT id FROM capi_delivery_log
      WHERE store_id = NEW.store_id
      ORDER BY id DESC
      OFFSET 500
    );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fires after each insert. Cheap because the OFFSET 500 query uses the
-- (store_id, sent_at DESC) index and only ever returns the small overflow.
CREATE TRIGGER trg_capi_delivery_log_cap
AFTER INSERT ON capi_delivery_log
FOR EACH ROW EXECUTE FUNCTION trim_capi_delivery_log();


-- ============================================================
-- emq_snapshots
-- ============================================================
-- Daily Event Match Quality snapshot per dataset. Drives the EMQ trend chart
-- on the Ad Tracking page. 90-day rolling history is plenty.

CREATE TABLE emq_snapshots (
  store_id            text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  dataset_id          text NOT NULL,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  overall_emq         numeric(3,1),
  per_event           jsonb,                          -- { Purchase: 9.2, ViewContent: 7.8, ... }
  per_field_coverage  jsonb,                          -- { em: 0.95, ph: 0.40, fbc: 0.62, ... }
  PRIMARY KEY (store_id, dataset_id, captured_at)
);

CREATE INDEX idx_emq_snapshots_store_time ON emq_snapshots(store_id, captured_at DESC);

ALTER TABLE emq_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "store_isolation" ON emq_snapshots
  USING      (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));
