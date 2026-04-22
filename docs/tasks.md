# COD Tracker — Implementation Task List
> All tasks derived from docs/claude.md. Complete in order — later tasks depend on earlier ones.

---

## Task 1: Scaffold project & configure infrastructure

**Status:** Pending

1. Run `npx @shopify/create-app@latest` — choose Remix template
2. Install extra packages: `@shopify/shopify-app-session-storage-postgresql`
3. In `shopify.server.js` replace default SQLite/Prisma session storage:
   ```js
   import { shopifyApp } from "@shopify/shopify-app-remix/server";
   import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";

   const shopify = shopifyApp({
     sessionStorage: new PostgreSQLSessionStorage(process.env.SUPABASE_DATABASE_URL),
     // ... other config
   });
   ```
4. Set Shopify API version to `2025-01` in config
5. Set scopes to `read_products,read_orders` in shopify.config.js
6. Add all env vars from example.env to `.env` (local) and Railway dashboard (production):
   - `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES`, `SHOPIFY_APP_URL`
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DATABASE_URL`
   - `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`
   - `POSTEX_API_TOKEN` (local dev/testing only — not used in production)
   - `CRON_SECRET` (generate with `openssl rand -hex 32`)
   - `SESSION_SECRET` (generate with `openssl rand -hex 32`)
   - `NODE_ENV`
7. `SUPABASE_DATABASE_URL` is the direct PostgreSQL connection string from Supabase dashboard — use the connection pooler URL for production, not the REST API URL
8. Create Railway project, link the repo, set all env vars in Railway dashboard
9. In Shopify Partner Dashboard: set app URL = Railway HTTPS URL, add both Railway URL and ngrok URL as allowed redirect URLs
10. Delete Prisma schema and all SQLite references left over from the template — the app must not use SQLite at all on Railway (ephemeral filesystem wipes SQLite on every deploy)
11. Confirm `npm run dev` loads the app embedded in Shopify admin without errors

---

## Task 2: Set up Supabase database — tables, indexes, RLS, RPC functions

**Status:** Pending

Run all SQL below in Supabase SQL editor in order.

### Tables

```sql
CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text UNIQUE NOT NULL,           -- .myshopify.com domain
  postex_token text,
  postex_merchant_id text,
  meta_access_token text,
  meta_ad_account_id text,
  meta_token_expires_at timestamptz,       -- Meta long-lived tokens expire after 60 days
  expenses_amount numeric DEFAULT 0,
  expenses_type text CHECK (expenses_type IN ('monthly', 'per_order')),
  sellable_returns_pct numeric DEFAULT 100,
  onboarding_complete boolean DEFAULT false,
  onboarding_step integer DEFAULT 1,       -- 1=postex, 2=meta, 3=cogs, 4=expenses
  last_postex_sync_at timestamptz,
  last_meta_sync_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  tracking_number text NOT NULL,
  order_ref_number text,                   -- normalized: # stripped, matches Shopify order number
  transaction_status text,                 -- raw status string from PostEx e.g. "Delivered"
  status_code text,                        -- mapped code: '0001'-'0013'
  invoice_payment numeric DEFAULT 0,       -- GROSS amount customer paid, NOT what merchant receives
  transaction_fee numeric DEFAULT 0,
  transaction_tax numeric DEFAULT 0,
  reversal_fee numeric DEFAULT 0,
  reversal_tax numeric DEFAULT 0,
  upfront_payment numeric DEFAULT 0,
  reserve_payment numeric DEFAULT 0,
  balance_payment numeric DEFAULT 0,
  items integer DEFAULT 1,
  invoice_division integer DEFAULT 1,
  city_name text,
  customer_name text,
  customer_phone text,
  delivery_address text,
  order_detail text,
  transaction_notes text,
  pickup_address text,
  return_address text,
  actual_weight numeric,
  booking_weight numeric,
  merchant_name text,
  shopify_order_id text,
  cogs_total numeric DEFAULT 0,            -- SUM(unit_cost × quantity) for all line items
  cogs_matched boolean DEFAULT false,      -- true = matched to Shopify; false = defaulted to 0
  is_delivered boolean DEFAULT false,      -- status_code = '0005'
  is_returned boolean DEFAULT false,       -- status_code IN ('0002','0006','0007')
  is_in_transit boolean DEFAULT true,      -- everything else
  transaction_date timestamptz,            -- order creation date — used for rolling window logic
  order_pickup_date timestamptz,
  order_delivery_date timestamptz,
  upfront_payment_date timestamptz,
  reserve_payment_date timestamptz,
  raw_metadata jsonb,                      -- full PostEx API response stored here
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(store_id, tracking_number)
);

CREATE TABLE product_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  shopify_variant_id text NOT NULL,
  shopify_product_id text NOT NULL,
  sku text,
  product_title text,
  variant_title text,
  unit_cost numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(store_id, shopify_variant_id)
);

CREATE TABLE ad_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  spend_date date NOT NULL,
  amount numeric DEFAULT 0,
  source text DEFAULT 'meta',              -- 'meta' always for now
  meta_campaign_data jsonb,               -- raw Meta API response for future use
  updated_at timestamptz DEFAULT now(),
  UNIQUE(store_id, spend_date)
);

-- NEVER purged. Used for period-over-period % change calculations.
CREATE TABLE daily_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  snapshot_date date NOT NULL,
  total_sales numeric DEFAULT 0,
  total_orders integer DEFAULT 0,
  total_units integer DEFAULT 0,
  total_returns integer DEFAULT 0,
  total_in_transit integer DEFAULT 0,
  total_delivery_cost numeric DEFAULT 0,
  total_cogs numeric DEFAULT 0,
  total_ad_spend numeric DEFAULT 0,
  total_expenses numeric DEFAULT 0,
  gross_profit numeric DEFAULT 0,
  net_profit numeric DEFAULT 0,
  UNIQUE(store_id, snapshot_date)
);
```

### Indexes

```sql
CREATE INDEX idx_orders_store_date   ON orders(store_id, transaction_date);
CREATE INDEX idx_orders_store_flags  ON orders(store_id, is_delivered, is_returned, is_in_transit);
CREATE INDEX idx_orders_ref          ON orders(store_id, order_ref_number);
CREATE INDEX idx_orders_status       ON orders(store_id, status_code);
CREATE INDEX idx_product_costs_variant ON product_costs(store_id, shopify_variant_id);
CREATE INDEX idx_ad_spend_store_date ON ad_spend(store_id, spend_date);
CREATE INDEX idx_snapshots_store_date ON daily_snapshots(store_id, snapshot_date);
```

### RLS Policies

BOTH `USING` and `WITH CHECK` are required on every table:
- `USING` controls SELECT / UPDATE / DELETE (which rows are visible)
- `WITH CHECK` controls INSERT / UPDATE (which rows can be written)
- Missing `WITH CHECK` = inserts silently fail or error under RLS

```sql
ALTER TABLE stores          ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_costs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_spend        ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "store_isolation" ON stores
  USING (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));

CREATE POLICY "store_isolation" ON orders
  USING (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));

CREATE POLICY "store_isolation" ON product_costs
  USING (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));

CREATE POLICY "store_isolation" ON ad_spend
  USING (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));

CREATE POLICY "store_isolation" ON daily_snapshots
  USING (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));
```

### RPC Functions

```sql
-- RLS context setter — called before every Supabase query server-side
CREATE OR REPLACE FUNCTION set_app_store(store text)
RETURNS void AS $$
  SELECT set_config('app.current_store_id', store, true);
$$ LANGUAGE sql;

-- Main dashboard stats for a period
CREATE OR REPLACE FUNCTION get_dashboard_stats(
  p_store_id text,
  p_from_date date,
  p_to_date date,
  p_expenses_amount numeric,
  p_expenses_type text,
  p_days_in_period integer
)
RETURNS TABLE (
  sales numeric, orders bigint, units bigint, returns bigint, in_transit bigint,
  delivery_cost numeric, reversal_cost numeric, cogs numeric,
  ad_spend numeric, expenses numeric, gross_profit numeric, net_profit numeric,
  roas numeric, poas numeric, cac numeric, aov numeric,
  margin_pct numeric, roi_pct numeric, refund_pct numeric
) AS $$
  -- Implement all formulas exactly:
  -- sales          = SUM(invoice_payment) WHERE is_delivered = true
  -- delivery_cost  = SUM(transaction_fee + transaction_tax + reversal_fee + reversal_tax)
  --                  for BOTH delivered AND returned orders
  -- reversal_cost  = SUM(reversal_fee + reversal_tax) for returned orders
  -- cogs           = SUM(cogs_total) WHERE is_delivered = true OR is_returned = true
  -- expenses       = CASE p_expenses_type
  --                    WHEN 'monthly'   THEN p_expenses_amount * (p_days_in_period / 30.0)
  --                    WHEN 'per_order' THEN p_expenses_amount * delivered_order_count
  --                  END
  -- gross_profit   = sales - delivery_cost - cogs
  -- net_profit     = gross_profit - ad_spend - expenses
  -- ad_spend       = SUM(ad_spend.amount) for the date range from ad_spend table
  -- roas           = CASE WHEN ad_spend = 0 THEN NULL ELSE sales / ad_spend END
  -- poas           = CASE WHEN ad_spend = 0 THEN NULL ELSE net_profit / ad_spend END
  -- cac            = CASE WHEN ad_spend = 0 OR orders = 0 THEN NULL ELSE ad_spend / orders END
  -- aov            = CASE WHEN orders = 0 THEN NULL ELSE sales / orders END
  -- margin_pct     = CASE WHEN sales = 0 THEN NULL ELSE (net_profit / sales) * 100 END
  -- roi_pct        = CASE WHEN (cogs+ad_spend+delivery_cost)=0 THEN NULL
  --                        ELSE (net_profit / (cogs+ad_spend+delivery_cost)) * 100 END
  -- refund_pct     = CASE WHEN (orders+returns) = 0 THEN 0
  --                        ELSE (returns / (orders+returns)) * 100 END
  -- NULL return for ratio metrics = show "N/A" in UI (never show 0 for ratio when denominator is 0)
$$ LANGUAGE sql;

-- Period comparison using daily_snapshots (for % change on cards)
CREATE OR REPLACE FUNCTION get_period_comparison(
  p_store_id text,
  p_current_from date,
  p_current_to date,
  p_prior_from date,
  p_prior_to date
)
RETURNS TABLE (
  current_sales numeric, prior_sales numeric, sales_pct_change numeric,
  current_profit numeric, prior_profit numeric, profit_pct_change numeric
) AS $$
  -- Sum daily_snapshots rows for current period and prior period separately
  -- pct_change = ((current - prior) / NULLIF(prior, 0)) * 100
  -- Source is always daily_snapshots — never purged, always available for comparison
$$ LANGUAGE sql;

-- Drill-down paginated orders for a period
CREATE OR REPLACE FUNCTION get_orders_for_period(
  p_store_id text,
  p_from_date date,
  p_to_date date,
  p_status_filter text,  -- 'delivered', 'returned', 'in_transit', 'all'
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  tracking_number text, order_ref_number text, customer_name text,
  city_name text, transaction_date timestamptz, invoice_payment numeric,
  delivery_cost numeric, reversal_cost numeric, cogs_total numeric,
  transaction_status text, items integer, cogs_matched boolean
) AS $$
  -- Filter by transaction_date range and p_status_filter
  -- delivery_cost = transaction_fee + transaction_tax
  -- reversal_cost = reversal_fee + reversal_tax
  -- Apply LIMIT / OFFSET for pagination
$$ LANGUAGE sql;
```

---

## Task 3: Build core server libraries

**Status:** Pending

Create all files in `app/lib/`. These are server-only — never imported in client code. Filename convention `.server.js` prevents accidental client import.

### app/lib/supabase.server.js

```js
import { createClient } from '@supabase/supabase-js';

export async function getSupabaseForStore(shop) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  // Sets RLS context — every query after this is scoped to this store only
  await supabase.rpc('set_app_store', { store: shop });
  return supabase;
}
```

Every Supabase call MUST go through `getSupabaseForStore`. Direct `createClient` without `set_app_store` will bypass RLS and either fail or expose cross-store data.

### app/lib/dates.server.js

All date logic uses PKT (UTC+5). Railway runs in UTC — always convert PKT date boundaries to UTC before passing to Supabase queries. "Today" in PKT: midnight PKT = 19:00 UTC the previous day.

Exports:
- `getTodayPKT()` → `{ start: Date(UTC), end: Date(UTC) }`
- `getYesterdayPKT()` → `{ start, end }`
- `getMTDPKT()` → `{ start: 1st of current month in PKT as UTC, end: now as UTC }`
- `getLastMonthPKT()` → `{ start: 1st of last month, end: last day of last month }`
- `getMTDComparisonPKT()` → `{ start: 1st of last month, end: same day-of-month last month }` — e.g. Apr 1–22 compares against Mar 1–22
- `getDaysInPeriod(startUTC, endUTC)` → integer count of calendar days
- `formatPKTDate(dateUTC)` → `'YYYY-MM-DD'` string in PKT (for PostEx API calls and ad_spend date)

### app/lib/calculations.server.js

Pure functions, no DB calls. All inputs are numbers. Outputs are numbers or `null`. `null` means show "N/A" in UI — never show 0 for a ratio when the denominator is 0.

```js
export function calcExpenses(amount, type, daysInPeriod, deliveredOrders) {
  if (type === 'monthly') return amount * (daysInPeriod / 30);
  if (type === 'per_order') return amount * deliveredOrders;
  return 0;
}
export const calcGrossProfit = (sales, deliveryCost, cogs) => sales - deliveryCost - cogs;
export const calcNetProfit   = (gross, adSpend, expenses) => gross - adSpend - expenses;
export const calcROAS  = (sales, adSpend)      => adSpend === 0 ? null : sales / adSpend;
export const calcPOAS  = (net, adSpend)        => adSpend === 0 ? null : net / adSpend;
export const calcCAC   = (adSpend, orders)     => adSpend === 0 || orders === 0 ? null : adSpend / orders;
export const calcAOV   = (sales, orders)       => orders === 0 ? null : sales / orders;
export const calcMargin = (net, sales)         => sales === 0 ? null : (net / sales) * 100;
export const calcROI   = (net, cogs, ad, del)  => (cogs+ad+del) === 0 ? null : (net/(cogs+ad+del))*100;
export const calcRefundPct = (ret, del)        => (ret+del) === 0 ? 0 : (ret/(ret+del))*100;
export const calcPctChange = (cur, prior)      => prior === 0 ? null : ((cur-prior)/prior)*100;
```

### app/lib/postex.server.js

```
Base URL: https://api.postex.pk/services/integration/api/order/
Auth header: token: <postex_token>   (per-store value from stores table)
```

Verified param names (from live API testing — wrong names return 400):
- `orderStatusId` — camelCase, lowercase 'd'. Value `0` = all statuses.
- `startDate` / `endDate` — NOT `fromDate`/`toDate`

Status code mapping:

| Code | Meaning | Flag |
|------|---------|------|
| 0005 | Delivered | `is_delivered = true` |
| 0002 | Returned | `is_returned = true` |
| 0006 | Returned | `is_returned = true` |
| 0007 | Returned | `is_returned = true` |
| 0001, 0003, 0004, 0008, 0013 | In transit variants | `is_in_transit = true` |

Status code source: last item in `transactionStatusHistory` array → field `transactionStatusMessageCode`.

Fallback (if `transactionStatusHistory` missing or empty):

```js
const STRING_STATUS_MAP = {
  'Delivered':             '0005',
  'Returned':              '0002',
  'Booked':                '0003',
  'Out For Delivery':      '0004',
  'Attempted':             '0013',
  'Delivery Under Review': '0008',
};
// Map from top-level `transactionStatus` string field
```

Exports:
- `fetchOrders(token, startDate, endDate)` → `GET /v1/get-all-order?orderStatusId=0&startDate=...&endDate=...` → returns raw `dist[]` array or throws
- `validateToken(token)` → `GET /v2/get-operational-city` → 200 = valid
- `mapOrder(rawOrder, storeId)` → normalizes one PostEx order to DB shape:
  - Strips `#` from `orderRefNumber`
  - Reads last item of `transactionStatusHistory` for `status_code`; falls back to `STRING_STATUS_MAP` if array is missing or empty
  - Sets `is_delivered`, `is_returned`, `is_in_transit` from `status_code`
  - Stores full raw response in `raw_metadata`

### app/lib/meta.server.js

```
Meta API endpoint:
GET /{ad_account_id}/insights
  ?fields=spend
  &time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
  &level=account
  &access_token={meta_access_token}

Returns: { "data": [{ "spend": "194.97" }] }
```

OAuth uses `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI` from env. Scope: `ads_read`.
Long-lived tokens expire after 60 days. Store expiry as `now + 60 days` in `meta_token_expires_at`.

Exports:
- `getMetaAuthUrl(state)` → OAuth redirect URL
- `exchangeCodeForToken(code)` → `{ access_token, expires_in }`
- `getAdAccounts(access_token)` → list of ad accounts for the user (for dropdown in onboarding)
- `fetchSpend(token, adAccountId, sinceDate, untilDate)` → number (PKR spend for that date range)
- `isTokenExpired(meta_token_expires_at)` → boolean
- `isTokenExpiringSoon(meta_token_expires_at)` → boolean (true if expiry within 7 days)

### app/lib/shopify.server.js

```
Shopify Admin API version: 2025-01
Scopes required: read_products, read_orders
```

Exports:
- `getProductVariants(session)` → `GET /admin/api/2025-01/products.json` with variants → returns flat list: `[{ shopify_variant_id, shopify_product_id, sku, product_title, variant_title }]`
- `getOrderByName(session, orderRefNumber)` → `GET /admin/api/2025-01/orders.json?name={orderRefNumber}&status=any` → returns line items: `[{ variant_id, quantity }]`
- `registerUninstallWebhook(session)` → `POST /admin/api/2025-01/webhooks.json` for `app/uninstalled` topic pointing to `{SHOPIFY_APP_URL}/api/webhooks/uninstall`

---

## Task 4: Build app entry routing logic + store install handler

**Status:** Pending

Two things to implement:

### Store row creation on OAuth callback

In the Shopify auth callback (`auth.$`) or equivalent post-install hook, after Shopify session is created:

```js
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
await supabase.from('stores').upsert({
  store_id: shop,          // .myshopify.com domain from session
  onboarding_complete: false,
  onboarding_step: 1
}, { onConflict: 'store_id', ignoreDuplicates: true });
```

`ignoreDuplicates: true` is critical — reinstalls must NOT overwrite existing PostEx token, Meta credentials, COGS data, or any existing settings. Only creates a row if none exists.

Also call `shopify.server.js registerUninstallWebhook(session)` here.

### app._index loader routing logic

```js
export async function loader({ request }) {
  const { session } = await shopify.authenticate.admin(request);
  const shop = session.shop;
  const supabase = await getSupabaseForStore(shop);

  const { data: store } = await supabase
    .from('stores')
    .select('onboarding_complete, onboarding_step')
    .eq('store_id', shop)
    .single();

  if (!store) {
    // Fallback: should be created on install, but handle gracefully
    return redirect('/app/onboarding/step1-postex');
  }

  if (!store.onboarding_complete) {
    const stepRoutes = {
      1: '/app/onboarding/step1-postex',
      2: '/app/onboarding/step2-meta',
      3: '/app/onboarding/step3-cogs',
      4: '/app/onboarding/step4-expenses',
    };
    return redirect(stepRoutes[store.onboarding_step] ?? '/app/onboarding/step1-postex');
  }

  // Onboarding complete — load and return dashboard data (see Task 7)
}
```

---

## Task 5: Build onboarding wizard — 4 steps

**Status:** Pending

Routes: `app.onboarding.step1-postex`, `step2-meta`, `step3-cogs`, `step4-expenses`
Merchant can navigate back to previous steps freely. `stores.onboarding_step` tracks progress.

### Step 1: PostEx Setup

Route: `app/routes/app.onboarding.step1-postex/`

Fields: PostEx API Token (text input), Merchant ID (text input)

On submit (action):
1. Call `postex.server.js validateToken(token)` → `GET /v2/get-operational-city`
2. If non-200: return error `"Invalid token. Please check your PostEx credentials."` — do NOT advance
3. If 200: upsert `stores` row with `{ postex_token, postex_merchant_id, onboarding_step: 2 }`
4. Trigger historical backfill as fire-and-forget background job (do NOT await):
   - Fetch from Jan 1 of current year to today, chunked by month (see Task 6)
   - Set a flag/mechanism so the dashboard shows "Syncing historical data..." banner until complete
5. Redirect to step 2

### Step 2: Meta Ads Setup (Skippable)

Route: `app/routes/app.onboarding.step2-meta/`

UI: "Connect Meta Ads" button + "Skip for now" link

On "Skip for now":
- Update `stores.onboarding_step = 3`
- `meta_access_token` stays `null` — ad spend shows as 0, ROAS/POAS/CAC show as N/A

On "Connect Meta Ads":
1. Redirect to Meta OAuth URL (`getMetaAuthUrl` from `meta.server.js`)
2. OAuth callback at `META_REDIRECT_URI` returns code
3. Exchange code for token (`exchangeCodeForToken`)
4. Fetch ad accounts (`getAdAccounts`) → show dropdown for merchant to select their account
5. On account selection + save: upsert `stores` with `{ meta_access_token, meta_ad_account_id, meta_token_expires_at: now+60days, onboarding_step: 3 }`
6. Redirect to step 3

Note: Until Meta app is approved, merchants must be pre-added as testers in Meta Developer Console (max 25 testers). The code is identical — no changes needed once Meta approves the app.

### Step 3: COGS Setup

Route: `app/routes/app.onboarding.step3-cogs/`

Loader:
1. Call `shopify.server.js getProductVariants(session)` to get all variants
2. Fetch existing `product_costs` rows for this store
3. Merge: show all Shopify variants, pre-fill `unit_cost` from DB if a row already exists

UI (use `COGSTable` component — see Task 8):
- Table: Product Title | Variant | SKU | Unit Cost (PKR) [editable input]
- Footer: "X of Y variants have costs entered" (count where `unit_cost > 0`)

On "Save & Continue" (action):
1. Bulk upsert ALL rows to `product_costs` — including rows where `unit_cost = 0`
2. Trigger retroactive COGS matching as fire-and-forget background job:
   - Fetch all orders WHERE `cogs_matched = false` for this store
   - For each: call `getOrderByName` → get line items → compute `cogs_total` → update order
   - Without this, historical orders synced before COGS setup will never get matched
3. Update `stores.onboarding_step = 4`
4. Redirect to step 4

### Step 4: Expenses Setup

Route: `app/routes/app.onboarding.step4-expenses/`

Fields:
- Amount (numeric PKR)
- Type: radio — "Per Month" | "Per Order"
- Explanation: "Per Month expenses are prorated across each time period. Per Order expenses multiply by the number of delivered orders."

On "Finish Setup" (action):
1. Upsert `stores` with `{ expenses_amount, expenses_type, onboarding_complete: true, onboarding_step: 4 }`
2. Redirect to `/app` (dashboard)

---

## Task 6: Build background jobs — historical backfill & retroactive COGS matching

**Status:** Pending

### app/lib/backfill.server.js — Historical backfill

Triggered from onboarding Step 1 after PostEx token saved. Must not block UI — fire and forget.

```js
export async function runHistoricalBackfill(storeRow, session) {
  const chunks = getMonthlyChunks('YYYY-01-01', todayPKT);
  // e.g. [{start:'2026-01-01', end:'2026-01-31'}, {start:'2026-02-01', end:'2026-02-28'}, ...]

  for (const chunk of chunks) {
    const rawOrders = await fetchOrders(storeRow.postex_token, chunk.start, chunk.end);
    const mapped = rawOrders.map(o => mapOrder(o, storeRow.store_id));
    await supabase.from('orders').upsert(mapped, { onConflict: 'store_id,tracking_number' });
    // For each upserted order where cogs_matched = false and product_costs exist: matchCOGS
  }
}
```

Chunking is required because a 16-month PostEx call takes 38 seconds (verified by live testing). Monthly chunks take ~2-3 seconds each. Maximum 12 chunks per backfill.

### app/lib/sync.server.js — PostEx sync orchestrator

Used by both the regular cron job and backfill.

```js
export async function syncStore(storeRow, session, supabase) {
  // Regular cron: 30-day rolling window in PKT
  const { start, end } = getLast30DaysPKT();
  const rawOrders = await fetchOrders(storeRow.postex_token, start, end);
  const mapped = rawOrders.map(o => mapOrder(o, storeRow.store_id));

  for (const order of mapped) {
    const { data: existing } = await supabase
      .from('orders').select('is_delivered,is_returned,cogs_matched')
      .eq('tracking_number', order.tracking_number).single();

    await supabase.from('orders').upsert(order, { onConflict: 'store_id,tracking_number' });

    // If status just changed to delivered/returned and COGS not yet matched: match now
    const statusChanged = existing &&
      (order.is_delivered !== existing.is_delivered || order.is_returned !== existing.is_returned);
    if (statusChanged && !existing.cogs_matched) {
      await matchCOGS(supabase, storeRow.store_id, session, order.order_ref_number, order.tracking_number);
    }
  }

  await supabase.from('stores')
    .update({ last_postex_sync_at: new Date() })
    .eq('store_id', storeRow.store_id);
}

export async function matchCOGS(supabase, storeId, session, orderRefNumber, trackingNumber) {
  const lineItems = await getOrderByName(session, orderRefNumber);
  if (!lineItems || lineItems.length === 0) return;

  let cogsTotal = 0;
  let allMatched = true;

  for (const item of lineItems) {
    const { data: cost } = await supabase
      .from('product_costs')
      .select('unit_cost')
      .eq('shopify_variant_id', item.variant_id)
      .single();

    if (cost) {
      cogsTotal += cost.unit_cost * item.quantity;
    } else {
      allMatched = false;
    }
  }

  await supabase.from('orders')
    .update({ cogs_total: cogsTotal, cogs_matched: allMatched })
    .eq('tracking_number', trackingNumber);
}
```

### Retroactive COGS batch (triggered from onboarding Step 3)

```js
export async function retroactiveCOGSMatch(supabase, storeId, session) {
  const { data: unmatched } = await supabase
    .from('orders')
    .select('order_ref_number, tracking_number')
    .eq('cogs_matched', false);

  for (const order of unmatched) {
    await matchCOGS(supabase, storeId, session, order.order_ref_number, order.tracking_number);
  }
  // Run sequentially to avoid Shopify rate limits
  // Fire and forget from onboarding — do not block the save response
}
```

---

## Task 7: Build dashboard UI — 4 KPI cards, detail panel, drill-down table, banners

**Status:** Pending

Route: `app/routes/app._index/`

### Loader

1. Authenticate Shopify session, get `shop` domain
2. Load store row: `expenses_amount`, `expenses_type`, `sellable_returns_pct`, `meta_access_token`, `meta_token_expires_at`, `last_postex_sync_at`
3. Compute PKT date boundaries for all 4 periods
4. For each period call `get_dashboard_stats` RPC — pass PKT boundaries converted to UTC, `expenses_amount`, `expenses_type`, `days_in_period`
5. For Today, Yesterday, MTD: call `get_period_comparison` RPC — do NOT call for Last Month (no comparison data exists)
6. Count orders WHERE `cogs_matched = false` → for warning banner
7. Check meta token expiry → for warning banner
8. Return all as loader data

### app/components/KPICard.jsx

Props: `period` (`'today'|'yesterday'|'mtd'|'lastMonth'`), `stats`, `pctChange` (null for lastMonth), `dateLabel`

Card header colors:
- `today` / `yesterday` → green
- `mtd` / `lastMonth` → teal

Card layout:
```
[Period Name]                [Date or date range]
Sales [±X.X%]                ← % change: green=up, orange=down. OMIT entirely on lastMonth card
PKR X,XXX,XXX

Orders / Units               Returns
XXX / XXX                    XX

Adv. cost                    Blended ROAS
-PKR X,XXX                   X.XX (or N/A)

Net Profit [±X.X%]           Orders
PKR X,XXX                    XXX

                       [More]
```

N/A rules — use the string `"N/A"`, never `0`, when:
- `ROAS`, `POAS`, `CAC` → when `meta_access_token = null` OR `ad_spend = 0`
- `AOV` → when `orders = 0`
- `Margin`, `ROI` → when denominator = 0

"More" button → opens `DetailPanel` for that period

### app/components/DetailPanel.jsx

Polaris Modal or Sheet (slide-in). Props: `period`, `stats`, `open`, `onClose`, `sellableReturnsPct`

Content (in this exact order):
```
[Period Name]
[Date range]                                              [×]

> Sales                                    PKR X,XXX,XXX
> Orders                                             XXX
> Units Sold                                         XXX
> Returns                                             XX
> In Transit                                          XX   ← informational only, no financial impact
> Advertising cost                        -PKR X,XXX,XXX
> Shipping costs                          -PKR X,XXX,XXX   (transaction_fee + transaction_tax)
> Reversal costs                          -PKR X,XXX,XXX   (reversal_fee + reversal_tax)
> Cost of goods                           -PKR X,XXX,XXX
  Expenses                               -PKR X,XXX,XXX
  ─────────────────────────────────────────────────────
  Gross profit                             PKR X,XXX,XXX
  Net profit                               PKR X,XXX,XXX
  ─────────────────────────────────────────────────────
  Average order value                           PKR X,XXX
  Blended ROAS                                       X.XX
  Blended POAS                                       X.XX
  CAC                                           PKR X,XXX
  % Refunds                                         X.XX%
  Sellable returns                                  X.XX%   (from stores.sellable_returns_pct)
  Margin                                            X.XX%
  ROI                                               X.XX%
```

Rows marked `>` are drill-down: clicking opens `DrillDownTable` for that metric's status filter.

### app/components/DrillDownTable.jsx

Props: `period`, `statusFilter` (`'delivered'|'returned'|'in_transit'|'all'`), `open`, `onClose`

Loads data via Remix fetcher calling `get_orders_for_period` RPC. Paginated, 50 rows per page — do NOT load all orders at once.

Columns:

| Column | Source |
|--------|--------|
| Tracking # | `tracking_number` |
| Order Ref | `order_ref_number` |
| Customer | `customer_name` |
| City | `city_name` |
| Date | `transaction_date` |
| Invoice (PKR) | `invoice_payment` |
| Delivery Cost | `transaction_fee + transaction_tax` |
| Reversal Cost | `reversal_fee + reversal_tax` |
| COGS | `cogs_total` |
| Status | `transaction_status` |
| Items | `items` |
| COGS Matched | `cogs_matched` (flag icon) |

### app/components/WarningBanner.jsx

Show above KPI cards. All applicable banners show simultaneously. Priority order:

1. `cogs_matched = false` count > 0: `"X orders have missing COGS. Update your product costs in Settings."`
2. Meta token already expired: `"Meta Ads disconnected — token expired. Reconnect in Settings to restore ad spend data."`
3. Meta token expiring within 7 days: `"Your Meta Ads connection expires on [date]. Reconnect in Settings."`
4. Meta not connected (`meta_access_token = null`): subtle info: `"Connect Meta Ads in Settings to see advertising costs and ROAS."`
5. Backfill in progress: `"Syncing your order history... This may take a few minutes."`

### Empty State

If all 4 periods return zero orders — show instead of cards full of zeros:
- If backfill in progress: `"Your order data is being synced. Check back in a few minutes."`
- If backfill confirmed complete and still no orders: `"No orders found for this period."`

---

## Task 8: Build settings page — PostEx, Meta, COGS, Expenses

**Status:** Pending

Route: `app/routes/app.settings/`

Single page with 4 sections. All settings editable post-onboarding. Warning banners shown persistently above each form (not only on submit).

### Section 1: PostEx Settings

Fields: PostEx API Token (pre-filled), Merchant ID (pre-filled)

Persistent warning above form: `"Changing your PostEx token will trigger a validation check. Your order data will remain unchanged."`

On save (action):
1. Call `validateToken(newToken)` → `GET /v2/get-operational-city`
2. If invalid: return error `"Invalid token. Please check your PostEx credentials."` — do NOT save
3. If valid: update `stores.postex_token` and `stores.postex_merchant_id`

### Section 2: Meta Ads Settings

UI: Show current connection status + token expiry date + "Reconnect Meta Ads" button

Persistent warning: `"You will be redirected to Meta to re-authorize. This is required when your token expires."`

On "Reconnect": full OAuth flow same as onboarding Step 2 (`getMetaAuthUrl` → exchange → `getAdAccounts` → select → save)

On completion: update `meta_access_token`, `meta_ad_account_id`, `meta_token_expires_at` (now + 60 days)

This flow handles both initial reconnection and token renewal after expiry.

### Section 3: COGS Settings

Identical UI to onboarding Step 3 — use the same `COGSTable` component, not a copy.

Persistent warning: `"Updated costs apply to future calculations only. Historical snapshots will not be recalculated."`

On save: bulk upsert `product_costs` (same logic as onboarding Step 3)

Do NOT trigger retroactive COGS matching from settings — only from onboarding Step 3.

### Section 4: Expenses Settings

Fields: Amount (numeric PKR), Type radio (Per Month / Per Order) — pre-filled from `stores` row

Persistent warning: `"Expense changes apply from today. Past snapshots will not be updated."`

On save: update `stores.expenses_amount` and `stores.expenses_type`

### app/components/COGSTable.jsx (shared component)

Used by both onboarding Step 3 and Settings Section 3.

Props: `variants[]`, `existingCosts{}`, `onSave(costsMap)`

Columns: Product Title | Variant | SKU | Unit Cost (PKR) [editable input per row]

Footer: `"X of Y variants have costs entered"` (count where `unit_cost > 0`)

No inline save per row — one bulk "Save" / "Save & Continue" button for all rows at once.

---

## Task 9: Build cron job endpoints — all 5 jobs

**Status:** Pending

All cron routes: POST method only. All protected by `x-cron-secret` header. Return 401 if secret missing or wrong.

Security pattern applied to every cron route:
```js
export async function action({ request }) {
  if (request.headers.get('x-cron-secret') !== process.env.CRON_SECRET)
    return new Response('Unauthorized', { status: 401 });
  // logic here
}
```

### 1. api/cron/postex — PostEx 12-hour sync

File: `app/routes/api.cron.postex/`
Railway cron: `0 1,13 * * *` (UTC) = 6 AM + 6 PM PKT

Logic:
1. Fetch all stores WHERE `postex_token IS NOT NULL`
2. For each store sequentially (parallelize at 50+ stores, max 5 concurrent):
   a. Build 30-day rolling window in PKT: `(today − 30 days) → today`, convert to UTC for API call
   b. Call `sync.server.js syncStore(storeRow, session, supabase)`
   c. Log success or error per store — errors skip that store (do not retry, wait for next scheduled run)
3. Return `{ synced: N, errors: M }` summary

### 2. api/cron/meta-today — Meta 2-hour today sync

File: `app/routes/api.cron.meta-today/`
Railway cron: `0 */2 * * *` (UTC) = every 2 hours

Why 2 hours: Today's Meta spend is a live running number. Merchants check the Today card throughout the day. 2-hour intervals give a reasonably fresh number without excessive API calls.

Logic:
1. Fetch all stores WHERE `meta_access_token IS NOT NULL`
2. Filter out stores where `meta_token_expires_at < now` (skip expired tokens)
3. For each store: call `fetchSpend(token, adAccountId, todayPKT, todayPKT)`
4. Upsert `ad_spend`: `{ store_id, spend_date: todayPKT, amount, source: 'meta' }` — overwrites today's previous entry
5. Update `stores.last_meta_sync_at`

### 3. api/cron/meta-finalize — Meta yesterday finalize

File: `app/routes/api.cron.meta-finalize/`
Railway cron: `0 21 * * *` (UTC) = 2 AM PKT

Why 2 AM: Meta finalizes previous day spend after midnight. 2 AM PKT gives buffer for Meta's processing.

Logic:
1. Same store loop as meta-today
2. Date = yesterday in PKT
3. Upsert `ad_spend` for yesterday — this is the authoritative final number, overwrites any partial number stored during the day by the 2-hourly job

### 4. api/cron/snapshot — Daily snapshot

File: `app/routes/api.cron.snapshot/`
Railway cron: `55 18 * * *` (UTC) = 11:55 PM PKT

Logic:
1. Fetch all stores
2. For each store: call `get_dashboard_stats` RPC for today's date range (PKT)
3. Upsert ONE row to `daily_snapshots` for today:
   `{ store_id, snapshot_date: todayPKT, total_sales, total_orders, total_units, total_returns, total_in_transit, total_delivery_cost, total_cogs, total_ad_spend, total_expenses, gross_profit, net_profit }`
4. These snapshots are NEVER deleted — they power % change calculations forever

### 5. api/cron/purge — Monthly purge

File: `app/routes/api.cron.purge/`
Railway cron: `1 19 1 * *` (UTC) = 1st of month 12:01 AM PKT

Logic:
1. Calculate cutoff: first day of last month in PKT
   Example: running on May 1 → cutoff = April 1 → delete everything before April 1
2. `DELETE FROM orders WHERE transaction_date < cutoff`
3. Do NOT touch: `daily_snapshots`, `ad_spend`, `product_costs`, `stores`
4. `ON DELETE CASCADE` is NOT used here — this is a targeted date-range delete from `orders` only

### Railway cron configuration

In Railway dashboard, create 5 cron jobs:

| Job | Cron (UTC) | HTTP target | Header |
|-----|------------|-------------|--------|
| PostEx sync | `0 1,13 * * *` | `POST {APP_URL}/api/cron/postex` | `x-cron-secret: {CRON_SECRET}` |
| Meta today | `0 */2 * * *` | `POST {APP_URL}/api/cron/meta-today` | `x-cron-secret: {CRON_SECRET}` |
| Meta finalize | `0 21 * * *` | `POST {APP_URL}/api/cron/meta-finalize` | `x-cron-secret: {CRON_SECRET}` |
| Daily snapshot | `55 18 * * *` | `POST {APP_URL}/api/cron/snapshot` | `x-cron-secret: {CRON_SECRET}` |
| Monthly purge | `1 19 1 * *` | `POST {APP_URL}/api/cron/purge` | `x-cron-secret: {CRON_SECRET}` |

---

## Task 10: Build uninstall webhook handler

**Status:** Pending

File: `app/routes/api.webhooks.uninstall/`

Handles Shopify `app/uninstalled` webhook. Shopify signs all webhooks with `SHOPIFY_API_SECRET` — verify HMAC signature using the built-in Shopify Remix webhook verification.

On receipt:
1. Verify HMAC signature (reject with 401 if invalid)
2. Extract `shop` domain from webhook payload
3. Delete the `stores` row:
   ```js
   const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
   await supabase.from('stores').delete().eq('store_id', shop);
   ```
4. `ON DELETE CASCADE` on all child tables handles the rest automatically — `orders`, `product_costs`, `ad_spend`, `daily_snapshots` all deleted via cascade
5. Return 200 immediately — Shopify retries the webhook if it does not receive 200 within 5 seconds

Do NOT use `getSupabaseForStore` here — no RLS context needed for a delete-by-store-id operation. Use the service role client directly.

### Registration

- Register `app/uninstalled` webhook in the auth/install callback (Task 4)
- Topic constant: `APP_UNINSTALLED`
- Address: `{SHOPIFY_APP_URL}/api/webhooks/uninstall`
- Use the Shopify Remix template's built-in webhook handling pattern
