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

// Returns active products grouped by product, with shopify_cost pre-filled from
// Shopify's native "Cost per item" field (InventoryItem.cost).
// Shape: [{ shopify_product_id, product_title, variants: [{ shopify_variant_id,
//   shopify_product_id, product_title, variant_title, sku, shopify_cost }] }]
export async function getProductsForCOGS(session) {
  const { shop, accessToken } = session;
  const headers = adminHeaders(accessToken);

  // 1. Paginate through all active products
  const rawProducts = [];
  let url = adminUrl(shop, `products.json?status=active&limit=250&fields=id,title,variants`);
  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status}`);
    const data = await res.json();
    rawProducts.push(...data.products);
    url = parseNextUrl(res.headers.get('Link'));
  }

  // 2. Collect every inventory_item_id across all variants
  const invItemIds = [];
  for (const p of rawProducts) {
    for (const v of p.variants) {
      if (v.inventory_item_id) invItemIds.push(v.inventory_item_id);
    }
  }

  // 3. Batch-fetch inventory items (Shopify max = 100 per request)
  const costByInvItemId = {};
  for (let i = 0; i < invItemIds.length; i += 100) {
    const batch = invItemIds.slice(i, i + 100);
    const res = await fetch(
      adminUrl(shop, `inventory_items.json?ids=${batch.join(',')}&fields=id,cost`),
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      for (const item of data.inventory_items ?? []) {
        costByInvItemId[item.id] = item.cost != null ? parseFloat(item.cost) : null;
      }
    }
  }

  // 4. Build grouped structure
  return rawProducts.map(p => ({
    shopify_product_id: String(p.id),
    product_title: p.title,
    variants: p.variants.map(v => ({
      shopify_variant_id: String(v.id),
      shopify_product_id: String(p.id),
      product_title:      p.title,
      variant_title:      v.title,
      sku:                v.sku || '',
      shopify_cost:       costByInvItemId[v.inventory_item_id] ?? null,
    })),
  }));
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
