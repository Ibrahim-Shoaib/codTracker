# Ad Tracking — Deployment & E2E Test Runbook

This is the step-by-step guide to ship the Ad Tracking feature to production
and verify it works end-to-end on a real merchant store.

> Status: code complete, unit tests passing (46/46), `tsc --noEmit` clean for
> all new files, `npm run build` clean. Not yet E2E-tested — see "E2E walkthrough"
> below.

## 1. Environment variables (Railway)

Add these three to Railway production env (Settings → Variables):

| Variable | Value | How to get it |
|---|---|---|
| `META_PIXEL_CONFIG_ID` | `1316786037076433` | Already set up: Meta App Dashboard → Facebook Login for Business → Configurations → "Pixel Tracking" |
| `META_PIXEL_REDIRECT_URI` | `https://codtracker-production.up.railway.app/auth/meta-pixel/callback` | Add this exact URL to the Pixel Tracking config's allowed redirect URIs in Meta App Dashboard too |
| `ENCRYPTION_KEY` | output of `openssl rand -hex 32` | New value, do NOT reuse `SESSION_SECRET` |

**Optional:**

| Variable | Value | Purpose |
|---|---|---|
| `META_TEST_EVENT_CODE` | from Events Manager → your dataset → Test events tab | Sends "Send test event" page button events into the dev test stream instead of production |

## 2. Run the migration

Open Supabase SQL Editor and paste the contents of
`supabase/migrations/015_ad_tracking.sql`. Execute. Verify with:

```sql
SELECT count(*) FROM meta_pixel_connections;  -- 0
SELECT count(*) FROM capi_retries;            -- 0
SELECT count(*) FROM capi_delivery_log;       -- 0
SELECT count(*) FROM emq_snapshots;           -- 0
```

All four should return 0 rows but the tables should exist (no error).

## 3. Deploy the app to Railway

```bash
git push origin feat/ad-tracking
```

Then in Railway → Service → Deployments, redeploy.

**Verify** the new routes exist after redeploy by hitting:

- `GET https://codtracker-production.up.railway.app/auth/meta-pixel` → should redirect to Meta (302)
- `GET https://codtracker-production.up.railway.app/api/cron/capi-retry` → 401 (no cron secret) — confirms route is registered
- `GET https://codtracker-production.up.railway.app/proxy/tracking/track` → 401 (no signature) — confirms App Proxy route is up

## 4. Deploy Shopify config + extensions

```bash
shopify app deploy
```

This pushes:

- `shopify.app.toml` (new scopes, App Proxy config, new webhook subscriptions)
- `extensions/web-pixel-cod-tracker/` (Custom Web Pixel)
- `extensions/cart-identity-relay/` (Theme App Extension)

**Approve the new scopes** when Shopify CLI prompts. The app version will bump.

> Existing merchants will see a re-consent prompt the next time they open the
> app in admin (because we added `read_customers`, `read_checkouts`,
> `write_pixels`, `read_pixels`). That's expected — merchants approve once and
> nothing else changes for them. The Ad Tracking page is opt-in (they can
> ignore it).

## 5. Configure Railway cron schedules

In Railway → Service → Settings → Cron Schedules, add:

| Schedule | Path | Headers |
|---|---|---|
| `*/5 * * * *` | `/api/cron/capi-retry` | `x-cron-secret: $CRON_SECRET` |
| `0 6 * * *`   | `/api/cron/emq`        | `x-cron-secret: $CRON_SECRET` |

(The retry cron uses the same `CRON_SECRET` env var that already exists for
`api.cron.meta-today` etc.)

## 6. Submit Meta App Review (in parallel)

Go to Meta App Dashboard → App Review → Permissions and Features. Request
**Advanced access** on each:

- `ads_read`
- `ads_management`
- `business_management`

Prerequisites that must be done first:

1. Business Verification (Settings → Business Verification)
2. Access Verification (App Review → Requests)

Submission package per permission:

- Screencast: open Ad Tracking page → Connect Meta Pixel → grant in Meta UI →
  pick a Pixel → see "Connected" → click Send Test Event → see green banner
  with trace id → open Events Manager → see test event with full identity
- Use case writeup: "Tech Provider for Shopify merchants. Our app reads
  merchants' Meta Ads spend (ads_read) and relays Conversions API events on
  their behalf for first-party tracking (ads_management, business_management).
  We do not access ad accounts or businesses we do not own outside of merchant-
  granted access."

Expect 1–3 weeks of review iteration.

## 7. E2E walkthrough (do this on a dev store before merging)

> Until Advanced Access is granted, this E2E only works for users with a
> Developer/Tester role on your Meta App and admin access to a Business that
> has at least one Pixel.

### 7.1 Connect

1. Open the dev store's admin → COD Tracker app → click **Ad Tracking** in nav.
2. Click **Connect Meta Pixel**. Popup opens to Meta.
3. Pick a Business. Pick a Pixel. Grant.
4. Popup closes. Page revalidates. You should see the dataset selector.
5. Pick the dataset, click **Save & install pixel on storefront**.
6. Page should now show **Connected** badge + dataset id + EMQ "updates daily".

### 7.2 Verify Web Pixel installed

Shopify admin → Settings → Customer events. **COD Tracker Pixel** should be in
the list with status "Connected".

### 7.3 Verify Theme App Extension installed

Online Store → Themes → Customize → Theme settings → App embeds.
**COD Tracker Cart Relay** should be present. Toggle it ON.

### 7.4 Test event

Click **Send test event** on the Ad Tracking page. You should see:
- Green banner: "Test event accepted by Meta · trace ABC..."
- A new row in **Recent events** list: `PageView · sent · trace ABC...`

### 7.5 Real Purchase

1. On the storefront, append `?fbclid=test123` to any URL.
2. Browse a product, add to cart, complete checkout (use Shopify Bogus
   Gateway with card 1).
3. In Events Manager → your dataset → Overview, within ~30 seconds you should
   see a Purchase event matching the order. Click it; the **Match Quality**
   detail should show 9+ identity signals (em, ph, fn, ln, ct, st, zp, country,
   external_id, fbp, fbc, client_ip_address, client_user_agent).
4. In Ad Tracking page → Recent events, the Purchase should appear with status
   `sent`.

### 7.6 Refund

1. In admin, refund the test order.
2. Within ~30 seconds, a `Refund` custom event should appear in Events Manager
   with negative value matching the refund amount.

### 7.7 Disconnect

Click **Disconnect** on Ad Tracking page. Verify:

- Web Pixel removed from Settings → Customer events.
- `meta_pixel_connections` row deleted in Supabase.
- Reconnecting works cleanly (re-runs full OAuth flow).

## 8. Rollback plan

If anything breaks in production:

1. Railway: redeploy the previous commit. Existing connections survive (rows
   in `meta_pixel_connections` aren't affected by code rollback).
2. Database: `015_ad_tracking.sql` is additive — no rollback needed unless
   you want to drop the new tables: `DROP TABLE meta_pixel_connections,
   capi_retries, capi_delivery_log, emq_snapshots CASCADE;`
3. Shopify: `shopify app deploy` to revert to a previous app version (the
   CLI keeps version history).
4. Web Pixel: remains installed on stores until you `shopify app deploy` a
   version without the extension. Harmless if left in place — the App Proxy
   endpoint will simply return 200 with no-op for unconfigured shops.

## 9. Existing-merchant migration

Non-breaking by design:

- Existing `ads_read` connection (`stores.meta_access_token`) is **unchanged**.
  Spend reporting on the dashboard keeps working with no merchant action.
- The new Pixel Tracking is a **separate** connection
  (`meta_pixel_connections`) that merchants opt into via the Ad Tracking page.
- Adding `read_customers`/`read_checkouts`/`write_pixels` to scopes triggers
  a re-consent prompt the next time each merchant opens the app. They click
  "Accept" once — no other UX change.
- We do not migrate existing `meta_access_token` to a BISU token. They are
  different token types serving different purposes. Both can coexist on the
  same shop indefinitely.
