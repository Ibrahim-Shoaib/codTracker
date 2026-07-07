// ============================================================================
//  check-ad-tracking.mjs  —  Daily Meta ad-tracking health check (ANY store)
// ============================================================================
//
//  PURPOSE
//  -------
//  Foolproof, read-only daily verification that EVERY order placed on a store
//  was tracked and delivered to Meta. No writes. No guessing. Every line is a
//  database row or a live Meta/Shopify API response.
//
//  HOW TO RUN
//  ----------
//    node scripts/check-ad-tracking.mjs                 # pick a store from a menu
//    node scripts/check-ad-tracking.mjs --all           # check EVERY connected store
//    node scripts/check-ad-tracking.mjs --store=the-trendy-homes-pk.myshopify.com
//    node scripts/check-ad-tracking.mjs --list          # just list connected stores
//    node scripts/check-ad-tracking.mjs --all --date=yesterday
//    node scripts/check-ad-tracking.mjs --store=foo --date=2026-05-18
//
//  (the store name can be the full ".myshopify.com" domain OR any unique
//   fragment of it, e.g. --store=trendy)
//
//  EXIT CODE  (so you / Task Scheduler can trust it without reading the text)
//  ---------
//    0  PASS          every order is confirmed delivered to Meta
//    1  FAIL          a real tracking problem — read the "WHAT TO DO" block
//    2  INCONCLUSIVE  could not verify (DB / Shopify unreachable) — NOT a pass
//
//  SCHEDULE IT (Windows, runs every day at 09:00 PKT, checks all stores):
//    schtasks /Create /SC DAILY /ST 09:00 /TN "AdTrackingCheck" ^
//      /TR "cmd /c cd /d C:\Users\ibrah\projects\codtracker && ^
//      node scripts\check-ad-tracking.mjs --all >> scripts\logs\daily.txt 2>&1"
//  (or just double-click scripts\check-ad-tracking.cmd)
//
//  A one-line result is appended to scripts/logs/history.log every run so you
//  always have a dated audit trail even months from now.
// ============================================================================

import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// ── Load .env (same parser the other ops scripts use) ───────────────────────
try {
  for (const l of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  console.error("FATAL: cannot read .env in the current directory.");
  console.error("Run this from the project root: C:\\Users\\ibrah\\projects\\codtracker");
  process.exit(2);
}

// decryptSecret is optional — only used for the Meta cross-check. If it can't
// load (e.g. ENCRYPTION_KEY missing) the check still runs on DB+Shopify truth.
let decryptSecret = null;
try {
  ({ decryptSecret } = await import("../app/lib/crypto.server.js"));
} catch { /* Meta cross-check will be skipped with a warning */ }

// ── Args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (k) => {
  const a = argv.find((x) => x === `--${k}` || x.startsWith(`--${k}=`));
  if (!a) return undefined;
  return a.includes("=") ? a.split("=").slice(1).join("=") : true;
};
const optAll = !!getArg("all");
const optList = !!getArg("list");
const optStore = typeof getArg("store") === "string" ? getArg("store") : null;
const optDate = typeof getArg("date") === "string" ? getArg("date") : null;
const GRACE_MIN = Number(getArg("grace")) || 10; // order younger than this w/o
                                                  // capi_sent_at = in-flight

const PKT = 5 * 3600 * 1000;
const now = Date.now();

// Resolve the PKT day under review.
let pktDay;
if (!optDate || optDate === "today") {
  pktDay = new Date(now + PKT).toISOString().slice(0, 10);
} else if (optDate === "yesterday") {
  pktDay = new Date(now + PKT - 86400000).toISOString().slice(0, 10);
} else if (/^\d{4}-\d{2}-\d{2}$/.test(optDate)) {
  pktDay = optDate;
} else {
  console.error(`Bad --date "${optDate}". Use today | yesterday | YYYY-MM-DD.`);
  process.exit(2);
}
const dayStartMs = new Date(`${pktDay}T00:00:00Z`).getTime() - PKT;
const dayEndMs = dayStartMs + 86400000;
// When reviewing today, cap the window at "now"; orders can't exist in the future.
const windowEndMs = Math.min(dayEndMs, now);
const dayStartIso = new Date(dayStartMs).toISOString();
const dayEndIso = new Date(dayEndMs).toISOString();

// EMQ proxy weights — MUST mirror app/routes/api.cron.emq.tsx scoreForKeys().
// This is a LOCAL proxy only; Meta's authoritative EMQ lives in Events Manager.
const W = { em: 1.5, ph: 1.5, fn: 1.0, ln: 1.0, fbc: 1.0, external_id: 0.6,
  fbp: 0.5, ct: 0.4, st: 0.3, zp: 0.3, country: 0.3 };
const emqProxy = (keys) => {
  if (!keys) return 0;
  const s = new Set(keys);
  let v = 0;
  for (const k of Object.keys(W)) if (s.has(k)) v += W[k];
  if (s.has("client_ip_address") && s.has("client_user_agent")) v += 0.5;
  return Math.min(10, +v.toFixed(2));
};

const db = () =>
  new pg.Client({
    connectionString: process.env.SUPABASE_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

// ── Pick which store(s) to check ────────────────────────────────────────────
let connList;
{
  const c = db();
  try {
    await c.connect();
    connList = (
      await c.query(
        `select mpc.store_id, mpc.status, mpc.dataset_id, mpc.dataset_name,
                s.currency, s.is_demo
         from meta_pixel_connections mpc
         left join stores s on s.store_id = mpc.store_id
         order by mpc.store_id`
      )
    ).rows;
  } catch (e) {
    console.error("FATAL: cannot reach the database — cannot certify anything.");
    console.error(String(e?.message ?? e));
    process.exit(2);
  } finally {
    await c.end().catch(() => {});
  }
}

if (!connList.length) {
  console.error("No stores have Meta Pixel connected (meta_pixel_connections is empty).");
  process.exit(2);
}

if (optList) {
  console.log(`Connected stores (${connList.length}):\n`);
  connList.forEach((r, i) =>
    console.log(
      `  ${String(i + 1).padStart(2)}. ${r.store_id}` +
        `  [${r.status}] dataset="${r.dataset_name ?? r.dataset_id}"` +
        `${r.is_demo ? " (demo)" : ""}`
    )
  );
  process.exit(0);
}

let targets = [];
if (optAll) {
  targets = connList;
} else if (optStore) {
  const matches = connList.filter(
    (r) => r.store_id === optStore || r.store_id.includes(optStore)
  );
  if (matches.length === 0) {
    console.error(`No connected store matches "${optStore}". Try --list.`);
    process.exit(2);
  }
  if (matches.length > 1) {
    console.error(`"${optStore}" is ambiguous — matches ${matches.length} stores:`);
    matches.forEach((m) => console.error(`  - ${m.store_id}`));
    console.error("Be more specific or use the full domain.");
    process.exit(2);
  }
  targets = matches;
} else if (connList.length === 1) {
  targets = connList;
} else if (process.stdin.isTTY) {
  // Interactive numbered menu.
  console.log(`Select a store to check (PKT day ${pktDay}):\n`);
  connList.forEach((r, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${r.store_id}${r.is_demo ? " (demo)" : ""}`)
  );
  console.log(`   a. ALL stores`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question("\nNumber (or 'a'): ", res));
  rl.close();
  if (answer.trim().toLowerCase() === "a") targets = connList;
  else {
    const idx = parseInt(answer.trim(), 10) - 1;
    if (!(idx >= 0 && idx < connList.length)) {
      console.error("Invalid selection.");
      process.exit(2);
    }
    targets = [connList[idx]];
  }
} else {
  // Non-interactive (scheduled) with multiple stores and no flag → check ALL.
  // Foolproof default: never silently skip a store.
  targets = connList;
}

// ── Per-store review ────────────────────────────────────────────────────────
const L = (s = "") => console.log(s);
const HR = (t) => L(`\n${"═".repeat(78)}\n ${t}\n${"═".repeat(78)}`);
const fmt = (d) =>
  d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) + "Z" : "—";

async function reviewStore(meta) {
  const SHOP = meta.store_id;
  const FAIL = [];
  const WARN = [];
  let status = "PASS"; // PASS | FAIL | INCONCLUSIVE

  L(`\n\n${"#".repeat(78)}`);
  L(`#  STORE: ${SHOP}`);
  L(`#  PKT day under review: ${pktDay}   (window ${dayStartIso} → ${fmt(windowEndMs)})`);
  L(`#  Audit run @ ${new Date(now).toISOString()}`);
  L("#".repeat(78));

  const c = db();
  try {
    await c.connect();
  } catch (e) {
    L(`\nINCONCLUSIVE — database unreachable: ${e?.message}`);
    return { SHOP, status: "INCONCLUSIVE", FAIL: ["DB unreachable"], WARN, counts: {} };
  }
  const q = (s, p = []) => c.query(s, p).then((r) => r.rows);

  try {
    // 1 ── CONNECTION ────────────────────────────────────────────────────────
    HR("1. CONNECTION STATE");
    const [conn] = await q(
      `select status,status_reason,dataset_id,dataset_name,connected_at,
              last_event_sent_at,bisu_token
       from meta_pixel_connections where store_id=$1`,
      [SHOP]
    );
    if (!conn) {
      FAIL.push("No meta_pixel_connections row — pixel not connected");
      L("  NO connection row.");
    } else {
      L(`  status            : ${conn.status}${conn.status_reason ? " (" + conn.status_reason + ")" : ""}`);
      L(`  dataset           : ${conn.dataset_name ?? "?"} (${conn.dataset_id})`);
      L(`  connected_at      : ${fmt(conn.connected_at)}`);
      L(`  last_event_sent_at: ${fmt(conn.last_event_sent_at)} (${conn.last_event_sent_at ? ((now - new Date(conn.last_event_sent_at).getTime()) / 60000).toFixed(0) + " min ago" : "never"})`);
      if (conn.status !== "active")
        FAIL.push(`connection status = '${conn.status}' (expected 'active')`);
      if (new Date(conn.connected_at).getTime() > dayStartMs)
        WARN.push(`connection (re)created mid-day at ${fmt(conn.connected_at)} — orders before that could not fire`);
    }

    // 2 ── LIVE SHOPIFY GROUND TRUTH ─────────────────────────────────────────
    HR("2. LIVE SHOPIFY ORDERS — the denominator (every order that happened)");
    const [sess] = await q(
      `select "accessToken" t from shopify_sessions
       where shop=$1 and "isOnline"=false limit 1`,
      [SHOP]
    );
    let shopOrders = [];
    let shopifyOk = false;
    if (!sess?.t) {
      WARN.push("No Shopify offline session — cannot do live ground-truth (used DB durable signal only)");
      L("  No offline Shopify session token — ground-truth check skipped.");
    } else {
      try {
        let url =
          `https://${SHOP}/admin/api/2025-10/orders.json?` +
          new URLSearchParams({
            status: "any",
            created_at_min: new Date(dayStartMs - 3600000).toISOString(),
            created_at_max: new Date(dayEndMs).toISOString(),
            limit: "250",
          });
        while (url) {
          const r = await fetch(url, { headers: { "X-Shopify-Access-Token": sess.t } });
          if (!r.ok) {
            WARN.push(`Shopify Admin API ${r.status} — ground-truth degraded`);
            L(`  Shopify ${r.status}: ${(await r.text()).slice(0, 200)}`);
            break;
          }
          const j = await r.json();
          shopOrders.push(...(j.orders ?? []));
          const m = (r.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
          url = m ? m[1] : null;
        }
        shopOrders = shopOrders.filter((o) => {
          const t = new Date(o.created_at).getTime();
          return t >= dayStartMs && t < dayEndMs;
        });
        shopifyOk = true;
      } catch (e) {
        WARN.push(`Shopify fetch error — ground-truth degraded: ${e?.message}`);
      }
    }
    L(`  Shopify orders created on ${pktDay} (PKT): ${shopifyOk ? shopOrders.length : "UNKNOWN"}`);
    for (const o of shopOrders) {
      const ls = o.landing_site || "";
      L(
        `   #${o.name} id=${o.id} ${fmt(o.created_at)} ${o.financial_status}` +
          `${o.cancelled_at ? " CANCELLED" : ""} ${o.current_total_price ?? o.total_price} ${o.currency}` +
          ` fbclid=${/[?&]fbclid=/.test(ls) ? "Y" : "n"}`
      );
    }

    // 3 ── PER-ORDER RECONCILIATION ──────────────────────────────────────────
    HR("3. PER-ORDER RECONCILIATION (durable order_attribution + delivery log)");
    const ids = shopOrders.map((o) => String(o.id));
    const detIds = ids.map((i) => `purchase:${SHOP}:${i}`);
    const attrRows = ids.length
      ? await q(
          `select shopify_order_id,channel,capi_sent_at,attributed_at
           from order_attribution where store_id=$1 and shopify_order_id=any($2)`,
          [SHOP, ids]
        )
      : [];
    const attr = new Map(attrRows.map((r) => [r.shopify_order_id, r]));
    const logRows = detIds.length
      ? await q(
          `select event_id,status,http_status,match_keys
           from capi_delivery_log
           where store_id=$1 and event_name='Purchase' and event_id=any($2)
           order by sent_at`,
          [SHOP, detIds]
        )
      : [];
    const logByOid = new Map();
    for (const r of logRows) {
      const oid = r.event_id.split(":")[2];
      if (!logByOid.has(oid)) logByOid.set(oid, []);
      logByOid.get(oid).push(r);
    }

    let confirmed = 0, inFlight = 0, pending = 0, silentMiss = 0;
    L("  order      | created (PKT)        | channel        | Meta-confirmed | match");
    for (const o of shopOrders) {
      const id = String(o.id);
      const a = attr.get(id);
      const logs = logByOid.get(id) || [];
      const sent = logs.filter((x) => x.status === "sent");
      const lg = sent[sent.length - 1];
      const createdPkt = new Date(new Date(o.created_at).getTime() + PKT)
        .toISOString().slice(11, 19);
      const ageMin = (now - new Date(o.created_at).getTime()) / 60000;
      const capiSent = !!(a && a.capi_sent_at);
      const proof = capiSent
        ? `YES @ ${fmt(a.capi_sent_at)}`
        : sent.length
        ? "YES (log)"
        : "—";
      const mk = lg?.match_keys
        ? `EMQpx ${emqProxy(lg.match_keys)} [${lg.match_keys.join(",")}]`
        : a && a.capi_sent_at
        ? "(log rotated; durable signal set ✓)"
        : "—";
      L(
        `  #${(o.name || id).padEnd(8)} | ${createdPkt} (${pktDay}) | ` +
          `${(a?.channel ?? "no attr").padEnd(14)} | ${proof.padEnd(28)} | ${mk}`
      );

      if (capiSent || sent.length) {
        confirmed++;
        // Match-quality warning only for AD orders that lost the click id.
        if (lg?.match_keys && (a?.channel === "facebook_ads" || a?.channel === "instagram_ads")) {
          const s = new Set(lg.match_keys);
          if (!s.has("fbc"))
            WARN.push(`#${o.name} (${a.channel}) sent WITHOUT fbc click-id — match-quality degraded for this ad order`);
          if (!s.has("em") && !s.has("ph"))
            WARN.push(`#${o.name} sent with neither email nor phone — weak match`);
        }
      } else if (ageMin < GRACE_MIN) {
        inFlight++;
      } else if (a) {
        pending++;
        FAIL.push(`#${o.name} (${id}): attribution row exists but capi_sent_at NULL & no sent log (age ${ageMin.toFixed(0)}m) — NOT delivered to Meta`);
      } else {
        silentMiss++;
        FAIL.push(`#${o.name} (${id}): NO attribution row & NO delivery — FULL SILENT MISS (Meta never got this conversion)`);
      }
    }
    L(`\n  Confirmed delivered to Meta : ${confirmed}/${shopOrders.length}`);
    L(`  In-flight (<${GRACE_MIN}m old)        : ${inFlight}`);
    L(`  Pending (attr, not sent)    : ${pending}`);
    L(`  Silent miss (no trace)      : ${silentMiss}`);

    // 4 ── DELIVERY LOG: failures today ──────────────────────────────────────
    HR("4. capi_delivery_log — every event today + failures");
    const mix = await q(
      `select event_name,status,http_status,count(*) n
       from capi_delivery_log where store_id=$1 and sent_at>=$2 and sent_at<$3
       group by 1,2,3 order by 1,2,3`,
      [SHOP, dayStartIso, dayEndIso]
    );
    if (!mix.length) L("  (no delivery-log rows today — low volume, or rotated by 500-row cap)");
    for (const r of mix)
      L(`  ${r.event_name} / ${r.status} / http=${r.http_status ?? "-"} : ${r.n}`);
    const bad = await q(
      `select event_name,sent_at,http_status,error_msg,event_id
       from capi_delivery_log
       where store_id=$1 and sent_at>=$2 and sent_at<$3 and status<>'sent'
       order by sent_at desc`,
      [SHOP, dayStartIso, dayEndIso]
    );
    L(`\n  Failed/dropped rows today: ${bad.length}`);
    for (const r of bad) {
      L(`   ⚠ ${fmt(r.sent_at)} ${r.event_name} http=${r.http_status} "${r.error_msg}"`);
      if (r.event_name === "Purchase")
        FAIL.push(`Purchase delivery FAILED: ${r.event_id} http=${r.http_status} "${r.error_msg}"`);
      else
        WARN.push(`${r.event_name} ${r.http_status} "${r.error_msg}" (non-conversion; usually identity-less first-paint — benign)`);
    }

    // 5 ── RETRY BACKLOG ─────────────────────────────────────────────────────
    HR("5. capi_retries backlog (must be ~0 / nothing stuck)");
    const retr = await q(
      `select event_name,count(*) n,min(created_at) oldest,max(attempts) max_att
       from capi_retries where store_id=$1 group by 1`,
      [SHOP]
    );
    if (!retr.length) L("  EMPTY ✓");
    for (const r of retr) {
      L(`  ${r.event_name}: ${r.n} queued, oldest ${fmt(r.oldest)}, max attempts ${r.max_att}`);
      const ageH = (now - new Date(r.oldest).getTime()) / 3600000;
      if (r.event_name === "Purchase" && (r.n > 0 && ageH > 1))
        FAIL.push(`${r.n} Purchase event(s) stuck in retry queue (oldest ${ageH.toFixed(1)}h) — not delivered`);
      else
        WARN.push(`${r.n} ${r.event_name} in retry queue (drains every 5 min)`);
    }

    // 6 ── DEDUP INTEGRITY ───────────────────────────────────────────────────
    HR("6. DEDUP INTEGRITY (exactly one logical Purchase per order)");
    const dup = await q(
      `select split_part(event_id,':',3) oid, count(distinct event_id) ids
       from capi_delivery_log
       where store_id=$1 and event_name='Purchase' and status='sent'
         and event_id like 'purchase:%' and sent_at>=$2 and sent_at<$3
       group by 1 having count(distinct event_id)>1`,
      [SHOP, dayStartIso, dayEndIso]
    );
    L(`  Orders with >1 distinct event_id (double-count risk): ${dup.length}`);
    for (const r of dup) {
      L(`   ⚠ order ${r.oid}: ${r.ids} distinct ids`);
      FAIL.push(`double-fire on order ${r.oid} (${r.ids} distinct event_ids) — Meta may double-count`);
    }
    if (!dup.length) L("  ✓ Webhook re-deliveries reuse one deterministic id → Meta dedupes.");

    // 7 ── CHANNEL ATTRIBUTION ───────────────────────────────────────────────
    HR("7. CHANNEL ATTRIBUTION (order_attribution, today)");
    const ch = await q(
      `select channel,count(*) n,count(capi_sent_at) sent
       from order_attribution where store_id=$1
         and attributed_at>=$2 and attributed_at<$3
       group by 1 order by 1`,
      [SHOP, dayStartIso, dayEndIso]
    );
    const attrTot = ch.reduce((a, r) => a + +r.n, 0);
    const attrSent = ch.reduce((a, r) => a + +r.sent, 0);
    L(`  attribution rows: ${attrTot} | confirmed-sent: ${attrSent}`);
    for (const r of ch) L(`   ${r.channel}: ${r.n} (sent ${r.sent})`);
    if (shopifyOk && attrTot !== shopOrders.length)
      WARN.push(`attribution rows (${attrTot}) != live Shopify orders (${shopOrders.length}) — investigate the gap`);

    // 8 ── META'S OWN SERVER-SIDE RECEIPT (independent cross-check) ───────────
    HR("8. META GRAPH /stats — Meta's own confirmation (independent)");
    let metaPurchases = null;
    if (decryptSecret && conn?.bisu_token && conn?.dataset_id) {
      let tok = null;
      try { tok = decryptSecret(conn.bisu_token); } catch (e) {
        WARN.push(`BISU decrypt failed (${e?.message}) — Meta cross-check skipped`);
      }
      if (tok) {
        try {
          const u = new URL(`https://graph.facebook.com/v24.0/${conn.dataset_id}/stats`);
          u.searchParams.set("access_token", tok);
          u.searchParams.set("aggregation", "event");
          const r = await fetch(u);
          const b = await r.json();
          if (r.ok && b?.data) {
            const tot = new Map();
            let srvSeen = false;
            for (const bk of b.data) {
              if (new Date(bk.start_time).getTime() < dayStartMs) continue;
              if (new Date(bk.start_time).getTime() >= dayEndMs) continue;
              for (const row of bk.data ?? [])
                tot.set(row.value, (tot.get(row.value) ?? 0) + Number(row.count ?? 0));
            }
            metaPurchases = tot.get("Purchase") ?? 0;
            L("  Meta received (PKT day), by event:");
            for (const [e, n] of [...tot.entries()].sort((a, b) => b[1] - a[1]))
              L(`   ${e.padEnd(18)} ${n}`);
            // Independent cross-check vs our confirmed count.
            const es = new URL(`https://graph.facebook.com/v24.0/${conn.dataset_id}/stats`);
            es.searchParams.set("access_token", tok);
            es.searchParams.set("aggregation", "event_source");
            const er = await fetch(es);
            const eb = await er.json();
            if (er.ok && eb?.data)
              srvSeen = eb.data.some(
                (d) =>
                  new Date(d.start_time).getTime() >= dayStartMs &&
                  (d.data ?? []).some((x) => x.value === "SERVER" && Number(x.count) > 0)
              );
            L(`\n  → Meta server-side Purchase receipts: ${metaPurchases} (raw; Meta dedupes by event_id)`);
            L(`  → SERVER (CAPI) stream present today: ${srvSeen ? "YES ✓" : "not seen in window"}`);
            if (confirmed > 0 && metaPurchases === 0)
              FAIL.push(`We recorded ${confirmed} delivered Purchase(s) but Meta /stats shows ZERO today — investigate immediately (token/dataset mismatch or Meta-side rejection)`);
            if (confirmed > 0 && !srvSeen)
              WARN.push("No SERVER event_source seen in Meta /stats window — CAPI may not be landing (verify in Events Manager)");
          } else {
            WARN.push(`Meta /stats HTTP ${r.status} — independent cross-check unavailable`);
            L(`  Meta /stats HTTP ${r.status}: ${JSON.stringify(b)?.slice(0, 200)}`);
          }
        } catch (e) {
          WARN.push(`Meta /stats fetch error — cross-check unavailable: ${e?.message}`);
        }
      }
    } else {
      WARN.push("Meta cross-check unavailable (no crypto module / no token) — verdict rests on DB durable signal + Shopify ground truth");
      L("  Skipped (no decrypt capability or no token).");
    }

    // ── decide store status ────────────────────────────────────────────────
    if (FAIL.length) status = "FAIL";
    else if (!shopifyOk && confirmed === 0 && shopOrders.length === 0) {
      // Could not see Shopify AND no DB evidence either → cannot certify.
      const anyAttr = await q(
        `select count(*) n from order_attribution
         where store_id=$1 and attributed_at>=$2 and attributed_at<$3`,
        [SHOP, dayStartIso, dayEndIso]
      );
      if (+anyAttr[0].n === 0) status = "INCONCLUSIVE";
    }

    return {
      SHOP,
      status,
      FAIL,
      WARN,
      counts: {
        shopOrders: shopifyOk ? shopOrders.length : "?",
        confirmed,
        inFlight,
        pending,
        silentMiss,
        metaPurchases,
      },
    };
  } catch (e) {
    return {
      SHOP,
      status: "INCONCLUSIVE",
      FAIL: [`audit threw: ${e?.message ?? e}`],
      WARN,
      counts: {},
    };
  } finally {
    await c.end().catch(() => {});
  }
}

// ── Run all targets ─────────────────────────────────────────────────────────
const results = [];
for (const t of targets) results.push(await reviewStore(t));

// ── Final verdict + history log + operator guidance ─────────────────────────
HR("VERDICT");
for (const r of results) {
  const c = r.counts || {};
  const tag =
    r.status === "PASS" ? "✅ PASS" :
    r.status === "FAIL" ? "❌ FAIL" : "⚠️  INCONCLUSIVE";
  L(
    `${tag}  ${r.SHOP}  —  orders=${c.shopOrders ?? "?"} ` +
      `confirmed=${c.confirmed ?? 0} inflight=${c.inFlight ?? 0} ` +
      `pending=${c.pending ?? 0} silentMiss=${c.silentMiss ?? 0}` +
      (c.metaPurchases != null ? ` metaRecv=${c.metaPurchases}` : "")
  );
  for (const f of r.FAIL) L(`     ❌ ${f}`);
  for (const w of r.WARN) L(`     ⚠  ${w}`);
}
// FAIL outranks INCONCLUSIVE for the process exit code.
const anyFail = results.some((r) => r.status === "FAIL");
const anyInc = results.some((r) => r.status === "INCONCLUSIVE");
const exitCode = anyFail ? 1 : anyInc ? 2 : 0;

L("");
if (exitCode === 0) {
  L("✅ ALL CLEAR — every order in the window is confirmed delivered to Meta.");
} else if (exitCode === 1) {
  L("❌ ACTION REQUIRED — at least one store has a real tracking problem.");
  L("");
  L("WHAT TO DO:");
  L("  • 'FULL SILENT MISS' or 'NOT delivered': the connection was likely down");
  L("    when the order fired. Open the app → Ad Tracking page for that store,");
  L("    confirm the Pixel shows 'Connected' (reconnect if not). Events older");
  L("    than 7 days cannot be recovered (Meta's CAPI window).");
  L("  • 'Purchase delivery FAILED http=...': read the error_msg. 190/OAuth =");
  L("    token expired → merchant must reconnect the Pixel in the app.");
  L("  • 'stuck in retry queue': the capi-retry cron may not be running on");
  L("    Railway — check the scheduled job is enabled.");
  L("  • 'double-fire': two distinct event_ids for one order — escalate, this");
  L("    is a code regression in the deterministic event_id path.");
  L("  • 'Meta /stats shows ZERO': token/dataset mismatch — verify the store is");
  L("    connected to the correct Meta dataset in Events Manager.");
} else {
  L("⚠️  COULD NOT VERIFY — this is NOT a pass. The database or Shopify Admin");
  L("    API was unreachable for at least one store. Re-run when connectivity");
  L("    is restored; do not assume tracking is fine until it returns ✅.");
}

// Append a permanent one-line history record.
try {
  const logDir = path.join("scripts", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const line =
    `${new Date(now).toISOString()}\tday=${pktDay}\t` +
    `exit=${exitCode}\t` +
    results
      .map(
        (r) =>
          `${r.SHOP}=${r.status}(o:${r.counts?.shopOrders ?? "?"},c:${r.counts?.confirmed ?? 0},miss:${r.counts?.silentMiss ?? 0})`
      )
      .join(" ") +
    "\n";
  fs.appendFileSync(path.join(logDir, "history.log"), line);
  L(`\n(history appended to scripts/logs/history.log)`);
} catch (e) {
  L(`\n(could not write history log: ${e?.message})`);
}

process.exit(exitCode);
