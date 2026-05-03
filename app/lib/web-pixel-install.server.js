// Install / uninstall the Custom Web Pixel extension for a merchant via Shopify
// Admin GraphQL. Called when a merchant connects/disconnects Pixel Tracking.
//
// Shopify allows exactly ONE Custom Web Pixel per app installation per shop;
// calling webPixelCreate twice for the same shop is an error, so we use
// webPixelUpdate when an id is already known.

const API_VERSION = "2025-10";

function adminUrl(shop) {
  return `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
}

async function adminGraphQL(shop, accessToken, query, variables) {
  const res = await fetch(adminUrl(shop), {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    const msg =
      json.errors?.[0]?.message ?? `webPixel admin call failed: ${res.status}`;
    throw new Error(msg);
  }
  return json.data;
}

// Settings shape that the Custom Web Pixel reads at runtime via init.settings.
// `accountID` is the merchant's shop_id — the pixel beacons it back to the App
// Proxy so we can route events to the correct connection in our DB.
function buildSettings({ shop }) {
  return JSON.stringify({ accountID: shop });
}

export async function installWebPixel({ shop, accessToken }) {
  const settings = buildSettings({ shop });

  const mutation = /* GraphQL */ `
    mutation webPixelCreate($webPixel: WebPixelInput!) {
      webPixelCreate(webPixel: $webPixel) {
        webPixel { id settings }
        userErrors { field message }
      }
    }
  `;

  const data = await adminGraphQL(shop, accessToken, mutation, {
    webPixel: { settings },
  });

  const errors = data?.webPixelCreate?.userErrors ?? [];
  if (errors.length) {
    // Most common error: "A web pixel already exists for this app". In that
    // case we look it up via webPixel query and update instead.
    const existing = await getInstalledWebPixel({ shop, accessToken });
    if (existing) {
      return updateWebPixel({ shop, accessToken, id: existing.id });
    }
    throw new Error(
      `webPixelCreate failed: ${errors.map((e) => e.message).join("; ")}`
    );
  }

  return data.webPixelCreate.webPixel;
}

export async function updateWebPixel({ shop, accessToken, id }) {
  const settings = buildSettings({ shop });
  const mutation = /* GraphQL */ `
    mutation webPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
      webPixelUpdate(id: $id, webPixel: $webPixel) {
        webPixel { id settings }
        userErrors { field message }
      }
    }
  `;
  const data = await adminGraphQL(shop, accessToken, mutation, {
    id,
    webPixel: { settings },
  });
  const errors = data?.webPixelUpdate?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `webPixelUpdate failed: ${errors.map((e) => e.message).join("; ")}`
    );
  }
  return data.webPixelUpdate.webPixel;
}

export async function uninstallWebPixel({ shop, accessToken, id }) {
  const mutation = /* GraphQL */ `
    mutation webPixelDelete($id: ID!) {
      webPixelDelete(id: $id) {
        deletedWebPixelId
        userErrors { field message }
      }
    }
  `;
  const data = await adminGraphQL(shop, accessToken, mutation, { id });
  const errors = data?.webPixelDelete?.userErrors ?? [];
  if (errors.length) {
    // "doesn't exist" is fine on disconnect — pretend success.
    if (errors.some((e) => /not\s*exist|does not exist/i.test(e.message ?? ""))) {
      return { deletedWebPixelId: id };
    }
    throw new Error(
      `webPixelDelete failed: ${errors.map((e) => e.message).join("; ")}`
    );
  }
  return { deletedWebPixelId: data.webPixelDelete.deletedWebPixelId };
}

// Look up the existing Custom Web Pixel for this app on this shop, if any.
// The Admin API only allows one Custom Pixel per app per shop, so the answer
// is at most one row.
export async function getInstalledWebPixel({ shop, accessToken }) {
  const query = /* GraphQL */ `
    query CurrentAppInstallation {
      currentAppInstallation {
        id
        webPixel { id settings }
      }
    }
  `;
  const data = await adminGraphQL(shop, accessToken, query, {});
  return data?.currentAppInstallation?.webPixel ?? null;
}
