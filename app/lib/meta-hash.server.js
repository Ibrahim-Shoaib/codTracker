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

// Phone: E.164-style digits only (country code prefix, no leading +).
// "+92 300 1234567" → "923001234567"
//
// Meta's documented EMQ optimization: phone in E.164 format (with country
// code) adds ~3 EMQ points vs. local-format phone. The value on a Shopify
// order is whatever the customer typed at checkout, which is often just
// "0300 1234567" without country code. We use the order's
// shipping/billing country_code to recover the missing prefix.
//
// Country code → dial code mapping. Limited to markets we know merchants
// operate in; other regions pass through with whatever digits they have.
const DIAL_CODES = {
  PK: "92", IN: "91", BD: "880", LK: "94",     // South Asia
  AE: "971", SA: "966", QA: "974", KW: "965", OM: "968", BH: "973",  // Gulf
  GB: "44", US: "1", CA: "1", AU: "61",        // Anglosphere
  DE: "49", FR: "33", IT: "39", ES: "34", NL: "31",  // EU
};

export function normalizePhone(value, countryCode) {
  if (!value) return null;
  let digits = String(value).replace(/\D/g, "");
  if (digits.length < 7) return null;

  // If country code is known and the phone doesn't already start with it,
  // try to recover the country prefix. Strips a leading domestic-trunk
  // zero first ("03001234567" → "3001234567"), then prepends the dial code.
  const cc = countryCode ? String(countryCode).toUpperCase() : null;
  const dial = cc && DIAL_CODES[cc];
  if (dial && !digits.startsWith(dial)) {
    if (digits.startsWith("0")) digits = digits.slice(1);
    digits = dial + digits;
  }

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

export function hashPhone(value, countryCode) {
  const n = normalizePhone(value, countryCode);
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

  // Pass the order's country code so phone-normalization can prepend the
  // right dial code (E.164 format) when the customer typed a domestic-format
  // number. Adds ~3 EMQ points per Meta's documented matching rules.
  const ph = hashPhone(input.phone, input.country);
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

  // external_id accepts either a single value (string/number) OR an array of
  // values. Meta CAPI's spec allows multiple external_ids per event so we can
  // pass our minted visitor_id (cross-session browser identity, present on
  // every event from a returning browser) AND the merchant's Shopify
  // customer.id (account identity, only present after the customer has an
  // account) on the same Purchase event — Meta then tries to match against
  // either one. Hashed entries are deduped because hashing the same value
  // twice produces the same SHA, so passing the same id in both slots is a
  // no-op for matching but bloats the payload.
  const eidInput = input.externalId;
  if (eidInput != null) {
    const list = Array.isArray(eidInput) ? eidInput : [eidInput];
    const hashed = [];
    const seen = new Set();
    for (const v of list) {
      const h = hashExternalId(v);
      if (h && !seen.has(h)) {
        seen.add(h);
        hashed.push(h);
      }
    }
    if (hashed.length) ud.external_id = hashed;
  }

  // Raw (not hashed) per Meta spec
  if (input.fbc) ud.fbc = String(input.fbc);
  if (input.fbp) ud.fbp = String(input.fbp);
  if (input.clientIp) ud.client_ip_address = String(input.clientIp);
  if (input.clientUa) ud.client_user_agent = String(input.clientUa);

  return ud;
}
