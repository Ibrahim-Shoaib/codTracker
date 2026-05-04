// Parses Meta identity (fbp/fbc/fbclid + UA) out of a Shopify order /
// checkout / refund webhook payload. The identity rides on cart attributes
// written by the Theme App Extension snippet on the storefront — see
// extensions/cart-identity-relay/.
//
// Cart attributes serialize to `note_attributes` on orders and `attributes`
// on checkouts. Both are arrays of { name, value } pairs. We support both.

const KEYS = {
  fbp: ["_fbp", "fbp"],
  fbc: ["_fbc", "fbc"],
  fbclid: ["_fbclid", "fbclid"],
  clientUa: ["_client_ua", "client_ua"],
  eventId: ["_cod_event_id", "event_id"],
};

function pickAttr(attrs, candidates) {
  if (!Array.isArray(attrs)) return null;
  for (const a of attrs) {
    const name = a?.name ?? a?.key;
    if (!name) continue;
    if (candidates.includes(name)) {
      const v = a?.value;
      if (v != null && String(v).length) return String(v);
    }
  }
  return null;
}

// Pulls `fbclid` (and similar Meta click params) out of a URL's query string.
// Used as a fallback when cart attributes are empty — typical for visitors
// who use Shopify's "Buy It Now" button (skips the persistent cart entirely)
// or come through Facebook's iOS in-app browser (cookie restrictions).
// Shopify's order webhook payload exposes the landing URL as `landing_site`.
function extractFbclidFromUrl(maybeUrl) {
  if (!maybeUrl) return null;
  try {
    // landing_site can be either a full URL or just a path. URL constructor
    // requires an absolute URL; pass any base for path-only forms.
    const u = new URL(maybeUrl, "https://example.com");
    const params = u.searchParams;
    return params.get("fbclid") ?? null;
  } catch {
    return null;
  }
}

// Order webhook payload uses `note_attributes`. Checkout uses `attributes`.
// Some webhooks also surface them under `cart_token`+`presentment_currency`.
export function extractIdentityFromOrder(order) {
  const attrs = order?.note_attributes ?? order?.attributes ?? [];

  const fbp = pickAttr(attrs, KEYS.fbp);
  let fbc = pickAttr(attrs, KEYS.fbc);
  let fbclid = pickAttr(attrs, KEYS.fbclid);

  // Fallback: if neither cart attributes carry fbclid, parse it from the
  // order's landing URL. This covers Buy It Now (no cart write happened),
  // Facebook in-app browsers (cookies stripped), and any path where
  // identity-relay didn't get a chance to persist the click id. Without
  // this, every paid Meta-ad click that goes through Buy It Now would lose
  // its attribution server-side.
  if (!fbclid && order?.landing_site) {
    fbclid = extractFbclidFromUrl(order.landing_site);
  }

  // Synthesize _fbc from fbclid if cart attribute didn't include one. The
  // timestamp anchor for the _fbc cookie format must be the click time —
  // we use the order's processed_at when available so the synthesized
  // value is closer to the real click than `now()` (which can be hours
  // off for COD orders that webhook later than purchase).
  if (!fbc && fbclid) {
    const clickTs = order?.processed_at
      ? new Date(order.processed_at).getTime()
      : order?.created_at
      ? new Date(order.created_at).getTime()
      : Date.now();
    fbc = `fb.1.${clickTs}.${fbclid}`;
  }

  return {
    fbp,
    fbc,
    fbclid,
    eventId: pickAttr(attrs, KEYS.eventId),
    clientIp: order?.client_details?.browser_ip ?? order?.browser_ip ?? null,
    clientUa:
      pickAttr(attrs, KEYS.clientUa) ??
      order?.client_details?.user_agent ??
      null,
  };
}

// Pull customer identity from an order — email/phone/name/address — for the
// hashed user_data block. Shopify orders have customer-level + shipping/billing
// fallbacks; we prefer customer fields and fall back to shipping_address.
export function extractCustomerIdentity(order) {
  const c = order?.customer ?? {};
  const ship = order?.shipping_address ?? order?.billing_address ?? {};

  return {
    email: order?.email ?? c.email ?? null,
    phone: order?.phone ?? c.phone ?? ship?.phone ?? null,
    firstName: c.first_name ?? ship?.first_name ?? null,
    lastName: c.last_name ?? ship?.last_name ?? null,
    city: ship?.city ?? null,
    state: ship?.province_code ?? ship?.province ?? null,
    zip: ship?.zip ?? null,
    country: ship?.country_code ?? ship?.country ?? null,
    externalId: c.id != null ? String(c.id) : null,
  };
}
