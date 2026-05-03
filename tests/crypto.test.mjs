// Unit tests for app/lib/crypto.server.js — AES-256-GCM round-trip.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret } from "../app/lib/crypto.server.js";

before(() => {
  // 64-char hex = 32 bytes = AES-256 key length.
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

test("encryptSecret + decryptSecret round-trip preserves the plaintext", () => {
  const secret = "EAAB...long-bisu-token";
  const ct = encryptSecret(secret);
  assert.notEqual(ct, secret);
  assert.equal(decryptSecret(ct), secret);
});

test("encryptSecret produces a different ciphertext on each call (random IV)", () => {
  const ct1 = encryptSecret("same-input");
  const ct2 = encryptSecret("same-input");
  assert.notEqual(ct1, ct2);
  assert.equal(decryptSecret(ct1), "same-input");
  assert.equal(decryptSecret(ct2), "same-input");
});

test("encryptSecret returns null on null input", () => {
  assert.equal(encryptSecret(null), null);
  assert.equal(encryptSecret(undefined), null);
});

test("decryptSecret returns null on null input", () => {
  assert.equal(decryptSecret(null), null);
  assert.equal(decryptSecret(""), null);
});

test("decryptSecret throws on tampered ciphertext", () => {
  // Use a long input so the ciphertext has many chars to safely tamper with.
  // (Tampering the last char hits base64 padding bits and may be a no-op.)
  const ct = encryptSecret(
    "long-bisu-token-payload-AAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  );
  const parts = ct.split(":");
  // Flip the FIRST char of the ciphertext segment — guaranteed to land on
  // significant bits so GCM auth tag will reject the result.
  const first = parts[2][0];
  const replacement = first === "A" ? "B" : "A";
  parts[2] = replacement + parts[2].slice(1);
  assert.throws(() => decryptSecret(parts.join(":")));
});

test("decryptSecret throws on malformed payload", () => {
  assert.throws(() => decryptSecret("not-three-parts"));
  assert.throws(() => decryptSecret("a:b"));
});
