import { createClient } from '@supabase/supabase-js';

// One shared service-role client for the whole process.
//
// IMPORTANT (tenant isolation): the service-role key BYPASSES Postgres RLS,
// and supabase-js issues each query as its own PostgREST transaction — so a
// transaction-local `set_config('app.current_store_id', …)` can never scope
// later queries anyway. Isolation is enforced by the explicit
// `.eq('store_id', …)` filter that every query in this codebase carries.
// Never rely on RLS when using these clients.
//
// The old implementation created a fresh client AND awaited a
// `set_app_store` RPC on every call — one full network round-trip per
// request that had no effect. Both are gone; the `shop` parameter is kept
// so call sites don't churn.
let _client;

export function getAdminClient() {
  _client ??= createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
  return _client;
}

// Kept async-compatible: existing call sites do `await getSupabaseForStore(shop)`,
// and awaiting a plain value is a no-op.
export function getSupabaseForStore(_shop) {
  return getAdminClient();
}
