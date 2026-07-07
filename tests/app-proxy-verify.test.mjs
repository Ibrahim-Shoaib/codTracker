// Unit tests for the Shopify App Proxy signature verifier, including the
// spec's repeated-query-param rule (values joined with ',' per key).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyAppProxySignature } from "../app/lib/app-proxy-verify.server.js";

const SECRET = "test_shopify_api_secret";

before(() => {
  process.env.SHOPIFY_API_SECRET = SECRET;
});

// Build a signed proxy URL the way Shopify does: sort keys, join repeated
// values with ',', concatenate `key=value` pairs with NO separator, HMAC-hex.
function sign(params) {
  const grouped = new Map();
  for (const [k, v] of params) {
    if (grouped.has(k)) grouped.get(k).push(v);
    else grouped.set(k, [v]);
  }
  const canonical = Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, vs]) => `${k}=${vs.join(",")}`)
    .join("");
  return createHmac("sha256", SECRET).update(canonical).digest("hex");
}

function urlWith(params, signature) {
  const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `https://example.myshopify.com/apps/tracking/track?${qs}&signature=${signature}`;
}

test("accepts a correctly signed simple request", () => {
  const params = [
    ["shop", "example.myshopify.com"],
    ["timestamp", "1700000000"],
    ["path_prefix", "/apps/tracking"],
  ];
  assert.equal(verifyAppProxySignature(urlWith(params, sign(params))), true);
});

test("accepts repeated query params (joined with comma per Shopify spec)", () => {
  const params = [
    ["shop", "example.myshopify.com"],
    ["ids", "1"],
    ["ids", "2"],
    ["ids", "3"],
  ];
  assert.equal(verifyAppProxySignature(urlWith(params, sign(params))), true);
});

test("rejects a tampered param", () => {
  const params = [
    ["shop", "example.myshopify.com"],
    ["timestamp", "1700000000"],
  ];
  const sig = sign(params);
  const tampered = [["shop", "evil.myshopify.com"], ["timestamp", "1700000000"]];
  assert.equal(verifyAppProxySignature(urlWith(tampered, sig)), false);
});

test("rejects a missing signature", () => {
  assert.equal(
    verifyAppProxySignature("https://x.myshopify.com/apps/t?shop=a.myshopify.com"),
    false
  );
});

test("rejects a malformed signature without throwing", () => {
  const params = [["shop", "example.myshopify.com"]];
  assert.equal(verifyAppProxySignature(urlWith(params, "zz")), false);
});
