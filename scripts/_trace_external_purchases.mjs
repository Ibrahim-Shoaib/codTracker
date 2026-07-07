// Trace where the "extra" Purchase events Meta sees come from. We log 4 fires
// (2 dual-fired event_ids) for today, but Meta's stats show 8 Purchases.
// Either there's another Pixel installed firing duplicate events, OR our
// fires are showing up under different event_ids than expected.
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../app/lib/crypto.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const { data: conn } = await sb
  .from("meta_pixel_connections")
  .select("dataset_id, bisu_token")
  .eq("store_id", SHOP)
  .single();
const token = decryptSecret(conn.bisu_token);
const ds = conn.dataset_id;

// PKT today
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const todayPktDate = new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
const startUtc = new Date(`${todayPktDate}T00:00:00Z`).getTime() - PKT_OFFSET_MS;

// 1. event_source — browser vs server split for today's Purchases
console.log("─── BROWSER vs SERVER source split (Purchase events, today PKT) ───");
const sourceRes = await fetch(
  `https://graph.facebook.com/v24.0/${ds}/stats?` +
    new URLSearchParams({ access_token: token, aggregation: "event_source" })
);
const sourceJson = await sourceRes.json();
const tally = { BROWSER: 0, SERVER: 0 };
for (const bucket of sourceJson.data ?? []) {
  if (new Date(bucket.start_time).getTime() < startUtc) continue;
  for (const row of bucket.data ?? []) {
    tally[row.value] = (tally[row.value] ?? 0) + Number(row.count ?? 0);
  }
}
console.log(`  BROWSER (fbq from a script on a customer page): ${tally.BROWSER}`);
console.log(`  SERVER  (CAPI from a server hitting Meta):       ${tally.SERVER}`);

// 2. Earlier hours (before our app fired) — what events did Meta see and from where?
console.log("\n─── Per-hour Purchase breakdown (today PKT, both sources) ───");
const eventRes = await fetch(
  `https://graph.facebook.com/v24.0/${ds}/stats?` +
    new URLSearchParams({ access_token: token, aggregation: "event" })
);
const eventJson = await eventRes.json();

// Build a per-hour structure
console.log(`  ${"hour-utc".padEnd(28)} purchase-count  notes`);
console.log("  " + "─".repeat(70));
for (const bucket of eventJson.data ?? []) {
  const bucketStart = new Date(bucket.start_time).getTime();
  if (bucketStart < startUtc) continue;
  let purchases = 0;
  for (const row of bucket.data ?? []) {
    if (row.value === "Purchase") purchases += Number(row.count ?? 0);
  }
  if (purchases === 0) continue;
  const pktTime = new Date(bucketStart + PKT_OFFSET_MS).toISOString().slice(11, 16);
  console.log(`  ${bucket.start_time.padEnd(28)} ${String(purchases).padStart(2)}            (${pktTime} PKT)`);
}

// 3. Cross-reference our fires per hour
console.log("\n─── OUR fires per hour (capi_delivery_log) ───");
const { data: ourFires } = await sb
  .from("capi_delivery_log")
  .select("event_id, sent_at, status")
  .eq("store_id", SHOP)
  .eq("event_name", "Purchase")
  .gte("sent_at", new Date(startUtc).toISOString())
  .order("sent_at", { ascending: true });

const ourByHour = new Map();
for (const r of ourFires ?? []) {
  const hour = new Date(r.sent_at).toISOString().slice(0, 13) + ":00:00+0000";
  if (!ourByHour.has(hour)) ourByHour.set(hour, []);
  ourByHour.get(hour).push(r);
}
for (const [hour, rows] of ourByHour) {
  console.log(`  ${hour}  ${rows.length} fire(s) — event_ids: ${[...new Set(rows.map((r) => r.event_id))].join(", ")}`);
}

// 4. Compare and identify gap
console.log("\n─── GAP ANALYSIS ───");
const metaTotalToday = tally.BROWSER + tally.SERVER;
const ourFiresCount = ourFires?.length ?? 0;
const ourUniqueIds = new Set((ourFires ?? []).map((r) => r.event_id)).size;
console.log(`  Meta saw:                     ${metaTotalToday} Purchase events`);
console.log(`  Our app fired:                ${ourFiresCount} Purchase events (${ourUniqueIds} unique event_ids)`);
console.log(`  Unaccounted-for fires:        ${metaTotalToday - ourFiresCount}`);
console.log();
console.log(`  → ${tally.BROWSER} fires came from a BROWSER pixel`);
console.log(`     (likely not all from us — see "Purchase: SERVER-SIDE ONLY" comment in`);
console.log(`     extensions/cart-identity-relay/assets/meta-pixel.js — our theme block`);
console.log(`     deliberately does NOT fire fbq Purchase because thank-you pages don't`);
console.log(`     load theme app embeds. Web Pixel sandbox fires server-side beacons,`);
console.log(`     not direct browser fbq, so those land as SERVER too.)`);
console.log();
console.log(`  → ${tally.SERVER} fires came from SERVER (CAPI)`);
console.log(`     Our app fired ${ourFiresCount} of these.`);
console.log(`     The remaining ${tally.SERVER - ourFiresCount} are from another integration.`);
console.log();

if (tally.BROWSER > 0) {
  console.log(`  ⚠ ${tally.BROWSER} BROWSER Purchase fires likely come from:`);
  console.log(`    1. Shopify's native "Facebook & Instagram" sales channel app`);
  console.log(`       (auto-installs a Meta Pixel and fires events on checkout pages)`);
  console.log(`    2. A previously-installed Meta Pixel app (e.g. PixelYourSite,`);
  console.log(`       Loox, etc.) that's still active`);
  console.log(`    3. A hardcoded fbq() snippet in the theme code`);
  console.log();
  console.log(`  Check: Shopify admin → Settings → Apps → look for any Pixel apps`);
  console.log(`         Shopify admin → Settings → Customer events → look for Custom Web Pixels`);
  console.log(`         Theme code → search for "fbq(" and "fbevents.js"`);
}
if (tally.SERVER - ourFiresCount > 0) {
  console.log(`  ⚠ ${tally.SERVER - ourFiresCount} SERVER Purchase fires are from another CAPI integration:`);
  console.log(`    1. Shopify's native CAPI integration (if "Facebook & Instagram" channel`);
  console.log(`       has CAPI enabled — most do)`);
  console.log(`    2. A third-party CAPI tool (Triple Whale, Aimerce, Elevar, Littledata, etc.)`);
  console.log();
  console.log(`  Check: Meta Events Manager → Settings tab on the dataset → "Connected partners"`);
}
