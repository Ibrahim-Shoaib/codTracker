// ============================================================
// Demo data fabricator
// ============================================================
// Generates realistic orders + ad_spend for stores marked is_demo = true.
// Used twice:
//   1. Onboarding seed — backfills 90 days of history when the merchant
//      finishes step 4, so the dashboard is immediately useful.
//   2. Daily cron — appends today's orders + today's ad_spend so the
//      dashboard rolls forward each morning.
//
// Determinism — every number is derived from a seed = (storeId, date).
//   Same store + same date → same orders. Refreshing the dashboard never
//   changes what was already generated; today's batch only changes once
//   per calendar day. Customers who watch a demo over several days see a
//   coherent narrative, not random reshuffles.
//
// Idempotent — before generating a day, we check whether any orders for
//   that day already exist for the store. If so, that day is skipped.
//   Safe to call repeatedly.
//
// Reads real Shopify variants + costs so line_items match the merchant's
// own catalog and COGS reconciles to believable margins. Never calls
// PostEx or Meta.

import { getProductsForCOGS } from './shopify.server.js';

// ── tunable realism parameters ────────────────────────────────────────────
const CITIES = [
  // ~70% concentrated in the big four; tail covers the long-tail of PK cities.
  { name: 'Karachi',     weight: 0.34 },
  { name: 'Lahore',      weight: 0.24 },
  { name: 'Islamabad',   weight: 0.10 },
  { name: 'Faisalabad',  weight: 0.07 },
  { name: 'Rawalpindi',  weight: 0.05 },
  { name: 'Multan',      weight: 0.04 },
  { name: 'Peshawar',    weight: 0.04 },
  { name: 'Hyderabad',   weight: 0.03 },
  { name: 'Quetta',      weight: 0.03 },
  { name: 'Sialkot',     weight: 0.02 },
  { name: 'Gujranwala',  weight: 0.02 },
  { name: 'Sargodha',    weight: 0.02 },
];

// Status mix tuned for a healthy demo: 70% delivered, 15% returned, 15% in
// transit. Higher delivery rate than typical Pakistani COD (real shops
// see 55-65%) so the demo dashboard shows a profitable business — which
// is the point of a demo. Returns at 15% still demonstrates real return
// loss without dragging margins underwater.
const STATUS_MIX = [
  { status: 'Delivered', weight: 0.70, code: '0005', flags: { is_delivered: true,  is_returned: false, is_in_transit: false } },
  { status: 'Return',    weight: 0.15, code: '0002', flags: { is_delivered: false, is_returned: true,  is_in_transit: false } },
  { status: 'Booked',    weight: 0.10, code: '0003', flags: { is_delivered: false, is_returned: false, is_in_transit: true  } },
  { status: 'Out For Delivery', weight: 0.05, code: '0004', flags: { is_delivered: false, is_returned: false, is_in_transit: true  } },
];

// Customer-name pool — first + last lists, joined to feel local.
const FIRST_NAMES = [
  'Ali','Ayesha','Hassan','Fatima','Bilal','Sara','Usman','Hira','Ahmed','Maryam',
  'Zain','Iqra','Hamza','Mehwish','Faisal','Noor','Yasir','Komal','Owais','Sana',
];
const LAST_NAMES = [
  'Khan','Ahmed','Malik','Sheikh','Hussain','Raza','Ali','Iqbal','Siddiqui','Butt',
  'Shah','Qureshi','Riaz','Mehmood','Tariq','Akhtar','Saleem','Aslam','Bashir','Cheema',
];

// Daily volume profile. Hashed from store_id so each demo store has its own
// "size". Returns { baseDaily, growthPctPerDay, weeklyMultipliers }.
//
// baseDaily floor was raised from 12 → 25 so even the smallest demo store
// produces enough revenue to clear ad spend + delivery + COGS at a healthy
// margin. With ROAS-targeted ad spend (see fabricateAdSpend), profit ≈
// 30% of revenue regardless of catalog cost, so the floor of 25 orders/day
// guarantees roughly 300K+ PKR monthly profit even on a low-ticket catalog.
function profileForStore(storeId) {
  const h = hash32(storeId);
  // 25–50 orders/day baseline — active mid-size COD store
  const baseDaily = 25 + (h % 26);
  // 0.10%–0.40% per day growth — a gentle upward slope
  const growthPctPerDay = 0.001 + ((h >> 5) % 30) / 10000;
  // Pakistani COD has a weekly cycle: Fri/Sat slightly stronger
  const weeklyMultipliers = [0.95, 0.98, 1.00, 1.02, 1.10, 1.15, 1.05]; // Sun..Sat
  return { baseDaily, growthPctPerDay, weeklyMultipliers };
}

// Per-day order count derived from the profile + a deterministic per-day
// noise term (±20%).
function dailyTargetOrders(profile, dateYmd) {
  const { baseDaily, growthPctPerDay, weeklyMultipliers } = profile;
  const day = new Date(dateYmd + 'T00:00:00Z');
  const dow = day.getUTCDay(); // 0..6
  const daysSinceEpoch = Math.floor(day.getTime() / 86_400_000);
  const noise = (rng01(`${dateYmd}|noise`) * 0.4) - 0.2; // ±20%
  const trend = Math.pow(1 + growthPctPerDay, daysSinceEpoch % 720); // bounded so it can't run away on long backfills
  const target = baseDaily * weeklyMultipliers[dow] * trend * (1 + noise);
  return Math.max(1, Math.round(target));
}

// ── deterministic RNG helpers ─────────────────────────────────────────────
// Cheap stable string hash → uint32.
function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
// Seedable [0,1) PRNG. Same seed string always returns the same value.
function rng01(seed) {
  let h = hash32(seed);
  // xorshift32 once for diffusion
  h ^= h << 13; h >>>= 0;
  h ^= h >>> 17; h >>>= 0;
  h ^= h << 5;  h >>>= 0;
  return (h >>> 0) / 0xFFFFFFFF;
}
// Returns a stateful RNG closure — successive calls produce a stream of
// [0,1) values, all deterministic from the seed.
function makeRng(seed) {
  let counter = 0;
  return () => rng01(`${seed}|${counter++}`);
}
function pickWeighted(rng, items) {
  const total = items.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (const x of items) {
    r -= x.weight;
    if (r <= 0) return x;
  }
  return items[items.length - 1];
}
function intBetween(rng, lo, hi) { // inclusive
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ── Shopify variant catalog → flattened list with prices + costs ──────────
// Returns [{ variant_id, product_id, title, price, cost }] across the
// merchant's active products. Variants without a price are dropped (we'd
// have nothing to charge the customer).
async function loadCatalog({ supabase, storeId, session }) {
  const products = await getProductsForCOGS(session); // hits Shopify (free)
  const flat = [];
  for (const p of products) {
    for (const v of p.variants) {
      // We need a price to fabricate invoice_payment. The Shopify product
      // payload here doesn't include `price` (we trim fields for speed),
      // so we approximate from cost when missing — see priceFor() below.
      flat.push({
        variant_id: v.shopify_variant_id,
        product_id: v.shopify_product_id,
        product_title: v.product_title,
        variant_title: v.variant_title,
        cost: v.shopify_cost ?? null,
      });
    }
  }
  // Prefer merchant-saved costs over Shopify cost so the demo reflects what
  // they entered in step 3.
  const { data: savedCosts } = await supabase
    .from('product_costs')
    .select('shopify_variant_id, unit_cost')
    .eq('store_id', storeId);
  const savedMap = {};
  for (const r of savedCosts ?? []) {
    savedMap[r.shopify_variant_id] = Number(r.unit_cost) || 0;
  }
  for (const v of flat) {
    if (savedMap[v.variant_id] != null) v.cost = savedMap[v.variant_id];
  }
  // Drop variants we know nothing about — can't fabricate without a unit cost.
  return flat.filter((v) => v.cost != null && v.cost > 0);
}

// Approximate retail price from cost (2.5×–4.5× markup, avg 3.5×). Higher
// than typical real-world COD because we want the demo dashboard to look
// healthy: a 3.5× markup leaves ~30% net margin after delivery + ads.
function priceFor(cost, rng) {
  const markup = 2.5 + rng() * 2.0;
  return Math.round((cost * markup) / 10) * 10; // round to PKR-10
}

// ── one fabricated order ──────────────────────────────────────────────────
function fabricateOrder({ rng, storeId, dateYmd, sequence, catalog }) {
  // 1–3 line items per order, weighted toward 1
  const lineCount = pickWeighted(rng, [
    { count: 1, weight: 0.65 },
    { count: 2, weight: 0.25 },
    { count: 3, weight: 0.10 },
  ]).count;

  const lineItems = [];
  let cogsTotal = 0;
  let invoicePayment = 0;
  const orderDetailParts = [];
  for (let i = 0; i < lineCount; i++) {
    const v = catalog[Math.floor(rng() * catalog.length)];
    const qty = pickWeighted(rng, [
      { q: 1, weight: 0.85 }, { q: 2, weight: 0.12 }, { q: 3, weight: 0.03 },
    ]).q;
    const unitPrice = priceFor(v.cost, rng);
    lineItems.push({ variant_id: v.variant_id, quantity: qty });
    cogsTotal += v.cost * qty;
    invoicePayment += unitPrice * qty;
    const title = v.variant_title && v.variant_title !== 'Default Title'
      ? `${v.product_title} - ${v.variant_title}`
      : v.product_title;
    orderDetailParts.push(`[ ${qty} x ${title} ]`);
  }

  const status = pickWeighted(rng, STATUS_MIX);
  const city = pickWeighted(rng, CITIES).name;
  const customer = `${FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)]}`;

  // Delivery fee scales loosely with invoice value; tax is ~12% of fee
  // (matches the proportions we see in real PostEx data). Range 220-340
  // is on the lower end of real PostEx fees — keeps demo margins healthy.
  const isTerminal = status.flags.is_delivered || status.flags.is_returned;
  const transactionFee = isTerminal ? Math.round(220 + rng() * 120) : 0;
  const transactionTax = isTerminal ? Math.round(transactionFee * 0.12) : 0;
  const reversalFee = status.flags.is_returned ? Math.round(transactionFee * 0.85) : 0;
  const reversalTax = status.flags.is_returned ? Math.round(reversalFee * 0.12) : 0;

  // Random hour 09:00–22:00 PKT so today's bar isn't a midnight spike
  const hour = 9 + Math.floor(rng() * 13);
  const minute = Math.floor(rng() * 60);
  // PKT (UTC+5) → represent as ISO with offset so Postgres stores the right instant
  const ts = `${dateYmd}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:00`;

  // Tracking number must be unique per (store_id, tracking_number). Salt
  // with the day + sequence so a re-seed never collides.
  const tracking = `DM${hash32(`${storeId}|${dateYmd}|${sequence}`).toString(36).toUpperCase().padStart(8, '0').slice(0, 9)}`;

  return {
    store_id: storeId,
    tracking_number: tracking,
    order_ref_number: String(10000 + ((hash32(`${storeId}|${dateYmd}|${sequence}|ref`)) % 90000)),
    transaction_status: status.status,
    invoice_payment: invoicePayment,
    transaction_fee: transactionFee,
    transaction_tax: transactionTax,
    reversal_fee: reversalFee,
    reversal_tax: reversalTax,
    items: lineCount,
    city_name: city,
    customer_name: customer,
    order_detail: orderDetailParts.join(' '),
    transaction_date: ts,
    is_delivered: status.flags.is_delivered,
    is_returned:  status.flags.is_returned,
    is_in_transit: status.flags.is_in_transit,
    cogs_total: cogsTotal,
    cogs_matched: true,
    cogs_match_source: 'exact',
    line_items: lineItems,
    updated_at: new Date().toISOString(),
  };
}

// ── ad spend per day ──────────────────────────────────────────────────────
// ROAS-targeted: ad spend is derived from the day's actual delivered revenue
// so the spend always makes sense relative to what we sold. Real Pakistani
// COD shops running profitable Meta ads land at ROAS 3.5-5.0; we draw from
// that band each day.
//
// Why not CPA-based: a CPA model (ad spend = orders × cost-per-acquisition)
// detaches spend from revenue, so a low-cost catalog generates low revenue
// but the same ad spend → guaranteed losses on the demo dashboard. The
// ROAS approach self-balances: small catalog → small revenue → small spend.
function fabricateAdSpend(deliveredRevenueToday, rng) {
  if (deliveredRevenueToday <= 0) {
    // Even on a zero-delivery day, real merchants are still paying for ads.
    // Drop to a small floor (~PKR 1500-3000) so the chart doesn't dip to 0.
    return Math.round(1500 + rng() * 1500);
  }
  const targetRoas = 3.5 + rng() * 1.5; // ROAS 3.5-5.0
  const noise = 0.90 + rng() * 0.20;    // ±10% day-to-day variance
  return Math.round((deliveredRevenueToday / targetRoas) * noise);
}

// ── public: generate one or more days for one store ───────────────────────
//
// `dates` — array of 'YYYY-MM-DD' strings. Each day is fabricated independently
// and skipped if any orders already exist for (store_id, that day).
//
// Returns { ordersInserted, daysSkipped, daysFabricated, adSpendInserted }.
export async function fabricateDemoDataForDates({
  supabase,
  storeId,
  session,
  dates,
}) {
  if (!dates?.length) return { ordersInserted: 0, daysSkipped: 0, daysFabricated: 0, adSpendInserted: 0 };

  const catalog = await loadCatalog({ supabase, storeId, session });
  if (catalog.length === 0) {
    console.warn(`[demo-fabricator ${storeId}] empty catalog — Shopify products with cost > 0 required`);
    return { ordersInserted: 0, daysSkipped: 0, daysFabricated: 0, adSpendInserted: 0 };
  }

  const profile = profileForStore(storeId);

  let ordersInserted = 0;
  let daysSkipped = 0;
  let daysFabricated = 0;
  let adSpendInserted = 0;

  for (const dateYmd of dates) {
    // Idempotent: if any order for that day already exists, skip.
    const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('store_id', storeId)
      .gte('transaction_date', `${dateYmd}T00:00:00+05:00`)
      .lt('transaction_date',  `${dateYmd}T23:59:59+05:00`);
    if ((count ?? 0) > 0) { daysSkipped++; continue; }

    const target = dailyTargetOrders(profile, dateYmd);
    const rng = makeRng(`${storeId}|${dateYmd}|orders`);
    const rows = [];
    for (let i = 0; i < target; i++) {
      rows.push(fabricateOrder({ rng, storeId, dateYmd, sequence: i, catalog }));
    }

    // One PostgREST batch per day — keeps memory + payload sizes small.
    const { error: ordErr } = await supabase
      .from('orders')
      .upsert(rows, { onConflict: 'store_id,tracking_number' });
    if (ordErr) {
      console.error(`[demo-fabricator ${storeId}] order upsert failed for ${dateYmd}:`, ordErr);
      continue;
    }
    ordersInserted += rows.length;

    // Ad spend for the day, derived from the day's delivered revenue so
    // ROAS is healthy regardless of catalog size or order volume.
    const deliveredRevenue = rows.reduce(
      (sum, r) => sum + (r.is_delivered ? r.invoice_payment : 0),
      0
    );
    const adRng = makeRng(`${storeId}|${dateYmd}|ad`);
    const adAmount = fabricateAdSpend(deliveredRevenue, adRng);
    const { error: adErr } = await supabase
      .from('ad_spend')
      .upsert(
        {
          store_id:  storeId,
          spend_date: dateYmd,
          amount:    adAmount,
          source:    'meta',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'store_id,spend_date' }
      );
    if (!adErr) adSpendInserted++;
    daysFabricated++;
  }

  return { ordersInserted, daysSkipped, daysFabricated, adSpendInserted };
}

// Convenience: build a list of YYYY-MM-DD strings spanning [from, to] inclusive.
export function datesBetween(fromYmd, toYmd) {
  const dates = [];
  const cur = new Date(fromYmd + 'T00:00:00Z');
  const end = new Date(toYmd   + 'T00:00:00Z');
  while (cur.getTime() <= end.getTime()) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cur.getUTCDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}
