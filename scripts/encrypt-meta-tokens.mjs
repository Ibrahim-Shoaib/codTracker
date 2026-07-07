// One-time backfill: encrypt legacy plaintext stores.meta_access_token rows.
//
// ⚠️  RUN ORDER MATTERS: deploy the code that reads via decryptMaybe() FIRST,
// then run this. Running it against a deployment that still reads plaintext
// would break Meta spend sync until the next deploy.
//
// Idempotent — already-encrypted rows are detected by format and skipped.
//
// Usage: node scripts/encrypt-meta-tokens.mjs           (dry run)
//        node scripts/encrypt-meta-tokens.mjs --apply   (write changes)

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createCipheriv, randomBytes } from "node:crypto";

const APPLY = process.argv.includes("--apply");

const CIPHERTEXT_RE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

function b64u(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function encryptSecret(plaintext) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return `${b64u(iv)}:${b64u(cipher.getAuthTag())}:${b64u(ct)}`;
}

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
  console.error("ENCRYPTION_KEY missing or not 64 hex chars"); process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: rows, error } = await supabase
  .from("stores")
  .select("store_id, meta_access_token")
  .not("meta_access_token", "is", null);
if (error) { console.error(error); process.exit(1); }

let encrypted = 0, alreadyDone = 0;
for (const row of rows ?? []) {
  if (CIPHERTEXT_RE.test(row.meta_access_token)) { alreadyDone++; continue; }
  console.log(`${APPLY ? "encrypting" : "[dry-run] would encrypt"} token for ${row.store_id}`);
  if (APPLY) {
    const { error: upErr } = await supabase
      .from("stores")
      .update({ meta_access_token: encryptSecret(row.meta_access_token) })
      .eq("store_id", row.store_id);
    if (upErr) { console.error(`  FAILED for ${row.store_id}:`, upErr.message); continue; }
  }
  encrypted++;
}
console.log(`done: ${encrypted} ${APPLY ? "encrypted" : "pending"}, ${alreadyDone} already encrypted, ${rows?.length ?? 0} total`);
