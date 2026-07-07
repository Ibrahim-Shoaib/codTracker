import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SHOP = 'the-trendy-homes-pk.myshopify.com';
await sb.rpc('set_app_store', { store: SHOP });

const { data } = await sb.from('orders')
  .select('*')
  .eq('store_id', SHOP)
  .order('created_at', { ascending: false })
  .limit(1);
console.log(JSON.stringify(data?.[0], null, 2));
