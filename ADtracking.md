# Ad Tracking — Full Pipeline Guide

> Authoritative, end-to-end reference for the Meta Pixel + Conversions API
> relay. Written for future Claude instances and contributors. Code is the
> source of truth; this maps it so you don't have to re-derive the whole
> graph every time. Last full audit + rewrite: 2026-05-16 (the-trendy-homes-pk).
>
> If this conflicts with the code, the code wins — then fix this file.

---

## 0. TL;DR / mental model

The headline feature: send Meta a **server-side Conversions API (CAPI)** copy
of every storefront + conversion event, identified well enough that Meta can
match it to a user and attribute/optimize ads — even when the browser pixel
is blocked (ad-blockers, iOS, Safari ITP, Instagram/Facebook in-app browsers).

There are **three independent client mechanisms** and **one server core**.
The single most important thing to understand: of the three client paths,
**`meta-pixel.js` (theme app embed) is the workhorse that actually runs in
production.** The Custom Web Pixel is consent-gated and largely dormant on
real COD stores. Misjudging which path is live is the #1 way to misdiagnose
this system.

```
                ┌─────────────────── CLIENT (storefront) ───────────────────┐
 Meta ad click  │  ?fbclid=… lands on storefront                            │
   ──────────▶  │                                                            │
                │  (A) Custom Web Pixel  (extensions/web-pixel-cod-tracker)   │
                │      sandboxed (LavaMoat strict), CONSENT-GATED, mostly     │
                │      dormant. Subscribes to Shopify analytics events.       │
                │                                                            │
                │  (B) Theme embed: meta-pixel.js  ← THE ACTIVE PATH         │
                │      not sandboxed, no consent gate. Loads real fbq +       │
                │      dual-fires browser pixel AND server beacon.            │
                │                                                            │
                │  (C) Theme embed: identity-relay.js                         │
                │      mirrors _fbp/_fbc/_fbclid/_cod_visitor_id onto cart    │
                │      attributes so they ride the order webhook.            │
                └───────────────┬──────────────────────┬─────────────────────┘
                                │ beacon               │ cart attrs on order
                                ▼                      ▼
        /apps/tracking/track (App Proxy, HMAC-signed)   Shopify order/checkout
        proxy.tracking.track.tsx                        webhooks
                                │                      │
                                ▼                      ▼
                  ┌──────────────────── SERVER CORE ────────────────────┐
                  │ visitors store (cross-session identity)              │
                  │ buildUserData (hash PII per Meta spec)               │
                  │ buildCAPIEvent + sendCAPIEventsForShop               │
                  │ deterministic event_id (browser↔server dedup)        │
                  │ capi_delivery_log / capi_retries / order_attribution │
                  └───────────────────────┬──────────────────────────────┘
                                          ▼
                          Meta Graph  POST /{dataset_id}/events  (v24.0)
```

---

## 1. The three client mechanisms (know which is live)

### (A) Custom Web Pixel — `extensions/web-pixel-cod-tracker/src/index.js`
- Shopify "Custom Web Pixel" extension, `runtime_context = "strict"` (LavaMoat
  Web Worker sandbox). Installed/updated/removed via Admin GraphQL
  `webPixelCreate|Update|Delete` (`app/lib/web-pixel-install.server.js`),
  triggered when the merchant connects/disconnects Pixel Tracking.
- Subscribes to `page_viewed`, `product_viewed`, `product_added_to_cart`,
  `search_submitted`, `checkout_started`, `payment_info_submitted`,
  `checkout_completed`, plus identity-only `checkout_contact_info_submitted`
  / `checkout_address_info_submitted` (these beacon `event:"identity_update"`
  → server upserts visitor PII, fires no CAPI).
- Beacons to `${window.location.origin}/apps/tracking/track`.
- **CONSENT-GATED**: the sandbox is silenced by Shopify's Customer Privacy
  API when marketing consent isn't granted. On real COD/PK stores it is
  effectively **dormant** — measured: only 7 InitiateCheckout beacons in the
  *entire 30-day `visitor_events` retention window* vs ~28/day from the
  server path. Do not assume its subscriptions deliver.
- Identity cache: when checkout-info events DO fire, it caches em/ph/addr in
  sandbox `localStorage` (`_codprofit_identity`, 24h TTL) and attaches it to
  every later beacon. Only helps within the same (consented) session.

### (B) Theme embed `meta-pixel.js` — `extensions/cart-identity-relay/assets/` — THE ACTIVE PATH
- Loaded by the `meta-pixel.liquid` app-embed block (target `head`). Not
  sandboxed, no consent gate → fires reliably for every visitor.
- `bootstrap()` fetches `/apps/tracking/config` → gets `pixel_id` +
  `visitor_id`, loads Meta's real `fbevents.js`, `fbq('set','autoConfig',
  'false')` (kills SubscribedButtonClick noise), `fbq('init', pixelId, AM)`.
- **Dual-fires every event**: `fbq('track', …, {eventID})` (browser, visible
  to Meta Pixel Helper) **and** a beacon to `/apps/tracking/track` (server
  CAPI). Both use the **same deterministic event_id** → Meta dedupes them
  into one event with combined identity (the documented gold standard).
- Fires browser-side: **PageView** (always), **ViewContent** (on
  `/products/*`), **AddToCart** (hooks `fetch`/XHR/form to `/cart/add`).
- Does **NOT** fire InitiateCheckout or Purchase browser-side — those are
  **server-only** (see §7). Comments in the file explain why
  (`installCheckoutClickHooks` is left defined but intentionally unwired:
  re-enabling it reintroduces a ~2× IC double-count because the click-hook
  psid event_id can't be reproduced by the server CHECKOUTS_CREATE webhook,
  which only knows the checkout token).
- Advanced Matching: `meta-pixel.liquid` stages `window.__codprofitAM` from
  Liquid — **only** for logged-in `customer` or on `checkout`/order-status
  pages. Anonymous COD buyers → AM is empty (this is why browse events carry
  no em/ph; see §12 and §16).

### (C) Theme embed `identity-relay.js`
- Loaded by the `identity-relay.liquid` app-embed block. Reads `_fbp`,
  `_fbc`, fresh `?fbclid`, UA, and the resolved `cod_visitor_id`, and writes
  them as **cart attributes** via `POST /cart/update.js` (keepalive). On the
  order webhook these arrive in `note_attributes` so the server can recover
  identity without a DB lookup.
- Sets `_fbc` cookie from a URL fbclid if absent:
  `fb.1.<Date.now()>.<fbclid>` — this is the **browser** constructing fbc
  from the full URL fbclid, which is **Meta-spec-compliant** (the fbclid is
  not modified). Do not confuse this with the *server*-side synthesis from
  truncated `landing_site`, which is forbidden — see §9.

> **Both theme embeds must be enabled by the merchant** in Online Store →
> Themes → Customize → App embeds. The app surfaces a one-click deep link
> (`buildThemeActivationUrl`, App-API-key form) and polls
> `/app/api/embed-status` to auto-detect activation. Shopify forbids
> programmatic theme writes for tracking apps, so the merchant click is
> unavoidable.

---

## 2. Connect / OAuth flow (Facebook Login for Business → BISU)

Distinct from the older `ads_read` spend flow (`app/lib/meta.server.js`).
This is FBL4B issuing a **BISU** (Business Integration System User) token —
**never expires**, scoped to the merchant's dataset. `app/lib/meta-pixel.server.js`.

1. **Ad Tracking page → "Connect"** (`app.ad-tracking.tsx` action,
   `intent=connect`): mints CSRF `state`, stores `state/shop/returnTo` in the
   short-lived `meta_pixel_oauth` cookie session (`meta-pixel-session.server.js`,
   10-min, `sameSite:none`), returns `getMetaPixelAuthUrl(state)`. UI opens it
   in a popup.
2. Merchant consents in Meta's UI (Business + Pixel + ad-account picker baked
   into the `META_PIXEL_CONFIG_ID` config).
3. **`/auth/meta-pixel/callback`** (`auth.meta-pixel.callback.tsx`):
   verifies `state`, `exchangeCodeForBISU(code)` → BISU access token (+
   sometimes `client_business_id`), `debugToken()` for scopes/user_id.
4. **Pixel discovery — four paths, cheapest first** (must exhaust all before
   giving up; failing here strands a merchant who *did* grant access):
   - **A** `discoverPixelsViaAdAccounts`: `/me/adaccounts` → `/{act}/adspixels`.
     The path that works for the common Admin-System-User BISU shape.
   - **B** `discoverPixelsFromBISU`: walk `granular_scopes[].target_ids`,
     probe each with `?fields=id,name,owner_business` (Pixel ⇒ 200,
     Business/SystemUser/Ad-account ⇒ 400 "nonexisting field").
   - **C** `listDatasets(businessId)`: business id from exchange
     `client_business_id` → `extractBusinessId(granular_scopes)`; lists
     `owned_pixels` + `client_pixels`.
   - **D** `resolveClientBusinessId` (4 sub-paths) → `listDatasets`.
   - All fail → **manual entry** fallback (merchant pastes the Pixel ID;
     `manual_entry_required` flag; 10–20 digit validation).
5. **Persist**: exactly one pixel → `autoCompleteConnection()` (one-click,
   no selection screen): `installWebPixel()` via the persisted **offline**
   session, upsert `meta_pixel_connections` (`bisu_token` encrypted with
   `encryptSecret`, AES-256-GCM, `crypto.server.js`), `status='active'`.
   Multiple pixels → stash in cookie, render selection screen, merchant
   picks → `intent=save_dataset` does the same persist.
6. Callback runs in the popup; `htmlResponse` postMessages the parent and
   closes; the Ad Tracking loader revalidates and shows "connected".
7. **Disconnect** (`intent=disconnect`): `revokeBISU` (DELETE
   `/me/permissions`), `uninstallWebPixel`, then **delete** the
   `meta_pixel_connections` row. Deleting the row (vs flipping status) is
   why a disconnected shop's CAPI sends are dropped silently — see §15.

---

## 3. App Proxy endpoints (`/apps/tracking/*`)

Configured in `shopify.app.toml` `[app_proxy]` → `…/proxy/tracking`. First-
party at the merchant domain (bypasses blockers; Safari ITP grants full
`Max-Age` on `Set-Cookie`). **Every hit HMAC-verified** by
`verifyAppProxySignature` (`app-proxy-verify.server.js`, constant-time) —
without it we'd accept arbitrary CAPI from the internet.

- **`/apps/tracking/config`** (`proxy.tracking.config.tsx`, loader/GET):
  returns `{ pixel_id, connected, shop, visitor_id }`. Resolves
  `visitor_id` from the echoed `?vid=` (App Proxy strips cookies both ways,
  so the theme block round-trips the id via query param + persists it in
  `localStorage`/`document.cookie` itself). Mints a fresh UUID on first
  visit. Returns `connected:false` (still 200) for unconnected shops.
- **`/apps/tracking/track`** (`proxy.tracking.track.tsx`, loader+action):
  1. HMAC verify, parse body (JSON or beacon form).
  2. Resolve `visitor_id` (explicit body field > cookie > mint).
  3. **`upsertVisitor` runs for EVERY signed beacon** — including
     identity-only `identity_update` events that map to no Meta event. This
     is how checkout-entered PII reaches the visitor row.
  4. `shopifyEventToMeta(body.event)` → null ⇒ 204 (after the upsert).
  5. Build `user_data` (`buildUserData`), record a `visitor_events`
     breadcrumb, `sendCAPIEventsForShop` for the mapped event.
  - `external_id` = `[body.external_id, visitorId]` deduped — every server
    event carries ≥1 stable external_id (biggest EMQ lever for anon stores).

---

## 4. Server webhooks — `app/routes/api.webhooks.meta-pixel.tsx`

Subscribed in `shopify.app.toml` (managed) **and** re-asserted on every
`afterAuth` via `registerMetaPixelWebhooks` (`shopify.server.js`, belt-and-
suspenders REST POST, 422 = already-registered = no-op). One handler,
branches on `topic`:

| Topic | → Meta event | Handler |
|---|---|---|
| `ORDERS_CREATE` + `ORDERS_PAID` | **Purchase** | `handleOrderPaid` |
| `ORDERS_EDITED` | (ignored in v1) | — |
| `REFUNDS_CREATE` | **Refund** (custom, negative value) | `handleRefund` |
| `CHECKOUTS_CREATE` | **InitiateCheckout** | `handleCheckout` |
| `CHECKOUTS_UPDATE` | **AddPaymentInfo** (only if `payment_url`) | `handleCheckout` |

**Why `orders/create` not just `orders/paid`:** COD payment is captured days
later; `orders/paid` would land after Meta's 7-day attribution window. Fire
Purchase at order *placement*; if `orders/paid` later fires, the
deterministic event_id makes Meta dedupe.

`handleCheckout` **skips the fire entirely if `user_data` has no matchable
identity** (no hashed PII, no fbp/fbc, no ip+ua pair) — `CHECKOUTS_CREATE`
often arrives before the buyer types anything, and Meta 400s an identity-less
event. The eventual Purchase webhook carries full identity anyway, so this
loses nothing. (This is a common "why didn't InitiateCheckout fire" answer.)

Always returns **200** (errors logged, never re-thrown) so Shopify doesn't
NACK+retry on a CAPI hiccup. Webhook auth via `authenticate.webhook`.

---

## 5. Deterministic event_id & dedup model (critical, do not break)

`event_id = "<event>:<shop>:<resource>"`, e.g.
`purchase:the-trendy-homes-pk.myshopify.com:7674649608508`.

- **Webhook retries**: Shopify retries non-2xx with the same resource id →
  same event_id → Meta dedupes. (We 200 fast anyway.)
- **orders/create + orders/paid**: same `order.id` → same
  `purchase:<shop>:<id>` → one Purchase in Meta.
- **Browser ↔ server**: the Custom Web Pixel `deterministicId("Purchase",
  order.id)` and `meta-pixel.js`'s server-only Purchase both yield
  `purchase:<shop>:<id>`. For browse events both client paths use
  `<shopify_event_name>:<shop>:<psid>` where `psid` is the **shared**
  `_codprofit_psid` cookie (visible to both the sandbox and the theme
  block). **PageView was the one historical mismatch** (`pageview:` vs
  `page_viewed:`) — fixed 2026-05-16 so `meta-pixel.js` now emits
  `page_viewed:<shop>:<psid>` matching the Custom Web Pixel's
  `fallbackId("page_viewed")`.
- The browser fbq fire and its own server beacon from `meta-pixel.js`
  always share one `eventId` variable → they dedupe regardless of the
  string's value. The string only matters for cross-*pixel* dedupe.

> **Invariant:** never make an event_id non-deterministic or per-fire-random
> for events that have a webhook counterpart. That reintroduces double
> counting. Tests in `tests/visitors-pickBestFbc.test.mjs` + the single-
> prefix check in `scripts/_verify_pipeline_fixes.mjs` guard this.

---

## 6. Visitor identity store — `app/lib/visitors.server.js`

`visitors` table, one row per `cod_visitor_id` per store. Carries hashed PII
(`em_hash`…`external_id_hash`), latest raw `fbp/fbc/ip/ua`, and
`fbc_history`/`utm_history` jsonb (cap 5). `upsertVisitor` SELECT→merge→UPSERT
with **`preserveOrUpdate`** semantics: a newer non-null value wins; an empty
event never nulls out a known value. 180-day TTL on `last_seen_at`.

**Three-tier visitor lookup at conversion time** (each tier only if the prior
missed): 1) `_cod_visitor_id` cart attribute; 2) `findVisitorByFbclid`
(substring `ilike` on `latest_fbc` because Shopify truncates landing_site
fbclid — match the truncated against the full); 3) `findRecentVisitorByIpUa`
(same ip+ua within ±60 min — catches FB iOS IAB where fbclid rotates per page).

---

## 7. Browse vs conversion flow (numbered, end-to-end)

**Browse (PageView/ViewContent/AddToCart)** — production path is (B):
1. `meta-pixel.js bootstrap()` → `/apps/tracking/config` → pixel_id +
   visitor_id; loads fbq.
2. Event fires → `track()` dual-fires `fbq` + beacon to
   `/apps/tracking/track` with `event_id = <evt>:<shop>:<psid>`.
3. Server upserts visitor, records breadcrumb, builds user_data
   (fbp/fbc/ip/ua + external_id; em/ph only if a prior Purchase wrote them
   back — see §16), `sendCAPIEventsForShop`. Meta dedupes the browser+server
   pair by event_id.

**Conversion (Purchase)** — server-only:
1. Buyer completes order → Shopify `orders/create` (and later `orders/paid`).
2. `handleOrderPaid`: `extractIdentityFromOrder` (cart attrs / landing_site
   fbclid) + `extractCustomerIdentity` (email/phone/name/addr/customer.id).
3. Three-tier visitor lookup → `recoveredVisitorId` + `visitor`.
4. `pickBestFbc` (§9) → best **genuine** fbc.
5. `buildUserData` (hash per Meta spec) with `external_id =
   [visitor_id, customer.id]`, fbp/fbc/ip/ua, full hashed PII from the order.
6. `event_id = identityHints.eventId ?? purchase:<shop>:<order.id>`.
7. `sendCAPIEventsForShop` → Meta.
8. **Visitor write-back** (added 2026-05-16): if `recoveredVisitorId`,
   `upsertVisitor` the order's hashed em/ph/addr onto the visitor row so this
   visitor's *future* browse events score high EMQ. Additive, best-effort,
   after the CAPI fire so delivery latency isn't gated.
9. `recordOrderAttribution` (§11); on `capiResult.ok` →
   `markAttributionCapiSent` stamps `order_attribution.capi_sent_at`.

Mirror logic lives in `api.cron.capi-reconcile.tsx` `replayPurchase` (safety
net, §10) — keep the two in lockstep when changing either.

---

## 8. user_data hashing — `app/lib/meta-hash.server.js`

Normalize-then-SHA256 per Meta's spec (mismatched normalization halves match
rate). Phone → E.164 using the order's country_code dial map (+~3 EMQ).
`em/ph/fn/ln/ct/st/zp/country/external_id` hashed (arrays); `fbc/fbp/
client_ip_address/client_user_agent` raw. `external_id` accepts an array and
dedupes by hash so passing `[visitor_id, customer.id]` is safe. Empty/invalid
inputs drop the key entirely (never send empty arrays — Meta penalizes that).

---

## 9. fbc / fbclid — the "modified fbclid" compliance invariant ⚠️

**THE rule (Meta diagnostic "Server sending modified fbclid value in fbc
parameter"): never put a lowercased or truncated fbclid in `fbc`. An omitted
fbc scores better than a modified one.**

- Shopify **truncates `order.landing_site`** to ~91 chars (measured: cookie
  fbclid p50≈159). `extractIdentityFromOrder` still *computes* a synthesized
  `fb.1.<ts>.<fbclid>` from it (tagged `fbcSource:"synthesized_from_landing_site"`)
  — but that value is **truncated/modified**.
- `pickBestFbc` (post-2026-05-16) returns fbc **only** from genuine browser
  `_fbc` cookie values: tier 1 cart-attribute fbc, tier 2 `visitor.latest_fbc`,
  tier 3 `visitor.fbc_history`. **There is no tier 4** — a
  `synthesized_from_landing_site` value is **never** returned; the event
  ships with em/ph/external_id/fbp/ip+ua instead.
- The bare fbclid is **still used** for visitor lookup (`findVisitorByFbclid`)
  and channel attribution (`classifyUrlChannel`) — those are internal, not
  sent to Meta. Only the *fbc wire value* is refused.
- The **browser** constructing `_fbc` from a full URL `?fbclid` (identity-
  relay.js / Custom Web Pixel `ensureFbCookies`) is spec-compliant — the
  fbclid is the complete one the browser saw, not modified.
- Guarded by `tests/visitors-pickBestFbc.test.mjs` ("NEVER returns a
  synthesized fbc"). Do not reintroduce a synthesized-fbc fallback.

---

## 10. CAPI sender, delivery log, retries, reconcile — `app/lib/meta-capi.server.js`

- `lookupConnection`: requires a `meta_pixel_connections` row with
  `status='active'` + decryptable `bisu_token`. Row **absent** (disconnected)
  ⇒ console.warn + drop (FK would block a log row). Row **present but
  inactive/lookup-error** ⇒ writes a `dropped` row to `capi_delivery_log`
  (this was the #9393 silent-drop fix — always leave a trace).
- `postCAPIEvents`: `POST graph.facebook.com/v24.0/{dataset_id}/events`,
  `data_processing_options:[]`. Up to 1000 events/call (webhook Purchase
  fires single for latency).
- Success ⇒ `capi_delivery_log` row `status='sent'` with `match_keys =
  Object.keys(user_data)` (only for `sent`), bump
  `meta_pixel_connections.last_event_sent_at`.
- Failure: transient (429/5xx/network) ⇒ `capi_retries` (backoff
  `5m→30m→2h→6h→8h`, 5 attempts then drop — Meta rejects >7-day-old events).
  4xx ⇒ `failed` log row; auth errors (190/401/403) flip connection
  `status='error'` → dashboard reconnect banner.
- **`capi_delivery_log` is capped at 500 rows/shop** by an after-insert
  trigger. Busy shops rotate out overnight Purchase rows within hours →
  **absence from the log ≠ a missed event.** Authoritative "sent" signal is
  `order_attribution.capi_sent_at`.
- `api.cron.capi-retry.tsx` (every 5 min) → `drainRetries`.
- `api.cron.capi-reconcile.tsx` (hourly): pulls last 2h of Shopify orders per
  active connection, replays any Purchase with no `sent` log row. Safety net
  for silent drops. Idempotent via deterministic event_id.

---

## 11. Channel attribution — `app/lib/channel-attribution.server.js`

Written at Purchase time, idempotent on `(store_id, shopify_order_id)`.
Three locked buckets (do not add more — keeps the dashboard legible):
- `facebook_ads` — fbclid present + (utm_source=facebook OR absent OR other).
- `instagram_ads` — fbclid present + utm_source=instagram.
- `direct_organic` — no fbclid.

Resolution: tier 1 `visitor.latest_fbc` set ⇒ paid Meta, split FB/IG by the
most recent `visitor_events.url` utm_source; tier 2 (no visitor fbc) classify
`order.landing_site` URL (rescues Instagram/FB IAB orders where beacons were
blocked but the fbclid rode the landing URL); else `direct_organic`. 30-day
TTL. Powers the dashboard channel breakdown card.

---

## 12. EMQ — it is a LOCAL PROXY, not Meta's real EMQ ⚠️

`api.cron.emq.tsx` (daily 06:00 UTC) does **NOT** call Meta. It computes a
weighted score from `capi_delivery_log.match_keys` of `sent` events in a
7-day window (capped by the 500-row trim). Weights: `em/ph` 1.5, `fn/ln/fbc`
1.0, `external_id` 0.6, `fbp` 0.5, `ct` 0.4, `st/zp/country` 0.3, `ip+ua`
0.5, cap 10. Stored in `emq_snapshots.{overall_emq, per_event}` (90-day TTL).
The Ad Tracking page reads only `emq_snapshots` (the `MatchStrengthBar`).

- A browse event with `[external_id,fbp,fbc,ip+ua]` scores exactly **2.6**;
  a Purchase with full order PII ≈ **8.4**. These are expected, not broken.
- **The 2026-05-12 "collapse" 10→3.5 was NOT a regression.** Commit
  `ab7cee7` (2026-05-11 19:49 PKT) switched the cron from Meta's
  `aggregation=had_pii` coverage rate (≈10 for any event with ≥1 PII key) to
  this honest proxy. Browse match quality was always ~2.6.
- `fetchEMQ` in `meta-pixel.server.js` (the old `had_pii` path) is **dead
  code** — no callers in `app/` (only the throwaway
  `scripts/_test_emq_for_trendy.mjs` references it). Don't wire it back
  expecting "real EMQ"; Meta does not expose Events-Manager EMQ via Graph API.
- Real EMQ lives only in Meta Events Manager (and the "modified fbclid"
  diagnostic there is the thing that actually matters for attribution).

---

## 13. Crons (Railway scheduled, `x-cron-secret`)

| Endpoint | UTC | Purpose |
|---|---|---|
| `api.cron.capi-retry` | every 5 min | drain `capi_retries` |
| `api.cron.capi-reconcile` | hourly | replay missed Purchases (last 2h) |
| `api.cron.emq` | `0 6 * * *` | local EMQ proxy snapshot |
| `api.cron.visitors-trim` | `0 3 * * *` | TTLs: visitor_events 30d, visitors 180d, emq_snapshots 90d (`trim_emq_snapshots`), order_attribution 30d (`trim_order_attribution`) |

---

## 14. Tables touched (all RLS by `store_id`, set via `set_app_store`)

`meta_pixel_connections` (1/shop: encrypted BISU, dataset_id, web_pixel_id,
status, last_event_sent_at), `visitors`, `visitor_events` (30d),
`order_attribution` (30d, `capi_sent_at` = authoritative "sent"),
`capi_delivery_log` (500/shop cap), `capi_retries`, `emq_snapshots` (90d).

---

## 15. Failure modes & recovery

| Symptom | Cause | Recovery |
|---|---|---|
| Purchase missing from `capi_delivery_log` but `order_attribution.capi_sent_at` set | 500-row trim evicted it | None needed — it was sent |
| Purchase with no attribution + no log + no retry | silent drop (connection row absent/inactive at fire time) | hourly reconcile cron replays; or `scripts/_*replay*` (deterministic id = safe) |
| Connection `status='error'` | Meta auth 190/401/403 | merchant reconnects on Ad Tracking page |
| `capi_retries` backlog growing | Meta 429/5xx or network | self-drains; investigate if >5 attempts dropping |
| Meta "modified fbclid" diagnostic | truncated synthesized fbc reached Meta | §9 — should be 0 after 2026-05-16 deploy; re-check Events Manager 3d after deploy |
| Browse EMQ stuck ~2.4 | no em/ph on browse events | §16 — structural; mitigated by Purchase write-back over time |

---

## 16. Non-obvious gotchas (read before "fixing" anything)

1. **`meta-pixel.js` is the live path, the Custom Web Pixel is mostly
   dormant.** Diagnose against the theme embed first.
2. **Theme app embeds do NOT load on Shopify Checkout Extensibility.** So
   `meta-pixel.js` / `identity-relay.js` never run on the checkout/thank-you
   pages. Checkout-entered PII can only be learned by (a) the consent-gated
   Custom Web Pixel `checkout_*_info_submitted` handlers, or (b) the
   **order webhook** (always has it). This is why InitiateCheckout/Purchase
   are server-only and why browse-event em/ph relies on the Purchase
   write-back (§7 step 8) lifting *future* sessions of returning visitors.
3. **`em_hash` legitimately near-zero on first-time anonymous buyers** —
   nothing knows their email until checkout. Not a bug. The write-back only
   helps returning visitors.
4. **EMQ here is a proxy, not Meta's number** (§12). Never report it as
   Meta's EMQ; never diagnose the 05-12 drop as a regression.
5. **Never synthesize fbc from landing_site** (§9). Omit instead.
6. **App Proxy strips cookies both directions** — visitor_id persistence is
   the theme block's job (`localStorage`/`document.cookie` + `?vid=` round-
   trip), not `Set-Cookie`.
7. **Disconnect deletes the `meta_pixel_connections` row** (not a soft
   flag) — an in-flight CAPI then drops with only a console.warn (FK blocks a
   log row). Expected behavior.
8. **`capi_delivery_log` 500-row cap** — never infer "missed" from absence;
   use `order_attribution.capi_sent_at`.
9. **PageView event_id** must stay `page_viewed:<shop>:<psid>` in
   `meta-pixel.js` to dedupe with the Custom Web Pixel.
10. **Two deploy targets**: extensions (Custom Web Pixel + theme embeds) ship
    via `shopify app deploy`; server code ships via Railway from `main`.
    A change can be half-live. The extensions and Remix server are
    independent release trains.

---

## 17. Recent fixes (2026-05-16) + how to verify

Branch `fix/capi-fbc-bulletproof-and-visitor-enrichment` (PR open) +
`shopify app deploy` version `codprofit-21`:

1. **Bulletproof fbc** — `pickBestFbc` never emits a synthesized/truncated
   fbc (§9). `visitors.server.js`.
2. **Cross-session PII write-back** — Purchase webhook + reconcile cron
   `upsertVisitor` the order's hashed PII onto the visitor row (§7.8).
3. **PageView event_id dedup** — `meta-pixel.js` `pageview:`→`page_viewed:`.
4. Tests updated; 111/111 pass; `remix build` clean.

Server fixes (1,2) are live only after the PR merges to `main` (Railway).
Extension fix (3) + Custom Web Pixel identity capture shipped via
`shopify app deploy` (codprofit-21).

**Verify:** `node scripts/_verify_pipeline_fixes.mjs` (re-runnable). Expected
post-deploy deltas: `visitors.em_hash` count 0→>0, newest PageView prefix →
`page_viewed:`, `capi_retries` stays 0, Meta "modified fbclid" diagnostic
ages out of Events Manager within ~3 days. Baseline + forensic scripts:
`_pipeline_audit_trendy_today.mjs`, `_pipeline_forensics.mjs` (throwaway
`_*` convention).

---

## 18. Quick file index

| Concern | File |
|---|---|
| Ad Tracking page (loader/action/UI) | `app/routes/app.ad-tracking.tsx` |
| OAuth callback + pixel discovery | `app/routes/auth.meta-pixel.callback.tsx` |
| FBL4B/BISU Graph helpers, `fetchEMQ`(dead) | `app/lib/meta-pixel.server.js` |
| OAuth cookie session (10 min) | `app/lib/meta-pixel-session.server.js` |
| BISU encryption (AES-256-GCM) | `app/lib/crypto.server.js` |
| Web Pixel install/update/delete | `app/lib/web-pixel-install.server.js` |
| App Proxy HMAC verify | `app/lib/app-proxy-verify.server.js` |
| App Proxy config / track | `app/routes/proxy.tracking.config.tsx` / `proxy.tracking.track.tsx` |
| Order/checkout/refund webhooks | `app/routes/api.webhooks.meta-pixel.tsx` |
| Cart-attr / customer identity parse | `app/lib/cart-attributes.server.js` |
| Visitor store, `pickBestFbc` | `app/lib/visitors.server.js` |
| Channel attribution | `app/lib/channel-attribution.server.js` |
| CAPI send/log/retry/drain | `app/lib/meta-capi.server.js` |
| Hash + buildUserData | `app/lib/meta-hash.server.js` |
| EMQ proxy cron | `app/routes/api.cron.emq.tsx` |
| Retry / reconcile / trim crons | `app/routes/api.cron.capi-retry.tsx`, `…capi-reconcile.tsx`, `…visitors-trim.tsx` |
| Embed activation detect / poll | `app/lib/theme-embed.server.js`, `app/routes/app.api.embed-status.tsx` |
| Webhook re-assert | `registerMetaPixelWebhooks` in `app/lib/shopify.server.js` |
| Custom Web Pixel (sandboxed) | `extensions/web-pixel-cod-tracker/src/index.js` |
| Theme embed: browser fbq + beacon | `extensions/cart-identity-relay/assets/meta-pixel.js` (+`meta-pixel.liquid`) |
| Theme embed: cart-attr relay | `extensions/cart-identity-relay/assets/identity-relay.js` (+`identity-relay.liquid`) |
| Webhooks/scopes/app-proxy config | `shopify.app.toml` |
