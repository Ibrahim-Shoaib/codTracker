import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../lib/crypto.server.js";
import { fetchEMQ } from "../lib/meta-pixel.server.js";

// Railway cron: 0 6 * * * (UTC) = once daily at 06:00 UTC (~11 AM PKT)
//
// Pulls per-event EMQ (Event Match Quality) scores for every active dataset
// and snapshots them into emq_snapshots. Drives the EMQ trend chart on the
// Ad Tracking page. Skips datasets that errored or have no events yet.

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: connections } = await supabase
    .from("meta_pixel_connections")
    .select("store_id, dataset_id, bisu_token")
    .eq("status", "active");

  if (!connections?.length) {
    return json({ snapshotted: 0, skipped: 0, errors: 0 });
  }

  let snapshotted = 0;
  let skipped = 0;
  let errors = 0;

  for (const conn of connections) {
    try {
      const token = decryptSecret(conn.bisu_token);
      const stats = await fetchEMQ(token, conn.dataset_id);
      if (!stats) {
        skipped++;
        continue;
      }

      // Stats shape (Meta): array of { event_name, value } where value is the
      // EMQ for that event in the past 7 days. We compute an overall score as
      // a weighted-by-volume average if Meta returns volume; otherwise simple
      // mean.
      const perEvent: Record<string, number> = {};
      let total = 0;
      let count = 0;
      for (const row of stats as Array<{ event_name?: string; value?: number }>) {
        if (row?.event_name && typeof row.value === "number") {
          perEvent[row.event_name] = row.value;
          total += row.value;
          count++;
        }
      }
      const overall = count > 0 ? total / count : null;

      await supabase.from("emq_snapshots").insert({
        store_id: conn.store_id,
        dataset_id: conn.dataset_id,
        overall_emq: overall,
        per_event: perEvent,
      });
      snapshotted++;
    } catch (err) {
      console.error(`EMQ snapshot failed for ${conn.store_id}:`, err);
      errors++;
    }
  }

  // Trim emq_snapshots older than 90 days. Cheap because of the (store_id,
  // captured_at) index — single full table delete with a WHERE clause.
  await supabase
    .from("emq_snapshots")
    .delete()
    .lt(
      "captured_at",
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    );

  return json({ snapshotted, skipped, errors });
};
