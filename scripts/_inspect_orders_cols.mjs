import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
await sb.rpc('set_app_store', { store: 'the-trendy-homes-pk.myshopify.com' });
const { data, error } = await sb.from('orders').select('*').eq('store_id', 'the-trendy-homes-pk.myshopify.com').limit(1);
if (error) { console.error(error); process.exit(1); }
console.log(Object.keys(data[0] || {}));
