// Unit tests for app/lib/meta-hash.server.js
// Run with:  node --test tests/meta-hash.test.mjs
//
// These verify normalization rules match Meta's CAPI spec — a mismatch in
// normalization halves match rate, so each rule has its own test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  normalizeEmail,
  normalizePhone,
  normalizeName,
  normalizeCity,
  normalizeZip,
  normalizeCountry,
  hashEmail,
  hashPhone,
  hashName,
  buildUserData,
} from "../app/lib/meta-hash.server.js";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// ─── Normalization ────────────────────────────────────────────────────────────

test("normalizeEmail lowercases and trims", () => {
  assert.equal(normalizeEmail("  Foo@Example.COM  "), "foo@example.com");
});

test("normalizeEmail returns null on missing @", () => {
  assert.equal(normalizeEmail("not-an-email"), null);
});

test("normalizeEmail returns null on falsy input", () => {
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail(undefined), null);
});

test("normalizePhone strips non-digits and preserves country code", () => {
  assert.equal(normalizePhone("+92 300 1234567"), "923001234567");
  assert.equal(normalizePhone("(415) 555-0123"), "4155550123");
});

test("normalizePhone returns null for too-short input", () => {
  assert.equal(normalizePhone("123"), null);
});

test("normalizePhone prepends dial code when country is known and missing", () => {
  // Pakistani local format: "0300 1234567" → "923001234567" (E.164)
  assert.equal(normalizePhone("0300 1234567", "PK"), "923001234567");
  // US local format: "(415) 555-0123" → "14155550123"
  assert.equal(normalizePhone("(415) 555-0123", "US"), "14155550123");
  // UK with leading 0: "07700 900123" → "447700900123"
  assert.equal(normalizePhone("07700 900123", "GB"), "447700900123");
});

test("normalizePhone leaves number alone if dial code already present", () => {
  assert.equal(normalizePhone("923001234567", "PK"), "923001234567");
  assert.equal(normalizePhone("+923001234567", "PK"), "923001234567");
});

test("normalizePhone passes through unknown countries without modification", () => {
  assert.equal(normalizePhone("0300 1234567", "ZZ"), "03001234567");
  assert.equal(normalizePhone("0300 1234567"), "03001234567");
});

test("normalizeName strips diacritics, lowercases, removes punctuation", () => {
  assert.equal(normalizeName("José"), "jose");
  assert.equal(normalizeName("O'Brien"), "obrien");
  assert.equal(normalizeName("Mary-Anne"), "maryanne");
  assert.equal(normalizeName("  John  "), "john");
});

test("normalizeCity strips spaces and diacritics", () => {
  assert.equal(normalizeCity("New York"), "newyork");
  assert.equal(normalizeCity("Zürich"), "zurich");
});

test("normalizeZip lowercases and removes spaces", () => {
  assert.equal(normalizeZip("SW1A 1AA"), "sw1a1aa");
  assert.equal(normalizeZip("75200"), "75200");
});

test("normalizeCountry maps country names to ISO-2 codes", () => {
  assert.equal(normalizeCountry("Pakistan"), "pk");
  assert.equal(normalizeCountry("United States"), "us");
  assert.equal(normalizeCountry("US"), "us");
  assert.equal(normalizeCountry("uk"), "gb");
});

test("normalizeCountry returns null for unknown 3+ letter strings", () => {
  assert.equal(normalizeCountry("Atlantis"), null);
});

// ─── Hashing ──────────────────────────────────────────────────────────────────

test("hashEmail returns SHA-256 of normalized form", () => {
  const expected = sha("foo@example.com");
  assert.equal(hashEmail("Foo@Example.COM"), expected);
});

test("hashPhone returns SHA-256 of digits-only form", () => {
  const expected = sha("923001234567");
  assert.equal(hashPhone("+92 300 1234567"), expected);
});

test("hashName returns SHA-256 of stripped form", () => {
  const expected = sha("jose");
  assert.equal(hashName("José"), expected);
});

// ─── buildUserData ────────────────────────────────────────────────────────────

test("buildUserData wraps hashed fields in arrays per CAPI spec", () => {
  const ud = buildUserData({ email: "a@b.com" });
  assert.ok(Array.isArray(ud.em));
  assert.equal(ud.em.length, 1);
  assert.equal(ud.em[0], sha("a@b.com"));
});

test("buildUserData omits keys whose normalization returns null", () => {
  const ud = buildUserData({ email: "", phone: "x", firstName: "  " });
  assert.equal(ud.em, undefined);
  assert.equal(ud.ph, undefined);
  assert.equal(ud.fn, undefined);
});

test("buildUserData passes fbp/fbc/ip/ua through unhashed", () => {
  const ud = buildUserData({
    fbp: "fb.1.123.456",
    fbc: "fb.1.789.abc",
    clientIp: "1.2.3.4",
    clientUa: "Mozilla/5.0",
  });
  assert.equal(ud.fbp, "fb.1.123.456");
  assert.equal(ud.fbc, "fb.1.789.abc");
  assert.equal(ud.client_ip_address, "1.2.3.4");
  assert.equal(ud.client_user_agent, "Mozilla/5.0");
});

test("buildUserData hashes external_id", () => {
  const ud = buildUserData({ externalId: "Customer-123" });
  assert.deepEqual(ud.external_id, [sha("customer-123")]);
});

test("buildUserData with full identity produces all 13 fields", () => {
  const ud = buildUserData({
    email: "jane@example.com",
    phone: "+923001112222",
    firstName: "Jane",
    lastName: "Doe",
    city: "Karachi",
    state: "Sindh",
    zip: "75200",
    country: "PK",
    externalId: "abc123",
    fbp: "fb.1.x.y",
    fbc: "fb.1.x.z",
    clientIp: "1.1.1.1",
    clientUa: "ua",
  });
  const expected = [
    "em", "ph", "fn", "ln", "ct", "st", "zp", "country", "external_id",
    "fbp", "fbc", "client_ip_address", "client_user_agent",
  ];
  for (const key of expected) {
    assert.ok(ud[key] != null, `missing key ${key}`);
  }
});
