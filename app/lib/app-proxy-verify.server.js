// Verify the HMAC signature on a Shopify App Proxy request.
// Reference: https://shopify.dev/docs/apps/online-store/app-proxies#calculate-a-digital-signature
//
// Shopify signs every proxy hit with a `signature` query param computed as
// HMAC-SHA256(sorted-query-params-without-signature, API_SECRET) — hex digest.
// Without verifying this we'd be trusting raw beacons from the open internet.

import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyAppProxySignature(url) {
  const u = new URL(url);
  const params = u.searchParams;
  const signature = params.get("signature");
  if (!signature) return false;

  // Per Shopify's spec, repeated query params are joined into a single
  // `key=a,b` entry before sorting — a URL that legitimately repeats a
  // param (array-style filters) must not break verification.
  const grouped = new Map();
  for (const [key, value] of params.entries()) {
    if (key === "signature") continue;
    if (grouped.has(key)) grouped.get(key).push(value);
    else grouped.set(key, [value]);
  }
  const sorted = Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, vs]) => `${k}=${vs.join(",")}`)
    .join("");

  const expected = createHmac("sha256", process.env.SHOPIFY_API_SECRET ?? "")
    .update(sorted)
    .digest("hex");

  // Constant-time compare to avoid timing attacks.
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
