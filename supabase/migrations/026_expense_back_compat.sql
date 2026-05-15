-- 026_expense_back_compat.sql
-- HOTFIX. Migration 024 made store_expenses.kind NOT NULL with no default.
-- The still-deployed OLD app inserts expenses as (store_id, name, amount,
-- type) WITHOUT kind -> every "add expense" on the live app fails with a
-- not-null violation (this already cost a real merchant a row).
--
-- A BEFORE INSERT trigger derives the new columns from the legacy `type`
-- when they're absent, so the old app keeps working unchanged AND the new
-- app (which always sets kind explicitly) is unaffected. Legacy-style
-- inserts get effective_from = NULL (unbounded) == the old "applies to the
-- entire period" behavior, so numbers are preserved exactly.

BEGIN;

CREATE OR REPLACE FUNCTION public.store_expenses_compat()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Old app omits kind -> derive from legacy `type`.
  IF NEW.kind IS NULL THEN
    NEW.kind := CASE NEW.type
                  WHEN 'per_order' THEN 'per_order'
                  WHEN 'monthly'   THEN 'fixed'
                  ELSE 'fixed'
                END;
  END IF;
  -- Keep legacy `type` populated for fixed/per_order even when only the new
  -- app set kind, so any un-migrated reader still works.
  IF NEW.type IS NULL AND NEW.kind = 'fixed'     THEN NEW.type := 'monthly';   END IF;
  IF NEW.type IS NULL AND NEW.kind = 'per_order' THEN NEW.type := 'per_order'; END IF;
  IF NEW.is_variable IS NULL THEN NEW.is_variable := false; END IF;
  IF NEW.series_id   IS NULL THEN NEW.series_id   := gen_random_uuid(); END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_store_expenses_compat ON store_expenses;
CREATE TRIGGER trg_store_expenses_compat
  BEFORE INSERT ON store_expenses
  FOR EACH ROW EXECUTE FUNCTION public.store_expenses_compat();

COMMIT;
