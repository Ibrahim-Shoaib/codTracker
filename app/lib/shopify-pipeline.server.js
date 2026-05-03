// Real-time "Unfulfilled in Shopify" pipeline value, bucketed into the four
// dashboard period ranges. Used by the dashboard loader to render the yellow
// "PKR X · Unfulfilled" pill under the Sales number on each KPI card.
//
// Single REST call to Shopify Admin Orders, then we bucket by PKT-localized
// created_at — much cheaper than firing four range-scoped queries. The
// volume cap (4 pages × 250 = 1000 unfulfilled orders) is far above realistic
// COD store backlogs.

import { formatPKTDate } from './dates.server.js';

const API_VERSION = '2025-10';

function emptyBuckets() {
  return {
    today:     { count: 0, value: 0 },
    yesterday: { count: 0, value: 0 },
    mtd:       { count: 0, value: 0 },
    lastMonth: { count: 0, value: 0 },
  };
}

function parseNextUrl(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

// session: Shopify offline session (must expose `shop` and `accessToken`)
// ranges:  { today: {from,to}, yesterday: {from,to}, mtd: {from,to}, lastMonth: {from,to} }
//          where from/to are PKT YYYY-MM-DD strings.
//
// Returns the same shape, with each value being { count, value }.
// On failure (no token, network error, Shopify error) returns null so the
// caller can render the dashboard without the Unfulfilled pills rather than
// blowing up.
export async function fetchUnfulfilledPipeline(session, ranges) {
  if (!session?.accessToken || !session?.shop) return null;

  // Earliest from-date across all 4 ranges. Last Month is usually the floor,
  // but we don't assume the order — just take the min.
  const floor = Object.values(ranges).reduce(
    (min, r) => (r.from < min ? r.from : min),
    '9999-12-31'
  );
  // Express the floor as start-of-day PKT in ISO 8601 with +05:00 offset so
  // Shopify's created_at_min semantics line up with our PKT day boundaries.
  const createdAtMin = `${floor}T00:00:00+05:00`;

  const headers = {
    'X-Shopify-Access-Token': session.accessToken,
    'Content-Type': 'application/json',
  };

  let url =
    `https://${session.shop}/admin/api/${API_VERSION}/orders.json` +
    `?fulfillment_status=unfulfilled&status=open` +
    `&created_at_min=${encodeURIComponent(createdAtMin)}` +
    `&limit=250&fields=id,created_at,total_price`;

  const collected = [];
  for (let page = 0; page < 4 && url; page++) {
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      console.error('Shopify pipeline fetch network error:', err);
      return null;
    }
    if (!res.ok) {
      console.error(`Shopify pipeline fetch failed: ${res.status}`);
      return null;
    }
    const { orders } = await res.json();
    for (const o of orders ?? []) {
      collected.push({
        createdAt: o.created_at,
        amount:    Number(o.total_price) || 0,
      });
    }
    url = parseNextUrl(res.headers.get('link'));
  }

  const buckets = emptyBuckets();
  for (const o of collected) {
    const pkt = formatPKTDate(new Date(o.createdAt));
    for (const [key, range] of Object.entries(ranges)) {
      if (pkt >= range.from && pkt <= range.to) {
        buckets[key].count += 1;
        buckets[key].value += o.amount;
      }
    }
  }
  return buckets;
}

// Single-range variant — returns { count, value } for the Unfulfilled pill
// on a custom-date KPI card. One Shopify Admin call, scoped to [from, to]
// by created_at_min only — orders dated after `to` are filtered out in JS
// to avoid a second range param the REST endpoint doesn't reliably accept.
//
// Returns { count: 0, value: 0 } on any failure so the caller can render
// the pill at zero rather than blowing up the dashboard.
export async function fetchUnfulfilledForRange(session, fromYmd, toYmd) {
  if (!session?.accessToken || !session?.shop) return { count: 0, value: 0 };

  const createdAtMin = `${fromYmd}T00:00:00+05:00`;
  const headers = {
    'X-Shopify-Access-Token': session.accessToken,
    'Content-Type': 'application/json',
  };

  let url =
    `https://${session.shop}/admin/api/${API_VERSION}/orders.json` +
    `?fulfillment_status=unfulfilled&status=open` +
    `&created_at_min=${encodeURIComponent(createdAtMin)}` +
    `&limit=250&fields=id,created_at,total_price`;

  let count = 0;
  let value = 0;
  for (let page = 0; page < 4 && url; page++) {
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      console.error('Shopify single-range pipeline fetch network error:', err);
      return { count, value };
    }
    if (!res.ok) {
      console.error(`Shopify single-range pipeline fetch failed: ${res.status}`);
      return { count, value };
    }
    const { orders } = await res.json();
    for (const o of orders ?? []) {
      const pkt = formatPKTDate(new Date(o.created_at));
      if (pkt >= fromYmd && pkt <= toYmd) {
        count += 1;
        value += Number(o.total_price) || 0;
      }
    }
    url = parseNextUrl(res.headers.get('link'));
  }
  return { count, value };
}
