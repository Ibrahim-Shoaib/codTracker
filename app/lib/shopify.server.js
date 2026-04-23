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

// Converts a full-size Shopify CDN image URL to the _small (100×100) variant.
function shopifyImageSmall(src) {
  if (!src) return null;
  const [path, query] = src.split('?');
  const dot = path.lastIndexOf('.');
  if (dot === -1) return src;
  const small = path.slice(0, dot) + '_small' + path.slice(dot);
  return query ? `${small}?${query}` : small;
}

// Returns active products grouped by product, with shopify_cost pre-filled from
// Shopify's native "Cost per item" field (InventoryItem.cost) and a _small
// image URL for display.
// Shape: [{ shopify_product_id, product_title, image_url, variants: [{ shopify_variant_id,
//   shopify_product_id, product_title, variant_title, sku, shopify_cost }] }]
export async function getProductsForCOGS(session) {
  const { shop, accessToken } = session;
  const headers = adminHeaders(accessToken);

  // Paginate products and tally 90-day sales in parallel — both are independent
  async function fetchProducts() {
    const list = [];
    let url = adminUrl(shop, `products.json?status=active&limit=250&fields=id,title,variants,images`);
    while (url) {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status}`);
      const data = await res.json();
      list.push(...data.products);
      url = parseNextUrl(res.headers.get('Link'));
    }
    return list;
  }

  async function fetchSales() {
    const sales = {}; // product_id (number) → total quantity sold
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    let url = adminUrl(shop, `orders.json?status=any&created_at_min=${since}&limit=250&fields=line_items`);
    while (url) {
      const res = await fetch(url, { headers });
      if (!res.ok) break; // non-fatal — fall back to unsorted
      const data = await res.json();
      for (const order of data.orders ?? []) {
        for (const item of order.line_items ?? []) {
          if (item.product_id) {
            sales[item.product_id] = (sales[item.product_id] || 0) + item.quantity;
          }
        }
      }
      url = parseNextUrl(res.headers.get('Link'));
    }
    return sales;
  }

  // 1. Fetch products and 90-day sales counts at the same time
  const [rawProducts, salesByProductId] = await Promise.all([fetchProducts(), fetchSales()]);

  // Sort bestsellers first; products with no sales go to the bottom
  rawProducts.sort((a, b) => (salesByProductId[b.id] ?? 0) - (salesByProductId[a.id] ?? 0));

  // 2. Collect every inventory_item_id across all variants
  const invItemIds = [];
  for (const p of rawProducts) {
    for (const v of p.variants) {
      if (v.inventory_item_id) invItemIds.push(v.inventory_item_id);
    }
  }

  // 3. Build batches and fire all inventory-item requests in parallel
  const batches = [];
  for (let i = 0; i < invItemIds.length; i += 100) {
    batches.push(invItemIds.slice(i, i + 100));
  }
  const batchResults = await Promise.all(
    batches.map(batch =>
      fetch(
        adminUrl(shop, `inventory_items.json?ids=${batch.join(',')}&fields=id,cost`),
        { headers }
      ).then(r => r.ok ? r.json() : { inventory_items: [] })
    )
  );
  const costByInvItemId = {};
  for (const data of batchResults) {
    for (const item of data.inventory_items ?? []) {
      costByInvItemId[item.id] = item.cost != null ? parseFloat(item.cost) : null;
    }
  }

  // 4. Build grouped structure
  return rawProducts.map(p => ({
    shopify_product_id: String(p.id),
    product_title:      p.title,
    image_url:          shopifyImageSmall(p.images?.[0]?.src ?? null),
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
    adminUrl(shop, `orders.json?name=${encodeURIComponent('#' + orderRefNumber)}&status=any`),
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

// Fetches all Shopify orders and returns a Map of order_name → [{ variant_id, quantity }].
// Respects Shopify's Retry-After header on 429 — retries up to 5 times per page.
export async function getOrdersLineItemMap(session, createdAtMin) {
  const { shop, accessToken } = session;
  const headers = adminHeaders(accessToken);
  const map = new Map();

  const dateParam = createdAtMin ? `&created_at_min=${encodeURIComponent(createdAtMin)}` : '';
  let url = adminUrl(
    shop,
    `orders.json?status=any&limit=250&fields=name,line_items${dateParam}`
  );

  while (url) {
    let res;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(url, { headers });
      if (res.status !== 429) break;
      const retryAfter = parseFloat(res.headers.get('retry-after') ?? '2');
      await new Promise(r => setTimeout(r, retryAfter * 1000));
    }
    if (!res.ok) throw new Error(`Shopify getOrdersLineItemMap failed: ${res.status}`);
    const { orders } = await res.json();

    for (const order of orders ?? []) {
      map.set(order.name, order.line_items.map(item => ({
        variant_id: String(item.variant_id),
        quantity:   item.quantity,
      })));
    }

    url = parseNextUrl(res.headers.get('link'));
  }

  return map;
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
