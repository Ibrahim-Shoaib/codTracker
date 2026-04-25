// Probes whether the block is app-scoped or IP/network-scoped.
// All these calls do NOT use your app token, so a 200 response = network OK.

async function call(label, url) {
  const res = await fetch(url);
  const text = await res.text();
  console.log(`\n${label}`);
  console.log(`  ${res.status}`);
  console.log(`  ${text.slice(0, 400)}`);
}

// 1. Public, unauthenticated Facebook page metadata.
await call('1. graph.facebook.com root, no token', 'https://graph.facebook.com/');

// 2. oEmbed of a public Facebook video (no token needed).
await call('2. oEmbed public', 'https://graph.facebook.com/v21.0/oembed_video?url=https://www.facebook.com/facebook/videos/10153231379946729/');

// 3. OAuth dialog endpoint (uses app id only — won't access your data).
const dialogUrl = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${process.env.META_APP_ID ?? '0'}&redirect_uri=https%3A%2F%2Fexample.com&response_type=code`;
const res = await fetch(dialogUrl, { redirect: 'manual' });
console.log(`\n3. OAuth dialog HEAD`);
console.log(`  status=${res.status}`);
console.log(`  location=${res.headers.get('location')?.slice(0, 200)}`);

import 'dotenv/config';
