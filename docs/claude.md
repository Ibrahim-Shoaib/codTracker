# COD Tracker — Shopify App Build Guide
> This document is written for future Claude instances. Read every section before writing any code. All decisions in this document are final unless the user explicitly changes them.

---

## Project Overview
A Shopify-embedded COD analytics dashboard that reconciles Shopify orders with PostEx logistics data. It calculates real net profit by accounting for delivery costs, COGS, ad spend, and expenses. Built for Pakistani COD merchants. **PKR only. No currency conversion. Ever.**

---

## Tech Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Framework | Remix (Shopify App Template) | Official Shopify template, App Bridge native |
| UI | Shopify Polaris + App Bridge | Native Shopify embedded look and feel |
| Database | Supabase (PostgreSQL) | RLS, SQL aggregations via RPC, free tier |
| Hosting | Railway | Public HTTPS URL required for Shopify OAuth on real stores |
| Auth | Shopify OAuth | `.myshopify.com` domain = `store_id` everywhere |
| Cron | Railway cron jobs | PostEx sync can take 30s+, Supabase Edge Functions have CPU limits |

---

## Architecture Decisions

### Multi-tenancy
- Single-table approach: every table has a `store_id` column = merchant's `.myshopify.com` domain
- Row Level Security (RLS) enabled on ALL tables
- RLS policy on every table: `store_id = current_setting('app.current_store_id', true)`
- The server sets this config before every Supabase query using the Shopify session shop domain

### How to Set store_id on Every Supabase Request (Critical)
Every server-side Supabase call must set the store context first:
```js
// lib/supabase.server.js
export async function getSupabaseForStore(shop) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  // Set RLS context — this makes RLS policies work
  await supabase.rpc('set_app_store', { store: shop });
  return supabase;
}
```
```sql
-- Supabase function to set the config
CREATE OR REPLACE FUNCTION set_app_store(store text)
RETURNS void AS $$
  SELECT set_config('app.current_store_id', store, true);
$$ LANGUAGE sql;
```

### Database: Rolling Window
- Keep only: **current month (MTD) + last full month**
- Purge anything older than the 1st of last month
- Purge runs via Railway cron on the 1st of every month at 12:01 AM PKT
- `daily_snapshots` are NEVER purged — required for % change calculations
- `ad_spend` is NEVER purged — keep for historical ROAS reference

### Timezone
- **All date calculations use PKT (UTC+5)**
- This app is Pakistan-only — PKT is hardcoded, never user-configurable
- Railway server runs in UTC — always convert date boundaries to UTC when querying Supabase
- "Today" = current date in PKT. Midnight in PKT = 19:00 UTC previous day

### Environment Strategy
- One Shopify app registration with multiple redirect URLs (ngrok for local dev + Railway URL for production)
- Per-store credentials (PostEx token, Meta tokens) stored in `stores` table in Supabase — NOT in `.env`
- App-level credentials (Shopify keys, Supabase keys, Meta App credentials) go in `.env`

### Shopify Session Storage (Critical for Production)
The Shopify Remix template uses SQLite + Prisma by default for session storage. **This breaks on Railway** because Railway has an ephemeral filesystem — SQLite data is wiped on every deploy.

Must replace default session storage with a custom PostgreSQL adapter using Supabase:
```js
// shopify.server.js — configure custom session storage
import { shopifyApp } from "@shopify/shopify-app-remix/server";
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";

const shopify = shopifyApp({
  sessionStorage: new PostgreSQLSessionStorage(process.env.SUPABASE_DATABASE_URL),
  // ... other config
});
```
Add `SUPABASE_DATABASE_URL` to `.env` — this is the direct PostgreSQL connection string from Supabase dashboard (not the REST API URL). Use the connection pooler URL for production.

### App Entry Routing Logic
On every load of `app._index`, the server must:
1. Get the Shopify session shop domain
2. Check if a `stores` row exists for this `store_id`
   - If no row: create one with just `store_id`, redirect to `/app/onboarding/step1-postex`
   - If row exists but `onboarding_complete = false`: redirect to the correct step based on `onboarding_step`
   - If `onboarding_complete = true`: render the dashboard

### Store Row Creation on Install
When a merchant installs the app (Shopify OAuth callback completes), immediately create a `stores` row:
```js
await supabase.from('stores').upsert({
  store_id: shop,  // .myshopify.com domain
  onboarding_complete: false,
  onboarding_step: 1
}, { onConflict: 'store_id', ignoreDuplicates: true });
```
Use `ignoreDuplicates: true` so reinstalls don't overwrite existing config.

---

## Database Schema

### `stores` table
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
  last_postex_sync_at timestamptz,         -- track when last sync ran
  last_meta_sync_at timestamptz,
  created_at timestamptz DEFAULT now()
);
```

### `orders` table
```sql
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id text NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,

  -- PostEx core fields
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

  -- Shopify matched fields
  shopify_order_id text,
  cogs_total numeric DEFAULT 0,            -- SUM(unit_cost × quantity) for all line items
  cogs_matched boolean DEFAULT false,      -- true = successfully matched to Shopify, false = defaulted to 0

  -- Status flags (derived from status_code, set on every upsert)
  is_delivered boolean DEFAULT false,      -- status_code = '0005'
  is_returned boolean DEFAULT false,       -- status_code IN ('0002','0006','0007')
  is_in_transit boolean DEFAULT true,      -- everything else

  -- Dates
  transaction_date timestamptz,            -- order creation date — used for rolling window logic
  order_pickup_date timestamptz,
  order_delivery_date timestamptz,
  upfront_payment_date timestamptz,
  reserve_payment_date timestamptz,

  -- Future-proofing
  raw_metadata jsonb,                      -- full PostEx API response stored here

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  UNIQUE(store_id, tracking_number)
);

-- Critical indexes for query performance
CREATE INDEX idx_orders_store_date ON orders(store_id, transaction_date);
CREATE INDEX idx_orders_store_flags ON orders(store_id, is_delivered, is_returned, is_in_transit);
CREATE INDEX idx_orders_ref ON orders(store_id, order_ref_number);
CREATE INDEX idx_orders_status ON orders(store_id, status_code);
```

### `product_costs` table
```sql
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

CREATE INDEX idx_product_costs_variant ON product_costs(store_id, shopify_variant_id);
```

### `ad_spend` table
```sql
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

CREATE INDEX idx_ad_spend_store_date ON ad_spend(store_id, spend_date);
```

### `daily_snapshots` table
```sql
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

CREATE INDEX idx_snapshots_store_date ON daily_snapshots(store_id, snapshot_date);
```

### RLS Policies (apply to all tables)
```sql
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_snapshots ENABLE ROW LEVEL SECURITY;

-- BOTH USING and WITH CHECK are required:
-- USING controls SELECT/UPDATE/DELETE (which rows are visible)
-- WITH CHECK controls INSERT/UPDATE (which rows can be written)
-- Missing WITH CHECK = inserts will silently fail or error under RLS

CREATE POLICY "store_isolation" ON orders
  USING (store_id = current_setting('app.current_store_id', true))
  WITH CHECK (store_id = current_setting('app.current_store_id', true));

CREATE POLICY "store_isolation" ON stores
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

---

## Financial Calculations (Source of Truth)

All values in PKR. No conversion. No other currency.

```
Sales              = SUM(invoice_payment) WHERE is_delivered = true
Delivery Cost      = SUM(transaction_fee + transaction_tax + reversal_fee + reversal_tax)
                     applies to BOTH delivered AND returned orders
COGS               = SUM(cogs_total) WHERE is_delivered = true OR is_returned = true
                     product left warehouse regardless of outcome
Ad Spend           = SUM(ad_spend.amount) for the period
                     = 0 if merchant has not connected Meta
Expenses           = IF per_month: expenses_amount × (days_in_period / 30)
                     IF per_order: expenses_amount × delivered_order_count

Gross Profit       = Sales - Delivery Cost - COGS
Net Profit         = Gross Profit - Ad Spend - Expenses

Blended ROAS       = Sales / Ad Spend           → "N/A" if Ad Spend = 0
Blended POAS       = Net Profit / Ad Spend      → "N/A" if Ad Spend = 0
CAC                = Ad Spend / Orders          → "N/A" if Ad Spend = 0 or Orders = 0
Average Order Value = Sales / Orders            → "N/A" if Orders = 0
Margin%            = (Net Profit / Sales) × 100 → "N/A" if Sales = 0
ROI%               = (Net Profit / (COGS + Ad Spend + Delivery Cost)) × 100
                     → "N/A" if denominator = 0
% Refunds          = (Returns / (Delivered + Returns)) × 100 → 0 if no orders
Sellable Returns%  = merchant-configured setting in stores table (default 100%)
```

### Division by Zero Rule
**Never show 0 for a ratio metric when the denominator is 0. Always show "N/A".** Showing 0 ROAS when there is no ad spend is misleading — it implies the merchant spent money and got nothing back.

### Order Counting Rules
- **Sales**: Delivered orders only (`is_delivered = true`)
- **Orders count**: Delivered orders only
- **Units Sold**: SUM(items) WHERE is_delivered = true
- **Returns**: COUNT WHERE is_returned = true
- **In-transit**: COUNT WHERE is_in_transit = true — shown as informational count only, zero financial impact
- **Returned orders**: `invoice_payment` excluded from Sales, `reversal_fee + reversal_tax` included in Delivery Cost, `cogs_total` included in COGS
- **invoicePayment is GROSS** — it is what the customer paid, NOT what PostEx remits to the merchant

---

## % Change Logic (Per Card)

| Card | Current Period | Compared Against | Show % Change? |
|------|---------------|-----------------|----------------|
| Today | Today (PKT) | Yesterday | Yes |
| Yesterday | Yesterday | Day before yesterday | Yes |
| MTD | 1st of month → today | Same day-range last month (e.g. Apr 1-22 vs Mar 1-22) | Yes |
| Last Month | Full last month | No comparison | **NO — never show % change on Last Month card** |

**Why no % change on Last Month:** The month before last month falls outside the rolling database window and was never stored. There is no data to compare against. Do not show a % change, do not show a dash, simply omit the % change element entirely from the Last Month card.

**% change source:** Always calculated from `daily_snapshots` table (never purged). Sum snapshot rows for the comparison period and compare.

**% change color:**
- Green = improvement (sales up, profit up)
- Orange = decline (sales down, profit down)

---

## PostEx API Integration

### Base URL
`https://api.postex.pk/services/integration/api/order/`

### Auth
Header: `token: <postex_token>` — per-store token stored in `stores` table

### Key Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `v1/get-all-order` | GET | Main order sync |
| `v2/get-operational-city` | GET | Token validation during onboarding |
| `v1/track-order/{trackingNumber}` | GET | Single order lookup if needed |

### List Orders — Correct Param Names (verified by live testing)
```
GET /v1/get-all-order?orderStatusId=0&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
Header: token: <value>
```
- `orderStatusId` — camelCase, lowercase 'd'. Value `0` = all statuses.
- `startDate` / `endDate` — not `fromDate`/`toDate`. Verified from actual 400 error responses.
- Returns JSON with `statusCode`, `statusMessage`, `dist` array of orders.

### Status Code Mapping

| Code | Meaning | DB Flag |
|------|---------|---------|
| 0001 | At Merchant's Warehouse | is_in_transit |
| 0002 | Returned | is_returned |
| 0003 | At PostEx Warehouse | is_in_transit |
| 0004 | Package on Route | is_in_transit |
| 0005 | **Delivered** | **is_delivered** |
| 0006 | Returned | is_returned |
| 0007 | Returned | is_returned |
| 0008 | Delivery Under Review | is_in_transit |
| 0013 | Attempt Made | is_in_transit |

Status code comes from `transactionStatusHistory` array — use the **last item** in the array (most recent event). Use its `transactionStatusMessageCode` to set `status_code`.

The top-level `transactionStatus` field is a human-readable string (e.g. "Delivered", "Booked") — store it as `transaction_status` for display purposes only.

**Fallback:** If `transactionStatusHistory` is missing or empty, map `status_code` from the `transactionStatus` string:
```js
const statusStringMap = {
  'Delivered': '0005',
  'Returned': '0002',
  'Booked': '0003',
  'Out For Delivery': '0004',
  'Attempted': '0013',
  'Delivery Under Review': '0008',
};
```

### Performance (from live testing on real store data)

| Date Range | Orders | Time to First Byte | Total Time | Size |
|------------|--------|--------------------|------------|------|
| 3 weeks | 6 | <1s | <1s | ~7 KB |
| 4 months | 768 | 8.59s | 9.19s | 703 KB |
| 16 months | ~5,800 | 37.27s | 38.28s | 5.3 MB |

Bottleneck is entirely server-side at PostEx. The 30-day sync window = approximately 2-3 seconds per store.

### Order Ref Number Normalization
PostEx `orderRefNumber` arrives as `#9271` or `9271` — inconsistent. Always strip `#` before storing and before matching to Shopify. Stored as `order_ref_number` in DB without `#`.

### Error Handling for PostEx Sync
- If PostEx returns non-200: log the error, skip that store, continue to next store
- Do not retry immediately — wait for next scheduled sync
- Update `last_postex_sync_at` only on success

---

## Shopify Integration

### Scopes Required
```
read_products, read_orders
```

### Admin API Usage
- Fetch all product variants + SKUs → COGS setup table
- Fetch order by order number → get line items for COGS matching
- Register `app/uninstalled` webhook → data deletion on uninstall

### COGS Matching Flow
1. Take `order_ref_number` from PostEx (already normalized, no `#`)
2. Query Shopify Admin API: `GET /admin/api/2025-01/orders.json?name={order_ref_number}&status=any`
3. Get line items → each has `variant_id` + `quantity`
4. Look up `product_costs` by `(store_id, shopify_variant_id)`
5. `cogs_total = SUM(unit_cost × quantity)` across all line items
6. Set `cogs_matched = true` if all variants found in `product_costs`, `false` if any variant is missing
7. Orders with `cogs_matched = false` are flagged on dashboard: "X orders have missing COGS"

### Retroactive COGS Matching (after onboarding Step 3)
When merchant completes the COGS setup step and saves their product costs, immediately trigger a batch retroactive match on all existing orders where `cogs_matched = false`. This runs as a background job after the COGS save completes. Without this, historical orders synced before COGS was set up will never get matched.

### Uninstall Webhook
- Register `app/uninstalled` topic during app installation
- On receipt: delete ALL rows for that `store_id` from every table
- Cascade deletes handle this automatically via `ON DELETE CASCADE` foreign keys on `stores` table
- Just delete the row from `stores` and everything else cascades

---

## Meta Ads Integration

### Current State (Unverified Meta App)
- Merchants must be added manually as testers in Meta Developer Console (max 25 testers)
- Standard Meta OAuth flow works normally for whitelisted testers
- No code difference — same OAuth flow, same API calls
- Once Meta approves the app: tester requirement removed, no code changes needed

### Meta OAuth Scopes Required
```
ads_read
```

### Meta API Endpoint for Spend Data
```
GET /{ad_account_id}/insights
  ?fields=spend
  &time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
  &level=account
  &access_token={meta_access_token}
```
Returns: `{ "data": [{ "spend": "194.97" }] }`

### Token Expiry Handling
- Meta long-lived tokens expire after **60 days**
- Store expiry in `stores.meta_token_expires_at`
- Before every Meta sync: check if token expires within 7 days → if yes, show warning banner on dashboard: "Your Meta Ads connection expires soon. Go to Settings to reconnect."
- If token is already expired: skip Meta sync for that store, show error banner on dashboard
- Merchant reconnects via Settings page → new token replaces old one, new expiry stored

### Meta Skipped / Not Connected
- Meta step is optional during onboarding — merchant can skip
- If skipped: `meta_access_token = null`, `meta_ad_account_id = null`
- Ad Spend = 0 for all periods
- ROAS, POAS, CAC all show "N/A" on dashboard
- Show a subtle "Connect Meta Ads" prompt on dashboard for merchants who skipped

---

## Cron Jobs (Railway)

All times PKT (UTC+5). All endpoints protected by `x-cron-secret` header.

### Schedule Overview

| Job | Schedule (PKT) | Railway Cron Expression (UTC) | Endpoint |
|-----|---------------|-------------------------------|----------|
| PostEx sync | 6 AM + 6 PM | `0 1,13 * * *` | `POST /api/cron/postex` |
| Meta today sync | Every 2 hours | `0 */2 * * *` | `POST /api/cron/meta-today` |
| Meta yesterday finalize | 2 AM | `0 21 * * *` | `POST /api/cron/meta-finalize` |
| Daily snapshot | 11:55 PM | `55 18 * * *` | `POST /api/cron/snapshot` |
| Monthly purge | 1st of month 12:01 AM | `1 19 1 * *` | `POST /api/cron/purge` |

### Cron Endpoint Security Pattern (apply to every cron route)
```js
export async function action({ request }) {
  const secret = request.headers.get('x-cron-secret');
  if (secret !== process.env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }
  // sync logic here
}
```

### 1. PostEx Sync — 6 AM + 6 PM PKT

**Why 12-hour interval:** Pakistani delivery statuses update slowly. Two syncs per day covers morning and evening status changes without hammering PostEx.

**What it does:**
- Fetch all stores from `stores` table where `postex_token IS NOT NULL`
- For each store sequentially:
  - Call `/v1/get-all-order` with **30-day rolling window** (today-30 → today) in PKT dates
  - Upsert every order by `(store_id, tracking_number)`
  - On each upsert: recompute `is_delivered`, `is_returned`, `is_in_transit` from `status_code`
  - If an order's status changed TO delivered or returned AND `cogs_matched = false`: trigger COGS matching against Shopify
  - Update `stores.last_postex_sync_at` on success
- Run stores sequentially. At 50+ stores consider parallelizing with max 5 concurrent.

**Historical backfill (first install only):**
- Triggered immediately when merchant saves PostEx token in onboarding Step 1
- Fetch from January 1st of current year to today
- Chunk into monthly requests (12 API calls max) run sequentially
- Run as background job — do not block the onboarding UI
- Show a "Syncing historical data..." banner on dashboard until complete

### 2. Meta Today Sync — Every 2 Hours

**Why 2 hours:** Today's Meta spend is a live running number. Merchants check the Today card throughout the day. 2-hour intervals give a reasonably fresh number without excessive API calls.

**What it does:**
- Fetch all stores where `meta_access_token IS NOT NULL` and token is not expired
- For each store: call Meta API for **today's date only**
- Upsert `ad_spend` for `spend_date = today` — overwrites previous today entry
- Small payload: one number per store

**Note:** Today's number is preliminary. The Meta Yesterday Finalize job locks in the final number.

### 3. Meta Yesterday Finalize — 2 AM PKT

**Why 2 AM:** Meta finalizes previous day spend after midnight. 2 AM PKT gives buffer for Meta's processing.

**What it does:**
- For each connected store: call Meta API for **yesterday's date**
- Upsert `ad_spend` for yesterday — this is the authoritative final number
- Overwrites whatever partial number the 2-hourly job stored during that day

### 4. Daily Snapshot — 11:55 PM PKT

**What it does:**
- For each store: aggregate today's orders from `orders` table
- Write one row to `daily_snapshots` for today's date
- Include: sales, orders, units, returns, in_transit, delivery_cost, cogs, ad_spend, expenses, gross_profit, net_profit
- These snapshots power the % change calculations on dashboard cards
- **Never deleted**

### 5. Monthly Purge — 1st of Month 12:01 AM PKT

**What it does:**
- Delete from `orders` WHERE `transaction_date < first day of last month`
- Example: On May 1st, delete everything before April 1st
- `ON DELETE CASCADE` is NOT used here — only deleting specific date range from `orders`
- Never touches: `daily_snapshots`, `ad_spend`, `product_costs`, `stores`

---

## Onboarding Wizard (4 Steps)

Merchant is redirected to onboarding on first install. `stores.onboarding_step` tracks progress. Merchant can navigate back to previous steps freely.

### Step 1: PostEx Setup
- Fields: PostEx API Token, Merchant ID
- On save: hit `GET /v2/get-operational-city` with the token
  - 200 response = valid → save to `stores`, advance to step 2, trigger background historical backfill
  - Non-200 = show error "Invalid token. Please check your PostEx credentials."

### Step 2: Meta Ads Setup (Skippable)
- "Connect Meta Ads" button → Meta OAuth flow
- Merchant must be pre-added as tester (until Meta app approved)
- On success: save `meta_access_token`, `meta_ad_account_id`, `meta_token_expires_at` (now + 60 days)
- Show dropdown of available ad accounts for merchant to select
- "Skip for now" link → advance to step 3 with `meta_access_token = null`

### Step 3: COGS Setup
- Fetch all product variants from Shopify Admin API
- Display table: Product Title | Variant | SKU | Unit Cost (PKR) input
- Merchant enters cost per SKU
- "Save & Continue" → bulk upsert to `product_costs` table
- Variants with no cost entered are saved with `unit_cost = 0`
- Show count: "X of Y variants have costs entered"

### Step 4: Expenses Setup
- Field: Monthly/Per-Order expense amount in PKR
- Radio: "Per Month" or "Per Order"
- Explanation shown: "Per Month expenses are prorated across each time period. Per Order expenses multiply by the number of delivered orders."
- Save to `stores.expenses_amount` and `stores.expenses_type`
- "Finish Setup" → set `onboarding_complete = true`, redirect to dashboard

---

## Settings Page

All settings are editable post-onboarding. Show a warning banner before saving changes.

### PostEx Settings
- Edit: Token, Merchant ID
- Warning on save: "Changing your PostEx token will trigger a validation check. Your order data will remain unchanged."
- On save: re-validate token via Operational Cities API. If invalid, reject and show error. If valid, save.

### Meta Ads Settings
- Edit: Reconnect Meta account (full OAuth flow again)
- Warning on save: "You will be redirected to Meta to re-authorize. This is required when your token expires."
- Use this flow for both initial connect and token renewal
- Useful path: token expired → merchant comes here → re-authorizes → new token + new expiry saved

### COGS Settings
- Full editable table: same UI as onboarding Step 3
- Warning on save: "Updated costs apply to future calculations only. Historical snapshots will not be recalculated."
- Merchants change suppliers and prices frequently — this should be easy to access

### Expenses Settings
- Edit: Amount and type
- Warning on save: "Expense changes apply from today. Past snapshots will not be updated."

---

## Dashboard UI

Reference images: `docs/img/img0.png` (main cards) and `docs/img/img1.png` (detail panel).

### Main View — 4 KPI Cards

Layout: 4 horizontal cards — Today | Yesterday | MTD | Last Month

**Card header colors:**
- Today: Green
- Yesterday: Green  
- MTD: Teal
- Last Month: Teal/Blue

**Each card contains:**
```
[Period Name]          [Date or date range]
Sales [±X.X%]
PKR X,XXX,XXX

Orders / Units         Returns
XXX / XXX              XX

Adv. cost              Blended ROAS
-PKR X,XXX             X.XX

Net Profit [±X.X%]     Orders
PKR X,XXX              XXX

                [More]
```

- % change shown on Sales and Net Profit — colored orange (down) or green (up)
- **Last Month card: NO % change shown on any metric** — no prior data exists
- "More" link at bottom of every card → opens Detail Panel for that period
- ROAS, POAS, CAC show "N/A" when Meta not connected or Ad Spend = 0

### Detail Panel — Triggered by "More"

Slide-in panel (Polaris Modal or Sheet) showing full breakdown for the selected period:

```
[Period Name]
[Date range]                              [×]

> Sales                        PKR X,XXX,XXX
> Orders                                  XXX
> Units Sold                              XXX
> Returns                                  XX
> In Transit                               XX   (informational only)
> Advertising cost            -PKR X,XXX,XXX
> Shipping costs              -PKR X,XXX,XXX   (transaction_fee + transaction_tax)
> Reversal costs              -PKR X,XXX,XXX   (reversal_fee + reversal_tax)
> Cost of goods               -PKR X,XXX,XXX
  Expenses                   -PKR X,XXX,XXX
  ─────────────────────────────────────────
  Gross profit                 PKR X,XXX,XXX
  Net profit                   PKR X,XXX,XXX
  ─────────────────────────────────────────
  Average order value          PKR X,XXX
  Blended ROAS                 X.XX
  Blended POAS                 X.XX
  CAC                          PKR X,XXX
  % Refunds                    X.XX%
  Sellable returns             X.XX%
  Margin                       X.XX%
  ROI                          X.XX%
```

**The `>` rows are drill-down.** Clicking opens a table of the individual orders contributing to that number.

### Drill-Down Order Table Columns

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
| COGS Matched | `cogs_matched` (flag) |

Paginate drill-down table — do not load all orders at once.

### Dashboard Warning Banners (shown above cards)
- `cogs_matched = false` orders exist: "X orders have missing COGS. Update your product costs in Settings."
- Meta token expiring within 7 days: "Your Meta Ads connection expires on [date]. Reconnect in Settings."
- Meta token expired: "Meta Ads disconnected — token expired. Reconnect in Settings to restore ad spend data."
- Meta not connected: subtle prompt "Connect Meta Ads in Settings to see advertising costs and ROAS."
- Historical backfill in progress: "Syncing your order history... This may take a few minutes."

### Empty State (New Merchant, No Orders Yet)
If the dashboard loads and there are zero orders in the DB (e.g. backfill still in progress or merchant has no PostEx orders yet), show a friendly empty state instead of cards full of zeros:
- "Your order data is being synced. Check back in a few minutes."
- If backfill is confirmed complete and still no orders: "No orders found for this period."

---

## Supabase RPC Functions

All dashboard aggregations done via RPC — never fetch raw order rows to the frontend.

```sql
-- 1. Main dashboard stats for a period
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
);

-- 2. Period comparison using daily_snapshots (for % change)
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
);

-- 3. Drill-down orders for a period (paginated)
CREATE OR REPLACE FUNCTION get_orders_for_period(
  p_store_id text,
  p_from_date date,
  p_to_date date,
  p_status_filter text,  -- 'delivered', 'returned', 'in_transit', 'all'
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE ( -- all order columns needed for drill-down table );
```

---

## Project File Structure (Remix)

```
app/
  routes/
    auth.$/                         # Shopify OAuth callback
    app._index/                     # Dashboard main view
    app.onboarding/                 # Wizard shell + step routing
    app.onboarding.step1-postex/    # PostEx token setup
    app.onboarding.step2-meta/      # Meta OAuth (skippable)
    app.onboarding.step3-cogs/      # COGS input table
    app.onboarding.step4-expenses/  # Expenses setup
    app.settings/                   # Settings page (all 4 sections)
    api.cron.postex/                # PostEx 12-hour sync
    api.cron.meta-today/            # Meta 2-hour today sync
    api.cron.meta-finalize/         # Meta 2 AM finalize
    api.cron.snapshot/              # 11:55 PM daily snapshot
    api.cron.purge/                 # Monthly purge
    api.webhooks.uninstall/         # Shopify app/uninstalled webhook
  components/
    KPICard.jsx                     # Dashboard card (Today/Yesterday/MTD/Last Month)
    DetailPanel.jsx                 # "More" slide-in panel
    DrillDownTable.jsx              # Paginated order table inside detail panel
    COGSTable.jsx                   # Product cost input table (onboarding + settings)
    WarningBanner.jsx               # Dashboard warning banners
  lib/
    postex.server.js                # PostEx API client + upsert logic
    shopify.server.js               # Shopify Admin API client
    meta.server.js                  # Meta Marketing API client
    supabase.server.js              # Supabase client with store_id RLS helper
    sync.server.js                  # Orchestrates PostEx sync + COGS matching
    backfill.server.js              # Historical backfill (chunked by month)
    calculations.server.js          # Financial formula functions
    dates.server.js                 # PKT date helpers, period boundary calculations
```

---

## Key Business Rules (Never Break)

1. **Sales = Delivered orders only** — `is_delivered = true`
2. **COGS applies to Delivered AND Returned** — product left the warehouse
3. **Returned orders**: `invoice_payment` excluded from Sales; reversal costs included in Delivery Cost
4. **In-transit orders**: informational count only — zero impact on any financial figure
5. **invoicePayment is GROSS** — the customer paid this; PostEx deducts fees before remitting
6. **Strip `#` from orderRefNumber** before storing and before Shopify matching
7. **All aggregations via Supabase RPC** — never pull raw order rows to the frontend for calculation
8. **store_id = .myshopify.com domain** — set via `set_app_store()` RPC before every Supabase query
9. **daily_snapshots are never purged** — % change calculations depend on them
10. **ad_spend rows are never purged** — historical ROAS reference
11. **Currency is PKR only** — no conversion, no other currency display, ever
12. **Division by zero = N/A** — never show 0 for ratio metrics when denominator is 0
13. **Last Month card has no % change** — prior month data does not exist in rolling DB
14. **All date logic uses PKT (UTC+5)** — convert to UTC when querying Supabase
15. **Uninstall = full data deletion** — delete `stores` row, cascade handles the rest
