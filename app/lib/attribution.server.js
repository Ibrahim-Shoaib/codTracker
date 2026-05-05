// Multi-touch attribution layer.
//
// Two responsibilities:
//   1. recordPurchaseAttribution — called by the webhook handler after
//      a successful CAPI Purchase fire. Captures the link from the
//      Shopify order to the resolved visitor_id (+ recovered_via tier),
//      computes the touch journey from visitor_events, and upserts
//      one row into purchase_attribution.
//   2. Pure attribution-model functions — given an array of touches and
//      a value, return per-source/per-campaign credit splits. Used by
//      the dashboard for any model the merchant selects.
//
// All hashed PII / cookie data live elsewhere (visitors / visitor_events).
// This module only deals with the (order, visitor, touches, model)
// math.

import { createClient } from "@supabase/supabase-js";

function adminClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// ─── Touch-journey reconstruction ─────────────────────────────────────────

// Pull the visitor's events leading up to the Purchase, ordered chronologically.
// Returns an array of { event_name, occurred_at, utm_source, utm_campaign,
// utm_content, fbp, fbc, ip, ua } sorted ascending by occurred_at.
//
// `before` is the Purchase timestamp — we exclude events at or after it
// because anything that happened post-conversion isn't a touch that
// drove this Purchase.
export async function getTouchJourney({ storeId, visitorId, before }) {
  if (!storeId || !visitorId) return [];
  const supabase = adminClient();
  const { data } = await supabase
    .from("visitor_events")
    .select("event_name, occurred_at, utm_source, utm_campaign, utm_content, fbp, fbc, ip, ua")
    .eq("store_id", storeId)
    .eq("visitor_id", visitorId)
    .lt("occurred_at", before instanceof Date ? before.toISOString() : before)
    .order("occurred_at", { ascending: true });
  return data ?? [];
}

// Collapse adjacent visitor-events that are almost-certainly the same
// physical visitor recorded under different visitor_ids — Meta's iOS IAB
// wipes cookies between page loads so a single user can produce N
// visitor_ids in a session. Without collapsing, multi-touch models
// over-count touch chains for IAB users.
//
// Heuristic: two touches are "the same logical visitor" when they
// share (ip, ua) AND are within 5 minutes of each other. Conservative
// enough that a different person on the same NAT IP an hour later
// stays a separate touch. Aggressive enough that a cookie-wiped
// visitor's three back-to-back PageViews collapse to one.
export function collapseIabDuplicates(touches) {
  if (!Array.isArray(touches) || touches.length <= 1) return touches ?? [];
  const FIVE_MIN = 5 * 60 * 1000;
  const out = [touches[0]];
  for (let i = 1; i < touches.length; i++) {
    const cur = touches[i];
    const prev = out[out.length - 1];
    const sameIpUa =
      cur.ip && prev.ip && cur.ua && prev.ua &&
      cur.ip === prev.ip && cur.ua === prev.ua;
    const closeInTime =
      Math.abs(new Date(cur.occurred_at).getTime() - new Date(prev.occurred_at).getTime()) <= FIVE_MIN;
    // "Same campaign" is forgiving: explicit-equal OR either side is
    // null. The null case covers a common pattern: PageView lands with
    // ?utm_campaign=X, then a follow-up AddToCart on /cart fires with
    // no URL utms — those should still inherit the campaign context of
    // the originating ad click rather than splitting attribution.
    const sameCampaign =
      cur.utm_campaign === prev.utm_campaign ||
      cur.utm_campaign == null ||
      prev.utm_campaign == null;
    if (sameIpUa && closeInTime && sameCampaign) {
      // Same logical visitor — keep the first touch of the cluster.
      // Optionally we could merge utm_* if one was null and the other set;
      // doing that here so a zero-utm refresh after the ad-click PageView
      // doesn't drop the campaign attribution.
      if (!prev.utm_source && cur.utm_source) prev.utm_source = cur.utm_source;
      if (!prev.utm_campaign && cur.utm_campaign) prev.utm_campaign = cur.utm_campaign;
      if (!prev.utm_content && cur.utm_content) prev.utm_content = cur.utm_content;
      continue;
    }
    out.push(cur);
  }
  return out;
}

// ─── Attribution models ───────────────────────────────────────────────────
//
// Each model takes:
//   - touches: array of { occurred_at, utm_source, utm_campaign, utm_content }
//     (already collapsed; chronological)
//   - value: number — the Purchase value to split
//   - opts: model-specific (e.g. half-life days for time-decay)
// And returns an array of { utm_source, utm_campaign, utm_content, weight, credit }
// where:
//   - weight ∈ [0,1], all weights sum to 1 (or 0 if no touches)
//   - credit = weight * value
//
// Touches without any utm_source are treated as "(direct)" — they still
// get credit per the model, but get aggregated under the "(direct)"
// channel in the dashboard.

function asKey(t) {
  return {
    utm_source: t.utm_source ?? "(direct)",
    utm_campaign: t.utm_campaign ?? "(none)",
    utm_content: t.utm_content ?? "(none)",
  };
}

export function attributeFirstTouch(touches, value) {
  if (!touches?.length) return [];
  const t = touches[0];
  return [{ ...asKey(t), weight: 1, credit: Number(value ?? 0) }];
}

export function attributeLastTouch(touches, value) {
  if (!touches?.length) return [];
  const t = touches[touches.length - 1];
  return [{ ...asKey(t), weight: 1, credit: Number(value ?? 0) }];
}

export function attributeLinear(touches, value) {
  if (!touches?.length) return [];
  const w = 1 / touches.length;
  const v = Number(value ?? 0);
  return touches.map((t) => ({ ...asKey(t), weight: w, credit: w * v }));
}

// Position-based: 40% to first, 40% to last, 20% spread evenly over
// any middle touches. The classic U-shape. With 1 touch it collapses
// to last-touch (=first-touch). With 2 touches it's 50/50. With 3+ the
// weights are 0.4 / 0.2/(n-2) each / 0.4.
export function attributePositionBased(touches, value) {
  if (!touches?.length) return [];
  const n = touches.length;
  const v = Number(value ?? 0);
  if (n === 1) return [{ ...asKey(touches[0]), weight: 1, credit: v }];
  if (n === 2) {
    return [
      { ...asKey(touches[0]), weight: 0.5, credit: 0.5 * v },
      { ...asKey(touches[1]), weight: 0.5, credit: 0.5 * v },
    ];
  }
  const middleW = 0.2 / (n - 2);
  return touches.map((t, i) => {
    const weight = i === 0 || i === n - 1 ? 0.4 : middleW;
    return { ...asKey(t), weight, credit: weight * v };
  });
}

// Time-decay: weight = 2^(-Δdays / halfLifeDays), then normalized so
// weights sum to 1. More-recent touches get more credit. Default
// half-life of 7 days matches the Meta ads attribution-window default.
export function attributeTimeDecay(touches, value, opts = {}) {
  if (!touches?.length) return [];
  const halfLifeDays = Number(opts.halfLifeDays ?? 7);
  const v = Number(value ?? 0);
  const last = touches[touches.length - 1];
  const lastTs = new Date(last.occurred_at).getTime();
  const raw = touches.map((t) => {
    const dtDays =
      (lastTs - new Date(t.occurred_at).getTime()) / (24 * 60 * 60 * 1000);
    return Math.pow(2, -dtDays / halfLifeDays);
  });
  const total = raw.reduce((s, x) => s + x, 0) || 1;
  return touches.map((t, i) => {
    const weight = raw[i] / total;
    return { ...asKey(t), weight, credit: weight * v };
  });
}

// Dispatch table for model selection from a string.
export const ATTRIBUTION_MODELS = {
  first_touch: attributeFirstTouch,
  last_touch: attributeLastTouch,
  linear: attributeLinear,
  position_based: attributePositionBased,
  time_decay: attributeTimeDecay,
};

export function applyModel(modelName, touches, value, opts) {
  const fn = ATTRIBUTION_MODELS[modelName];
  if (!fn) throw new Error(`Unknown attribution model: ${modelName}`);
  return fn(touches, value, opts);
}

// ─── Aggregator: per-Purchase credits → per-campaign rollup ─────────────────
//
// Given an array of {utm_source, utm_campaign, utm_content, credit}
// rows from many Purchases, group and sum into one row per
// (utm_source, utm_campaign, utm_content). Used by the dashboard to
// produce the campaign-revenue table for any non-last-touch model
// (last-touch is precomputed via the SQL RPC).
export function rollupCredits(creditRows) {
  const map = new Map();
  for (const r of creditRows ?? []) {
    const key = `${r.utm_source}|${r.utm_campaign}|${r.utm_content}`;
    if (!map.has(key)) {
      map.set(key, {
        utm_source: r.utm_source,
        utm_campaign: r.utm_campaign,
        utm_content: r.utm_content,
        credit: 0,
        touches: 0,
      });
    }
    const agg = map.get(key);
    agg.credit += Number(r.credit ?? 0);
    agg.touches += 1;
  }
  return Array.from(map.values()).sort((a, b) => b.credit - a.credit);
}

// ─── Webhook-side recorder ────────────────────────────────────────────────
//
// Idempotent on (store_id, order_id) — webhook retries reuse the same
// row. Best-effort: never blocks the webhook ack on a DB failure.
export async function recordPurchaseAttribution({
  storeId,
  orderId,
  visitorId,
  customerId,
  recoveredVia,
  orderValue,
  currency,
  orderCreatedAt,
}) {
  try {
    let touches = [];
    let touchCount = 0;
    let timeToConvertSec = null;
    let lastTouch = null;

    if (visitorId) {
      const raw = await getTouchJourney({
        storeId,
        visitorId,
        before: orderCreatedAt,
      });
      touches = collapseIabDuplicates(raw);
      touchCount = touches.length;
      if (touches.length) {
        lastTouch = touches[touches.length - 1];
        const first = touches[0];
        timeToConvertSec = Math.max(
          0,
          Math.floor(
            (new Date(orderCreatedAt).getTime() -
              new Date(first.occurred_at).getTime()) /
              1000
          )
        );
      }
    }

    const supabase = adminClient();
    await supabase
      .from("purchase_attribution")
      .upsert(
        {
          store_id: storeId,
          order_id: String(orderId),
          visitor_id: visitorId ?? null,
          customer_id: customerId != null ? String(customerId) : null,
          recovered_via: recoveredVia ?? "none",
          order_value: orderValue ?? null,
          currency: currency ?? null,
          order_created_at:
            orderCreatedAt instanceof Date
              ? orderCreatedAt.toISOString()
              : orderCreatedAt,
          last_touch_utm_source: lastTouch?.utm_source ?? null,
          last_touch_utm_campaign: lastTouch?.utm_campaign ?? null,
          last_touch_utm_content: lastTouch?.utm_content ?? null,
          touch_count: touchCount,
          time_to_convert_sec: timeToConvertSec,
        },
        { onConflict: "store_id,order_id" }
      );
  } catch (err) {
    console.error(`[attribution] recordPurchaseAttribution failed:`, err);
  }
}
