import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";

// Railway cron: 1 19 1 * * (UTC) = 1st of month 12:01 AM PKT
// Deletes orders older than the 1st of last month (PKT). Never touches daily_snapshots or ad_spend.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // First day of last month at midnight PKT, expressed as UTC ISO string
  const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
  const nowPKT = new Date(Date.now() + PKT_OFFSET_MS);
  const year  = nowPKT.getUTCFullYear();
  const month = nowPKT.getUTCMonth(); // 0-indexed current month
  // midnight of 1st of last month in PKT = that instant minus PKT offset in UTC
  const cutoffUTC = new Date(Date.UTC(year, month - 1, 1) - PKT_OFFSET_MS);
  const cutoff = cutoffUTC.toISOString();

  const adminClient = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error, count } = await adminClient
    .from("orders")
    .delete({ count: "exact" })
    .lt("transaction_date", cutoff);

  if (error) {
    console.error("Purge failed:", error);
    return json({ deleted: 0, cutoff, error: error.message }, { status: 500 });
  }

  return json({ deleted: count ?? 0, cutoff });
};
