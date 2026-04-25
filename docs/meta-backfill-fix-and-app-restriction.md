# Meta Historical Backfill — Pagination Fix and App-Level Access Block

> **Status as of 2026-04-25:** Code fixes are committed to the working tree (not staged, not pushed). Re-running the backfill is **blocked** on a Meta-platform-level restriction of the app that the Facebook account owner (the user's client) must resolve before any further API calls can succeed.
>
> This file is written for a future Claude instance picking up this thread cold. Read it end-to-end before doing anything.

---

## TL;DR

1. Found and fixed a real bug in `app/lib/meta.server.js` — `fetchDailySpend` was reading only the first page of Meta's paginated `/insights` response, silently dropping the tail of every chunk older than ~25 days.
2. Hardened the backfill loop so transient API errors don't masquerade as "history ended."
3. While verifying the fix end-to-end, discovered Meta is currently returning `code 200 "API access blocked"` for **every** call from this app — including app-token-only endpoints like `/me` and `/debug_token`. The Meta app itself is restricted at the platform level.
4. The most likely trigger: the registered Privacy Policy / Terms / Data-Deletion URLs return 404 on the Railway deploy (we confirmed `/privacy` and `/terms` are 404).
5. The user's client (Meta account owner of the developer account) needs to log in to Meta Developer Console, read the restriction notice, and either fix the policy URLs or appeal.
6. Once access is restored, run `node scripts/rerun-meta-backfill.mjs` — it will pre-flight-gate, snapshot existing rows to a backup file, then re-run the fixed backfill. The existing rows are correct (they're page-1 days from the buggy fetch), so the re-run is purely additive — it inserts the previously-missing days.

---

## The original bug (what brought this thread into existence)

**Symptom (from user, on 2026-04-25):**
- Single store onboarded yesterday (2026-04-24), backfill ran once.
- `ad_spend` totals by month on the affected store:
  - Mar / Feb / Jan 2026: accurate (matches Ads Manager).
  - **Dec 2025: zero.**
  - Nov 2025 and earlier: non-zero but consistently lower than Ads Manager.
- Already ruled out by user: campaigns deleted, currency change, timezone change, wrong account, status-filter issues, single-chunk failure.

**Diagnosis (confirmed by inspecting the live data):**

The backfill walks backwards in 60-day chunks and calls `fetchDailySpend(token, ad, start, end)` for each. The original implementation:

```js
// OLD app/lib/meta.server.js fetchDailySpend
const params = new URLSearchParams({
  fields:         'spend',
  time_range:     timeRange,
  time_increment: '1',
  level:          'account',
  access_token:   accessToken,
});
const res = await fetch(`${GRAPH_BASE}/${adAccountId}/insights?${params}`);
const data = await res.json();
return (data.data ?? []).map(d => ({ date: d.date_start, spend: Number(d.spend ?? 0) }));
```

No `limit` parameter and no `paging.next` follow-up. Meta defaults to ~25 rows per page on this query and returns rows in `date_start` ascending order, so each chunk silently truncates after the first ~25 days.

**Why recent months looked correct anyway:** the user had paused all campaigns, so recent days had little or no spend. With few rows in the API response, page 1 fit comfortably and nothing was truncated. Older months, where every day had spend, hit the limit and lost their tails.

**Confirmed by data:**
- DB rows for the affected store span `2025-06-18 .. 2026-03-16`.
- The latest row in chunk 1 (covering Feb 25 – Apr 25) is `2026-03-16` — exactly 20 days from the chunk's start, consistent with a small page size.
- In the Sept–Dec 2025 window, **76 of 122 days are missing**, and the missing block is contiguously `2025-09-17 .. 2025-12-31`. The cuts align with chunk boundaries (`2025-08-29 .. 2025-10-27`, `2025-10-28 .. 2025-12-26`).
- December collapse is explained: Dec 1–26 is in chunk 3 past the page-1 cut; Dec 27–31 falls in chunk 2 but the user happened to have ~zero spend on those days (campaigns winding down).

The affected store is `the-trendy-homes-pk.myshopify.com` (only one connected Meta store at the time of writing). All 132 existing `ad_spend` rows have `source='meta'` — no manual entries to worry about.

---

## Code changes applied (working tree, not committed)

### 1. `app/lib/meta.server.js` — `fetchDailySpend` now follows pagination

```js
export async function fetchDailySpend(accessToken, adAccountId, sinceDate, untilDate) {
  const timeRange = JSON.stringify({ since: sinceDate, until: untilDate });
  const params = new URLSearchParams({
    fields:         'spend',
    time_range:     timeRange,
    time_increment: '1',
    level:          'account',
    limit:          '500',
    access_token:   accessToken,
  });
  let url = `${GRAPH_BASE}/${adAccountId}/insights?${params}`;
  const out = [];
  for (let page = 0; page < 50 && url; page++) {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Meta fetchDailySpend failed: ${err.error?.message ?? res.status}`);
    }
    const data = await res.json();
    for (const d of (data.data ?? [])) {
      out.push({ date: d.date_start, spend: Number(d.spend ?? 0) });
    }
    url = data.paging?.next ?? null;
  }
  return out;
}
```

`limit=500` makes pagination a no-op for any normal 60-day chunk (one page is enough). The `paging.next` loop is the safety net if Meta ignores the limit. The `page < 50` cap guards against a runaway cursor.

`fetchSpend` (the cron path used by `api.cron.meta-today` and `api.cron.meta-finalize`) was **not** changed — those calls don't use `time_increment` and only need a single aggregate row.

### 2. `app/lib/backfill.server.js` — `runMetaHistoricalBackfill` no longer treats throws as "empty"

Old behaviour: a thrown chunk incremented the same `consecutiveEmpty` counter as a truly empty response, so two transient errors in a row would terminate the historical walk early **and** still stamp `last_meta_sync_at` as if the run completed.

New behaviour:
- One retry per chunk with a 2-second backoff.
- If both attempts throw, the run aborts loudly (`aborted = true`, console.error).
- `last_meta_sync_at` is **only** stamped when `!aborted`, so an aborted run remains visible and the merchant's UI will not falsely report "synced."
- Empty-data still counts toward the stop condition, separately from errors.

Upsert error from Supabase also aborts the run rather than silently moving past it.

### 3. New scripts under `scripts/` (not wired into the app)

| File | Purpose |
|------|---------|
| `inspect-ad-spend.mjs` | Print every connected store's `ad_spend` row count, date range, monthly totals, and missing dates in the Sept–Dec 2025 window. |
| `probe-meta-chunk3.mjs` | Hit Meta `/insights` for chunk 3's exact range with default and `limit=500`, plus chunk 1, to confirm or rule out pagination as the cause. |
| `probe-meta-access.mjs` | Try `/me`, `/me/adaccounts`, the ad account directly, a simple last-7-days insights call, and `/debug_token`. Diagnoses whether the token is alive. |
| `probe-meta-app-status.mjs` | App-token-only calls — `/{app-id}`, restrictions, roles, permissions, and a generic Graph health check. Distinguishes user-token-vs-app-level blocks. |
| `probe-meta-network.mjs` | No-token calls (`graph.facebook.com/`, oEmbed, OAuth dialog HEAD). Confirms the network/IP is not blocked. |
| `check-ad-spend-sources.mjs` | Lists `(store_id, source)` row counts in `ad_spend` so the re-run can't accidentally clobber non-meta entries. |
| `rerun-meta-backfill.mjs` | The actual re-run. Pre-flights `/me`, snapshots `ad_spend` to `scripts/backups/ad_spend_<store>_<timestamp>.json`, then calls the fixed `runMetaHistoricalBackfill`, and prints a before/after monthly diff. |

These can all be deleted later — they're not imported anywhere in the app.

---

## The blocker — Meta app is restricted at the platform level

**Symptom:** every Graph call from this app returns:

```json
{ "error": { "message": "API access blocked.", "type": "OAuthException", "code": 200 } }
```

This applies to:
- The user token in the DB (`stores.meta_access_token`, expires 2026-06-23 — still in date).
- The app access token (`META_APP_ID|META_APP_SECRET`).
- Even `/me` and `/debug_token`.

What is **not** blocked (proves it's app-scoped, not network or token):
- Direct `https://graph.facebook.com/v21.0/` with no token returns the normal "Unsupported get request" error.
- The OAuth dialog at `https://www.facebook.com/v21.0/dialog/oauth?client_id=…` redirects to `login.php` correctly, so the app ID is recognized.

**Likely root cause:** Meta's automated review flagged the app because required policy URLs return 404. Confirmed:

```
https://codtracker-production.up.railway.app/         -> 200
https://codtracker-production.up.railway.app/auth/meta/callback -> 200
https://codtracker-production.up.railway.app/privacy  -> 404
https://codtracker-production.up.railway.app/terms    -> 404
```

If the Meta Developer Console has Privacy Policy / Terms of Service / Data Deletion URLs registered against `…/privacy` and `…/terms` (a common default), Meta's crawler hits 404 and auto-restricts apps requesting `ads_read`.

**Why the backfill yesterday succeeded but today fails:** Meta's automated checks run periodically. The flag landed between yesterday's onboarding run and today's diagnostic.

---

## Steps to unblock (must be done by the Meta account owner)

The Meta app is owned by the user's client's Facebook account, not the user's. The client needs to:

1. Log in to **Meta Developer Console** → My Apps → app id **`1928008384513562`** (`cod-tracker`).
2. Read the top banner on the App Dashboard — it states the specific restriction reason and any required action.
3. Check the email inbox tied to the app's admin contact for a Meta notification with the same details.
4. **Settings → Basic** in the dashboard — verify and (if needed) update:
   - Privacy Policy URL
   - Terms of Service URL
   - User Data Deletion (URL or callback)
   - App Domains (should contain `codtracker-production.up.railway.app`)
5. Either change those URLs in the dashboard to ones that return 200 (Notion, GitHub Pages, etc.), OR add the matching routes to the Remix app so they resolve. The latter is more durable; ask the user before adding routes.
6. Submit appeal / re-review in the dashboard if one is offered. Some restrictions clear automatically once the crawler re-checks.

---

## Resuming the backfill once access is restored

1. **Verify access** — run any of:
   ```bash
   node scripts/probe-meta-access.mjs
   ```
   `/me` should return the user's Meta profile JSON (not "API access blocked").

2. **Re-run the backfill** — uses pre-flight gating + snapshot:
   ```bash
   node scripts/rerun-meta-backfill.mjs
   # or to target one store explicitly:
   node scripts/rerun-meta-backfill.mjs the-trendy-homes-pk.myshopify.com
   ```
   The script will:
   - Hit `/me` first; abort cleanly if access is still blocked (no writes).
   - Snapshot existing `ad_spend` rows to `scripts/backups/ad_spend_<store>_<UTC-timestamp>.json`.
   - Call the fixed `runMetaHistoricalBackfill`.
   - Print a per-month before/after diff so the deltas are obvious.

3. **Spot-check** — re-run `node scripts/inspect-ad-spend.mjs` and compare to Meta Ads Manager monthly totals for the affected store. Pay special attention to:
   - **Dec 2025**: should now match Ads Manager.
   - **Sep–Nov 2025, plus everything older than chunk 2**: should now match Ads Manager.
   - **Jan / Feb / Mar 2026**: should be unchanged (already accurate).
   - The DB date range should now extend further back than `2025-06-18` if there was real data older than that, because the buggy fetch may have prematurely tripped the empty-chunk stop condition.

---

## Why the re-run is safe to do without further user input

- All 132 existing rows have `source='meta'` (verified via `check-ad-spend-sources.mjs`). No manual entries get clobbered.
- Existing meta rows are **correct** — they're the page-1 days of each chunk with their real spend values. Re-upserting them produces identical numbers.
- Previously-missing days have no row in the DB; the re-run inserts them.
- Upsert is keyed on `(store_id, spend_date)` — never reaches into other stores or other sources.
- The re-run script writes a JSON backup before any DB write, so the previous state is restorable.
- The backfill loop walks until 2 consecutive empty chunks (existing behaviour, kept intact).

The only risk to manage was **non-meta sources existing in `ad_spend`**, and that was eliminated by inspection. If a future store has manual entries, the upsert would still only touch days returned by Meta — but the `source` column on those days would flip to `'meta'`. That's not a current concern but worth noting.

---

## Things to watch for / pitfalls when picking this up

1. **Don't run the re-run script before confirming access is restored.** It pre-flight-gates, but it's still wasteful to spam the API while blocked.
2. **The cron paths (`api.cron.meta-today`, `api.cron.meta-finalize`) are also failing right now**, because they use the same blocked token. Once access is restored, they will recover automatically on their next scheduled run — no manual fix needed. They use `fetchSpend` (single aggregate row), not `fetchDailySpend`, so they were never affected by the pagination bug.
3. **Token expiry is 2026-06-23.** If access takes longer than that to restore, the token will be expired and the merchant will need to re-authenticate via the Settings page (which triggers `getMetaAuthUrl` → fresh OAuth → new long-lived token). The DB row will be replaced.
4. **If Meta forces async report runs for old time ranges**, the response would be `{ "report_run_id": "…" }` with no `data.data` array. The current `fetchDailySpend` would treat that as an empty page and stop. We have not seen this happen here (the existing data shape proves sync mode worked yesterday), but it's the next-most-likely Meta-specific quirk to watch for in older accounts. If it appears, switch to async reports: `POST /{ad_account_id}/insights` → poll the job → `GET /{report_run_id}/insights`.
5. **Timezone seam.** `todayPKT()` builds chunk boundaries in PKT; Meta returns `date_start` in the ad account's timezone. For accounts not configured in PKT, ±1-day mismatches at chunk seams can happen. Not the cause of the current bug. If you find day-boundary off-by-ones after the re-run, this is the next suspect.
6. **Don't push or commit the changes until the user asks.** Branch state at the time of writing: `main`, with `M .claude/settings.local.json` and a handful of untracked files (the new scripts, backups dir).

---

## Files at a glance

```
app/lib/meta.server.js          modified — fetchDailySpend now paginates (limit=500 + paging.next loop)
app/lib/backfill.server.js      modified — runMetaHistoricalBackfill split error-vs-empty handling, retry-once, no last_meta_sync_at on abort

scripts/inspect-ad-spend.mjs            (new, diagnostic)
scripts/probe-meta-chunk3.mjs           (new, diagnostic)
scripts/probe-meta-access.mjs           (new, diagnostic)
scripts/probe-meta-app-status.mjs       (new, diagnostic)
scripts/probe-meta-network.mjs          (new, diagnostic)
scripts/check-ad-spend-sources.mjs      (new, diagnostic)
scripts/rerun-meta-backfill.mjs         (new, the actual re-run with safety gates)
scripts/backups/                        (created on first re-run, holds JSON snapshots)

docs/meta-backfill-fix-and-app-restriction.md   (this file)
```

---

## Affected store / account constants

- store_id: `the-trendy-homes-pk.myshopify.com`
- ad account: `act_1224674772151444`
- Meta App ID: `1928008384513562`
- Token expiry: `2026-06-23T04:13:53Z` (still in date as of writing)
- last_meta_sync_at at time of writing: `2026-04-24T04:13:57Z` (will be re-stamped after a clean re-run)
