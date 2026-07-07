# cod-tracker — Feature Map

> The original `tasks.md` was a 23-step build checklist. The app shipped a long time ago and grew well past that scope (Ad Tracking, multi-currency, demo mode, two ingest modes). This file is now a "what exists / where to look" map. For implementation guidance see [`docs/claude.md`](./claude.md); for live state always read the code/schema.

---

## Status

Production. Live at `https://codtracker-production.up.railway.app`. Hosted on Railway via Dockerfile.

The original 4-step build checklist in this document — scaffold → Supabase → PostEx integration → Shopify integration → Meta integration → onboarding wizard → settings → dashboard → cron jobs → polish — is fully shipped. Subsequent work added Ad Tracking (Pixel + CAPI relay + visitor identity + channel attribution + EMQ), multi-currency support with FX, the `shopify_direct` ingest mode, demo mode with a shared pool, and the customer-side `order_date` enrichment pipeline.

---

## Feature → file map

### Dashboard

| Surface | Files |
|---|---|
| Loader, redirects, KPI shell | `app/routes/app._index.tsx` |
| KPI card | `app/components/KPICard.jsx` |
| Detail panel + drill-down | `app/components/DetailPanel.jsx` |
| City loss panel | `app/components/CityLossPanel.jsx`, RPC `get_city_breakdown` |
| Trend chart | `app/components/TrendPanel.jsx`, RPC in migration `012_trend_series_rpc.sql` |
| Break-even section | `app/components/BreakEvenSection.jsx` |
| In-pipeline pills | `app/components/PipelinePills.jsx`, `app/lib/shopify-pipeline.server.js`, `app/lib/demo-pipeline.server.js` |
| Warning banners | `app/components/WarningBanner.jsx` |
| Period boundaries (PKT) | `app/lib/dates.server.js` |
| Aggregation dispatch | `app/lib/stats-adapter.server.js` (postex vs shopify_direct) |
| Main RPC | `get_dashboard_stats` in `supabase/schema.sql` |
| % change RPC | `get_period_comparison` in `supabase/schema.sql` |
| AJAX endpoints | `app.api.{stats,trend,city-breakdown,embed-status}.tsx` |

### Onboarding

| Step | Route | Purpose |
|---|---|---|
| 1 | `app/routes/app.onboarding.step1-postex.tsx` | PostEx token validation + historical backfill kickoff |
| 2 | `app/routes/app.onboarding.step2-meta.tsx` | Meta Ads OAuth (skippable) |
| 3 | `app/routes/app.onboarding.step3-cogs.tsx` | COGS table population |
| 4 | `app/routes/app.onboarding.step4-expenses.tsx` | Multi-row `store_expenses` |
| Wrapper | `app/routes/app.onboarding.tsx` | |

### Settings

`app/routes/app.settings.tsx` covers PostEx, Meta, expenses, currency. COGS editing is on `app/routes/app.cogs.tsx`.

### PostEx

| File | Purpose |
|---|---|
| `app/lib/postex.server.js` | API client, status mapping, `#`-stripping |
| `app/lib/sync.server.js` | Per-store sync orchestration |
| `app/lib/backfill.server.js` | Historical backfill (chunked monthly) |
| `app/lib/invoice-fix.server.js` | Repair zero `invoice_payment` rows from PostEx |
| `app/lib/stale-orders.server.js` | Detect stuck-in-transit orders |
| `app/routes/api.cron.postex.tsx` | 6 AM + 6 PM PKT sync, `CONCURRENCY=5` |

### Shopify

| File | Purpose |
|---|---|
| `app/shopify.server.ts` | shopifyApp config, canonical scopes, afterAuth |
| `app/lib/shopify.server.js` | Admin API client + webhook helpers |
| `app/lib/shopify-pipeline.server.js` | Unfulfilled-pipeline reads |
| `app/lib/enrich.server.js` | `order_date` enrichment + COGS enrichment |
| `app/lib/cogs.server.js` | Variant matching strategies |
| `app/routes/api.cogs-rematch.tsx` | Manual retroactive COGS match endpoint |
| `app/routes/webhooks.app.{uninstalled,scopes_update}.tsx` | Shopify-managed webhooks |

### Meta Ads spend

| File | Purpose |
|---|---|
| `app/lib/meta.server.js` | OAuth, `fetchSpendInStoreCurrency`, token expiry helpers |
| `app/lib/meta-session.server.js` | OAuth session cookie |
| `app/lib/fx.server.js` | open.er-api.com client + `fx_rates` cache |
| `app/routes/auth.meta.callback.tsx` | OAuth callback |
| `app/routes/api.cron.meta-today.tsx` | Today's running spend, every 2 h UTC |
| `app/routes/api.cron.meta-finalize.tsx` | Yesterday's final spend, 2 AM PKT |
| `app/routes/api.meta-backfill.tsx` | Backfill for newly-connected merchants |

### Meta Pixel + CAPI relay

| File | Purpose |
|---|---|
| `app/routes/app.ad-tracking.tsx` | Connect / status / recent events page |
| `app/routes/auth.meta-pixel.callback.tsx` | BISU OAuth callback |
| `app/routes/api.webhooks.meta-pixel.tsx` | Order/checkout/refund → CAPI |
| `app/routes/proxy.tracking.config.tsx` | App Proxy: visitor cookie minting |
| `app/routes/proxy.tracking.track.tsx` | App Proxy: client-side beacon → CAPI |
| `app/lib/meta-pixel.server.js` | OAuth helpers, EMQ fetch, BISU revoke |
| `app/lib/meta-pixel-session.server.js` | Pixel OAuth session cookie |
| `app/lib/meta-capi.server.js` | CAPI HTTP client, retry queue, delivery log |
| `app/lib/meta-hash.server.js` | SHA-256 PII hashing for CAPI `user_data` |
| `app/lib/web-pixel-install.server.js` | Admin GraphQL `webPixelCreate`/`webPixelDelete` |
| `app/lib/app-proxy-verify.server.js` | HMAC verification of App Proxy requests |
| `app/lib/theme-embed.server.js` | Poll `settings_data.json` for embed status |
| `app/lib/visitors.server.js` | Visitor row upsert + lookup helpers |
| `app/lib/cart-attributes.server.js` | Identity extraction from order webhooks |
| `app/lib/channel-attribution.server.js` | facebook_ads / instagram_ads / direct_organic |
| `app/lib/crypto.server.js` | AES-256-GCM for BISU token at rest |
| `app/routes/api.cron.capi-retry.tsx` | Drain `capi_retries`, every 5 min |
| `app/routes/api.cron.emq.tsx` | Daily EMQ snapshot |
| `app/routes/api.cron.visitors-trim.tsx` | Trim `visitor_events`, `visitors`, `emq_snapshots`, `order_attribution` |

### Demo mode

| File | Purpose |
|---|---|
| `app/lib/demo-pool.server.js` | `effectiveStoreId`, pool seeding |
| `app/lib/demo-fabricator.server.js` | Synthetic order generation |
| `app/lib/demo-pipeline.server.js` | Mock unfulfilled-pipeline data |
| `app/routes/api.cron.demo-tick.tsx` | Daily fabrication tick |

### Multi-tenancy / infra

| File | Purpose |
|---|---|
| `app/lib/supabase.server.js` | service-role client + `set_app_store` |
| `app/lib/format.js` | Money / number rendering (currency-aware) |
| `app/lib/calculations.server.js` | Reusable math helpers |
| `app/routes/api.webhooks.uninstall.tsx` | Hard-delete on uninstall |
| `app/routes/auth.{$,login}.tsx` | Shopify OAuth entrypoints |
| `app/root.tsx`, `entry.server.tsx` | Remix root |
| `app/routes/app.tsx` | NavMenu wrapper |

---

## Data model quick reference

Schema: `supabase/schema.sql` + 23 incremental migrations. See `docs/claude.md` for the table-by-table rundown. Headline tables:

- Tenant (RLS): `stores`, `orders`, `product_costs`, `ad_spend`, `store_expenses`, `daily_snapshots`, `meta_pixel_connections`, `capi_retries`, `capi_delivery_log`, `emq_snapshots`, `visitors`, `visitor_events`, `order_attribution`.
- Shared: `fx_rates`.

RPCs in `supabase/schema.sql`: `set_app_store`, `get_dashboard_stats`, `get_period_comparison`, `get_orders_for_period`, `get_city_breakdown`. Trim helpers in migrations 015 (`trim_capi_delivery_log` trigger), 017 (`trim_emq_snapshots`), 020 (`trim_order_attribution`). Order-date trigger in 021 (`preserve_order_date`).

---

## Cron jobs (all `x-cron-secret`-protected)

| UTC | PKT | Endpoint |
|---|---|---|
| `0 1,13 * * *` | 6 AM + 6 PM | `POST /api/cron/postex` |
| `0 */2 * * *` | every 2 h | `POST /api/cron/meta-today` |
| `0 21 * * *` | 2 AM | `POST /api/cron/meta-finalize` |
| `*/5 * * * *` | every 5 min | `POST /api/cron/capi-retry` |
| `0 6 * * *` | 11 AM | `POST /api/cron/emq` |
| `0 3 * * *` | 8 AM | `POST /api/cron/visitors-trim` |
| `0 4 * * *` | 9 AM | `POST /api/cron/demo-tick` |

No daily-snapshot or monthly-purge cron exists in the current build (earlier plans were dropped).

---

## Operational scripts

`scripts/` contains both committed utilities and one-off audits. Anything prefixed with `_` is throwaway / investigative — don't depend on it. The non-`_` scripts (`apply-migration-*`, `build-candidate-pairs`, `dump-*`, `force-rematch`, `compare-manual-vs-db`, etc.) are the keepers; they exist because at this scale we periodically need to validate COGS matching, audit pipeline state, or reapply a single migration without re-running the whole `migrations/` folder.

---

## Where to look first when something breaks

| Symptom | Start here |
|---|---|
| Dashboard shows nothing or is wrong | `app/routes/app._index.tsx`, `get_dashboard_stats` SQL, `app/lib/stats-adapter.server.js` |
| KPI cards empty for new install | Check `stores` row, `is_demo`, backfill progress, `last_postex_sync_at` |
| Wrong currency on cards | `stores.currency`, `app/lib/format.js`, `afterAuth` in `app/shopify.server.ts` |
| Meta Ads not showing | `stores.meta_token_expires_at`, `stores.meta_sync_error`, `api.cron.meta-today` logs |
| FX-converted spend looks off | `fx_rates` row freshness, `meta_ad_account_currency`, `fetchSpendInStoreCurrency` |
| CAPI events missing in Events Manager | `capi_delivery_log`, `capi_retries`, `app.ad-tracking.tsx` "Recent events", deterministic event_id collisions |
| EMQ chart not updating | `api.cron.emq` logs, `emq_snapshots` rows, BISU token validity |
| Returns happening but no `is_returned` flips | PostEx `transactionStatusHistory` last entry, `app/lib/postex.server.js` status mapping |
| Order-date bucketing collapses to one day | `orders.order_date` NULL, `enrichOrdersWithShopify` in `app/lib/enrich.server.js`, attempts counter |
| Dashboard stuck on "Syncing" | Backfill row state, `last_postex_sync_at`, manual `api.cron.postex` trigger |
| Demo store sees real data (or vice versa) | `stores.is_demo`, `effectiveStoreId` in `app/lib/demo-pool.server.js` |
