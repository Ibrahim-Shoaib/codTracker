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

// Order webhook payload uses `note_attributes`. Checkout uses `attributes`.
// Some webhooks also surface them under `cart_token`+`presentment_currency`.
export function extractIdentityFromOrder(order) {
  const attrs = order?.note_attributes ?? order?.attributes ?? [];

  const fbp = pickAttr(attrs, KEYS.fbp);
  let fbc = pickAttr(attrs, KEYS.fbc);
  const fbclid = pickAttr(attrs, KEYS.fbclid);

  // Synthesize _fbc from fbclid if cart attribute didn't include one. This
  // covers the case where the Theme App Extension snippet wasn't installed
  // but the customer landed via a Meta ad (URL had ?fbclid=...).
  if (!fbc && fbclid) {
    fbc = `fb.1.${Date.now()}.${fbclid}`;
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
