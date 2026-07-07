// Unit tests for the shared constant-time cron secret check.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { verifyCronSecret } from "../app/lib/cron-auth.server.js";

function reqWithSecret(value) {
  const headers = new Headers();
  if (value != null) headers.set("x-cron-secret", value);
  return new Request("https://app.example.com/api/cron/test", { headers });
}

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret-value-for-tests";
});

test("accepts the correct secret", () => {
  assert.equal(verifyCronSecret(reqWithSecret("s3cret-value-for-tests")), true);
});

test("rejects a wrong secret of same length", () => {
  assert.equal(verifyCronSecret(reqWithSecret("s3cret-value-for-testZ")), false);
});

test("rejects a wrong-length secret", () => {
  assert.equal(verifyCronSecret(reqWithSecret("short")), false);
});

test("rejects a missing header", () => {
  assert.equal(verifyCronSecret(reqWithSecret(null)), false);
});

test("rejects everything when CRON_SECRET is unset", () => {
  delete process.env.CRON_SECRET;
  assert.equal(verifyCronSecret(reqWithSecret("anything")), false);
  assert.equal(verifyCronSecret(reqWithSecret("")), false);
});
