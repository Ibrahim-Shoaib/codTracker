# cod-tracker — Architecture & Build Guide

> Reference for future Claude instances and contributors. Covers the *current* state of the app — what shipped, where it lives, why decisions were made. Update this when you change behavior; otherwise it rots and stops being useful (the old version of this doc was kept as truth long after the schema, scopes, and feature surface had moved).
>
> When in doubt, treat code, the live Supabase schema, and `shopify.app.toml` as the source of truth — not this document.

---

## What this app is

A Shopify-embedded analytics + Meta-ad-tracking app for COD merchants:

1. **Profit dashboard** — KPI cards (Today / Yesterday / MTD / Last Month), drill-down detail panel, city loss panel, trend chart, break-even projection, in-pipeline pills.
2. **PostEx integration** — order sync + status flag derivation, historical backfill on first install. Pakistani COD couriers.
3. **Shopify integration** — COGS matching by variant, customer-side `order_date` enrichment, unfulfilled-pipeline reads.
4. **Meta ad spend** — `ads_read` OAuth, daily fetch + 2-hourly today refresh, FX-converted to store currency at ingest.
5. **Meta Pixel + CAPI relay** — Custom Web Pixel, App Proxy first-party endpoint, server-side webhooks → CAPI with deterministic dedup, retry queue, EMQ scoring, channel attribution.
6. **Demo mode** — synthetic data via a shared demo pool for sales/onboarding flows.

Originally PKR-only. Now multi-currency: any Shopify-supported currency, with FX conversion applied to Meta ad spend at ingest. There is also a `shopify_direct` ingest mode for prepaid/international stores that don't use a courier integration — the dashboard reads live from Shopify Admin API instead of aggregating the `orders` table.

---

## Tech stack

| Layer | Choice | Notes |
|------|--------|-------|
| Framework | Remix v2 (`@remix-run/*` 2.16) | Stick with Remix; *do not* migrate to React Router 7 unless deliberately scoped. |
| UI | Shopify Polaris v12 + App Bridge v4 + Polaris-Viz | |
| Database | Supabase (Postgres) | RLS, RPC aggregations, free tier. |
| Sessions | `@shopify/shopify-app-session-storage-postgresql` | Uses `SUPABASE_DATABASE_URL` (pooled Postgres), **not** SQLite — Railway's filesystem is ephemeral. |
| Hosting | Railway (Dockerfile) | `node:20.18.1-alpine` pinned (floating tag was hanging Metal builds). |
| Cron | Railway scheduled jobs | Hit `/api/cron/*` with `x-cron-secret`. |
| Shopify Admin | API `2025-10` | |
| Node | `>=20.19 <22 \|\| >=22.12` | |

---

## Multi-tenancy

`store_id` = the merchant's `.myshopify.com` domain. It is the natural key on every tenant table.

Every tenant table has RLS enabled with the policy:

```sql
USING      (store_id = current_setting('app.current_store_id', true))
WITH CHECK (store_id = current_setting('app.current_store_id', true));
```

Both `USING` and `WITH CHECK` are required — without `WITH CHECK`, inserts pass RLS silently for the wrong store.

The server-side helper:

```js
// app/lib/supabase.server.js
export async function getSupabaseForStore(shop) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  await supabase.rpc('set_app_store', { store: shop });
  return supabase;
}
```

…sets `app.current_store_id` for the duration of the connection. Every dashboard / onboarding / settings query goes through this. Cron jobs that fan out across stores either call `getSupabaseForStore` per iteration, or use the raw service-role client and filter by `store_id` explicitly (e.g. `api.cron.postex` lists tenants up-front and uses both patterns).

`set_app_store` lives in `supabase/schema.sql`.

---

## Environment variables

Authoritative source: `example.env`. Highlights:

- **Shopify** — `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`. `SHOPIFY_SCOPES` is optional; when unset, `app/shopify.server.ts` uses `CANONICAL_SCOPES` (which **must match `shopify.app.toml`** exactly, or scope-diff re-auth detection breaks).
- **Supabase** — `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DATABASE_URL`.
- **Meta Ads spend OAuth** — `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`. Scope: `ads_read`.
- **Meta Pixel Tracking** — `META_PIXEL_CONFIG_ID` (Facebook Login for Business config from the Conversions API template), `META_PIXEL_REDIRECT_URI`, optional `META_TEST_EVENT_CODE` for routing dev events to the Test Events stream.
- **PostEx** — `POSTEX_API_TOKEN` is local-dev only. Production tokens live per-merchant in `stores.postex_token`.
- **Secrets** — `CRON_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`. Each `openssl rand -hex 32`. `ENCRYPTION_KEY` encrypts `meta_pixel_connections.bisu_token` at rest with AES-256-GCM (`app/lib/crypto.server.js`); **must differ** from `SESSION_SECRET` so leaking one doesn't compromise the other.

---

## Shopify scopes (canonical list)

Hardcoded in `app/shopify.server.ts` as `CANONICAL_SCOPES` and mirrored in `shopify.app.toml`:

```
read_orders, read_products, read_inventory,
read_customers, read_checkouts,
write_pixels, read_pixels, read_customer_events,
read_themes
```

Why each:

| Scope | Reason |
|---|---|
| `read_orders` | COGS matching, order webhooks, dashboard reads. |
| `read_products`, `read_inventory` | COGS table population. |
| `read_customers` | Email/phone/name on order webhooks for hashed CAPI identity. |
| `read_checkouts` | Checkout webhooks → InitiateCheckout CAPI events. |
| `write_pixels`, `read_pixels` | Install/manage Custom Web Pixel via Admin GraphQL. |
| `read_customer_events` | Required by `webPixelCreate` so the Web Pixel receives checkout/purchase events from the customer-events stream inside the LavaMoat sandbox. |
| `read_themes` | Poll active theme `settings_data.json` to auto-detect when the merchant has saved our app embeds (no `write_themes`; Shopify gates programmatic theme writes behind an exemption tracking apps don't qualify for). |

`afterAuth` (in `app/shopify.server.ts`) does three things on every install / re-auth:

1. Upserts a `stores` row with `ignoreDuplicates: true` (re-installs don't overwrite credentials).
2. Pulls `currency` + `money_format` from Shopify `shop.json` and stores them on `stores`.
3. Re-asserts shop-specific webhook subscriptions for `app/uninstalled` and the meta-pixel topics — belt-and-suspenders against the real production case where TOML-managed subs failed to retroactively register on older installs.

---

## Database schema

Authoritative: `supabase/schema.sql` for the original tables, `supabase/migrations/00N_*.sql` for incremental changes (run in numeric order). Schema below is illustrative; if it conflicts with the SQL files, the SQL files win.

### Tenant tables (RLS-isolated)

| Table | Purpose |
|---|---|
| `stores` | One row per merchant. Credentials, settings, currency, ingest mode, onboarding state, last-sync timestamps. |
| `orders` | PostEx-synced orders + COGS-matched fields + Shopify `order_date`. |
| `product_costs` | One row per (`store_id`, `shopify_variant_id`). Unit cost in store currency. |
| `ad_spend` | One row per (`store_id`, `spend_date`). Amount in **store** currency (FX-converted at ingest). Never purged. |
| `store_expenses` | Multi-row expenses per store. `{ name, amount, type IN ('monthly', 'per_order') }`. Replaced the legacy single-amount `stores.expenses_amount` / `stores.expenses_type` columns (which still exist but are unused). |
| `daily_snapshots` | Per-day aggregate per store. Defined for % change calculations. Never purged. |
| `meta_pixel_connections` | One row per shop with the Pixel Tracking config connected. Encrypted BISU token, dataset_id, business_id, web_pixel_id, status. |
| `capi_retries` | Failed CAPI events awaiting retry. Drained by `api.cron.capi-retry` every 5 min. Deleted on success or after 5 attempts. |
| `capi_delivery_log` | Rolling tail of recently-sent CAPI events. Capped at **500 rows per shop** by an after-insert trigger (`trim_capi_delivery_log`). Powers the dashboard's "Recent events" list. |
| `emq_snapshots` | Daily Event Match Quality scores per dataset. 90-day TTL via `trim_emq_snapshots`. Drives EMQ trend chart. |
| `visitors` | One row per cod_visitor_id (per-browser-per-store). Hashed PII + latest `fbp/fbc/ip/ua` + `fbc_history`/`utm_history` jsonb arrays. 180-day TTL on `last_seen_at`. |
| `visitor_events` | Per-event breadcrumb. 30-day raw audit trail. |
| `order_attribution` | One row per Shopify order, written at Purchase-webhook time. Pre-classified `channel ∈ {facebook_ads, instagram_ads, direct_organic}`, UTM provenance. 30-day TTL. |

### Shared tables

| Table | Purpose |
|---|---|
| `fx_rates` | Daily-cached `(base, quote) → rate` from open.er-api.com. Read-allowed to all (read-only RLS); writes are service-role only. Used by `app/lib/fx.server.js`. |

### Notable columns / mechanisms

- `orders.transaction_date` — when **PostEx** accepted the consignment.
- `orders.order_date` — when the **customer** placed the order on Shopify. Filled by `enrich.server.js` (`enrichOrdersWithShopify`) from Shopify `created_at`. Fallback to `transaction_date` after 5 unsuccessful enrichment attempts. **Dashboard date-bucketing uses `COALESCE(order_date, transaction_date)`.** Without this, merchants who batch-ship once a week saw all unshipped orders collapse onto today.
- `orders.cogs_match_source` — `'none' | 'sku' | 'exact' | 'fuzzy' | 'sibling_avg' | 'fallback_avg'`. Match strategy is implemented in `app/lib/cogs.server.js`.
- `orders.is_delivered` / `is_returned` / `is_in_transit` — derived from `status_code`, set on every upsert.
- `stores.is_demo` — when `true`, dashboard reads point to the shared demo pool `store_id` (see Demo mode below).
- `stores.ingest_mode` — `'postex'` (default) or `'shopify_direct'`. Dispatched by `app/lib/stats-adapter.server.js`.
- `stores.currency`, `stores.money_format`, `stores.meta_ad_account_currency` — multi-currency support.
- `stores.meta_sync_error` — last Meta cron error message; cleared on success/reconnect. Drives a dashboard banner.
- `meta_pixel_connections.bisu_token` — AES-256-GCM at rest. Encrypted via `app/lib/crypto.server.js` with `ENCRYPTION_KEY`.

### RPC functions (`supabase/schema.sql`)

| RPC | Purpose |
|---|---|
| `set_app_store(store text)` | Sets `app.current_store_id` for RLS. **Call before every Supabase query server-side.** |
| `get_dashboard_stats(p_store_id, p_from_date, p_to_date, p_monthly_expenses, p_per_order_expenses)` | Main dashboard aggregate. Returns one row with sales / orders / units / returns / in_transit / delivery_cost / reversal_cost / tax / cogs / ad_spend / expenses / gross_profit / net_profit / return_loss / roas / poas / cac / aov / margin_pct / roi_pct / refund_pct / in_transit_value. NULL ratios (denominator = 0) → UI shows "N/A". |
| `get_period_comparison(...)` | % change against a prior period using `daily_snapshots`. Skipped for the Last Month card (no prior data exists in rolling window). |
| `get_orders_for_period(...)` | Paginated drill-down for the detail panel. |
| `get_city_breakdown(...)` | City-level return-loss aggregation for the "Where you're losing money" panel. |
| `trim_emq_snapshots()` | 90-day TTL. Called from `api.cron.visitors-trim`. |
| `trim_order_attribution()` | 30-day TTL. Called from `api.cron.visitors-trim`. |
| `trim_capi_delivery_log()` | After-insert trigger; per-shop 500-row cap. |

---

## Financial calculations

All values in the **store's currency** (PKR for legacy installs; matches Shopify `shop.json` for new ones). Formulas live in `get_dashboard_stats` (the SQL is the source of truth — what's below is descriptive).

```
Sales              = SUM(invoice_payment) WHERE is_delivered
Delivery Cost      = SUM(transaction_fee + transaction_tax + reversal_fee + reversal_tax)
                     for delivered + returned
Reversal Cost      = SUM(reversal_fee)                  for returned
Tax                = SUM(transaction_tax + reversal_tax) for delivered + returned
COGS               = SUM(cogs_total) for delivered
                   + SUM(cogs_total × (1 - sellable_returns_pct/100)) for returned
                   (the unsellable portion is the real loss; default 85% sellable)
Return Loss (PKR)  = per returned order: full delivery+reversal + unsellable COGS
Ad Spend           = SUM(ad_spend.amount) for the period (already FX-converted at ingest)
Expenses           = monthly_total × (number of month-starts in window)
                   + per_order_total × delivered_order_count
                   (monthly charges fire on the 1st of each month, not prorated daily)

Gross Profit       = Sales - Delivery Cost - COGS
Net Profit         = Gross Profit - Ad Spend - Expenses

ROAS               = Sales       / Ad Spend          → NULL if Ad Spend = 0
POAS               = Net Profit  / Ad Spend          → NULL if Ad Spend = 0
CAC                = Ad Spend    / Delivered Orders  → NULL if either is 0
AOV                = Sales       / Delivered Orders  → NULL if Delivered = 0
Margin %           = Net Profit / Sales × 100        → NULL if Sales = 0
ROI %              = Net Profit / (COGS + Ad Spend + Delivery Cost) × 100 → NULL if 0
% Refunds          = Returns / (Delivered + Returns) × 100 → 0 if no orders
In-Transit Value   = SUM(invoice_payment) for non-terminal orders
                     (excludes Delivered, Returned, Cancelled, Transferred)
```

### Order count rule

The displayed `orders` count = `delivered + returned`. A return is still an order the customer placed; the carrier just didn't complete it. Internal `v_delivered` (delivered-only) is what feeds CAC / AOV.

### Division-by-zero rule

Ratio metrics return NULL when the denominator is 0; the UI renders "N/A". **Never display 0 for an undefined ratio** — implies the merchant spent money and got nothing back.

### Last Month % change

The Last Month card has **no % change**. The month before last falls outside the rolling window and was never stored.

---

## Currency + FX

- `stores.currency` — ISO 4217 code from Shopify `shop.json` (set in `afterAuth`). Source of truth for dashboard rendering (uses `Intl.NumberFormat`; `money_format` is a fallback hint).
- `stores.meta_ad_account_currency` — set when the merchant connects Meta. If it differs from `stores.currency`, the spend-fetcher (`fetchSpendInStoreCurrency` in `app/lib/meta.server.js`) applies an FX conversion at **ingest time** and writes the converted amount to `ad_spend.amount`.
- **Convert-at-ingest, Stripe-style.** Historical `ad_spend` rows are frozen — they don't drift as FX moves. Display is trivial (no FX at render).
- `fx_rates` — daily-cached from open.er-api.com (free, no key, daily). The on-demand fetcher in `app/lib/fx.server.js` refreshes if cache is >24 h old, falls back to last-known-good when the live API is unavailable. Identity rates (USD→USD = 1.0) short-circuit and are not stored.

Legacy: all currently-installed stores were PKR before migration 018; the `currency` default of `'PKR'` and `money_format` of `'Rs.{{amount}}'` keep them rendering identically.

---

## Ingest modes

`stores.ingest_mode` ∈ `{'postex', 'shopify_direct'}`. `app/lib/stats-adapter.server.js` dispatches.

- **`postex`** (default for legacy + Pakistani COD) — PostEx cron populates `orders`; dashboard reads aggregates via RPC. Full feature set: city panel, trend, pipeline pills.
- **`shopify_direct`** (prepaid / international, no courier) — `orders` table stays empty. Dashboard hits Shopify Admin API live at request time with a 60s in-memory cache. KPI cards render the same shape; the city / trend / pipeline panels are skipped (we don't have the data).

Switching modes later is supported but historical data is mode-bound (PostEx aggregates ≠ Shopify aggregates by design — different inclusion rules, different statuses). New data flows through the new path; old data stays where it was.

---

## Date / timezone

All date-bucketing uses **PKT (UTC+5)**, hardcoded. App is Pakistan-first and even non-PKR merchants share the operational rhythm. Helpers live in `app/lib/dates.server.js` (`nowPKT`, `startOfDayUTC`, `endOfDayUTC`, `getTodayPKT`, `getYesterdayPKT`, `getMTDPKT`, `getLastMonthPKT`, `getMTDComparisonPKT`, `getDayBeforeYesterdayPKT`, `getMonthBeforeLastPKT`, `getPriorEqualLengthRange`).

Strategy: shift `Date.now() + 5h` so UTC fields read as PKT, do day arithmetic, then convert back to real UTC for Supabase queries.

---

## PostEx integration

Base URL: `https://api.postex.pk/services/integration/api/order/`
Auth: header `token: <postex_token>` — per-store, in `stores.postex_token`.

| Endpoint | Purpose |
|---|---|
| `GET v1/get-all-order?orderStatusId=0&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` | Main order sync (camelCase params; `startDate`/`endDate`, **not** `fromDate`/`toDate`). |
| `GET v2/get-operational-city` | Token validation in onboarding. |
| `GET v1/track-order/{trackingNumber}` | Single-order lookup (rare). |

### Status-code mapping

| Code | Meaning | Flag |
|---|---|---|
| 0001 | At Merchant's Warehouse | `is_in_transit` |
| 0002 | Returned | `is_returned` |
| 0003 | At PostEx Warehouse | `is_in_transit` |
| 0004 | Package on Route | `is_in_transit` |
| 0005 | **Delivered** | `is_delivered` |
| 0006 | Returned | `is_returned` |
| 0007 | Returned | `is_returned` |
| 0008 | Delivery Under Review | `is_in_transit` |
| 0013 | Attempt Made | `is_in_transit` |

`status_code` comes from the **last** entry in `transactionStatusHistory[]`. Top-level `transactionStatus` is a human-readable string stored in `transaction_status` for display. Fallback if history is empty: map from the string (`Delivered`→`0005`, `Returned`→`0002`, `Booked`→`0003`, …) — see `app/lib/postex.server.js`.

### Order-ref normalization

`orderRefNumber` arrives as `#9271` or `9271` inconsistently. Always strip `#` before storing and before matching to Shopify. `order_ref_number` is stored without `#`.

### Sync flow

`app/lib/sync.server.js` orchestrates per-store. The cron (`api.cron.postex`) lists all stores with `postex_token IS NOT NULL AND is_demo != true`, then runs them in batches of `CONCURRENCY = 5`. For each store:

1. Fetch from PostEx with a 30-day rolling window.
2. Upsert by `(store_id, tracking_number)`; recompute flags from `status_code`.
3. Trigger `retroactiveCOGSMatch` (fire-and-forget).
4. If a Shopify offline session exists, fire `fixZeroInvoicePayments` (best-effort recovery for known-bad PostEx rows).
5. Update `stores.last_postex_sync_at` on success.

Failure on one store doesn't abort the run; the error is logged.

### Historical backfill

`app/lib/backfill.server.js`. Triggered when the merchant saves their PostEx token in onboarding step 1. Fetches Jan 1 of current year → today, chunked monthly, run sequentially as a background job. Dashboard banner: "Syncing your order history…".

---

## Shopify integration

`app/lib/shopify.server.js` and `app/lib/shopify-pipeline.server.js`. Admin API `2025-10`.

### COGS matching

`app/lib/cogs.server.js` and `app/lib/enrich.server.js`. Strategies, in priority order:

1. **`sku`** — line-item SKU matches a `product_costs.sku`.
2. **`exact`** — variant title + product title exact match.
3. **`fuzzy`** — token-overlap title match.
4. **`sibling_avg`** — average across other variants of the same product.
5. **`fallback_avg`** — store-wide average. Last resort.

Match source is recorded in `orders.cogs_match_source`. `cogs_matched = true` when all line items found a non-zero cost.

### Order date enrichment

`enrichOrdersWithShopify` runs on every cron tick + after onboarding. When it has a Shopify match, it writes `order_date = shopify created_at`. When it doesn't, it increments `order_date_attempts`; after 5 attempts a finalize sweep writes `order_date = transaction_date` as the permanent fallback. The `preserve_order_date` BEFORE-UPDATE trigger defends against any future code path that mistakenly tries to clobber a resolved date with NULL.

### Retroactive matching

When the merchant completes COGS setup, a batch retroactive match runs over all existing orders with `cogs_matched = false`. Without this, orders synced before COGS was configured would never match.

### Uninstall

`app/uninstalled` webhook → delete the `stores` row. `ON DELETE CASCADE` removes everything else.

---

## Meta Ads spend integration

Separate from the Pixel Tracking flow.

OAuth scope: `ads_read`. Tokens are long-lived (60 days). Stored as `stores.meta_access_token` + `stores.meta_token_expires_at` + `stores.meta_ad_account_id` + `stores.meta_ad_account_name` + `stores.meta_ad_account_currency`.

### Endpoint

```
GET /{ad_account_id}/insights
  ?fields=spend
  &time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
  &level=account
  &access_token={token}
```

`fetchSpendInStoreCurrency` wraps this and applies FX from `fx_rates` if `meta_ad_account_currency != stores.currency`.

### Token expiry handling

- Within 7 days of expiry → dashboard banner ("Your Meta Ads connection expires on [date]").
- Expired → skip Meta cron for that store, set `stores.meta_sync_error`, dashboard banner ("Meta Ads disconnected — token expired").
- Reconnect via `/app/settings` → new token + new expiry.

### Skipped Meta

If the merchant skipped Meta in onboarding, all ad-spend reads return 0; ROAS / POAS / CAC render "N/A"; a subtle prompt invites them to connect later.

---

## Meta Pixel + CAPI relay

The headline ad-tracking feature. Lives across:

- `app/routes/app.ad-tracking.tsx` — connect / status / recent events page.
- `app/routes/auth.meta-pixel.callback.tsx` — completes BISU flow, persists encrypted token.
- `app/routes/api.webhooks.meta-pixel.tsx` — receives Shopify order/checkout/refund webhooks, fires CAPI.
- `app/routes/proxy.tracking.config.tsx` and `proxy.tracking.track.tsx` — App Proxy at `/apps/tracking/*`.
- `app/lib/meta-pixel.server.js`, `meta-pixel-session.server.js`, `meta-capi.server.js`, `meta-hash.server.js`.
- `app/lib/web-pixel-install.server.js` — installs/uninstalls the Custom Web Pixel via Admin GraphQL.
- `app/lib/visitors.server.js`, `cart-attributes.server.js`, `channel-attribution.server.js`, `app-proxy-verify.server.js`.

### Connect flow

1. Merchant clicks "Connect Pixel" → Facebook Login for Business with `META_PIXEL_CONFIG_ID` (the "Pixel Tracking" configuration created from the Conversions API template).
2. Callback receives a BISU (Business Integration System User) token. Encrypted with AES-256-GCM (`ENCRYPTION_KEY`) and stored in `meta_pixel_connections.bisu_token`.
3. We pull dataset list, business, ad accounts. Merchant picks a dataset.
4. We install a Custom Web Pixel via Shopify Admin GraphQL `webPixelCreate` (requires `write_pixels` + `read_customer_events`).
5. The merchant must save the app embeds in the active theme — `theme-embed.server.js` polls `settings_data.json` to auto-detect this and `app.api.embed-status.tsx` exposes the status to the UI.

### Conversion path (server-side)

Webhook subscriptions in `shopify.app.toml` (`uri = /api/webhooks/meta-pixel`):

- `orders/create` + `orders/paid` → Purchase
- `orders/edited` → ignored in v1 (most edits don't move CAPI numbers)
- `refunds/create` → negative-value Purchase
- `checkouts/create` + `checkouts/update` → InitiateCheckout

**Why `orders/create` (not just `orders/paid`):** for COD stores payment is captured later — often days later, manually. `orders/paid` arrives long after Meta's 7-day attribution window has closed. Firing Purchase on `orders/create` with the same deterministic `event_id` means the canonical conversion lands at order placement; if `orders/paid` eventually fires too, Meta dedupes by `event_id`.

**Deterministic event_id:** `<event>:<shop>:<resource_id>` (e.g. `purchase:store.myshopify.com:5634819345`). Stays under Meta's 100-char limit even for very long shop domains. Shopify retries non-2xx webhooks with the same resource id, so the same event_id repeats — Meta dedupes; we never double-count.

**Cross-session enrichment:** at Purchase time we look up the visitor row written by earlier storefront events (see Visitor identity below) and merge its hashed identity + best `fbc` into the CAPI payload. Meta receives the union of every signal we ever saw for that visitor, not just what's on the live order.

### App Proxy first-party endpoint

Configured in `shopify.app.toml`:

```toml
[app_proxy]
url = "https://codtracker-production.up.railway.app/proxy/tracking"
subpath = "tracking"
prefix = "apps"
```

Public URL: `https://{shop}.myshopify.com/apps/tracking/{config|track}`.

Requests are first-party at the merchant's domain (bypasses ad blockers; Safari ITP grants the full 1-year `Max-Age` on `Set-Cookie` headers, instead of truncating to 7 days the way it does for `document.cookie`-set cookies).

Shopify signs the request with HMAC-SHA256 over the query params; `verifyAppProxySignature` rejects anything unsigned (without it we'd accept arbitrary CAPI events from anyone on the internet).

`/apps/tracking/config` mints (or recognizes) a `cod_visitor_id` cookie via `Set-Cookie`. `/apps/tracking/track` accepts beacon POSTs from the Custom Web Pixel: upserts the `visitors` row with latest fbp/fbc/ip/ua + hashed PII, appends a `visitor_events` breadcrumb, fires CAPI for whitelisted client-side events.

### Visitor identity store

`visitors` (one row per `cod_visitor_id`) carries the cross-session identity:

- Hashed PII columns (em / ph / fn / ln / ct / st / zp / country / external_id) — indefinite retention.
- Latest raw `fbp / fbc / ip / ua` — refreshed on every event (CAPI sends these unhashed).
- `fbc_history` and `utm_history` — jsonb arrays of `{value, seen_at}`, capped at 5 entries each. Visitor who clicks two ads days apart keeps both click_ids.

The theme block writes `_cod_visitor_id` into Shopify cart attributes via `/cart/update.js`, so the id rides through to the order webhook. The Purchase handler joins on `visitor_id` and `pickBestFbc` chooses the highest-confidence click id from history. `visitors.server.js` also supports fallback lookups by fbclid and by recent (ip, ua) when cart attributes are missing.

`visitor_events` is the per-event breadcrumb trail with 30-day retention — purely for diagnostics and a future "session timeline" UI. The Purchase enrichment path reads from `visitors` directly, never from `visitor_events`.

### Channel attribution

`order_attribution` is written at Purchase-webhook time. Three buckets (locked — keep the dashboard clear):

- `facebook_ads` — fbclid present + `utm_source` is `facebook` (or absent).
- `instagram_ads` — fbclid present + `utm_source = instagram`.
- `direct_organic` — no fbclid (organic / direct / non-Meta).

30-day rolling TTL via `trim_order_attribution` in `api.cron.visitors-trim`. Powers the Ad Tracking dashboard's channel breakdown card.

### CAPI delivery + retries

`capi_delivery_log` keeps the most-recent 500 events per shop (after-insert trigger). Drives the dashboard's "Recent events" list.

`capi_retries` holds events that failed first try. `api.cron.capi-retry` drains it every 5 min with exponential backoff. Rows are deleted on success or after 5 attempts (Meta won't accept events older than 7 days anyway, so further retries are wasted).

### Event Match Quality

`api.cron.emq` (daily) calls Meta's EMQ endpoint per dataset and stores `overall_emq` + per-event scores + per-field coverage in `emq_snapshots`. 90-day TTL via `trim_emq_snapshots`. Powers the EMQ trend chart on the Ad Tracking page.

---

## Demo mode

`stores.is_demo = true` flips dashboard reads to a shared demo pool `store_id` (resolved by `effectiveStoreId` in `app/lib/demo-pool.server.js`). Expenses + COGS still come from the merchant's own row; only orders / ad_spend reads are redirected.

`api.cron.demo-tick` (daily, 9 AM PKT) fabricates synthetic orders + ad spend for the pool. Lives in `demo-fabricator.server.js`. `demo-pipeline.server.js` builds the in-pipeline mock data the pills display.

The PostEx cron explicitly excludes demo stores (`is_demo != true`) — hitting PostEx with the magic-key token returns 401 and would pollute the row.

---

## Cron schedule

Railway scheduled jobs. All endpoints require `x-cron-secret: $CRON_SECRET`. Times are UTC (PKT = UTC+5).

| Job | UTC | PKT | Endpoint |
|---|---|---|---|
| PostEx sync | `0 1,13 * * *` | 6 AM + 6 PM | `POST /api/cron/postex` |
| Meta today | `0 */2 * * *` | every 2 h | `POST /api/cron/meta-today` |
| Meta finalize | `0 21 * * *` | 2 AM | `POST /api/cron/meta-finalize` |
| CAPI retry | `*/5 * * * *` | every 5 min | `POST /api/cron/capi-retry` |
| EMQ snapshot | `0 6 * * *` | 11 AM | `POST /api/cron/emq` |
| Trim tables | `0 3 * * *` | 8 AM | `POST /api/cron/visitors-trim` |
| Demo tick | `0 4 * * *` | 9 AM | `POST /api/cron/demo-tick` |

There is no daily-snapshot cron and no monthly-purge cron in the current build (earlier plans were dropped). `daily_snapshots` and `ad_spend` rows are populated as a side effect of the live aggregation; if a true rolling-window purge is reintroduced, mirror the cron-secret pattern below.

Standard guard:

```ts
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  // ...
};
```

---

## Onboarding (4 steps)

`stores.onboarding_step` (1–4) tracks progress; `onboarding_complete` flips the dashboard on. The onboarding layout (`app.onboarding.tsx`) renders a Polaris `Page backAction` to the previous step (none on step 1) so the wizard is never a dead-end — `onboarding_step` only ever advances in the step actions, so going back and re-entering is safe.

1. **PostEx (`/app/onboarding/step1-postex`)** — token field. Validated against `GET v2/get-operational-city`. On success: save token, advance, kick off background historical backfill.
2. **Meta Ads (`/app/onboarding/step2-meta`)** — skippable. Connect via Meta OAuth (`ads_read`). On success: save token + expiry + ad-account choice. Skip → `meta_access_token = null`.
3. **COGS (`/app/onboarding/step3-cogs`)** — fetch all variants from Shopify Admin API, present table (Product / Variant / SKU / Unit Cost), bulk upsert to `product_costs`. Empty cells stored as 0. Counter: "X of Y variants have costs entered". On save: trigger retroactive COGS match.
4. **Expenses (`/app/onboarding/step4-expenses`)** — the shared `<ExpenseManager>` (segments model — see Expenses page below) plus a "Finish setup" footer. The step is explicitly optional: a persistent subdued caption tells the merchant they can manage expenses anytime on the Expenses page, shown whether or not any expense was added. "Finish" sets `onboarding_complete = true` and redirects to `/app`. Pool seeding (`ensurePoolSeeded`) runs here for stores tagged demo.

---

## Settings (`/app/settings`)

PostEx + Meta Ads are configured inline (same validation as the corresponding onboarding step — e.g. PostEx re-validates against operational-cities). COGS and **Expenses** are *not* inline: each is a card with a primary button that links out to its own dedicated page (`/app/cogs`, `/app/expenses`). This keeps Settings short and the two data-heavy editors on focused pages with their own back-arrow to Settings.

Meta Ads "Reconnect" reuses the OAuth flow. After OAuth the callback redirects to `/app` (the embedded app root); `app._index.tsx` notices a pending token in the OAuth session cookie and forwards to `/app/settings` to complete the connection — this preserves App Bridge auth context (server-side 302s strip it).

---

## Expenses page (`/app/expenses`)

`app/routes/app.expenses.tsx`. Linked from the app nav (between Home and Ad Tracking) and from Settings. Mirrors the `/app/cogs` shell: full Polaris `Page` with `backAction` → Settings + App Bridge `TitleBar`.

Two parts:

1. **This-month impact card** — a month-to-date figure that reconciles *exactly* with the dashboard's MTD card, because it is computed through the same path: `get_expense_breakdown` RPC for `postex`/demo (orders from the pool via `effectiveStoreId`, expenses always the merchant's own shop via `p_expense_store_id = shop`), or the stats-adapter's shared JS allocator for `shopify_direct`. Folded into Fixed / Per-order / % buckets by the pure `app/lib/expense-impact.server.js` `summarizeImpact()` (unit-tested). If the impact path throws, the loader returns `impact: null` and the card is hidden — the manager still works and no wrong number is ever shown (the standing "never display a misleading figure" rule). The card is also absent when no expenses are configured.
2. **The shared `<ExpenseManager>`** — same component and `handleExpenseAction` mutation handler as onboarding step 4. The component posts its forms to the current route, so this page owns an `action` that delegates to `handleExpenseAction`. One code path across all three surfaces (onboarding, this page); Settings no longer embeds it.

## Dashboard layout

`app/routes/app._index.tsx`. Reference imagery: `docs/img/img0.png`, `docs/img/img1.png`.

- **4 KPI cards** — Today / Yesterday / MTD / Last Month. Sales + Net Profit show % change against the prior period (`get_period_comparison` against `daily_snapshots`). Last Month card shows no % change (no prior data in rolling window). ROAS / POAS / CAC render "N/A" when Meta isn't connected or Ad Spend = 0.
- **Detail panel** (`<DetailPanel/>`) — slide-in, full breakdown for a card's period. `>` rows drill down to a paginated order table.
- **City loss panel** (`<CityLossPanel/>`) — `get_city_breakdown` results.
- **Trend panel** (`<TrendPanel/>`) — Polaris-Viz line chart over the period.
- **Break-even section** (`<BreakEvenSection/>`) — implied break-even numbers given current ad spend.
- **In-pipeline pills** (`<PipelinePills/>`) — Shopify unfulfilled orders, fed by `fetchUnfulfilledPipeline` (or `fetchDemoPipeline` for demo stores).
- **Warning banners** (`<WarningBanner/>`) — missing COGS, Meta token expiring/expired, backfill in progress, sync errors.
- **Empty state** — friendly copy when there are zero orders (vs cards full of zeros).

---

## Key business rules (non-negotiable unless deliberately scoped)

1. **Sales = delivered orders only**.
2. **COGS applies to delivered + returned** — product left the warehouse.
3. **Returned orders**: `invoice_payment` excluded from Sales; reversal costs included in Delivery Cost; unsellable COGS portion counts as loss (not full COGS).
4. **In-transit orders**: informational count only — zero financial impact (financial value lives in `in_transit_value`).
5. **invoicePayment is GROSS** — what the customer paid, *not* what PostEx remits.
6. **Strip `#` from `orderRefNumber`** before storing and before Shopify matching.
7. **All aggregations via Supabase RPC** — never pull raw rows to the frontend for math.
8. **`store_id` = `.myshopify.com`** — set via `set_app_store()` before every Supabase query.
9. **`daily_snapshots` and `ad_spend` are never purged** — % change and historical ROAS depend on them.
10. **Division by zero = NULL → "N/A"** — never display 0 for an undefined ratio.
11. **Last Month card has no % change**.
12. **All date logic uses PKT (UTC+5)** — convert to UTC at Supabase boundary.
13. **Uninstall = full data deletion** — delete `stores` row, cascade handles the rest.
14. **CAPI event_id must be deterministic** (`<event>:<shop>:<resource>`) — Shopify webhook retries depend on Meta deduping.
15. **Multi-currency: convert at ingest, never at render** — historical numbers are frozen.

---

## Repository layout

See `README.md` for the file-tree. Quick map:

```
app/
  shopify.server.ts                  shopifyApp + canonical scopes + afterAuth
  routes/                            see README
  lib/                               server-only modules (.server.js suffix)
  components/                        Polaris components shared across routes
supabase/
  schema.sql                         base tables + RLS + RPCs
  migrations/001..023*.sql           run in order
scripts/                             ops scripts (audit, backfill, smoke). _*.mjs are throwaway.
shopify.app.toml                     scopes / webhooks / app proxy
Dockerfile, railway.json             Railway deploy
```

---

## When you change behavior

- **Schema changes** → add a numbered migration to `supabase/migrations/`. Update the relevant section here.
- **Scope changes** → update both `shopify.app.toml` and `CANONICAL_SCOPES` in `app/shopify.server.ts`. Run `npm run deploy` so Shopify knows.
- **Webhook subscription changes** → update `shopify.app.toml` (managed-install). For belt-and-suspenders shop-specific subs, update `registerMetaPixelWebhooks` in `app/lib/shopify.server.js` (it's re-asserted on every `afterAuth`).
- **Cron changes** → update Railway scheduled jobs and the table above.
- **Calculation changes** → edit `get_dashboard_stats` (SQL is the source of truth). Update the formulas section here.
- **New env var** → add it to `example.env` with a comment, and to Railway. The app should fail loudly on startup if the var is required and missing (see `SUPABASE_DATABASE_URL`).
