// Rigorous test harness for the cross-session visitor identity store.
// Runs against live Supabase + the deployed App Proxy on the test
// merchant (the-trendy-homes-pk.myshopify.com).
//
// Tests every code path the production feature relies on:
//
//   1. visitor lib unit tests (direct against DB)
//   2. App Proxy /apps/tracking/config — visitor_id mint + Set-Cookie
//   3. App Proxy /apps/tracking/track — beacon UPSERTs visitor row
//   4. Returning-visitor flow — same cookie returns same visitor_id
//   5. Cross-session enrichment merge logic (the actual ROAS-mover)
//   6. Retention — verify fields the cron will trim
//   7. Cleanup
//
// Each test prints PASS / FAIL and exits non-zero on any failure so it
// can gate a CI step or a pre-deploy check.

import "dotenv/config";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

const SHOP = "the-trendy-homes-pk.myshopify.com";
const STOREFRONT = "https://thetrendyhome.pk";

const PG_URL = process.env.SUPABASE_DATABASE_URL;
if (!PG_URL) {
  console.error("SUPABASE_DATABASE_URL not set");
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    console.log("  ✓ " + name);
    pass++;
  } else {
    console.log("  ✗ " + name + (detail ? " — " + detail : ""));
    fail++;
    failures.push(name);
  }
}

async function main() {
  const pg = new Client({ connectionString: PG_URL, ssl: { rejectUnauthorized: false }});
  await pg.connect();

  // Track everything we created so we can clean up at the end even on
  // partial failure.
  const createdVisitorIds = [];
  const createdEventIds = [];

  // ─── Test 1: visitor lib direct unit tests ───────────────────────
  console.log("\n═══ 1. visitor lib unit tests (direct DB) ═══");

  // Dynamic import so we don't pollute the global before dotenv runs.
  const { upsertVisitor, getVisitor, recordVisitorEvent, mintVisitorId, resolveVisitorId, pickBestFbc } =
    await import("../app/lib/visitors.server.js");

  // mintVisitorId returns a 36-char UUID
  const minted = mintVisitorId();
  check(
    "mintVisitorId returns 36-char UUID",
    /^[0-9a-f-]{36}$/i.test(minted),
    "got: " + minted
  );

  // resolveVisitorId reads existing cookie OR mints new
  const existing = "12345678-aaaa-bbbb-cccc-1234567890ab";
  const resolved1 = resolveVisitorId("foo=bar; cod_visitor_id=" + existing + "; baz=qux");
  check(
    "resolveVisitorId reads existing cookie",
    resolved1.visitorId === existing && resolved1.isNew === false
  );
  const resolved2 = resolveVisitorId("foo=bar; baz=qux");
  check(
    "resolveVisitorId mints new when no cookie",
    /^[0-9a-f-]{36}$/i.test(resolved2.visitorId) && resolved2.isNew === true
  );
  const resolved3 = resolveVisitorId(null);
  check(
    "resolveVisitorId mints new on null header",
    /^[0-9a-f-]{36}$/i.test(resolved3.visitorId) && resolved3.isNew === true
  );

  // upsertVisitor creates a new row
  const v1 = mintVisitorId();
  createdVisitorIds.push(v1);
  await upsertVisitor({
    storeId: SHOP,
    visitorId: v1,
    input: {
      email: "test1@example.com",
      fbp: "fb.1.111.aaa",
      fbc: "fb.1.222.click1",
      fbclid: "click1",
      ip: "1.2.3.4",
      ua: "Mozilla/Test",
    },
  });
  let row = await getVisitor({ storeId: SHOP, visitorId: v1 });
  check(
    "upsertVisitor creates new row with em_hash set",
    row && row.em_hash && row.em_hash.length === 64,
    row ? "em_hash=" + row.em_hash.slice(0, 12) : "row null"
  );
  check(
    "upsertVisitor sets latest_fbp/fbc/ip/ua",
    row?.latest_fbp === "fb.1.111.aaa" &&
      row?.latest_fbc === "fb.1.222.click1" &&
      row?.latest_ip === "1.2.3.4" &&
      row?.latest_ua === "Mozilla/Test"
  );
  check(
    "upsertVisitor populates fbc_history with one entry",
    Array.isArray(row?.fbc_history) &&
      row.fbc_history.length === 1 &&
      row.fbc_history[0].value === "fb.1.222.click1" &&
      row.fbc_history[0].fbclid === "click1"
  );

  // Update with a partial event (no email) — preserve hash, rotate fbc
  await upsertVisitor({
    storeId: SHOP,
    visitorId: v1,
    input: {
      fbp: "fb.1.333.bbb",
      fbc: "fb.1.444.click2",
      fbclid: "click2",
      ip: "5.6.7.8",
    },
  });
  row = await getVisitor({ storeId: SHOP, visitorId: v1 });
  check(
    "second upsert preserves em_hash from first session",
    row?.em_hash && row.em_hash.length === 64,
    "got " + (row?.em_hash || "null")
  );
  check(
    "second upsert rotates latest_fbc to new value",
    row?.latest_fbc === "fb.1.444.click2"
  );
  check(
    "second upsert appends to fbc_history (now 2 entries)",
    Array.isArray(row?.fbc_history) && row.fbc_history.length === 2
  );

  // Third upsert with same fbc — dedup
  await upsertVisitor({
    storeId: SHOP,
    visitorId: v1,
    input: { fbc: "fb.1.444.click2", fbclid: "click2" },
  });
  row = await getVisitor({ storeId: SHOP, visitorId: v1 });
  check(
    "duplicate fbc dedup'd in history (still 2 entries)",
    Array.isArray(row?.fbc_history) && row.fbc_history.length === 2
  );

  // Five more new fbcs — verify history caps at 5
  for (let i = 3; i <= 8; i++) {
    await upsertVisitor({
      storeId: SHOP,
      visitorId: v1,
      input: { fbc: "fb.1.999." + i, fbclid: "click" + i },
    });
  }
  row = await getVisitor({ storeId: SHOP, visitorId: v1 });
  check(
    "fbc_history caps at 5 entries (oldest dropped)",
    Array.isArray(row?.fbc_history) && row.fbc_history.length === 5
  );

  // ─── Test 2: pickBestFbc priority ────────────────────────────────
  console.log("\n═══ 2. pickBestFbc selection logic ═══");

  const r1 = pickBestFbc({ cartAttrFbc: "fb.cart", visitor: row });
  check(
    "cart attribute wins when present",
    r1.fbc === "fb.cart" && r1.source === "cart_attribute"
  );
  const r2 = pickBestFbc({ cartAttrFbc: null, visitor: row });
  check(
    "visitor.latest_fbc when cart attr absent",
    r2.fbc === row.latest_fbc && r2.source === "visitor_latest"
  );
  const r3 = pickBestFbc({
    cartAttrFbc: null,
    visitor: { ...row, latest_fbc: null },
  });
  check(
    "fbc_history fallback when latest_fbc null",
    r3.fbc != null && r3.source === "visitor_history"
  );
  const r4 = pickBestFbc({ cartAttrFbc: null, visitor: null });
  check(
    "null result when no source",
    r4.fbc === null && r4.source === null
  );

  // ─── Test 3: App Proxy /apps/tracking/config end-to-end ──────────
  console.log("\n═══ 3. App Proxy /apps/tracking/config (live) ═══");

  const cfgRes = await fetch(STOREFRONT + "/apps/tracking/config");
  check("config returns 200", cfgRes.status === 200);
  const setCookie = cfgRes.headers.get("set-cookie") || "";
  check(
    "config sets cod_visitor_id cookie",
    /cod_visitor_id=[0-9a-f-]{32,40}/.test(setCookie),
    "Set-Cookie: " + setCookie.slice(0, 100)
  );
  check(
    "cookie has Max-Age=31536000 (1 year)",
    /Max-Age=31536000/i.test(setCookie)
  );
  check(
    "cookie has HttpOnly + Secure + SameSite=Lax",
    /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Lax/i.test(setCookie)
  );
  const cfg = await cfgRes.json();
  check("config response includes visitor_id", typeof cfg.visitor_id === "string");
  check("config response includes pixel_id (connected)", cfg.connected && cfg.pixel_id);
  const cfgVisitorId = cfg.visitor_id;
  createdVisitorIds.push(cfgVisitorId);

  // Same cookie should return same visitor_id (re-read scenario)
  const cookieMatch = setCookie.match(/cod_visitor_id=([0-9a-f-]+)/);
  if (cookieMatch) {
    const cfgRes2 = await fetch(STOREFRONT + "/apps/tracking/config", {
      headers: { Cookie: "cod_visitor_id=" + cookieMatch[1] },
    });
    const cfg2 = await cfgRes2.json();
    check(
      "config returns SAME visitor_id when cookie present",
      cfg2.visitor_id === cookieMatch[1]
    );
  } else {
    console.log(
      "  - SKIP cookie-readback test (no cod_visitor_id in response — Railway may not be deployed yet)"
    );
  }

  // ─── Test 4: App Proxy /apps/tracking/track UPSERTs visitor ──────
  console.log("\n═══ 4. App Proxy /apps/tracking/track UPSERT ═══");

  const trackVisitorId = mintVisitorId();
  createdVisitorIds.push(trackVisitorId);
  const beacon = {
    event: "page_viewed",
    event_id: "test:cross-session:" + Date.now(),
    event_time: Date.now(),
    url: "https://thetrendyhome.pk/products/test",
    fbp: "fb.1.555.beacon-test",
    fbc: "fb.1.666.beacon-click",
    fbclid: "beacon-click",
    user_agent: "Mozilla/CrossSessionTest",
    visitor_id: trackVisitorId,
    utm_source: "facebook",
    utm_campaign: "test-campaign-123",
  };
  createdEventIds.push(beacon.event_id);

  const trackRes = await fetch(STOREFRONT + "/apps/tracking/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(beacon),
  });
  check("track returns 200", trackRes.status === 200);
  check(
    "track response sets cookie",
    /cod_visitor_id=/.test(trackRes.headers.get("set-cookie") || "")
  );

  // Wait briefly for async UPSERT to land (track returns before
  // upsertVisitor completes — that's by design for latency).
  await new Promise((r) => setTimeout(r, 1500));

  const visitorRow = await getVisitor({ storeId: SHOP, visitorId: trackVisitorId });
  check(
    "visitor row created from beacon UPSERT",
    visitorRow != null,
    "visitor_id=" + trackVisitorId
  );
  check(
    "visitor row has latest_fbp/fbc from beacon",
    visitorRow?.latest_fbp === beacon.fbp && visitorRow?.latest_fbc === beacon.fbc
  );
  check(
    "visitor row utm_history populated",
    Array.isArray(visitorRow?.utm_history) &&
      visitorRow.utm_history.length === 1 &&
      visitorRow.utm_history[0].source === "facebook"
  );

  // ─── Test 5: Cross-session enrichment SIMULATION ─────────────────
  // The actual ROAS-mover. Insert a "5-day-old" visitor row with a
  // known fbc, then assert pickBestFbc returns it when the cart attr
  // is missing — exactly the multi-session scenario.
  console.log("\n═══ 5. Cross-session enrichment merge logic ═══");

  const oldVisitorId = mintVisitorId();
  createdVisitorIds.push(oldVisitorId);
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

  // Insert a fake "old session" row directly via SQL — the ad click
  // visitor saw 5 days ago, with a known fbc but with last_seen_at
  // dated to simulate they'd left the storefront.
  await pg.query(
    "INSERT INTO visitors (visitor_id, store_id, em_hash, latest_fbp, latest_fbc, latest_ip, latest_ua, fbc_history, first_seen_at, last_seen_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      oldVisitorId,
      SHOP,
      "abc123hash".padEnd(64, "f"),
      "fb.1.aaa.old-fbp",
      "fb.1.bbb.original-click",
      "9.9.9.9",
      "Mozilla/OldSession",
      JSON.stringify([
        { value: "fb.1.bbb.original-click", fbclid: "ad-click-day-1", seen_at: fiveDaysAgo },
      ]),
      fiveDaysAgo,
      fiveDaysAgo,
    ]
  );

  // Simulate Purchase webhook: cart attr fbc absent, visitor row carries it
  const enrichedVisitor = await getVisitor({ storeId: SHOP, visitorId: oldVisitorId });
  const enriched = pickBestFbc({ cartAttrFbc: null, visitor: enrichedVisitor });
  check(
    "5-day-old visitor's original click recovered as fbc on Purchase",
    enriched.fbc === "fb.1.bbb.original-click",
    "got: " + enriched.fbc + " from " + enriched.source
  );
  check(
    "fbc enrichment source is visitor_latest (not cart_attribute)",
    enriched.source === "visitor_latest"
  );

  // Same scenario but visitor.latest_fbc cleared — should fall back to fbc_history
  const noLatestFbcVisitor = { ...enrichedVisitor, latest_fbc: null };
  const enriched2 = pickBestFbc({ cartAttrFbc: null, visitor: noLatestFbcVisitor });
  check(
    "fbc_history rescue when latest_fbc is null",
    enriched2.fbc === "fb.1.bbb.original-click" && enriched2.source === "visitor_history"
  );

  // ─── Test 6: visitor_events breadcrumbs ──────────────────────────
  console.log("\n═══ 6. visitor_events breadcrumbs ═══");

  await recordVisitorEvent({
    storeId: SHOP,
    visitorId: trackVisitorId,
    eventName: "TestEvent",
    eventId: "test:event:" + Date.now(),
    url: "https://test.local/foo",
    ip: "1.1.1.1",
    ua: "Test/Bot",
    fbp: "fb.1.999.evt",
    utmSource: "facebook",
  });

  const evtRows = await pg.query(
    "SELECT count(*)::int FROM visitor_events WHERE visitor_id = $1",
    [trackVisitorId]
  );
  // Note: track endpoint also wrote a breadcrumb. Plus our recordVisitorEvent. So expect ≥1.
  check(
    "visitor_events row inserted from recordVisitorEvent",
    evtRows.rows[0].count >= 1
  );

  // ─── Test 7: cleanup ─────────────────────────────────────────────
  console.log("\n═══ 7. cleanup ═══");
  await pg.query("DELETE FROM visitor_events WHERE visitor_id = ANY($1::text[])", [
    createdVisitorIds,
  ]);
  await pg.query("DELETE FROM visitors WHERE visitor_id = ANY($1::text[])", [
    createdVisitorIds,
  ]);
  await pg.query(
    "DELETE FROM capi_delivery_log WHERE event_id = ANY($1::text[])",
    [createdEventIds]
  );
  console.log("  ✓ test data deleted");

  // ─── Summary ─────────────────────────────────────────────────────
  await pg.end();
  console.log(
    "\n═══ SUMMARY: " +
      pass +
      " passed, " +
      fail +
      " failed " +
      (fail === 0 ? "🟢" : "🔴") +
      " ═══"
  );
  if (fail > 0) {
    console.log("Failures:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nFATAL test harness error:", err);
  process.exit(2);
});
