import { createClient } from '@supabase/supabase-js';

export async function getSupabaseForStore(shop) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  // Sets RLS session config — scopes all subsequent queries to this store
  await supabase.rpc('set_app_store', { store: shop });
  return supabase;
}
