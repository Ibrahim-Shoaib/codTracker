# cod-tracker

Shopify-embedded analytics + Meta ad-tracking app for COD merchants. Reconciles Shopify orders with PostEx logistics data, calculates real net profit (delivery, COGS, ad spend, expenses), and provides a server-side Conversions API relay so Meta receives Purchase events even when browser pixels are blocked or COD orders are paid days after the click.

Originally built for Pakistani PKR merchants; now supports any Shopify-supported currency with FX conversion at ingest, and a `shopify_direct` ingest mode for prepaid/international stores that don't use a courier integration.

## What it does

1. **Profit dashboard** — Today / Yesterday / MTD / Last Month KPI cards with drill-down detail panel, city loss panel, trend chart, break-even projection, in-pipeline pills.
2. **PostEx integration** — twice-daily order sync, status-flag derivation (delivered / returned / in-transit), historical backfill on first install.
3. **Shopify integration** — COGS matching by variant (sku → exact → fuzzy → sibling-avg → fallback-avg), live order enrichment (`order_date` from Shopify `created_at`), unfulfilled-pipeline reads, customer-side date bucketing.
4. **Meta ads spend** — `ads_read` OAuth, daily fetch + 2-hourly today refresh, FX-converted to store currency at ingest.
5. **Meta Pixel + CAPI relay** — Custom Web Pixel installed via Admin GraphQL, App Proxy first-party tracking endpoint at `/apps/tracking/*`, server-side Purchase / InitiateCheckout / refund events, deterministic event_id dedup, retry queue with backoff, Event Match Quality (EMQ) scoring, channel attribution (facebook_ads / instagram_ads / direct_organic).
6. **Demo mode** — synthetic data via shared demo pool for sales / onboarding flows.

## Tech stack

| Layer | Choice |
|------|--------|
| Framework | Remix v2 (`@remix-run/*` 2.16) |
| UI | Shopify Polaris v12, Polaris-Viz, App Bridge v4 |
| Database | Supabase (Postgres) — RLS-isolated, RPC aggregations |
| Sessions | `@shopify/shopify-app-session-storage-postgresql` (uses `SUPABASE_DATABASE_URL`) |
| Hosting | Railway (Dockerfile, node:20.18.1-alpine) |
| Cron | Railway scheduled jobs hitting `/api/cron/*` with `x-cron-secret` |
| Shopify API | Admin API `2025-10` |

Node `>=20.19 <22 || >=22.12`.

## Local development

```bash
npm install
shopify app config use shopify.app.toml
npm run dev          # = shopify app dev (sets up tunnel, env, embed)
```

Required env (see `example.env` for the full list with comments):

- **Shopify** — `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`. `SHOPIFY_SCOPES` is optional and overridable; when unset, `app/shopify.server.ts` falls back to its hardcoded `CANONICAL_SCOPES` list (must stay in sync with `shopify.app.toml`).
- **Supabase** — `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DATABASE_URL` (the pooled Postgres URL — used both for Shopify session storage and for the meta-pixel BISU encryption pipeline).
- **Meta Ads (spend)** — `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`.
- **Meta Pixel Tracking** — `META_PIXEL_CONFIG_ID` (the FBL4B "Pixel Tracking" configuration), `META_PIXEL_REDIRECT_URI`, optional `META_TEST_EVENT_CODE`.
- **PostEx** — `POSTEX_API_TOKEN` (local dev only — production tokens are per-merchant in `stores.postex_token`).
- **Secrets** — `CRON_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY` (each `openssl rand -hex 32`). `ENCRYPTION_KEY` encrypts `meta_pixel_connections.bisu_token` at rest; **must** differ from `SESSION_SECRET`.

Database setup: run `supabase/schema.sql` once. It is the consolidated source of truth (tables, FKs, indexes, functions, triggers) — there are no incremental migrations.

## Deployment

Railway, via `Dockerfile` + `railway.json`. The Dockerfile pins `node:20.18.1-alpine` deliberately — a floating tag was repeatedly hanging Railway's Metal builder on Docker Hub manifest fetches.

Production app URL: `https://codtracker-production.up.railway.app` (registered in `shopify.app.toml`).

## Cron schedule

All endpoints require `x-cron-secret: $CRON_SECRET`. Times below are UTC (PKT = UTC+5).

| Job | Cron (UTC) | Endpoint | Notes |
|---|---|---|---|
| PostEx sync | `0 1,13 * * *` | `POST /api/cron/postex` | 6 AM + 6 PM PKT, 30-day rolling window, `CONCURRENCY = 5` |
| Meta today | `0 */2 * * *` | `POST /api/cron/meta-today` | live running today number, FX-converted |
| Meta finalize | `0 21 * * *` | `POST /api/cron/meta-finalize` | 2 AM PKT, locks yesterday |
| CAPI retry | `*/5 * * * *` | `POST /api/cron/capi-retry` | drains `capi_retries` with backoff |
| EMQ snapshot | `0 6 * * *` | `POST /api/cron/emq` | per-dataset EMQ + per-event + coverage |
| Trim tables | `0 3 * * *` | `POST /api/cron/visitors-trim` | `visitor_events` 30d, `visitors` 180d, `emq_snapshots` 90d, `order_attribution` 30d |
| Demo tick | `0 4 * * *` | `POST /api/cron/demo-tick` | fabricates daily synthetic data for the shared demo pool |

There is no monthly purge or daily snapshot cron in the current build — earlier plans were dropped.

## Repository layout

```
app/
  shopify.server.ts         # shopifyApp config — Postgres session storage, canonical scopes, afterAuth
  routes/
    _index/                 # public landing
    auth.{$,login,meta.callback,meta-pixel.callback}.tsx
    app.tsx                 # NavMenu (Home / Ad Tracking / Settings)
    app._index.tsx          # KPI dashboard (4 cards + panels)
    app.ad-tracking.tsx     # Pixel/CAPI connect + status + recent events
    app.settings.tsx        # Edit PostEx, Meta, COGS, expenses, currency
    app.cogs.tsx            # COGS table (post-onboarding)
    app.onboarding.{step1-postex,step2-meta,step3-cogs,step4-expenses}.tsx
    app.api.{stats,trend,city-breakdown,embed-status}.tsx   # AJAX endpoints used by the dashboard
    api.cron.{postex,meta-today,meta-finalize,capi-retry,emq,visitors-trim,demo-tick}.tsx
    api.webhooks.{meta-pixel,uninstall}.tsx
    api.{cogs-rematch,meta-backfill}.tsx
    proxy.tracking.{config,track}.tsx   # App Proxy — first-party visitor + beacon
    webhooks.app.{uninstalled,scopes_update}.tsx   # Shopify-managed webhooks
  lib/
    supabase.server.js      # service-role client + set_app_store RLS context
    dates.server.js         # PKT (UTC+5) helpers
    postex.server.js, sync.server.js, backfill.server.js
    shopify.server.js, shopify-pipeline.server.js, enrich.server.js, cogs.server.js
    meta.server.js, fx.server.js, stale-orders.server.js, invoice-fix.server.js
    meta-pixel.server.js, meta-pixel-session.server.js, meta-capi.server.js, meta-hash.server.js
    web-pixel-install.server.js, app-proxy-verify.server.js, theme-embed.server.js
    visitors.server.js, cart-attributes.server.js, channel-attribution.server.js
    crypto.server.js        # AES-256-GCM for BISU token at rest
    stats-adapter.server.js # postex vs shopify_direct dispatch
    demo-pool.server.js, demo-fabricator.server.js, demo-pipeline.server.js
    calculations.server.js, format.js
  components/               # KPICard, DetailPanel, COGSTable, CityLossPanel, BreakEvenSection,
                            # TrendPanel, PipelinePills, PillSkeleton, SyncingLoader, WarningBanner
supabase/
  schema.sql                # consolidated DDL (tables, FKs, indexes, functions, triggers) — run once
scripts/                    # one-off ops scripts (audit, backfill, smoke-checks). `_*.mjs` are throwaway.
docs/
  claude.md                 # architecture + build guide for future Claude instances
  tasks.md                  # what's built / where to look
shopify.app.toml            # canonical scopes + webhooks + app proxy
Dockerfile, railway.json
```

## Multi-tenancy / RLS

`store_id` is the merchant's `.myshopify.com` domain. Every tenant table has RLS `store_id = current_setting('app.current_store_id', true)`. `getSupabaseForStore(shop)` returns a service-role client that has already called `set_app_store(shop)` — every dashboard / settings query goes through it. Cron jobs that fan out across stores either set the context per-iteration (`getSupabaseForStore` per store) or use the raw service-role client and filter by `store_id` explicitly (e.g. `api.cron.postex`, which lists tenants up-front).

## Testing

```bash
npm test          # node --test tests/*.test.mjs
npm run lint
```

## Further reading

- `docs/claude.md` — architecture decisions, business rules, data model, integration details. Keep up to date if you change behavior.
- `supabase/schema.sql` + numbered migration files — authoritative data model. Schema docs in `docs/claude.md` should match.
- `shopify.app.toml` — webhook subscriptions, scopes, app proxy. **Must** stay in sync with `CANONICAL_SCOPES` in `app/shopify.server.ts`.
