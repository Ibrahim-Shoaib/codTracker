// Inspect actual fbc values stored for trendy:
//   - distribution of fbc lengths (truncation marker)
//   - case mixing patterns
//   - landing_site vs cookie-derived fbcs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
await sb.rpc("set_app_store", { store: SHOP });
const head = (s) => console.log("\n" + "═".repeat(80) + "\n " + s + "\n" + "═".repeat(80));

// ── 1. fbc length distribution from visitors ──
head("1. visitors.latest_fbc length distribution");
const { data: visitors } = await sb
  .from("visitors")
  .select("visitor_id, latest_fbc, fbc_history, last_seen_at")
  .eq("store_id", SHOP)
  .not("latest_fbc", "is", null)
  .order("last_seen_at", { ascending: false })
  .limit(2000);

const lens = (visitors ?? []).map((v) => v.latest_fbc?.length).filter(Boolean);
console.log(`  Total fbcs sampled: ${lens.length}`);
const buckets = { "<50": 0, "50-99": 0, "100-149": 0, "150-199": 0, "200-249": 0, "250+": 0 };
for (const l of lens) {
  if (l < 50) buckets["<50"]++;
  else if (l < 100) buckets["50-99"]++;
  else if (l < 150) buckets["100-149"]++;
  else if (l < 200) buckets["150-199"]++;
  else if (l < 250) buckets["200-249"]++;
  else buckets["250+"]++;
}
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(10)} ${v}`);

// ── 2. extract fbclid from fbc and compare lengths ──
head("2. fbclid length distribution (from fb.1.<ts>.<fbclid>)");
const fbclidLens = [];
const samples = [];
for (const v of visitors ?? []) {
  const m = v.latest_fbc?.match(/^fb\.\d+\.\d+\.(.+)$/);
  if (m) {
    fbclidLens.push(m[1].length);
    if (samples.length < 6) samples.push({ fbc: v.latest_fbc, fbclid: m[1], len: m[1].length });
  }
}
const fbcBuckets = { "<30": 0, "30-59": 0, "60-89": 0, "90-119": 0, "120-149": 0, "150+": 0 };
for (const l of fbclidLens) {
  if (l < 30) fbcBuckets["<30"]++;
  else if (l < 60) fbcBuckets["30-59"]++;
  else if (l < 90) fbcBuckets["60-89"]++;
  else if (l < 120) fbcBuckets["90-119"]++;
  else if (l < 150) fbcBuckets["120-149"]++;
  else fbcBuckets["150+"]++;
}
for (const [k, v] of Object.entries(fbcBuckets)) console.log(`  ${k.padEnd(10)} ${v}`);
console.log("\n  Sample fbcs:");
for (const s of samples) {
  console.log(`    len=${s.len}  fbclid=${s.fbclid.slice(0, 80)}${s.fbclid.length > 80 ? "…" : ""}`);
}

// ── 3. case variance in fbclid (Meta says lowercase modification is a sign) ──
head("3. fbclid case detection (Meta fbclids are MIXED CASE; all-lowercase = modified)");
let mixedCase = 0, allLower = 0, allUpper = 0;
const lowercaseSamples = [];
for (const v of visitors ?? []) {
  const m = v.latest_fbc?.match(/^fb\.\d+\.\d+\.(.+)$/);
  if (!m) continue;
  const fbclid = m[1];
  if (fbclid === fbclid.toLowerCase() && fbclid.length > 30 && /[a-z]/.test(fbclid)) {
    allLower++;
    if (lowercaseSamples.length < 5) lowercaseSamples.push({ visitor_id: v.visitor_id?.slice(0, 8), fbclid: fbclid.slice(0, 60) });
  } else if (fbclid === fbclid.toUpperCase()) {
    allUpper++;
  } else {
    mixedCase++;
  }
}
console.log(`  Mixed case (normal):   ${mixedCase}`);
console.log(`  All lowercase (suspect): ${allLower}`);
console.log(`  All uppercase:         ${allUpper}`);
if (lowercaseSamples.length) {
  console.log("\n  All-lowercase samples (POSSIBLE MODIFICATIONS):");
  for (const s of lowercaseSamples) console.log(`    visitor=${s.visitor_id}…  fbclid=${s.fbclid}…`);
}

// ── 4. fbc_history mismatch — visitor sees multiple fbcs for same fbclid? ──
head("4. fbc_history — same fbclid stored as different fbc strings (truncation evidence)");
let mismatch = 0;
for (const v of visitors ?? []) {
  const hist = Array.isArray(v.fbc_history) ? v.fbc_history : [];
  if (hist.length < 2) continue;
  const byFbclid = {};
  for (const h of hist) {
    if (!h.fbclid || !h.value) continue;
    byFbclid[h.fbclid] ??= new Set();
    byFbclid[h.fbclid].add(h.value);
  }
  for (const [, fbcs] of Object.entries(byFbclid)) {
    if (fbcs.size > 1) {
      mismatch++;
      if (mismatch <= 3) {
        console.log(`  visitor=${v.visitor_id?.slice(0, 8)}… stored ${fbcs.size} different fbc values for the same fbclid:`);
        for (const f of fbcs) console.log(`    ${f.slice(0, 100)}${f.length > 100 ? "…" : ""}`);
      }
    }
  }
}
console.log(`  Total visitors with fbc/fbclid mismatch: ${mismatch}`);

// ── 5. order_attribution.first_touch_url — is fbclid there truncated vs cookie? ──
head("5. Recent order first_touch_urls (look for short fbclid in URL = Shopify truncation)");
const { data: oa } = await sb
  .from("order_attribution")
  .select("shopify_order_id, channel, first_touch_url, attributed_at")
  .eq("store_id", SHOP)
  .ilike("first_touch_url", "%fbclid=%")
  .order("attributed_at", { ascending: false })
  .limit(10);

for (const a of oa ?? []) {
  const url = a.first_touch_url ?? "";
  const m = url.match(/[?&]fbclid=([^&#]+)/);
  const fbclid = m ? m[1] : null;
  console.log(`  order=${a.shopify_order_id} ${a.channel}`);
  console.log(`    fbclid len=${fbclid?.length} val=${fbclid?.slice(0, 80)}${fbclid && fbclid.length > 80 ? "…" : ""}`);
}

// ── 6. preview/test domain audit ──
head("6. visitor_events urls — count entries by hostname (look for shopifypreview)");
const { data: ve } = await sb
  .from("visitor_events")
  .select("url, occurred_at")
  .eq("store_id", SHOP)
  .gte("occurred_at", new Date(Date.now() - 7 * 86400000).toISOString())
  .limit(5000);

const hostCounts = {};
for (const e of ve ?? []) {
  if (!e.url) continue;
  try {
    const h = new URL(e.url).hostname;
    hostCounts[h] = (hostCounts[h] ?? 0) + 1;
  } catch {}
}
console.log(`  Total events: ${ve?.length}`);
const sorted = Object.entries(hostCounts).sort((a, b) => b[1] - a[1]);
for (const [h, c] of sorted.slice(0, 15)) console.log(`  ${String(c).padStart(6)} ${h}`);
const previewCount = sorted.filter(([h]) => h.includes("shopifypreview.com")).reduce((a, [, c]) => a + c, 0);
console.log(`\n  Total preview-domain events in 7d: ${previewCount}`);
