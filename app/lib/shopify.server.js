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

// ─── Shop settings ─────────────────────────────────────────────────────────────

// Fetches the shop's currency + money_format from Shopify's shop.json.
// Used by afterAuth to populate stores.currency on first install (and
// to re-sync if the merchant ever changes their store currency).
//
// Returns { currency: 'PKR'|'USD'|..., money_format: 'Rs.{{amount}}'|... }
// or null if the API errored — caller should default to PKR rather
// than block install.
export async function getShopCurrencySettings(session) {
  const { shop, accessToken } = session;
  try {
    const res = await fetch(adminUrl(shop, 'shop.json'), {
      headers: adminHeaders(accessToken),
    });
    if (!res.ok) return null;
    const { shop: data } = await res.json();
    return {
      currency: data?.currency ?? null,
      money_format: data?.money_format ?? null,
    };
  } catch {
    return null;
  }
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
      if (res.status === 401) throw new Error('SHOPIFY_401');
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

// Fetches all Shopify orders in a window and returns a Map keyed on
// order_name. Each value carries both the line items (for COGS matching)
// and the customer-side created_at (for the orders.order_date column).
// We bundle both fields off the SAME paginated request so adding order_date
// support to the dashboard introduces zero new Shopify API load.
//
// Map shape:
//   Map<name, { lineItems: [{ variant_id, quantity }], createdAt: string }>
//
// Respects Shopify's Retry-After header on 429 — retries up to 5 times per page.
export async function getOrdersLineItemMap(session, createdAtMin) {
  const { shop, accessToken } = session;
  const headers = adminHeaders(accessToken);
  const map = new Map();

  const dateParam = createdAtMin ? `&created_at_min=${encodeURIComponent(createdAtMin)}` : '';
  let url = adminUrl(
    shop,
    `orders.json?status=any&limit=250&fields=name,line_items,created_at${dateParam}`
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
      map.set(order.name, {
        lineItems: order.line_items.map(item => ({
          variant_id: String(item.variant_id),
          quantity:   item.quantity,
        })),
        createdAt: order.created_at ?? null,
      });
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

// Registers the meta-pixel webhook subscriptions (orders, checkouts, refunds).
// shopify.app.toml's [[webhooks.subscriptions]] should auto-register these on
// every install via managed installation, but we observed in production that
// merchants installed before the webhook config was added had only the
// uninstall webhook registered — the toml-declared subs never retroactively
// registered for them. This function is a safety net: called from afterAuth,
// it re-asserts every required subscription using REST `webhooks.json` (POST),
// and 422 ("address is taken") is a no-op for already-registered subs.
//
// Topics MUST match exactly what api.webhooks.meta-pixel.tsx switches on
// (case-insensitive in Shopify's payload, but we use the lowercase form here
// because that's what the REST API accepts).
export async function registerMetaPixelWebhooks(session) {
  const { shop, accessToken } = session;
  const callbackUrl = `${process.env.SHOPIFY_APP_URL}/api/webhooks/meta-pixel`;
  const topics = [
    'orders/create',
    'orders/paid',
    'orders/edited',
    'refunds/create',
    'checkouts/create',
    'checkouts/update',
  ];
  for (const topic of topics) {
    try {
      const res = await fetch(adminUrl(shop, 'webhooks.json'), {
        method: 'POST',
        headers: adminHeaders(accessToken),
        body: JSON.stringify({
          webhook: { topic, address: callbackUrl, format: 'json' },
        }),
      });
      if (!res.ok && res.status !== 422) {
        const body = await res.text();
        console.warn(
          `[shopify-webhooks] register ${topic} for ${shop} → HTTP ${res.status}: ${body.slice(0, 200)}`
        );
      }
    } catch (err) {
      console.warn(
        `[shopify-webhooks] register ${topic} for ${shop} threw: ${String(err)}`
      );
    }
  }
}
