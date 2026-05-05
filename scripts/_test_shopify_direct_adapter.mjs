// Live integration test: build a ShopifyDirectAdapter against Trendy
// Homes' real Shopify store (using its offline session) and verify
// the output shape + sane numbers. Trendy Homes is actually PostEx-
// mode in production — for this test we instantiate the adapter
// directly without flipping the column.
import { createClient } from "@supabase/supabase-js";
import { getStatsAdapter } from "../app/lib/stats-adapter.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}  ${detail}`); fail++; }
};

// Get the offline access token + simulate a store row in shopify_direct mode.
const { data: sessions } = await sb
  .from("shopify_sessions")
  .select("accessToken")
  .eq("shop", SHOP)
  .eq("isOnline", false);
const session = { shop: SHOP, accessToken: sessions[0].accessToken };
const store = {
  store_id: SHOP,
  ingest_mode: "shopify_direct",
  currency: "PKR",
  meta_ad_account_currency: "PKR",
};

const adapter = await getStatsAdapter(store, session);

// ─── Capabilities ────────────────────────────────────────────────────────
console.log("─── capabilities() ───");
const caps = adapter.capabilities();
check("mode is shopify_direct", caps.mode === "shopify_direct");
check("showPipelinePills is false", caps.showPipelinePills === false);
check("showCityLoss is false", caps.showCityLoss === false);
check("returnsLabel is 'Refunded'", caps.returnsLabel === "Refunded");
check("returnsUnit is 'money'", caps.returnsUnit === "money");

// ─── Today's stats ───────────────────────────────────────────────────────
console.log("\n─── getDashboardStats({ today }) — Trendy Homes today ───");
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const t0 = Date.now();
const todayStats = await adapter.getDashboardStats({
  periods: { today: { from: today, to: tomorrow, toExclusive: tomorrow } },
  monthlyExp: 50000,
  perOrderExp: 0,
});
const dt = Date.now() - t0;
console.log(`  Fetched in ${dt}ms`);
console.log(`  Stats:`, JSON.stringify(todayStats.today, null, 2));

const s = todayStats.today;
check("returns object has sales field", typeof s?.sales === "number");
check("returns object has orders field", typeof s?.orders === "number");
check("returns object has units field", typeof s?.units === "number");
check("returns object has returns field", typeof s?.returns === "number");
check("returns object has return_loss field", typeof s?.return_loss === "number");
check("in_transit is 0 (no courier)", s?.in_transit === 0);
check("delivery_cost is 0 (no courier)", s?.delivery_cost === 0);
check("ad_spend present", typeof s?.ad_spend === "number");
check("expenses present", typeof s?.expenses === "number");
check("gross_profit present", typeof s?.gross_profit === "number");
check("net_profit present", typeof s?.net_profit === "number");

// ─── Cache hit on second call ────────────────────────────────────────────
console.log("\n─── 60-second cache validation ───");
const t1 = Date.now();
const cachedStats = await adapter.getDashboardStats({
  periods: { today: { from: today, to: tomorrow, toExclusive: tomorrow } },
  monthlyExp: 50000,
  perOrderExp: 0,
});
const dtCached = Date.now() - t1;
console.log(`  Second call: ${dtCached}ms`);
check("second call < 100ms (cache hit)", dtCached < 100, `took ${dtCached}ms`);
check("cached result equals first call", JSON.stringify(cachedStats) === JSON.stringify(todayStats));

// ─── Multi-period in one call ────────────────────────────────────────────
console.log("\n─── Multi-period fetch (today + yesterday) ───");
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const multi = await adapter.getDashboardStats({
  periods: {
    today: { from: today, to: tomorrow, toExclusive: tomorrow },
    yesterday: { from: yesterday, to: today, toExclusive: today },
  },
  monthlyExp: 50000,
  perOrderExp: 0,
});
check("multi-period returns both keys", multi.today != null && multi.yesterday != null);
check("today and yesterday are independent (not the same object)", multi.today !== multi.yesterday);

// ─── Empty period (10 years ago) ─────────────────────────────────────────
console.log("\n─── Empty period (year 2015) ───");
const empty = await adapter.getDashboardStats({
  periods: { ancient: { from: "2015-01-01", to: "2015-01-31", toExclusive: "2015-01-31" } },
  monthlyExp: 0,
  perOrderExp: 0,
});
console.log(`  Empty stats:`, JSON.stringify(empty.ancient));
check("empty period sales is 0", empty.ancient.sales === 0);
check("empty period orders is 0", empty.ancient.orders === 0);
check("empty period roas is null (no spend)", empty.ancient.roas === null);
check("empty period cac is null (no spend)", empty.ancient.cac === null);
check("empty period refund_pct is 0 (not null)", empty.ancient.refund_pct === 0);

// ─── Stat-shape parity with PostEx RPC output ───────────────────────────
console.log("\n─── Stat-shape parity with get_dashboard_stats RPC ───");
const expectedFields = [
  "sales", "orders", "units", "returns", "in_transit",
  "delivery_cost", "reversal_cost", "tax", "cogs",
  "ad_spend", "expenses", "gross_profit", "net_profit",
  "return_loss", "roas", "poas", "cac", "aov",
  "margin_pct", "roi_pct", "refund_pct", "in_transit_value",
];
for (const f of expectedFields) {
  check(`field "${f}" is present in adapter output`, f in s);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
