// Unit tests for decryptMaybe / isEncryptedSecret — the tolerant reader that
// makes the encrypt-tokens-at-rest rollout safe (legacy plaintext rows keep
// working until the backfill script runs).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  encryptSecret,
  decryptMaybe,
  isEncryptedSecret,
} from "../app/lib/crypto.server.js";

before(() => {
  process.env.ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

test("decryptMaybe decrypts our ciphertext format", () => {
  const token = "EAABlongMetaAdsToken1234567890";
  const ct = encryptSecret(token);
  assert.equal(isEncryptedSecret(ct), true);
  assert.equal(decryptMaybe(ct), token);
});

test("decryptMaybe passes plaintext Meta tokens through unchanged", () => {
  // Real Meta tokens are alphanumeric — never contain ':'.
  const plain = "EAABsbCS1234ZBxyzLegacyPlaintextToken";
  assert.equal(isEncryptedSecret(plain), false);
  assert.equal(decryptMaybe(plain), plain);
});

test("decryptMaybe handles null/undefined/empty", () => {
  assert.equal(decryptMaybe(null), null);
  assert.equal(decryptMaybe(undefined), null);
  assert.equal(decryptMaybe(""), null);
});

test("colon-containing strings that are not our format pass through", () => {
  // Two segments only — not iv:tag:ct.
  const twoParts = "abc:def";
  assert.equal(isEncryptedSecret(twoParts), false);
  assert.equal(decryptMaybe(twoParts), twoParts);
  // Four segments — also not ours.
  const fourParts = "a:b:c:d";
  assert.equal(isEncryptedSecret(fourParts), false);
  assert.equal(decryptMaybe(fourParts), fourParts);
});
