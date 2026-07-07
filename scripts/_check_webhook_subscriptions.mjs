// List active webhook subscriptions for the shop and check whether our
// pixel-tracking topics are subscribed. Also pulls recent webhook delivery
// failures from Shopify's Notifications log if accessible.
import { createClient } from "@supabase/supabase-js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: sessions } = await sb
  .from("shopify_sessions")
  .select("accessToken")
  .eq("shop", SHOP)
  .eq("isOnline", false);
const token = sessions[0].accessToken;

console.log(`═══════════════════════════════════════════════════════════════════════════`);
console.log(` Webhook subscriptions for ${SHOP}`);
console.log(`═══════════════════════════════════════════════════════════════════════════`);

const res = await fetch(`https://${SHOP}/admin/api/2025-01/webhooks.json`, {
  headers: { "X-Shopify-Access-Token": token },
});
if (!res.ok) {
  console.error(`Shopify API ${res.status}:`, await res.text());
  process.exit(1);
}
const { webhooks } = await res.json();

console.log(`Total active webhook subscriptions: ${webhooks.length}\n`);

const wantedTopics = [
  "orders/create",
  "orders/paid",
  "orders/edited",
  "refunds/create",
  "checkouts/create",
  "checkouts/update",
  "app/uninstalled",
];

console.log(`${"topic".padEnd(28)} ${"address (truncated)".padEnd(60)} ${"created"}`);
console.log("─".repeat(120));
for (const w of webhooks) {
  const addr = w.address.length > 58 ? w.address.slice(0, 55) + "..." : w.address;
  console.log(`${w.topic.padEnd(28)} ${addr.padEnd(60)} ${w.created_at}`);
}

console.log("\n─── Topic coverage check ───");
const subbedTopics = new Set(webhooks.map((w) => w.topic));
for (const t of wantedTopics) {
  const ok = subbedTopics.has(t);
  console.log(`  ${ok ? "✓" : "✗"} ${t}`);
}

const missingTopics = wantedTopics.filter((t) => !subbedTopics.has(t));
if (missingTopics.length) {
  console.log(`\n⚠ Missing webhook subscriptions: ${missingTopics.join(", ")}`);
  console.log(`  These would be configured in shopify.app.toml under [[webhooks.subscriptions]].`);
  console.log(`  If you re-deployed the app and these aren't there, that's why orders/create`);
  console.log(`  webhook didn't fire for #9359 and #9360.`);
}

// Address inspection — confirm webhooks point at the right server
console.log("\n─── Webhook target inspection ───");
const expectedHostFragments = ["codtracker-production.up.railway.app", "/api/webhooks/", "/webhooks/"];
for (const w of webhooks) {
  const hitsExpected = expectedHostFragments.some((f) => w.address.includes(f));
  if (!hitsExpected) {
    console.log(`  ⚠ ${w.topic} points to unexpected URL: ${w.address}`);
  }
}

// When were these webhooks created? Compare to the missed orders
console.log("\n─── Created-at timing vs missed orders ───");
console.log(`  Order #9359 created: 2026-05-05T03:01:34 UTC`);
console.log(`  Order #9360 created: 2026-05-05T06:03:01 UTC\n`);
const ordersTopic = webhooks.find((w) => w.topic === "orders/create");
if (ordersTopic) {
  const createdAt = new Date(ordersTopic.created_at);
  const ord1 = new Date("2026-05-05T03:01:34Z");
  const ord2 = new Date("2026-05-05T06:03:01Z");
  console.log(`  orders/create webhook created: ${ordersTopic.created_at}`);
  if (createdAt > ord1 && createdAt < ord2) {
    console.log(`  ⚠ Webhook subscribed AFTER #9359 but BEFORE #9360 — explains missing #9359 only`);
  } else if (createdAt > ord2) {
    console.log(`  ⚠ Webhook subscribed AFTER both missing orders — explains why neither fired`);
  } else {
    console.log(`  ✓ Webhook was subscribed before both missing orders. Webhook delivery itself failed.`);
  }
}

// Check shopify.app.toml subscription declarations
console.log("\n─── Recommended next debug step ───");
console.log(`Check Shopify admin → Settings → Notifications → scroll to 'Webhooks' section`);
console.log(`That page shows the LAST 48h of webhook delivery attempts including failures.`);
console.log(`Look for orders/create attempts at 03:01 UTC and 06:03 UTC today —`);
console.log(`  • If they show "Failed" → our handler errored or Railway was down`);
console.log(`  • If they're ABSENT → webhook wasn't subscribed at the time`);
