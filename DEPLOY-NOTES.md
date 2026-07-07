# Deploy runbook — performance & hardening pass (2026-07-07)

This branch ships the IMPROVEMENTS.md items. Everything was built to be
**deploy-safe against the two live stores** (the-trendy-homes-pk, 0rq01u-da):
the DB migration is already applied and is backward-compatible with the
currently running code; the token-encryption change reads both formats.

## Already done (no action needed)

- ✅ **Migration 027 applied to production Supabase** (2026-07-07):
  - `pg_trgm` + `idx_visitors_fbc_trgm` + `idx_visitors_ip_seen` — verified
    via `EXPLAIN`: the fbclid purchase-webhook lookup now uses a Bitmap Index
    Scan instead of a seq scan over 24k visitor rows.
  - `upsert_visitor_merge()` RPC — merge semantics verified live against
    production (preserve-or-update, history dedup/cap, timestamps).
  - `capi_delivery_log` trim trigger now fires on ~2% of inserts; nightly
    full sweep (`trim_capi_delivery_log_all`) runs from the visitors-trim cron.
- ✅ Meta Graph **v24.0** verified live for both stores' ad accounts (HTTP 200,
  real spend values returned).
- ✅ Shopify Admin REST **2025-10** verified live with both stores' offline
  sessions (HTTP 200).
- ✅ `npm run typecheck` (0 errors, was 29), `npm test` (144 pass), `npm run lint`
  (0 errors), `npm run build` — all green. `package-lock.json` untouched.

## Deploy steps

1. **Push/merge → Railway deploys.** The Dockerfile is now multi-stage; the
   first build is a full rebuild (slower once), after that layer caching
   resumes. A failed build leaves the current deployment running.
2. Railway now health-checks **`/healthz`** (`railway.json`). No new env vars
   are required — `ENCRYPTION_KEY` is already set (used for BISU tokens).
3. **After the deploy is live**, encrypt the existing Meta ads tokens:
   ```
   node scripts/encrypt-meta-tokens.mjs           # dry run — lists the 2 rows
   node scripts/encrypt-meta-tokens.mjs --apply
   ```
   ⚠️ Do NOT run this before the deploy — the old code reads plaintext only.
   (Order is safe the other way around: new code reads both formats.)

## Post-deploy verification checklist

- [ ] `GET https://<app>/healthz` → `{"ok":true}`
- [ ] Dashboard for the-trendy-homes-pk loads; KPI skeletons appear briefly,
      then real numbers; break-even / trend / city panels stream in.
- [ ] Dashboard for 0rq01u-da (shopify_direct) loads with KPI cards.
- [ ] Ad-tracking page: connection still "active"; fire a Test event.
- [ ] Railway logs: no `upsert_visitor_merge RPC failed … falling back` lines
      (fallback working would be fine, but should not be the steady state).
- [ ] Next meta-today cron tick (every 2h): `synced: 2` in the response/logs.
- [ ] After the token-encrypt script: dashboard still shows Meta connected and
      ad spend keeps updating on the next cron tick.

## Behavior changes to be aware of

- **Webhooks fast-ACK**: `api.webhooks.meta-pixel` now returns 200 immediately
  and processes in the background. Purchase safety net = deterministic
  event_ids + the hourly capi-reconcile cron (unchanged).
- **Backfill polling**: the "setting up your dashboard" state now polls
  `/app/api/sync-status` (1 tiny query) instead of re-running the full
  dashboard loader every 4s.
- **`last_event_sent_at`** on meta_pixel_connections updates at most once per
  minute per store (was: every event).
- **KPI card date presets** are now computed in PKT regardless of the
  viewer's timezone (matches all server boundaries).
- **Meta ads token auto-refresh**: within 7 days of expiry the meta-today cron
  re-exchanges the token for a fresh ~60-day one (banner remains the fallback).
- `app/routes/app.additional.tsx` (unused template page) was deleted.
- `.env` and `scripts/` etc. are no longer copied into the Docker image
  (previously `COPY . .` shipped the .env with all secrets into every image).

## Rollback

`git revert` the commit and redeploy. Migration 027 does not need to be rolled
back — the old code ignores the new functions/indexes, and the trigger change
is behavior-compatible (the nightly sweep just won't run; re-create the
per-row trigger from migration 015 if you want the old trim cadence back).
If the encrypt script already ran and you roll back the code, re-connect Meta
from Settings once (or manually decrypt the two rows) — old code can't read
encrypted tokens.
