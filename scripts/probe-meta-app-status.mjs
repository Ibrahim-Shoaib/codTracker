// Diagnoses *what* is blocked at the Meta side. Distinguishes:
//   - User token revoked vs app-level block
//   - App in Development Mode vs Live Mode
//   - ads_read Standard vs Advanced Access (inferred)
//   - Business verification status
//   - URL/domain config (which is unrelated to API blocks but worth printing)

import 'dotenv/config';

const v = 'v21.0';
const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const APP_TOKEN = `${APP_ID}|${APP_SECRET}`;

async function call(label, url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  console.log(`\n${label}`);
  console.log(`  ${res.status}`, JSON.stringify(body).slice(0, 700));
  return { ok: res.ok, body, status: res.status };
}

console.log('=== ENV / config ===');
console.log('META_APP_ID:', APP_ID);
console.log('META_REDIRECT_URI:', process.env.META_REDIRECT_URI);
console.log('SHOPIFY_APP_URL:', process.env.SHOPIFY_APP_URL);

// 1. App-token call to /{app-id} — works even if user tokens are revoked.
//    Returns metadata about the app itself (namespace, category, etc.)
await call(
  '1. App metadata via app token',
  `https://graph.facebook.com/${v}/${APP_ID}?access_token=${APP_TOKEN}`,
);

// 2. App's restrictions / access settings
await call(
  '2. App restrictions field',
  `https://graph.facebook.com/${v}/${APP_ID}?fields=id,name,namespace,category,migrations,restrictions,object_store_urls&access_token=${APP_TOKEN}`,
);

// 3. App roles — who has admin/developer/tester access
await call(
  '3. App roles (admins/devs/testers)',
  `https://graph.facebook.com/${v}/${APP_ID}/roles?access_token=${APP_TOKEN}`,
);

// 4. Permissions list — Standard vs Advanced access
await call(
  '4. App permissions (standard/advanced access)',
  `https://graph.facebook.com/${v}/${APP_ID}/permissions?access_token=${APP_TOKEN}`,
);

// 5. Public unauthenticated call — probes whether Meta is blocking the IP entirely
//    vs blocking app/user. /search?q=... with an app token works for non-restricted use.
await call(
  '5. Generic Graph API health (no app context)',
  `https://graph.facebook.com/${v}/?access_token=${APP_TOKEN}`,
);

console.log('\n--- Interpretation ---');
console.log('If 1 also returns "API access blocked", the entire Meta app is restricted at the platform level.');
console.log('If 1 succeeds but 2/3/4 fail with the same error, scoped fields are restricted (often pre-app-review).');
console.log('If 5 works but 1 fails, only this app is blocked, not your IP/network.');
