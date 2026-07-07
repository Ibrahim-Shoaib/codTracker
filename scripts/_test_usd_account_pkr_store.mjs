// End-to-end test: simulate a PKR shop with a USD ad account.
// Verifies the FX conversion actually fires and produces correct PKR
// numbers stored in ad_spend.amount. Does NOT mutate any production
// data — only exercises the in-memory math path.
import { convertAmount, getFxRate } from "../app/lib/fx.server.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}  ${detail}`); fail++; }
};

console.log("─── Scenario: PKR shop, USD ad account, $25.50 daily spend ───\n");

const usdSpend = 25.50;
const c = await convertAmount(usdSpend, "USD", "PKR");
console.log(`  Input:  $${usdSpend} USD`);
console.log(`  Rate:   ${c.rate} (source=${c.source})`);
console.log(`  Output: PKR ${c.amount?.toFixed(2)}`);
check("converted amount > 1000 (sane PKR conversion of $25)", c.amount > 1000);
check("converted amount < 20000 (not crazy off)", c.amount < 20000);
check("rate is plausible (USD/PKR is 200-350 range)", c.rate > 200 && c.rate < 350);

console.log("\n─── Scenario: PKR shop, USD ad account, identity check ───\n");
const c2 = await convertAmount(1000, "PKR", "PKR");
check("PKR→PKR returns identity (1000 → 1000)", c2.amount === 1000 && c2.rate === 1);

console.log("\n─── Scenario: PKR shop, USD ad account, $0 spend ───\n");
const c3 = await convertAmount(0, "USD", "PKR");
check("zero spend converts to zero", c3.amount === 0);

console.log("\n─── Scenario: USD shop, PKR ad account (reverse) ───\n");
const c4 = await convertAmount(7000, "PKR", "USD");
console.log(`  PKR 7000 → USD ${c4.amount?.toFixed(2)} at rate ${c4.rate}`);
check("PKR→USD produces ~$25 from PKR 7000", c4.amount > 20 && c4.amount < 35);

console.log("\n─── Scenario: full ROAS math (PKR shop, USD account) ───\n");
// Simulate one day:
//   - Sales:    PKR 50,000 (from PostEx — already PKR)
//   - Ad spend: $35 USD from Meta → converted to PKR
//   - Expected ROAS = 50,000 / converted ≈ 5.1 (at rate ~280)
const sales = 50000; // PKR
const usdAdSpend = 35;
const cAd = await convertAmount(usdAdSpend, "USD", "PKR");
const adSpendPkr = cAd.amount;
const roas = sales / adSpendPkr;
console.log(`  Sales:        PKR ${sales}`);
console.log(`  Ad spend:     $${usdAdSpend} → PKR ${adSpendPkr.toFixed(2)}`);
console.log(`  ROAS:         ${roas.toFixed(2)}`);
check("ROAS computes cleanly with both sides in PKR", roas > 4 && roas < 7);

console.log("\n─── FX math sanity ───\n");
const r1 = await getFxRate("USD", "PKR");
const r2 = await getFxRate("PKR", "USD");
const product = r1.rate * r2.rate;
console.log(`  USD→PKR × PKR→USD = ${product.toFixed(6)} (should be ≈ 1)`);
check("inverse rates multiply to 1 (within 1%)", Math.abs(product - 1) < 0.01);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
