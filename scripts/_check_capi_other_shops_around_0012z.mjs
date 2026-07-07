// Did OTHER shops also have a CAPI silence then resume at ≈00:12Z 2026-05-10?
// If yes → server deploy/restart. If only Trendy → shop-specific.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// All shops that fired CAPI in the 1-hour window straddling 00:12Z 2026-05-10
const start = "2026-05-09T22:00:00Z";
const end   = "2026-05-10T02:00:00Z";
const { data } = await sb
  .from("capi_delivery_log")
  .select("store_id, sent_at, event_name, status")
  .gte("sent_at", start)
  .lt("sent_at", end)
  .order("sent_at", { ascending: true });

const byShop = new Map();
for (const r of data ?? []) {
  if (!byShop.has(r.store_id)) byShop.set(r.store_id, []);
  byShop.get(r.store_id).push(r);
}
console.log(`CAPI events between ${start} and ${end}: ${data?.length ?? 0} rows across ${byShop.size} shops\n`);
for (const [shop, rows] of byShop) {
  const first = rows[0];
  const last = rows[rows.length - 1];
  console.log(`  ${shop}`);
  console.log(`    first: ${first.sent_at}  ${first.event_name}/${first.status}`);
  console.log(`    last:  ${last.sent_at}  ${last.event_name}/${last.status}`);
  console.log(`    count: ${rows.length}`);
}

// And the one before the window — to know each shop's pre-silence activity.
console.log("\n─── Last CAPI event for each shop BEFORE 22:00Z 2026-05-09 ───");
const { data: shops } = await sb.from("meta_pixel_connections").select("store_id");
for (const { store_id } of shops ?? []) {
  const { data: last } = await sb
    .from("capi_delivery_log")
    .select("event_name, status, sent_at")
    .eq("store_id", store_id)
    .lt("sent_at", start)
    .order("sent_at", { ascending: false })
    .limit(1);
  console.log(`  ${store_id}: ${last?.[0]?.sent_at ?? "(none ever)"} ${last?.[0]?.event_name ?? ""}`);
}
