// ============================================================
// Demo pool — shared orders + ad_spend across all is_demo stores
// ============================================================
// Every demo store the merchant onboards reads from the SAME pool of
// fabricated data instead of generating its own. This means:
//   * New demo onboardings are instant (no 5-15s seed step).
//   * Storage stays bounded — one set of ~2K orders, not N copies.
//   * Every demo merchant sees identical numbers, useful for sales demos.
//
// The pool's orders/ad_spend live under a sentinel store_id row that the
// schema migration 014 inserts. The dashboard loader and trend API swap
// the merchant's session.shop for the pool id any time store.is_demo is
// true, so the merchant never sees the swap — to them the dashboard "just
// works" with realistic data.
//
// Pool ownership:
//   * COGS shown on demo dashboards comes from cogs_total baked into pool
//     orders, computed off the SYNTHETIC_CATALOG below. The COGS values
//     each demo merchant types in step 3 are stored against their own
//     store_id but don't influence the pool — the merchant still goes
//     through that step (good UX) but the dashboard is decoupled.
//   * Expenses (store_expenses) ARE per-store. Each merchant's entered
//     expenses still affect their own profit numbers.

import {
  fabricateDemoDataForDates,
  sweepStaleInTransit,
  datesBetween,
} from './demo-fabricator.server.js';

export const DEMO_POOL_STORE_ID = '__codprofit_demo_pool__';

// 5-product synthetic catalog spanning low/mid/premium price points.
// Variant ids are stable strings so re-seeding produces consistent
// line_items rows; they don't need to exist in any real Shopify store.
const SYNTHETIC_CATALOG = [
  { variant_id: 'demo-v-tshirt',   product_id: 'demo-p-tshirt',   product_title: 'Cotton T-Shirt',         variant_title: 'Default',  cost: 350  },
  { variant_id: 'demo-v-bedsheet', product_id: 'demo-p-bedsheet', product_title: 'Premium Bedsheet Set',   variant_title: 'King',     cost: 800  },
  { variant_id: 'demo-v-kurta',    product_id: 'demo-p-kurta',    product_title: 'Designer Kurta',         variant_title: 'Medium',   cost: 1500 },
  { variant_id: 'demo-v-watch',    product_id: 'demo-p-watch',    product_title: 'Smart Fitness Watch',    variant_title: 'Black',    cost: 2200 },
  { variant_id: 'demo-v-earbuds',  product_id: 'demo-p-earbuds',  product_title: 'Wireless Earbuds Pro',   variant_title: 'Default',  cost: 1800 },
];

// Returns the store_id to use when querying orders / ad_spend for the
// given merchant. Demo stores all share the pool; real stores use their
// own shop.
export function effectiveStoreId(storeRow, fallbackShop) {
  if (storeRow?.is_demo) return DEMO_POOL_STORE_ID;
  return fallbackShop;
}

// Idempotent: ensures the pool has 90 days of seeded data. Cheap when
// pool is already seeded — single COUNT query confirms today exists.
// Run on first demo onboarding (fire-and-forget) and from the daily cron.
export async function ensurePoolSeeded(supabase) {
  const today = new Date();
  const start = new Date(today.getTime() - 89 * 24 * 60 * 60 * 1000);
  const ymd = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Quick check: does the pool already have orders for today? If so, the
  // initial 90-day seed has run at some point (the daily cron keeps the
  // tail fresh). Skip the expensive fabrication.
  const todayYmd = ymd(today);
  const { count } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', DEMO_POOL_STORE_ID)
    .gte('transaction_date', `${todayYmd}T00:00:00+05:00`)
    .lte('transaction_date', `${todayYmd}T23:59:59+05:00`);
  if ((count ?? 0) > 0) return { alreadySeeded: true };

  // Empty pool — seed the full 90-day window. Per-day idempotency inside
  // the fabricator means partially-seeded pools fill in cleanly.
  const dates = datesBetween(ymd(start), ymd(today));
  const result = await fabricateDemoDataForDates({
    supabase,
    storeId: DEMO_POOL_STORE_ID,
    catalog: SYNTHETIC_CATALOG,
    dates,
  });
  return { alreadySeeded: false, ...result };
}

// Reseed the pool from scratch. Used by the cron's ?reseed=1 mode after
// fabrication parameters change.
export async function reseedPool(supabase, days = 90) {
  await supabase.from('orders').delete().eq('store_id', DEMO_POOL_STORE_ID);
  await supabase.from('ad_spend').delete().eq('store_id', DEMO_POOL_STORE_ID);

  const today = new Date();
  const start = new Date(today.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const ymd = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dates = datesBetween(ymd(start), ymd(today));

  return fabricateDemoDataForDates({
    supabase,
    storeId: DEMO_POOL_STORE_ID,
    catalog: SYNTHETIC_CATALOG,
    dates,
  });
}

// Daily tick: append today + sweep any aged-out in-transit orders.
export async function tickPool(supabase) {
  const today = new Date();
  const ymd = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const fabResult = await fabricateDemoDataForDates({
    supabase,
    storeId: DEMO_POOL_STORE_ID,
    catalog: SYNTHETIC_CATALOG,
    dates: [ymd(today)],
  });
  const sweepResult = await sweepStaleInTransit(supabase, DEMO_POOL_STORE_ID);
  return { fab: fabResult, sweep: sweepResult };
}
