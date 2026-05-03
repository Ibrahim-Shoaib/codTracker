// AES-256-GCM helpers for encrypting BISU tokens at rest in Supabase.
//
// The BISU token never expires — it's the keys to the merchant's Meta dataset
// for as long as our app exists. Storing it plaintext in Postgres is risky if
// the DB is ever exposed via a leak or misconfigured backup. AES-256-GCM with
// a 32-byte key gives us confidentiality + integrity (tampering detection).
//
// Key source: process.env.ENCRYPTION_KEY (64-char hex, generate with
// `openssl rand -hex 32`). Distinct from SESSION_SECRET so leaking one
// doesn't compromise the other.
//
// Output format: {iv}:{authTag}:{ciphertext}, all base64url. Self-contained
// per-row — no external key material needed beyond the env var.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // GCM-recommended

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Add a 64-char hex value to your environment (openssl rand -hex 32)."
    );
  }
  if (hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string (32 bytes).");
  }
  return Buffer.from(hex, "hex");
}

function b64u(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64u(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function encryptSecret(plaintext) {
  if (plaintext == null) return null;
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${b64u(iv)}:${b64u(tag)}:${b64u(ct)}`;
}

export function decryptSecret(payload) {
  if (!payload) return null;
  const parts = String(payload).split(":");
  if (parts.length !== 3) {
    throw new Error("decryptSecret: malformed ciphertext");
  }
  const [ivStr, tagStr, ctStr] = parts;
  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, fromB64u(ivStr));
  decipher.setAuthTag(fromB64u(tagStr));
  const pt = Buffer.concat([decipher.update(fromB64u(ctStr)), decipher.final()]);
  return pt.toString("utf8");
}
