# CODProfit — Full-App Audit & Improvement Plan

*Audited: 2026-07-07 · Scope: every route, lib, component, extension, SQL migration, Docker/CI config. Unit suite passes (124/124).*

> **Implementation status (updated 2026-07-07, same day):** the Week-1 and most
> Week-2 items below are ✅ **shipped** on this branch — see `DEPLOY-NOTES.md`
> for the runbook. Shipped: §1.1 (client singleton, dead RPC removed), §1.3
> (sync-status polling), §1.4 (webhook fast-ACK), §1.5 (timeouts everywhere),
> §1.6 (meta-today parallelized), §2.1–2.4 & §3.1–3.2 (visitor upsert RPC,
> connection cache, throttled stamp, detached beacon logs, trgm/ip indexes,
> sampled trim trigger + nightly sweep — migration 027, applied to prod),
> §4.2 (PKT presets), §4.5 (lang attr), §4.6/4.7 (dead route/loader data
> removed), §5.1 (Node 20.19.6), §5.3 (comment fixed), §5.4 (token
> auto-refresh), §5.5 (proxy verifier repeated params), §5.6 (timing-safe cron
> auth), §6.1 (token encryption + backfill script), §7.1 (real CI + typecheck,
> 29 TS errors fixed to 0), §7.2 (multi-stage Docker, USER node, healthcheck,
> .env no longer shipped in image), plus streamed dashboard with skeleton
> loading and per-panel error boundaries, and Meta Graph v21→v24 / Shopify
> REST 2025-01→2025-10 version alignment (both verified live).
>
> **Deliberately deferred** (higher blast radius, do as separate staged
> changes): §1.2 option 1 (`get_dashboard_bundle` single-scan SQL), §2.5
> (beacon batching to Meta), §4.1 (`v3_singleFetch`), §1.7 (GraphQL
> migration), §6.2 (real RLS), §8.1 (Sentry — needs an account/DSN), §8.2
> (cron overlap locks), §4.3 (ad-tracking file split), §7.3 (scripts/
> cleanup), §3.4 (migration ledger), §9 (webhook + SQL fixture tests).

The app is in good shape overall — clean separation of libs vs routes, deterministic COGS matching, idempotent CAPI event IDs, encrypted BISU tokens, well-commented code, and a real test suite for the pure logic. The findings below are ordered by **impact on speed and robustness**, each with the file(s) to touch and a concrete fix.

---

## 0. TL;DR — Top 10 by impact

| # | Finding | Area | Effort | Impact |
|---|---------|------|--------|--------|
| 1 | `set_app_store` RPC is a wasted network round-trip on **every** request — it can't do what the comment claims | Backend perf + security model | Low | High |
| 2 | Dashboard loader fires **17 parallel RPCs**, each re-scanning `orders` — collapse into 1–2 SQL calls | Backend perf | Medium | High |
| 3 | Storefront beacon path = **7–8 sequential DB round-trips per PageView** | Tracking hot path | Medium | High |
| 4 | `findVisitorByFbclid` uses leading-wildcard `ilike` with **no usable index** → per-purchase table scan | Database | Low | High |
| 5 | Purchase webhook does all work inline before ACK — risks Shopify's 5s deadline → duplicate deliveries | Reliability | Medium | High |
| 6 | CI runs only `yarn install` — no lint, no typecheck, no tests, no build | CI | Low | High |
| 7 | `stores.meta_access_token` stored **plaintext** (BISU token is encrypted; this one isn't) | Security | Low | High |
| 8 | Single-stage Dockerfile ships dev tooling + source; base image violates own `engines` range | Deploy | Low | Medium |
| 9 | Backfill polling revalidates the whole dashboard (17 RPCs) every 4 s | Frontend perf | Low | Medium |
| 10 | `capi_delivery_log` per-row trim trigger = write amplification on every beacon | Database | Low | Medium |

---

## 1. Backend performance

### 1.1 `getSupabaseForStore` — dead round-trip on every request ⚠️
`app/lib/supabase.server.js:3-11`

```js
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
await supabase.rpc('set_app_store', { store: shop });   // ← wasted
```

Two problems:

1. **It doesn't work.** `set_app_store` runs `set_config('app.current_store_id', store, true)` (`supabase/schema.sql:194`) — the `true` makes it **transaction-local**. Each supabase-js call is a separate PostgREST request/transaction, so the setting evaporates before any subsequent `.from()` query runs. The RLS policies keyed on `current_setting('app.current_store_id')` are never satisfied by this call.
2. **It doesn't matter that it doesn't work** — the client uses the **service-role key**, which bypasses RLS entirely. Tenant isolation today is enforced *only* by the explicit `.eq("store_id", …)` filters.

Consequences:
- Every loader/action pays one full Supabase round-trip (~50–150 ms from Railway to ap-northeast-1) for nothing. The dashboard, expenses, settings, stats API, ad-tracking, cron loops — all of them.
- The security comment ("scopes all subsequent queries to this store") is false and dangerous: a future developer may rely on it and skip an `.eq` filter.

**Fix (quick):** delete the RPC call, return a module-level singleton client (createClient is cheap but stateless — one instance can be shared safely):

```js
let _client;
export function getSupabaseForStore(/* shop */) {
  _client ??= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return _client;
}
```
(Keep the signature async-compatible or update ~15 call sites; either way callers keep their `.eq` filters.)

**Fix (proper, later):** if you want RLS to actually protect tenants, mint per-request Postgres JWTs with a `store_id` claim and use the anon key, with policies reading `auth.jwt()->>'store_id'`. Until then, update the RLS section comment in `schema.sql` to say isolation is filter-based.

Also apply the singleton pattern to the five other files that call `createClient()` per invocation: `visitors.server.js:30`, `meta-capi.server.js:25`, `fx.server.js:25`, `shopify.server.ts:60`, and the cron routes.

### 1.2 Dashboard loader — 17 RPCs per page view
`app/routes/app._index.tsx:196-250`

Each `get_dashboard_stats` call scans `orders` for its range; the loader calls it **10×** (4 periods + 3 priors + 3 break-even windows), plus 4 `get_expense_breakdown`, 2 `get_trend_series`, 1 city breakdown, 1 count. Supabase executes these concurrently, but you pay 17 PostgREST invocations and 10 overlapping scans of the same table (the 30/60/90-day windows are supersets of each other, and MTD ⊂ 90d).

**Fix options (in order of payoff/effort):**
1. **One SQL function `get_dashboard_bundle(p_store_id, p_expense_store_id)`** that computes all 10 period rows in a single scan using `FILTER (WHERE order_date >= …)` aggregates over the widest window (month-before-last → today) — one round trip, one scan. The RPC output shape can literally be `jsonb` keyed by period name so the loader stays trivial.
2. Cheaper intermediate step: `defer()` the below-the-fold data. Today only `unfulfilledPipeline` is deferred; `trend`, `cityBreakdown`, the 3 break-even windows, and the 4 expense breakdowns are all awaited before first byte. Moving those into deferred promises cuts time-to-first-paint to just the 7 KPI RPCs without touching SQL.
3. The city panel's all-time default (`cityFromDate = "2010-01-01"`, line 158) makes `get_city_breakdown` the single most expensive query on the page and it's below the fold — defer it and/or default to 90 days with "Maximum" as an explicit user choice.

### 1.3 Backfill polling re-runs the whole loader every 4 s
`app/routes/app._index.tsx:602-607`

`useRevalidator().revalidate()` on a 4-second interval re-executes all 17 RPCs + a Shopify pipeline fetch until `last_postex_sync_at` flips. A merchant staring at the syncing screen for 2 minutes costs ~30 × 17 = 500+ RPC invocations.

**Fix:** poll a tiny status route (`/app/api/sync-status` returning `{ done: boolean }` from one indexed `stores` select) and call `revalidate()` once when it flips.

### 1.4 Webhook handler does everything inline before the 200
`app/routes/api.webhooks.meta-pixel.tsx:35-76`

`handleOrderPaid` runs: up to 3 visitor lookups (one is the un-indexed `ilike`, §3.1) → Meta CAPI POST (external, up to seconds) → visitor write-back → attribution insert → capi_sent_at update — all before Shopify gets its 200. Shopify's timeout is ~5 s; a slow Meta call or DB hiccup → Shopify retries → you re-run the whole chain (idempotent thanks to deterministic event_ids, but it's wasted work and can snowball).

**Fix:** ACK first, work after. Simplest Remix-compatible shape: wrap the switch body in a detached promise (`void handleTopic(...)` after building the response), or write the payload to a `webhook_jobs` table and let the existing cron cadence drain it. At minimum, put an `AbortSignal.timeout(3500)` on the Meta fetch inside the webhook path (`postCAPIEvents` currently has **no timeout at all** — `meta-capi.server.js:161`; a hung Meta socket holds the webhook open indefinitely). The retry queue already exists to catch the failure.

### 1.5 `postCAPIEvents` / Graph API calls lack timeouts
`app/lib/meta-capi.server.js:161`, `app/lib/meta.server.js` (all fetches), `app/lib/meta-pixel.server.js`

Only `fx.server.js` uses an AbortController. Every Meta call should carry `signal: AbortSignal.timeout(8000)` (shorter inside webhooks, per §1.4). Same for PostEx calls in `postex.server.js`.

### 1.6 Sequential cron loops
- `api.cron.meta-today.tsx:37-88` processes stores **serially** — each store = 1 Meta call + up to 3 DB writes. At 100 stores × ~1 s this cron takes minutes. Batch with `Promise.allSettled` in chunks of 5 like `api.cron.postex.tsx` already does. Also: the two `stores` UPDATEs per store can be merged into one.
- `drainRetries` (`meta-capi.server.js:399-412`) updates retry rows **one-by-one**. Replace with a single upsert of the changed rows (`onConflict: "id"`) or a small RPC.

### 1.7 REST Admin API is on a deprecation path
`app/lib/shopify.server.js` (products.json, inventory_items.json, orders.json), `stats-adapter.server.js:197`

Shopify has deprecated the REST product/variant endpoints (new apps blocked from them since early 2025) and is steering everything to GraphQL. `getProductsForCOGS` (products + inventory cost) is the most exposed — GraphQL also gets you `inventoryItem { unitCost }` in the same query, removing the N/100 batched inventory-items calls entirely. `getOrdersLineItemMap` full-history mode (one-shot backfill) has **unbounded pagination** — fine for typical stores, but add a page cap + progress logging like the 50-page cap you already use in `stats-adapter._fetchOrders`.

---

## 2. Storefront tracking hot path (highest QPS path in the app)

Every storefront PageView/ViewContent/AddToCart beacon (`proxy.tracking.track.tsx`) currently costs, **sequentially**:

1. `upsertVisitor` → SELECT visitor row (round trip 1) → UPSERT merged row (2)
2. `recordVisitorEvent` → INSERT visitor_events (3)
3. `lookupConnection` → SELECT meta_pixel_connections + AES decrypt (4)
4. Meta CAPI POST (external, 200–600 ms)
5. `logDeliveries` → INSERT capi_delivery_log → fires per-row trim trigger (5)
6. UPDATE `meta_pixel_connections.last_event_sent_at` (6)

≈ 6 DB round-trips + 1 external call, serialized, per event. A store doing 50k pageviews/day drives ~300k Supabase requests/day from this path alone.

**Fixes, roughly independent:**

- **2.1 Make `upsertVisitor` one round trip.** Replace SELECT-merge-UPSERT with a single `INSERT … ON CONFLICT (store_id, visitor_id) DO UPDATE SET em_hash = COALESCE(EXCLUDED.em_hash, visitors.em_hash), … , fbc_history = append_capped(visitors.fbc_history, EXCLUDED…)` — the preserve-or-update semantics translate directly to `COALESCE`, and the history append/cap fits in a small SQL helper. Halves visitor write cost *and* removes the read-modify-write race between concurrent beacons from the same visitor (two tabs → lost update today).
- **2.2 Cache CAPI connections in memory.** `dataset_id` + decrypted token change ~never; cache per store for 60 s (same pattern as `stats-adapter`'s `_ancillaryCache`). Kills one SELECT + one AES decrypt per event. Invalidate on the connect/disconnect actions.
- **2.3 Throttle `last_event_sent_at`.** Update at most once per minute per store (track last write in the same in-memory cache). This is a hot-row UPDATE on every single event today.
- **2.4 Fire-and-forget the non-essential writes.** `recordVisitorEvent` and `logDeliveries` for *beacon* (non-Purchase) events don't need to block the response — `void`-detach them (Purchase-path logging should stay awaited since the recon cron depends on it).
- **2.5 Implement the batching the file header promises.** `meta-capi.server.js:10-13` describes accumulating beacon events per shop and flushing every 30 s / 100 events — that was never built; every beacon does its own Meta POST. Even simple per-instance batching cuts Meta calls ~10× on busy stores. (Purchases stay unbatched, correctly.)
- **2.6 Return 204 earlier for unmapped events.** Identity-only beacons (`checkout_contact_info_submitted`) already short-circuit — good — but they still pay the two-round-trip upsert; 2.1 covers them.

---

## 3. Database

### 3.1 Missing indexes for the visitor-recovery lookups (used on every purchase!)
`migrations/017_cross_session_visitors.sql:87-89` only has `(store_id, last_seen_at)`, `em_hash`, `ph_hash`.

- `findVisitorByFbclid` (`visitors.server.js:263`): `ilike '%<fbclid>%'` on `latest_fbc` → **sequential scan** of the store's visitors on every cart-attribute-less purchase and checkout webhook. Fix: `CREATE EXTENSION pg_trgm; CREATE INDEX idx_visitors_fbc_trgm ON visitors USING gin (latest_fbc gin_trgm_ops);` — or better, store the extracted `fbclid` in its own column at upsert time and index it btree (exact/prefix match instead of substring).
- `findRecentVisitorByIpUa` (`visitors.server.js:288`): filters `latest_ip` + `latest_ua` + `last_seen_at` range. Add `CREATE INDEX idx_visitors_ip_seen ON visitors(store_id, latest_ip, last_seen_at DESC);` (UA can stay a filter — IP is the selective key).

### 3.2 `capi_delivery_log` per-row trim trigger
`migrations/015_ad_tracking.sql:117-137` — every insert runs a `DELETE … WHERE id IN (SELECT … ORDER BY id DESC OFFSET 500)`. The subquery orders by `id` but the index is `(store_id, sent_at DESC)`, so each beacon insert walks ≥500 rows. Replace the trigger with a nightly trim cron (you already have `api.cron.visitors-trim.tsx` — add this table to it) or run the trigger statistically (e.g. `WHEN (random() < 0.01)`).

### 3.3 `get_dashboard_bundle` (see §1.2) — one scan for all periods.

### 3.4 Migration hygiene
Migrations are applied by ad-hoc scripts (`scripts/apply-migration-0XX.mjs`, `_run-migration-015.mjs`, …) with no `schema_migrations` ledger. Adopt `supabase db push`/`migra` or at least a tiny applied-migrations table so a fresh environment can be stood up deterministically — right now `schema.sql` + 26 migration files + manual script order is the only record, and `schema.sql`'s RPC signature (`p_monthly_expenses`) is several migrations stale.

---

## 4. Frontend

- **4.1 Enable `v3_singleFetch`** (`vite.config.ts:61`, currently `false`). Remix single-fetch removes a JSON round-trip per client navigation and is the last future-flag before the React Router 7 migration path. Test with App Bridge; the rest of the flags are already on.
- **4.2 KPICard date presets use browser-local time** (`KPICard.jsx:63` "user is in PKT") while every server boundary is hard PKT. A merchant traveling (or a VA in Europe) picks "Today" and gets yesterday's PKT bucket labeled as today. Compute presets in PKT (fixed +5 offset, no DST — trivially portable from `dates.server.js`) or thread the server-computed presets through the loader.
- **4.3 `app/routes/app.ad-tracking.tsx` is 2,506 lines** — loader + action + ~15 inline components in one file. Split into `app/features/ad-tracking/` (loader/action stay in the route; presentational components move out). Same for the 690-line dashboard route. This is maintainability, but it also improves editor/HMR performance and review-ability.
- **4.4 Hardcoded API key** — `app.ad-tracking.tsx:110` embeds `SHOPIFY_API_KEY = "4e49…"`. Use `process.env.SHOPIFY_API_KEY` via the loader (already exposed in `app.tsx`). Not secret, but it will silently break on any app re-creation/staging app.
- **4.5 `root.tsx`**: add `<html lang="en">`; consider self-hosting the Inter CSS (one less render-blocking third-party stylesheet; Polaris CDN preconnect already exists).
- **4.6 Leftover template routes**: `app.additional.tsx` (demo page from the Shopify template) and the marketing `_index/route.tsx` login form — delete `app.additional` from the bundle and nav if unused.
- **4.7 Dead loader work**: dashboard loader fetches `expensesList` (line 77-90) and returns it, but the dashboard page never renders it (expenses moved to `/app/expenses`) — drop it from this loader (the shopify_direct path still needs the rows for the allocator; keep it there only).

---

## 5. Correctness & data-accuracy risks

- **5.1 Dockerfile Node version violates `engines`.** `package.json` requires `>=20.19 <22 || >=22.12`; the image pins `node:20.18.1-alpine` (Dockerfile:6). Bump to `node:20.19.x-alpine` (or 22.12+) so prod matches the tested range.
- **5.2 PostEx 20-day rolling sync horizon** (`sync.server.js:22`): an order that flips status (e.g. Returned) **after** 20 days will never be re-synced — its terminal state in your DB is frozen wrong, silently skewing return-rate and profit for that month. Consider a weekly "terminal-state sweep" that re-queries PostEx for non-terminal orders older than 20 days (by tracking number), or extend the window for statuses in `{Booked, InTransit}` (partially covered by `cancelStaleBooked`, but that *guesses* Cancelled rather than asking PostEx).
- **5.3 Meta "Refund" custom event** (`api.webhooks.meta-pixel.tsx:271-303`): the comment says Meta "will subtract conversion value based on event_id linkage" — Meta does **not** net out custom `Refund` events against Purchases; refund adjustment requires the (allowlisted) Offline/Refund API or simply accepting Purchase-gross. The event is harmless but the expectation documented is wrong; worth a comment fix so nobody builds on it.
- **5.4 Meta token expiry UX**: 60-day ads token (`meta.server.js`) has no auto-refresh; the banner path works, but you can silently re-exchange a still-valid long-lived token for a fresh 60-day one during any dashboard load in the last 7 days (`isTokenExpiringSoon` already computed) — cheap insurance against spend gaps.
- **5.5 App-proxy signature verification** (`app-proxy-verify.server.js:16-20`): Shopify's spec joins **repeated** query params as `key=a,b`; your implementation emits `key=a` and `key=b` as separate entries. A storefront URL that legitimately repeats a param (arrays) would fail verification and drop the beacon. One-line fix: group values by key, join with `,`.
- **5.6 CRON_SECRET compare** is `!==` (all cron routes) — use `timingSafeEqual` like the proxy verifier. Low practical risk, one-line consistency fix.

---

## 6. Security

- **6.1 Encrypt `stores.meta_access_token` at rest.** The pixel BISU token gets AES-256-GCM (`crypto.server.js`), but the Marketing-API token — which can read all ad-account data — is plaintext in `stores` and travels through `auth.meta.callback.tsx` → cookie session → settings action. Wrap it with the same `encryptSecret`/`decryptSecret` pair (touch points: `auth.meta.callback.tsx`, `app.settings.tsx`, `app.onboarding.step2-meta.tsx`, `api.cron.meta-today/finalize`, `api.meta-backfill.tsx`, `demo-ad-spend.server.js`).
- **6.2 RLS is decorative today** (§1.1) — either make it real (JWT claims) or delete the policies + comment so the security model is honest. An honest model is safer than an imaginary one.
- **6.3 `.env` hygiene is good** (gitignored, example file provided). Consider moving the service-role key out of any client-adjacent code path review — currently server-only, correct.
- **6.4 `npm audit`** in CI (see §7) — you pin overrides for graphql-tools etc., but nothing verifies them going forward.

---

## 7. Build, deploy, CI

### 7.1 CI is a no-op
`.github/workflows/ci.yml` checks out, installs with **yarn** (the project is npm + `package-lock.json` — yarn ignores it), and stops. Replace with:

```yaml
- uses: actions/setup-node@… with: { node-version: 22, cache: npm }
- run: npm ci
- run: npm run lint
- run: npx tsc --noEmit          # add "typecheck" script
- run: npm test
- run: npm run build
```
Also add `"typecheck": "tsc --noEmit"` to package.json scripts. This single change catches the entire class of "works locally, breaks on Railway" issues before deploy.

### 7.2 Dockerfile
- **Multi-stage build**: build stage with full deps → runtime stage copying only `build/`, `package.json`, and `npm ci --omit=dev` prod deps. Current image ships source, docs, imgs, scripts (150+ debug scripts!), and dev-adjacent packages. Expect ~50-70 % image-size reduction and faster cold deploys on Railway.
- `npm remove @shopify/cli` (line 20) is a no-op — `@shopify/cli` isn't in dependencies; delete the line.
- Extend `.dockerignore`: `scripts/ docs/ imgs/ tests/ supabase/ extensions/ .github/ *.md .git` (extensions are deployed via `shopify app deploy`, not the web image).
- Add a `HEALTHCHECK` (and a `/healthz` route that checks a trivial Supabase select) so Railway restarts a wedged container; `restartPolicyType: ON_FAILURE` only helps if the process exits.
- Run as non-root (`USER node`) — one line, standard hardening.

### 7.3 Repo hygiene
`scripts/` contains ~150 one-off forensic scripts (32 of them git-tracked) plus data dumps (`_data_orders_6mo.json`, `_pairs_workbook.txt`). Move keepers to `scripts/ops/`, archive the rest to a branch or delete — they confuse every new reader (and any AI tooling) about what's load-bearing. `docs/tasks.md` + `ADtracking.md` similarly look like scratch.

---

## 8. Reliability & observability

- **8.1 Error tracking**: everything is `console.error` into Railway logs. Add Sentry (or GlitchTip) with the Remix SDK — server + browser — so webhook/CAPI failures and loader crashes page you instead of waiting for a merchant report. The codebase's history (the #9393 12-hour silent drop described in `api.cron.capi-reconcile.tsx`) is exactly the class of incident error tracking catches on hour zero.
- **8.2 Cron overlap locks**: Railway crons re-fire on schedule regardless of whether the previous run finished. `retroactiveCOGSMatch` has a proper DB lock; the postex sync loop, meta-today, and capi-reconcile don't. A slow PostEx tick overlapping the next one double-syncs stores. Reuse the compare-and-set lock pattern from `sync.server.js:145` at the cron level (one `cron_locks` row per job).
- **8.3 Metrics**: you already write `last_postex_sync_at` / `last_meta_sync_at`; a tiny `/app/api/ops` (or just a Supabase dashboard) charting cron durations + retry-queue depth + delivery-log failure ratio turns "is tracking healthy?" from forensic scripting into a glance. The 150 scripts in `scripts/` are the receipts for how much this is needed.
- **8.4 Graceful shutdown**: `remix-serve` gets SIGTERM on each Railway deploy while fire-and-forget work (`void runOneShotHistoricalEnrichment`, `void retroactiveCOGSMatch`, detached webhook work if §1.4 lands) is mid-flight. The DB locks make this safe-ish, but add a `process.on('SIGTERM')` drain window log so interrupted backfills are visible.

---

## 9. Testing gaps

Current suite (124 tests) covers the pure functions well: cogs matching, expense allocation, hashing, stats adapter math, fbc picking. Gaps, in priority order:

1. **Webhook handler integration tests** — `handleOrderPaid`/`handleCheckout` with mocked Supabase + fetch: the three-tier visitor lookup, dedup event_id, empty-user_data skip. This is the money path and has zero coverage.
2. **`get_dashboard_stats` / `get_expense_breakdown` SQL** — a pgTAP or scripted-against-local-Postgres test that pins the RPC output for a fixture store, so migration 027+ can't silently change profit math (that's the product).
3. **App-proxy signature verifier** — table-driven vectors incl. repeated params (§5.5).
4. **dates.server.js** — PKT boundary functions are trusted by everything and are pure; cheap to lock down (month rollover, Feb, MTD comparison capping).

---

## 10. Suggested sequencing

**Week 1 (all low-effort, high-yield):**
1. Remove `set_app_store` round-trip + client singletons (§1.1)
2. Real CI + typecheck script (§7.1)
3. Visitor indexes: trgm/fbclid column + ip/last_seen (§3.1)
4. Encrypt `meta_access_token` (§6.1)
5. Dockerfile: node 20.19, multi-stage, dockerignore, USER node (§7.2, §5.1)
6. Lightweight sync-status polling route (§1.3)
7. Timeouts on all Meta/PostEx fetches (§1.5)

**Week 2–3:**
8. `get_dashboard_bundle` single-scan RPC + defer below-the-fold (§1.2)
9. Beacon path: one-round-trip visitor upsert, connection cache, throttled `last_event_sent_at`, detached logging (§2)
10. Webhook fast-ACK (§1.4)
11. Delivery-log trim via cron instead of trigger (§3.2)
12. Sentry (§8.1)

**Backlog / strategic:**
13. GraphQL migration for Admin API calls (§1.7)
14. Real RLS or honest removal (§6.2)
15. Split `app.ad-tracking.tsx`; migrate libs to TS (§4.3)
16. PostEx terminal-state sweep beyond 20 days (§5.2)
17. Webhook integration tests + SQL fixture tests (§9)
18. `scripts/` cleanup + migration ledger (§7.3, §3.4)
