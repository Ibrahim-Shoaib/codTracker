import { createClient } from "@supabase/supabase-js";
const SHOP = "the-trendy-homes-pk.myshopify.com";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
const { data } = await sb
  .from("capi_delivery_log")
  .select("event_id, event_name, status, http_status, error_msg, sent_at")
  .eq("store_id", SHOP)
  .gte("sent_at", since)
  .order("sent_at", { ascending: false });
console.table(data);
