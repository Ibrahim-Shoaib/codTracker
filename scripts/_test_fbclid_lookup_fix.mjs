// Tests the fbclid → visitor row lookup fallback.
// (1) Unit-style tests of findVisitorByFbclid with real Supabase data.
// (2) Route-logic simulation: what would the webhook handler have sent
//     to Meta for orders #9363 and #9364 WITH the fix vs WITHOUT it.
import { createClient } from "@supabase/supabase-js";
import {
  findVisitorByFbclid,
  findRecentVisitorByIpUa,
  getVisitor,
  pickBestFbc,
} from "../app/lib/visitors.server.js";
import { extractIdentityFromOrder, extractCustomerIdentity } from "../app/lib/cart-attributes.server.js";
import { buildUserData } from "../app/lib/meta-hash.server.js";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let pass = 0, fail = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? "\n    " + detail : ""}`); fail++; }
}

// ─── (1) Unit tests of findVisitorByFbclid ───────────────────────────────
console.log("─── findVisitorByFbclid behavior ───");

// Real fbclid from #9363's landing_site (we already confirmed it's in our DB)
const realFbclid9363 = "PAZXh0bgNhZW0BMABhZGlkAas2JW1MWdJzcnRjBmFwcF9pZA8xMjQwMjQ1NzQyODc0MTQAAadSBtXNNLQm3q_f4Gq46";
const found9363 = await findVisitorByFbclid({ storeId: SHOP, fbclid: realFbclid9363 });
check(
  "real #9363 fbclid → visitor row found",
  found9363 !== null,
  `lookup returned: ${found9363 ? found9363.visitor_id : "null"}`
);
check(
  "found row's latest_fbc actually contains the fbclid",
  found9363?.latest_fbc?.includes(realFbclid9363) === true
);
check(
  "found row has visitor_id, fbp, fbc, ip",
  !!(found9363?.visitor_id && found9363?.latest_fbp && found9363?.latest_fbc && found9363?.latest_ip)
);

// Real fbclid from #9364's landing_site. Facebook iOS IAB rotates the
// fbclid value across page loads — the order's URL has a freshly-minted
// fbclid that DOESN'T match the visitor row's stored latest_fbc. This
// test documents that limitation: fbclid alone is insufficient for FB
// IAB; the IP+UA fallback below is what actually recovers the visitor.
const realFbclid9364 = "IwZXh0bgNhZW0BMABhZGlkAas2JXJ92WJzcnRjBmFwcF9pZAo2NjI4NTY4Mzc5AAEeg7Qe2MBbMlqQbTWRduU8KafwQeUJaROPfKPXA8zdpr56zJUjNHrGVvKWz7U_aem_tkQZ7r44__klA0jjA8hjvw";
const found9364 = await findVisitorByFbclid({ storeId: SHOP, fbclid: realFbclid9364 });
check(
  "#9364 fbclid lookup misses (FB IAB fbclid rotation — IP+UA fallback covers this case)",
  found9364 === null
);

// Edge cases
const noStore = await findVisitorByFbclid({ storeId: "", fbclid: realFbclid9363 });
check("empty storeId returns null", noStore === null);

const noFbclid = await findVisitorByFbclid({ storeId: SHOP, fbclid: null });
check("null fbclid returns null", noFbclid === null);

const tooShort = await findVisitorByFbclid({ storeId: SHOP, fbclid: "abc" });
check("too-short fbclid returns null", tooShort === null);

const tooLong = await findVisitorByFbclid({ storeId: SHOP, fbclid: "x".repeat(500) });
check("too-long fbclid returns null", tooLong === null);

const bogus = await findVisitorByFbclid({ storeId: SHOP, fbclid: "ZZZZZZZZZZZZZZZZZZZZZ_definitely_not_a_real_fbclid_value_xyz_NOPE" });
check("bogus fbclid returns null (no row matches)", bogus === null);

// ─── findRecentVisitorByIpUa tests ────────────────────────────────────
console.log("\n─── findRecentVisitorByIpUa behavior ───");

// Use #9364's IP and UA — should find one of the IAB visitor rows
const ip9364 = "119.160.59.6";
const ua9364 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/23E261 Safari/604.1 [FBAN/FBIOS;FBAV/559.0.0.56.80;FBBV/955347213;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/26.4.2;FBSS/3;FBID/phone;FBLC/en_GB;FBOP/5;FBRV/961168810;IABMV/1]";
const ipUaFound = await findRecentVisitorByIpUa({
  storeId: SHOP,
  ip: ip9364,
  ua: ua9364,
  referenceTime: new Date("2026-05-05T14:10:26+0000"),
  windowMinutes: 60,
});
check(
  "#9364 IP+UA recovers a visitor row",
  ipUaFound !== null,
  `lookup returned: ${ipUaFound ? ipUaFound.visitor_id : "null"}`
);

// Empty/missing args
check(
  "missing ip returns null",
  (await findRecentVisitorByIpUa({ storeId: SHOP, ip: "", ua: ua9364, referenceTime: Date.now() })) === null
);
check(
  "missing ua returns null",
  (await findRecentVisitorByIpUa({ storeId: SHOP, ip: ip9364, ua: "", referenceTime: Date.now() })) === null
);

// Time window pruning — far-past reference shouldn't match recent rows
const farPastMatch = await findRecentVisitorByIpUa({
  storeId: SHOP,
  ip: ip9364,
  ua: ua9364,
  referenceTime: new Date("2024-01-01T00:00:00Z"),
  windowMinutes: 60,
});
check("reference far in past returns null (out of window)", farPastMatch === null);

// ─── (2) Route-logic simulation for #9363 and #9364 ──────────────────────
console.log("\n─── Webhook handleOrderPaid replay: WITHOUT vs WITH fix ───");

const { data: sessions } = await sb
  .from("shopify_sessions")
  .select("accessToken")
  .eq("shop", SHOP)
  .eq("isOnline", false);
const sToken = sessions[0].accessToken;

async function fetchOrder(orderId) {
  const oRes = await fetch(
    `https://${SHOP}/admin/api/2025-01/orders/${orderId}.json?` +
      new URLSearchParams({
        fields:
          "id,name,email,phone,customer,shipping_address,line_items,total_price,currency,presentment_currency,processed_at,landing_site,note_attributes,client_details",
      }),
    { headers: { "X-Shopify-Access-Token": sToken } }
  );
  return (await oRes.json()).order;
}

async function simulate(orderId, label) {
  const order = await fetchOrder(orderId);
  const identityHints = extractIdentityFromOrder(order);
  const customer = extractCustomerIdentity(order);

  // BEFORE fix: only use cart-attribute visitor_id (which is null in IAB)
  const beforeVisitor = identityHints.visitorId
    ? await getVisitor({ storeId: SHOP, visitorId: identityHints.visitorId })
    : null;
  const beforeExtIds = [];
  if (identityHints.visitorId) beforeExtIds.push(identityHints.visitorId);
  if (customer.externalId) beforeExtIds.push(customer.externalId);
  const beforeUd = buildUserData({
    ...customer,
    externalId: beforeExtIds.length ? beforeExtIds : undefined,
    fbp: identityHints.fbp ?? beforeVisitor?.latest_fbp ?? undefined,
    fbc: identityHints.fbc ?? beforeVisitor?.latest_fbc ?? undefined,
    clientIp: identityHints.clientIp ?? beforeVisitor?.latest_ip ?? undefined,
    clientUa: identityHints.clientUa ?? beforeVisitor?.latest_ua ?? undefined,
  });

  // AFTER fix: cart-attr → fbclid → ip+ua+recency
  let afterVisitor = null;
  let afterVid = identityHints.visitorId;
  let afterSource = null;
  if (afterVid) {
    afterVisitor = await getVisitor({ storeId: SHOP, visitorId: afterVid });
    afterSource = "cart_attr";
  } else if (identityHints.fbclid) {
    afterVisitor = await findVisitorByFbclid({ storeId: SHOP, fbclid: identityHints.fbclid });
    if (afterVisitor) {
      afterVid = afterVisitor.visitor_id;
      afterSource = "fbclid";
    }
  }
  if (!afterVisitor && identityHints.clientIp && identityHints.clientUa) {
    afterVisitor = await findRecentVisitorByIpUa({
      storeId: SHOP,
      ip: identityHints.clientIp,
      ua: identityHints.clientUa,
      referenceTime: order.processed_at ?? order.created_at,
      windowMinutes: 60,
    });
    if (afterVisitor) {
      afterVid = afterVisitor.visitor_id;
      afterSource = "ip_ua";
    }
  }
  const afterExtIds = [];
  if (afterVid) afterExtIds.push(afterVid);
  if (customer.externalId) afterExtIds.push(customer.externalId);
  const afterUd = buildUserData({
    ...customer,
    externalId: afterExtIds.length ? afterExtIds : undefined,
    fbp: identityHints.fbp ?? afterVisitor?.latest_fbp ?? undefined,
    fbc: identityHints.fbc ?? afterVisitor?.latest_fbc ?? undefined,
    clientIp: identityHints.clientIp ?? afterVisitor?.latest_ip ?? undefined,
    clientUa: identityHints.clientUa ?? afterVisitor?.latest_ua ?? undefined,
  });

  console.log(`\n  ${label} (${order.name}) — fbclid=${identityHints.fbclid?.slice(0, 30)}…`);
  console.log(`    BEFORE fix:`);
  console.log(`      external_id values:  ${beforeUd.external_id?.length ?? 0}`);
  console.log(`      fbp:                 ${beforeUd.fbp ? "present" : "MISSING"}`);
  console.log(`      visitor recovered:   no`);
  console.log(`    AFTER fix:`);
  console.log(`      external_id values:  ${afterUd.external_id?.length ?? 0}`);
  console.log(`      fbp:                 ${afterUd.fbp ? "present (recovered)" : "MISSING"}`);
  console.log(`      visitor recovered:   ${afterVisitor ? `yes via ${afterSource} (visitor_id=${afterVid?.slice(0, 8)}…)` : "no"}`);

  return { before: beforeUd, after: afterUd, recoveredVisitor: !!afterVisitor, source: afterSource };
}

const r1 = await simulate(7643307934012, "Order #9363 (Instagram IAB)");
const r2 = await simulate(7643375370556, "Order #9364 (Facebook IAB, with cart)");

console.log("\n─── Improvement verification ───");
check("#9363 gains fbp from fbclid lookup", !r1.before.fbp && !!r1.after.fbp);
check("#9363 external_id grows from 1 → 2", (r1.before.external_id?.length ?? 0) === 1 && (r1.after.external_id?.length ?? 0) === 2);
check("#9363 visitor row recovered", r1.recoveredVisitor);

check("#9364 gains fbp from fbclid lookup", !r2.before.fbp && !!r2.after.fbp);
check("#9364 external_id grows from 1 → 2", (r2.before.external_id?.length ?? 0) === 1 && (r2.after.external_id?.length ?? 0) === 2);
check("#9364 visitor row recovered", r2.recoveredVisitor);

// ─── Final summary ───────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
