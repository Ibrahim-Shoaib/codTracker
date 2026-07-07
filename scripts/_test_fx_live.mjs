import { getFxRate, convertAmount } from "../app/lib/fx.server.js";
import { createClient } from "@supabase/supabase-js";

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}  ${d}`); fail++; } };

console.log("─── Identity ───");
const id = await getFxRate("PKR", "PKR");
check("PKR→PKR identity", id?.rate === 1 && id.source === "identity");
const idC = await convertAmount(100, "PKR", "PKR");
check("convertAmount identity", idC.amount === 100);

console.log("\n─── Live USD→PKR ───");
const usdPkr = await getFxRate("USD", "PKR");
console.log(`  rate=${usdPkr?.rate} source=${usdPkr?.source}`);
check("USD→PKR returns rate", usdPkr?.rate != null);
check("rate plausible 50-500", usdPkr?.rate > 50 && usdPkr?.rate < 500);

console.log("\n─── Cache hit ───");
const usdPkr2 = await getFxRate("USD", "PKR");
check("source=cache on retry", usdPkr2?.source === "cache");
check("rate matches", usdPkr2?.rate === usdPkr?.rate);

console.log("\n─── Math ───");
const c = await convertAmount(100, "USD", "PKR");
check("100*rate = converted", Math.abs(c.amount - 100 * c.rate) < 1e-6);

console.log("\n─── Bogus currency ───");
const bogus = await getFxRate("XYZ", "USD");
check("bogus from returns null", bogus === null);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { count } = await sb.from("fx_rates").select("*", { count: "exact", head: true });
console.log(`\nfx_rates rows in DB: ${count}`);
check("DB has rates cached", count > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
