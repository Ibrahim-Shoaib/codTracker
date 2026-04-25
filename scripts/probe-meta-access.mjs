import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const { data: store } = await supabase
  .from('stores')
  .select('meta_access_token, meta_ad_account_id, meta_token_expires_at')
  .not('meta_access_token', 'is', null)
  .limit(1)
  .single();

const { meta_access_token: token, meta_ad_account_id: ad, meta_token_expires_at: exp } = store;
console.log('token_expires_at:', exp, ' -> stillValid?', new Date(exp) > new Date());

async function probe(label, url) {
  const res = await fetch(url);
  const body = await res.json();
  console.log(`\n${label}`);
  console.log(`  status=${res.status}`);
  console.log(`  body=`, JSON.stringify(body).slice(0, 600));
}

const v = 'v21.0';

// 1. Token introspection — is the token itself alive?
await probe(
  '/me',
  `https://graph.facebook.com/${v}/me?access_token=${token}`,
);

// 2. List ad accounts the token can see
await probe(
  '/me/adaccounts',
  `https://graph.facebook.com/${v}/me/adaccounts?fields=id,name,currency,account_status&access_token=${token}`,
);

// 3. Direct read of the configured ad account (simple field)
await probe(
  `/${ad}`,
  `https://graph.facebook.com/${v}/${ad}?fields=id,name,currency,account_status,business&access_token=${token}`,
);

// 4. Insights without time_increment, no limit, just total spend last 7 days
const last7 = JSON.stringify({ since: '2026-04-18', until: '2026-04-24' });
await probe(
  `/${ad}/insights last7 (no time_increment)`,
  `https://graph.facebook.com/${v}/${ad}/insights?fields=spend&time_range=${encodeURIComponent(last7)}&level=account&access_token=${token}`,
);

// 5. Debug token endpoint — what does Meta think of this token?
await probe(
  '/debug_token',
  `https://graph.facebook.com/${v}/debug_token?input_token=${token}&access_token=${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`,
);
