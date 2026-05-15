-- 024_expense_segments.sql
-- Expenses v2 — time-bounded segments + percentage expenses.
--
-- ADDITIVE and BEHAVIOR-PRESERVING. Legacy rows are backfilled with
-- effective_from = effective_to = NULL (unbounded), kind derived from the
-- old `type`, and series_id = id. With NULL windows and no percent rows,
-- the table-driven allocator in 025 reproduces the old scalar math exactly
-- (proven by scripts/_expense_v2_baseline.mjs --verify).
--
-- The old `type` column is kept (now nullable) so any un-migrated reader
-- still works for fixed/per_order rows; it is no longer the source of truth.

BEGIN;

ALTER TABLE store_expenses
  ADD COLUMN IF NOT EXISTS series_id      uuid,
  ADD COLUMN IF NOT EXISTS kind           text,
  ADD COLUMN IF NOT EXISTS is_variable    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pct_base       text,
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to   date;

-- Backfill legacy rows. monthly -> fixed, per_order -> per_order.
-- Each existing expense is its own series. Windows stay NULL = "applies to
-- the entire period", which is exactly today's behavior.
UPDATE store_expenses
   SET series_id = COALESCE(series_id, id),
       kind = COALESCE(kind, CASE type
                               WHEN 'monthly'   THEN 'fixed'
                               WHEN 'per_order' THEN 'per_order'
                               ELSE 'fixed'
                             END);

ALTER TABLE store_expenses
  ALTER COLUMN series_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN series_id SET NOT NULL,
  ALTER COLUMN kind      SET NOT NULL;

-- Domain constraints
ALTER TABLE store_expenses
  ADD CONSTRAINT store_expenses_kind_check
  CHECK (kind IN ('fixed','per_order','percent'));

ALTER TABLE store_expenses
  ADD CONSTRAINT store_expenses_pct_base_check
  CHECK (
    (kind =  'percent' AND pct_base IN ('ad_spend','net_sales')) OR
    (kind <> 'percent' AND pct_base IS NULL)
  );

-- Windows are stored as month-start dates (1st). effective_to is the LAST
-- active month's 1st (NULL = open-ended). from <= to when both present.
ALTER TABLE store_expenses
  ADD CONSTRAINT store_expenses_effective_order_check
  CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from);

-- amount must be non-negative (existing data already clean — verified)
ALTER TABLE store_expenses
  ADD CONSTRAINT store_expenses_amount_nonneg CHECK (amount >= 0);

-- Relax legacy `type`: keep column for rollback safety, allow NULL (percent
-- rows have no legacy equivalent), drop the strict NOT NULL + old CHECK.
ALTER TABLE store_expenses ALTER COLUMN type DROP NOT NULL;
ALTER TABLE store_expenses DROP CONSTRAINT store_expenses_type_check;
ALTER TABLE store_expenses
  ADD CONSTRAINT store_expenses_type_check
  CHECK (type IS NULL OR type IN ('monthly','per_order'));

-- Make the allocator's per-store window scan cheap.
CREATE INDEX IF NOT EXISTS idx_store_expenses_alloc
  ON store_expenses (store_id, kind, effective_from, effective_to);

COMMIT;
