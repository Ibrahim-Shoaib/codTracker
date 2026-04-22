// Shopify Admin API client — uses REST with session accessToken.
// This file is the Admin API helper, distinct from app/shopify.server.ts (app config).

const API_VERSION = '2025-10';

function adminUrl(shop, path) {
  return `https://${shop}/admin/api/${API_VERSION}/${path}`;
}

function adminHeaders(accessToken) {
  return {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json',
  };
}

// Parses the rel="next" URL from a Shopify Link header for cursor pagination
function parseNextUrl(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

// ─── Products ─────────────────────────────────────────────────────────────────

// Returns flat list of all product variants for COGS setup table
export async function getProductVariants(session) {
  const { shop, accessToken } = session;
  const variants = [];
  let url = adminUrl(shop, `products.json?limit=250&fields=id,title,variants`);

  while (url) {
    const res = await fetch(url, { headers: adminHeaders(accessToken) });
    if (!res.ok) throw new Error(`Shopify getProductVariants failed: ${res.status}`);
    const { products } = await res.json();

    for (const product of products) {
      for (const variant of product.variants) {
        variants.push({
          shopify_variant_id: String(variant.id),
          shopify_product_id: String(product.id),
          sku:            variant.sku || '',
          product_title:  product.title,
          variant_title:  variant.title,
        });
      }
    }

    url = parseNextUrl(res.headers.get('Link'));
  }

  return variants;
}

// ─── Orders ───────────────────────────────────────────────────────────────────

// Returns line items [{ variant_id, quantity }] for COGS matching.
// orderRefNumber must already have # stripped.
export async function getOrderByName(session, orderRefNumber) {
  const { shop, accessToken } = session;
  const res = await fetch(
    adminUrl(shop, `orders.json?name=${encodeURIComponent(orderRefNumber)}&status=any`),
    { headers: adminHeaders(accessToken) }
  );
  if (!res.ok) throw new Error(`Shopify getOrderByName failed: ${res.status}`);
  const { orders } = await res.json();
  if (!orders?.length) return null;

  return orders[0].line_items.map(item => ({
    variant_id: String(item.variant_id),
    quantity:   item.quantity,
  }));
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

// Registers app/uninstalled webhook. Safe to call on every install — 422 means already registered.
export async function registerUninstallWebhook(session) {
  const { shop, accessToken } = session;
  const res = await fetch(adminUrl(shop, 'webhooks.json'), {
    method: 'POST',
    headers: adminHeaders(accessToken),
    body: JSON.stringify({
      webhook: {
        topic:   'app/uninstalled',
        address: `${process.env.SHOPIFY_APP_URL}/api/webhooks/uninstall`,
        format:  'json',
      },
    }),
  });
  // 422 = webhook already exists — not an error
  if (!res.ok && res.status !== 422) {
    throw new Error(`registerUninstallWebhook failed: ${res.status}`);
  }
}
