import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
await sb.rpc('set_app_store', { store: 'the-trendy-homes-pk.myshopify.com' });
const { data } = await sb.from('orders').select('*').eq('store_id', 'the-trendy-homes-pk.myshopify.com').limit(1);
if (data?.[0]) console.log(Object.keys(data[0]).sort().join('\n'));
else console.log('no rows');
