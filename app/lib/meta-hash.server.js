// SHA-256 hashing + normalization of customer identity per Meta CAPI spec.
// Reference: https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
//
// Every field that gets hashed must be normalized first (lowercase, trim,
// strip diacritics where required) — Meta hashes the same way on their end
// when matching against their user graph, and a mismatch in normalization
// halves your match rate.
//
// `fbc`, `fbp`, `client_ip_address`, `client_user_agent`, `event_id`
// are NOT hashed — they're sent raw.

import { createHash } from "node:crypto";

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function stripDiacritics(s) {
  // NFD splits accented chars into base + combining mark; we then drop the marks.
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

export function normalizeEmail(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (!v.includes("@")) return null;
  return v;
}

// Phone: digits only, must include country code (no leading +).
// "+92 300 1234567" → "923001234567"
export function normalizePhone(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits;
}

export function normalizeName(value) {
  if (!value) return null;
  const v = stripDiacritics(String(value)).toLowerCase().trim();
  // Meta wants the name with no whitespace or punctuation.
  return v.replace(/[\s\-'.,]/g, "") || null;
}

export function normalizeCity(value) {
  if (!value) return null;
  const v = stripDiacritics(String(value)).toLowerCase().trim();
  return v.replace(/[\s\-'.,]/g, "") || null;
}

// State: prefer 2-letter US codes when applicable; otherwise lowercase, no spaces.
export function normalizeState(value) {
  if (!value) return null;
  const v = stripDiacritics(String(value)).toLowerCase().trim();
  return v.replace(/[\s\-'.,]/g, "") || null;
}

// ZIP: lowercase, no spaces. For US use first 5; we let callers pass the full
// value and let Meta truncate downstream — Pakistan/UK/etc. zip formats vary.
export function normalizeZip(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim().replace(/\s+/g, "");
  return v || null;
}

// Country: 2-letter ISO 3166-1 alpha-2, lowercased.
// Also accepts common full names ("Pakistan", "United States") and a few
// non-ISO 2-letter aliases ("uk" → "gb") so we don't reject valid input that
// merchants legitimately type in their store settings.
const COUNTRY_ALIASES = {
  pakistan: "pk", "united states": "us", usa: "us", "united kingdom": "gb",
  uk: "gb", india: "in", "saudi arabia": "sa", uae: "ae",
  "united arab emirates": "ae", canada: "ca", australia: "au",
};

export function normalizeCountry(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  // Aliases take priority over passthrough so "uk" gets remapped to "gb".
  if (COUNTRY_ALIASES[v]) return COUNTRY_ALIASES[v];
  if (v.length === 2 && /^[a-z]{2}$/.test(v)) return v;
  return null;
}

export function normalizeExternalId(value) {
  if (value == null) return null;
  return String(value).toLowerCase().trim() || null;
}

// ─── Hashed wrappers ──────────────────────────────────────────────────────────

export function hashEmail(value) {
  const n = normalizeEmail(value);
  return n ? sha256(n) : null;
}

export function hashPhone(value) {
  const n = normalizePhone(value);
  return n ? sha256(n) : null;
}

export function hashName(value) {
  const n = normalizeName(value);
  return n ? sha256(n) : null;
}

export function hashCity(value) {
  const n = normalizeCity(value);
  return n ? sha256(n) : null;
}

export function hashState(value) {
  const n = normalizeState(value);
  return n ? sha256(n) : null;
}

export function hashZip(value) {
  const n = normalizeZip(value);
  return n ? sha256(n) : null;
}

export function hashCountry(value) {
  const n = normalizeCountry(value);
  return n ? sha256(n) : null;
}

export function hashExternalId(value) {
  const n = normalizeExternalId(value);
  return n ? sha256(n) : null;
}

// ─── User-data builder ────────────────────────────────────────────────────────

// Build a Meta CAPI `user_data` block from any combination of identity hints.
// Drops null/undefined keys so we never send empty arrays (Meta rejects them
// and lowers EMQ as if we'd sent garbage).
//
// Meta wants hashed PII fields as ARRAYS so multiple values can be supplied
// (e.g. multiple email addresses for the same person). Single-value arrays
// are valid and what we use here.
export function buildUserData(input) {
  const ud = {};

  const em = hashEmail(input.email);
  if (em) ud.em = [em];

  const ph = hashPhone(input.phone);
  if (ph) ud.ph = [ph];

  const fn = hashName(input.firstName);
  if (fn) ud.fn = [fn];

  const ln = hashName(input.lastName);
  if (ln) ud.ln = [ln];

  const ct = hashCity(input.city);
  if (ct) ud.ct = [ct];

  const st = hashState(input.state);
  if (st) ud.st = [st];

  const zp = hashZip(input.zip);
  if (zp) ud.zp = [zp];

  const country = hashCountry(input.country);
  if (country) ud.country = [country];

  const externalId = hashExternalId(input.externalId);
  if (externalId) ud.external_id = [externalId];

  // Raw (not hashed) per Meta spec
  if (input.fbc) ud.fbc = String(input.fbc);
  if (input.fbp) ud.fbp = String(input.fbp);
  if (input.clientIp) ud.client_ip_address = String(input.clientIp);
  if (input.clientUa) ud.client_user_agent = String(input.clientUa);

  return ud;
}
