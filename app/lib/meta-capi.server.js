// Meta Conversions API sender + retry queue management.
//
// Hot path:
//   1. Webhook handler / beacon endpoint calls sendCAPIEvents() inline.
//   2. On success → log to capi_delivery_log, done.
//   3. On failure → enqueue in capi_retries with exponential backoff.
//   4. Cron route /api/cron/capi-retry drains capi_retries every 5 minutes.
//
// We deliberately do NOT batch Purchase events — they fire one at a time from
// webhooks and the latency to Meta's optimization algorithm matters. Beacon
// events (AddToCart, ViewContent, InitiateCheckout) CAN be batched up to 1000
// per request; the beacon endpoint accumulates them by shop in memory and
// flushes every 30s or 100 events, whichever comes first.

import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "./crypto.server.js";

const GRAPH_VERSION = "v24.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Backoff schedule for failed events. Meta won't accept events older than 7 days,
// so capping at 5 attempts over ~8 hours is the right ceiling.
const BACKOFF_MINUTES = [5, 30, 120, 360, 480]; // 5m → 30m → 2h → 6h → 8h

function adminClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// ─── Connection lookup ────────────────────────────────────────────────────────

// Internal — returns the row state so callers can distinguish "no connection
// row" (merchant disconnected, expected drop) from "row exists but inactive"
// (broken connection, the failure mode that lost #9393's Purchase silently).
// The latter is what we now write a `dropped` log row for.
async function lookupConnection(storeId) {
  const supabase = adminClient();
  const { data, error } = await supabase
    .from("meta_pixel_connections")
    .select("dataset_id, bisu_token, status")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) {
    // Lookup itself failed — log so Railway captures the trace. Treat as
    // "row exists with unknown state" so the caller logs a drop and the
    // recon cron eventually retries the underlying order.
    console.warn(`[meta-capi lookupConnection ${storeId}] query error:`, error.message);
    return { exists: true, status: null, conn: null };
  }
  if (!data) {
    return { exists: false, status: null, conn: null };
  }
  if (data.status !== "active") {
    console.warn(`[meta-capi lookupConnection ${storeId}] inactive — status=${data.status}`);
    return { exists: true, status: data.status, conn: null };
  }
  return {
    exists: true,
    status: "active",
    conn: {
      datasetId: data.dataset_id,
      accessToken: decryptSecret(data.bisu_token),
    },
  };
}

// Returns { datasetId, accessToken } for the shop, or null if no connection
// exists / connection is revoked. Decrypts the BISU token in memory.
export async function getCAPIConnection(storeId) {
  const { conn } = await lookupConnection(storeId);
  return conn;
}

// ─── Event payload ────────────────────────────────────────────────────────────

// Build a single CAPI event object. Caller supplies user_data already built
// via meta-hash.buildUserData().
//
// Required fields (per Meta spec):
//   - event_name: standard event (Purchase, AddToCart, etc.)
//   - event_time: unix seconds (NOT ms), within last 7 days
//   - action_source: "website" | "email" | "app" | ...
//   - user_data: at least one matching field (em/ph/external_id/fbp/fbc/etc.)
//
// Recommended:
//   - event_id: dedup key, MUST match the browser pixel event_id when both
//     are sent. We always set it (UUID) so we can dedupe across retries too.
//   - event_source_url: the URL where the event happened
//   - custom_data: { value, currency, content_ids, ... }
/**
 * @param {object} args
 * @param {string} args.eventName            Meta standard event (Purchase, AddToCart, ...)
 * @param {string} args.eventId              UUID for dedup with browser pixel
 * @param {Date|number} [args.eventTime]     Date / unix-ms / unix-s — defaults to now
 * @param {string} [args.eventSourceUrl]
 * @param {object} [args.userData]           From buildUserData()
 * @param {object} [args.customData]
 * @param {string} [args.actionSource]       Defaults to "website"
 */
export function buildCAPIEvent({
  eventName,
  eventId,
  eventTime,
  eventSourceUrl,
  userData,
  customData,
  actionSource = "website",
} = {}) {
  if (!eventName) throw new Error("buildCAPIEvent: eventName required");
  if (!eventId) throw new Error("buildCAPIEvent: eventId required (dedup key)");

  const ts = (() => {
    if (eventTime instanceof Date) return Math.floor(eventTime.getTime() / 1000);
    if (typeof eventTime === "number") {
      // Heuristic: ms vs s
      return eventTime > 1e12 ? Math.floor(eventTime / 1000) : Math.floor(eventTime);
    }
    return Math.floor(Date.now() / 1000);
  })();

  const evt = {
    event_name: eventName,
    event_time: ts,
    event_id: eventId,
    action_source: actionSource,
    user_data: userData ?? {},
    // Empty array signals "full data processing" (no Limited Data Use).
    // Meta's docs require this field to be present even when not restricted —
    // omitting it can trigger ambiguous handling for users in regions with
    // privacy laws (CCPA/GDPR). Pakistani merchants don't currently fall
    // under LDU rules, but sending [] explicitly is the documented best
    // practice and improves data quality scoring on Meta's side.
    data_processing_options: [],
  };
  if (eventSourceUrl) evt.event_source_url = eventSourceUrl;
  if (customData && Object.keys(customData).length) evt.custom_data = customData;
  return evt;
}

// ─── Sending ──────────────────────────────────────────────────────────────────

// POST events to /{dataset_id}/events. Supports batches up to 1000 events.
// Returns { ok, status, body, traceId, eventsReceived }.
/**
 * @param {object} args
 * @param {string} args.accessToken
 * @param {string} args.datasetId
 * @param {Array<object>} args.events
 * @param {string} [args.testEventCode]
 */
export async function postCAPIEvents({ accessToken, datasetId, events, testEventCode } = {}) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: true, status: 204, body: null, traceId: null, eventsReceived: 0 };
  }
  const url = `${GRAPH_BASE}/${datasetId}/events`;
  const body = { data: events };
  if (testEventCode) body.test_event_code = testEventCode;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  let parsed = null;
  try { parsed = await res.json(); } catch { /* non-JSON body */ }

  return {
    ok: res.ok,
    status: res.status,
    body: parsed,
    traceId: parsed?.fbtrace_id ?? null,
    eventsReceived: parsed?.events_received ?? 0,
  };
}

// Send events for a specific shop — looks up the connection, posts to Meta,
// logs to delivery_log on success, enqueues to capi_retries on failure.
//
// `events` must already be CAPI-formatted (one or more buildCAPIEvent results).
/**
 * @param {object} args
 * @param {string} args.storeId
 * @param {Array<object>} args.events
 * @param {string} [args.testEventCode]
 */
export async function sendCAPIEventsForShop({ storeId, events, testEventCode } = {}) {
  const lookup = await lookupConnection(storeId);
  if (!lookup.conn) {
    // Silent-drop guard: the original bug was that a drop here left no DB
    // trace at all (no log row, no retry row). When the connection row
    // EXISTS but the lookup didn't return a usable conn (status flipped,
    // query error, etc.), we now write a `dropped` log row so the recon
    // cron and any monitoring pick it up. When the row is absent (merchant
    // intentionally disconnected) the FK on store_id would block the
    // insert anyway — we just console.warn and move on.
    if (lookup.exists) {
      const supabase = adminClient();
      await logDeliveries(
        supabase,
        storeId,
        events,
        { traceId: null, status: 0, body: { error: { message: lookup.status ? `inactive_${lookup.status}` : "no_connection" } } },
        "dropped"
      ).catch((err) => {
        console.warn(`[meta-capi logDeliveries ${storeId}] dropped-row insert failed:`, err?.message ?? err);
      });
    } else {
      console.warn(`[meta-capi sendCAPIEventsForShop ${storeId}] dropping ${events.length} event(s) — connection row absent (merchant disconnected)`);
    }
    return { ok: false, reason: "no_connection", events: events.length };
  }
  const conn = lookup.conn;

  const supabase = adminClient();
  let result;
  try {
    result = await postCAPIEvents({
      accessToken: conn.accessToken,
      datasetId: conn.datasetId,
      events,
      testEventCode,
    });
  } catch (err) {
    // Network failure — retry every event individually.
    await enqueueRetries(supabase, storeId, conn.datasetId, events, String(err?.message ?? err));
    return { ok: false, reason: "network_error", events: events.length };
  }

  if (result.ok) {
    await logDeliveries(supabase, storeId, events, result, "sent");
    await supabase
      .from("meta_pixel_connections")
      .update({ last_event_sent_at: new Date().toISOString() })
      .eq("store_id", storeId);
    return { ok: true, eventsReceived: result.eventsReceived, traceId: result.traceId };
  }

  // 4xx errors usually mean payload problems we can't fix on retry — log + drop.
  // 429 / 5xx are transient and worth retrying.
  const transient = result.status === 429 || (result.status >= 500 && result.status < 600);
  if (transient) {
    await enqueueRetries(
      supabase,
      storeId,
      conn.datasetId,
      events,
      `HTTP ${result.status}: ${result.body?.error?.message ?? "transient"}`
    );
  } else {
    await logDeliveries(supabase, storeId, events, result, "failed");
    // Auth errors (190 / OAuthException) → mark connection broken so the UI
    // shows a reconnect banner.
    const code = result.body?.error?.code;
    if (code === 190 || result.status === 401 || result.status === 403) {
      await supabase
        .from("meta_pixel_connections")
        .update({
          status: "error",
          status_reason: result.body?.error?.message ?? `HTTP ${result.status}`,
        })
        .eq("store_id", storeId);
    }
  }

  return { ok: false, reason: `http_${result.status}`, events: events.length };
}

async function logDeliveries(supabase, storeId, events, result, status) {
  const rows = events.map((e) => ({
    store_id: storeId,
    event_id: e.event_id,
    event_name: e.event_name,
    status,
    trace_id: result.traceId,
    http_status: result.status,
    // Both `failed` (Meta rejected) and `dropped` (we never sent — broken
    // local connection state) carry an error reason; `sent` doesn't.
    error_msg: status === "sent" ? null : result.body?.error?.message ?? null,
  }));
  // Service role bypasses RLS, but capi_delivery_log has a row-cap trigger
  // that fires per insert — keeps each shop's tail at <=500 rows.
  await supabase.from("capi_delivery_log").insert(rows);
}

async function enqueueRetries(supabase, storeId, datasetId, events, errorMsg) {
  const rows = events.map((e) => ({
    store_id: storeId,
    dataset_id: datasetId,
    event_id: e.event_id,
    event_name: e.event_name,
    event_time: new Date(e.event_time * 1000).toISOString(),
    payload: e,
    attempts: 0,
    next_attempt_at: nextAttemptAt(0).toISOString(),
    last_error: errorMsg,
  }));
  // ON CONFLICT DO NOTHING — if the same event_id is already enqueued, don't
  // duplicate. The retry cron picks up the existing row.
  await supabase.from("capi_retries").upsert(rows, { onConflict: "event_id", ignoreDuplicates: true });
}

function nextAttemptAt(attemptsSoFar) {
  const idx = Math.min(attemptsSoFar, BACKOFF_MINUTES.length - 1);
  return new Date(Date.now() + BACKOFF_MINUTES[idx] * 60_000);
}

// ─── Retry drain (called from cron) ───────────────────────────────────────────

// Drains up to N due retries, posts each to Meta, removes on success or
// reschedules on failure. Stops sending for a shop if its connection is broken.
export async function drainRetries({ limit = 100 } = {}) {
  const supabase = adminClient();
  const { data: due } = await supabase
    .from("capi_retries")
    .select("*")
    .lte("next_attempt_at", new Date().toISOString())
    .lt("attempts", 5)
    .order("next_attempt_at")
    .limit(limit);

  if (!due?.length) return { processed: 0, succeeded: 0, failed: 0, dropped: 0 };

  // Group by shop so we can batch and reuse the connection lookup.
  const byShop = new Map();
  for (const row of due) {
    if (!byShop.has(row.store_id)) byShop.set(row.store_id, []);
    byShop.get(row.store_id).push(row);
  }

  let succeeded = 0;
  let failed = 0;
  let dropped = 0;

  for (const [shopId, rows] of byShop) {
    const conn = await getCAPIConnection(shopId);
    if (!conn) {
      // Connection went away — drop these events; they're unrecoverable.
      const ids = rows.map((r) => r.id);
      await supabase.from("capi_retries").delete().in("id", ids);
      dropped += rows.length;
      continue;
    }

    // Send up to 1000 events per call.
    const events = rows.map((r) => r.payload);
    let result;
    try {
      result = await postCAPIEvents({
        accessToken: conn.accessToken,
        datasetId: conn.datasetId,
        events,
      });
    } catch (err) {
      result = { ok: false, status: 0, body: { error: { message: String(err?.message ?? err) } } };
    }

    if (result.ok) {
      await logDeliveries(supabase, shopId, events, result, "sent");
      await supabase.from("capi_retries").delete().in("id", rows.map((r) => r.id));
      succeeded += rows.length;
    } else {
      // Bump attempts + reschedule. If we hit attempts >= 5, log as failed
      // and delete (5-attempt cap is enforced in the SELECT above too).
      const errMsg = result.body?.error?.message ?? `HTTP ${result.status}`;
      const updates = rows.map((r) => {
        const nextAttempts = r.attempts + 1;
        if (nextAttempts >= 5) return { id: r.id, drop: true };
        return {
          id: r.id,
          drop: false,
          attempts: nextAttempts,
          next_attempt_at: nextAttemptAt(nextAttempts).toISOString(),
          last_error: errMsg,
        };
      });

      const toDrop = updates.filter((u) => u.drop).map((u) => u.id);
      const toBump = updates.filter((u) => !u.drop);

      if (toDrop.length) {
        const droppedEvents = rows
          .filter((r) => toDrop.includes(r.id))
          .map((r) => r.payload);
        await logDeliveries(supabase, shopId, droppedEvents, result, "failed");
        await supabase.from("capi_retries").delete().in("id", toDrop);
        dropped += toDrop.length;
      }

      // Update each row's attempts/next_attempt_at — Supabase doesn't have a
      // bulk UPDATE-with-different-values helper, so we issue them one by one.
      // This batch is small (<=100 rows total across all shops).
      for (const u of toBump) {
        await supabase
          .from("capi_retries")
          .update({
            attempts: u.attempts,
            next_attempt_at: u.next_attempt_at,
            last_error: u.last_error,
          })
          .eq("id", u.id);
      }
      failed += toBump.length;
    }
  }

  return {
    processed: due.length,
    succeeded,
    failed,
    dropped,
  };
}

// ─── Helper: Shopify event name → Meta standard event ─────────────────────────

const EVENT_NAME_MAP = {
  page_viewed: "PageView",
  product_viewed: "ViewContent",
  product_added_to_cart: "AddToCart",
  cart_viewed: null, // skip — noisy, not useful for ecom optimization
  search_submitted: "Search",
  checkout_started: "InitiateCheckout",
  checkout_address_info_submitted: null,
  checkout_contact_info_submitted: null,
  checkout_shipping_info_submitted: null,
  payment_info_submitted: "AddPaymentInfo",
  checkout_completed: "Purchase",
};

export function shopifyEventToMeta(name) {
  return EVENT_NAME_MAP[name] ?? null;
}
