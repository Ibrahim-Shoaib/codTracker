-- ============================================================
-- Migration 014: shared demo pool sentinel
-- ============================================================
-- All is_demo stores show the SAME orders + ad_spend so we don't fabricate
-- (or store) a separate copy of demo data per onboarded demo store. The
-- shared rows live under the sentinel store_id below; the dashboard loader
-- swaps to this id when the merchant's own store row has is_demo = true.
--
-- The sentinel is itself flagged is_demo = true so the existing real-cron
-- filters (.neq('is_demo', true)) keep skipping it — we never try to hit
-- PostEx or Meta with this id. onboarding_complete = true so it's not
-- treated as an in-progress merchant anywhere.
--
-- store_id format: __codprofit_demo_pool__ — the underscore prefix marks
-- it as system-internal and the name is unlikely to collide with any real
-- *.myshopify.com domain.

INSERT INTO stores (store_id, is_demo, onboarding_complete, sellable_returns_pct, created_at)
VALUES ('__codprofit_demo_pool__', true, true, 85, now())
ON CONFLICT (store_id) DO NOTHING;
