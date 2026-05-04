// Cross-session visitor identity store. Powers the multi-session
// attribution feature — every storefront event UPSERTs a row in
// `visitors` keyed on a long-lived first-party cookie, and the
// Purchase webhook joins on that row at conversion time so Meta
// receives the union of every signal we ever saw for that visitor
// (not just what's in the live order webhook payload).
//
// All hashed PII is normalized + hashed via the same helpers used
// for CAPI user_data, so the values written here are identical to
// what gets sent to Meta — no double-hashing, no normalization drift.

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  hashEmail,
  hashPhone,
  hashName,
  hashCity,
  hashState,
  hashZip,
  hashCountry,
  hashExternalId,
} from "./meta-hash.server.js";

// fbc_history / utm_history are jsonb arrays. Capping at 5 keeps the
// row size bounded — beyond that the most-recent entries are kept and
// older ones drop out.
const HISTORY_CAP = 5;

function adminClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// Generate a fresh visitor id. crypto.randomUUID() — universally
// available on Node 14+ and produces a 36-char v4 UUID (122 bits of
// entropy, collision-safe even at billions of visitors).
export function mintVisitorId() {
  return randomUUID();
}

// Resolve or mint a visitor id for an incoming request. Reads the
// `cod_visitor_id` cookie if present and well-formed; otherwise mints
// a new one. Returns { visitorId, isNew }.
//
// Accepts both raw UUIDs (8-4-4-4-12 hex) and our older 32-hex form
// for forward-compat — though the current minter only emits standard
// UUIDs.
export function resolveVisitorId(cookieHeader) {
  if (cookieHeader) {
    const match = cookieHeader.match(
      /(?:^|;\s*)cod_visitor_id=([a-f0-9-]{32,40})/i
    );
    if (match) {
      return { visitorId: match[1], isNew: false };
    }
  }
  return { visitorId: mintVisitorId(), isNew: true };
}

// Build the Set-Cookie header value for the visitor id.
//
// HTTP-set (not document.cookie) so Safari ITP grants the full
// Max-Age — same pattern Aimerce / Triple Whale / Stape use to bypass
// ITP's 7-day cap on JS-set first-party cookies.
//
// HttpOnly: theme block doesn't read this directly — it gets the
// visitor_id from /apps/tracking/config's response body. HttpOnly
// closes the XSS-exfiltration vector.
//
// SameSite=Lax: App Proxy delivers from the merchant's storefront
// origin, which is technically a cross-site context for cookies set
// by the proxy. Lax is the right balance — cookies travel on top-
// level navigations and same-site subrequests.
export function visitorCookieHeader(visitorId) {
  const ONE_YEAR = 60 * 60 * 24 * 365;
  return `cod_visitor_id=${visitorId}; Max-Age=${ONE_YEAR}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

// Append-and-cap helper for the jsonb history arrays. Dedups by
// content so repeated identical fbcs/UTMs don't bloat the row.
function appendHistory(existing, entry) {
  if (!entry) return Array.isArray(existing) ? existing : [];
  const arr = Array.isArray(existing) ? existing.slice() : [];
  const sig = JSON.stringify(entry);
  if (arr.some((x) => JSON.stringify({ ...x, seen_at: undefined }) === JSON.stringify({ ...entry, seen_at: undefined }))) {
    return arr;
  }
  arr.push({ ...entry, seen_at: new Date().toISOString() });
  return arr.slice(-HISTORY_CAP);
}

// "Use new if present, else preserve old" — semantics for cross-
// session enrichment. Once we've seen an em_hash, it stays even if
// later events are anonymous. If a later event has a different
// em_hash, the new one wins (visitor changed identity).
function preserveOrUpdate(newValue, oldValue) {
  return newValue ?? oldValue ?? null;
}

// UPSERT a visitor row given whatever signals are available on the
// current event. Single-round-trip: SELECT existing, merge in JS,
// UPSERT merged result.
//
// `input` keys (all optional except storeId + visitorId):
//   email, phone, firstName, lastName, city, state, zip, country, externalId,
//   fbp, fbc, fbclid, ip, ua, utmSource, utmCampaign, utmContent
//
// Returns nothing — best-effort, never blocks the calling event path.
export async function upsertVisitor({ storeId, visitorId, input = {} }) {
  if (!storeId || !visitorId) return;

  const supabase = adminClient();

  // Hash everything we have. Empty/invalid inputs return null and the
  // preserveOrUpdate helper keeps the prior value.
  const country = input.country ?? null;
  const newHashes = {
    em_hash: input.email ? hashEmail(input.email) : null,
    ph_hash: input.phone ? hashPhone(input.phone, country) : null,
    fn_hash: input.firstName ? hashName(input.firstName) : null,
    ln_hash: input.lastName ? hashName(input.lastName) : null,
    ct_hash: input.city ? hashCity(input.city) : null,
    st_hash: input.state ? hashState(input.state) : null,
    zp_hash: input.zip ? hashZip(input.zip) : null,
    country_hash: input.country ? hashCountry(input.country) : null,
    external_id_hash: input.externalId
      ? hashExternalId(input.externalId)
      : null,
  };

  try {
    // Read existing row (may be null on first event of a new visitor).
    const { data: existing } = await supabase
      .from("visitors")
      .select("*")
      .eq("store_id", storeId)
      .eq("visitor_id", visitorId)
      .maybeSingle();

    // Merge. Hash columns and latest_* both use preserveOrUpdate —
    // "freshness wins, but never null-out a prior value with an empty
    // event." History arrays append-and-cap.
    const merged = {
      store_id: storeId,
      visitor_id: visitorId,
      em_hash: preserveOrUpdate(newHashes.em_hash, existing?.em_hash),
      ph_hash: preserveOrUpdate(newHashes.ph_hash, existing?.ph_hash),
      fn_hash: preserveOrUpdate(newHashes.fn_hash, existing?.fn_hash),
      ln_hash: preserveOrUpdate(newHashes.ln_hash, existing?.ln_hash),
      ct_hash: preserveOrUpdate(newHashes.ct_hash, existing?.ct_hash),
      st_hash: preserveOrUpdate(newHashes.st_hash, existing?.st_hash),
      zp_hash: preserveOrUpdate(newHashes.zp_hash, existing?.zp_hash),
      country_hash: preserveOrUpdate(
        newHashes.country_hash,
        existing?.country_hash
      ),
      external_id_hash: preserveOrUpdate(
        newHashes.external_id_hash,
        existing?.external_id_hash
      ),
      latest_fbp: preserveOrUpdate(input.fbp ?? null, existing?.latest_fbp),
      latest_fbc: preserveOrUpdate(input.fbc ?? null, existing?.latest_fbc),
      latest_ip: preserveOrUpdate(input.ip ?? null, existing?.latest_ip),
      latest_ua: preserveOrUpdate(input.ua ?? null, existing?.latest_ua),
      fbc_history: appendHistory(
        existing?.fbc_history ?? [],
        input.fbc
          ? { value: input.fbc, fbclid: input.fbclid ?? null }
          : null
      ),
      utm_history: appendHistory(
        existing?.utm_history ?? [],
        input.utmSource || input.utmCampaign || input.utmContent
          ? {
              source: input.utmSource ?? null,
              campaign: input.utmCampaign ?? null,
              content: input.utmContent ?? null,
            }
          : null
      ),
      last_seen_at: new Date().toISOString(),
    };

    // Preserve first_seen_at on conflict; new rows get the default.
    if (!existing) {
      merged.first_seen_at = merged.last_seen_at;
    }

    await supabase
      .from("visitors")
      .upsert(merged, { onConflict: "store_id,visitor_id" });
  } catch (err) {
    // Best-effort — never block the calling event path on a DB failure.
    console.error(`[visitors] upsertVisitor failed:`, err);
  }
}

// Read the full visitor row for Purchase-webhook enrichment. Returns
// null if no row matches (anonymous visitor or pre-cookie merchant
// install).
export async function getVisitor({ storeId, visitorId }) {
  if (!storeId || !visitorId) return null;
  const supabase = adminClient();
  const { data } = await supabase
    .from("visitors")
    .select("*")
    .eq("store_id", storeId)
    .eq("visitor_id", visitorId)
    .maybeSingle();
  return data ?? null;
}

// Insert a per-event breadcrumb. 30-day retention via the trim cron.
// Best-effort — never blocks the CAPI fire path.
export async function recordVisitorEvent({
  storeId,
  visitorId,
  eventName,
  eventId,
  url,
  ip,
  ua,
  fbp,
  fbc,
  utmSource,
  utmCampaign,
  utmContent,
}) {
  if (!storeId || !visitorId || !eventName) return;
  try {
    const supabase = adminClient();
    await supabase.from("visitor_events").insert({
      store_id: storeId,
      visitor_id: visitorId,
      event_name: eventName,
      event_id: eventId ?? null,
      url: url ?? null,
      ip: ip ?? null,
      ua: ua ?? null,
      fbp: fbp ?? null,
      fbc: fbc ?? null,
      utm_source: utmSource ?? null,
      utm_campaign: utmCampaign ?? null,
      utm_content: utmContent ?? null,
    });
  } catch (err) {
    console.error(`[visitors] recordVisitorEvent failed:`, err);
  }
}

// Choose the best fbc to send on a Purchase event. Order of preference:
//   1. The order's cart-attribute fbc (if identity-relay captured it)
//   2. The visitor row's latest_fbc
//   3. The most-recent entry from visitor.fbc_history
//   4. Server-side synthesis from order.landing_site fbclid (caller's
//      job — done in cart-attributes.server.js)
//
// Returns { fbc, source } where source explains where it came from
// (useful for diagnostic logging).
export function pickBestFbc({ cartAttrFbc, visitor }) {
  if (cartAttrFbc) return { fbc: cartAttrFbc, source: "cart_attribute" };
  if (visitor?.latest_fbc) return { fbc: visitor.latest_fbc, source: "visitor_latest" };
  const history = visitor?.fbc_history;
  if (Array.isArray(history) && history.length) {
    const latest = history[history.length - 1];
    if (latest?.value) return { fbc: latest.value, source: "visitor_history" };
  }
  return { fbc: null, source: null };
}
