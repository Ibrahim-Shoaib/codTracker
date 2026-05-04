import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient } from "@supabase/supabase-js";

// Railway cron: 0 3 * * * (UTC) = nightly 3am
//
// Trims three time-bounded tables to keep storage in check:
//   - visitor_events: 30-day raw audit trail. Anything older has zero
//     CAPI value (Meta only accepts events ≤ 7d) and only privacy
//     exposure to keep around.
//   - visitors: 180-day rolling on last_seen_at. A visitor who hasn't
//     returned in 6 months is unlikely to. 180d = 6× Meta's longest
//     attribution window.
//   - emq_snapshots: 90-day rolling. Migration 015's comment promised
//     this TTL but never enforced it; migration 017 added the
//     trim_emq_snapshots() function. We invoke it here.
//
// Auth: x-cron-secret header (matches existing api.cron.* pattern).
// Idempotent: re-running mid-day re-applies cutoffs harmlessly.

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  );

  const cutoff30d = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();
  const cutoff180d = new Date(
    Date.now() - 180 * 24 * 60 * 60 * 1000
  ).toISOString();

  const { count: eventsDeleted } = await supabase
    .from("visitor_events")
    .delete({ count: "exact" })
    .lt("occurred_at", cutoff30d);

  const { count: visitorsDeleted } = await supabase
    .from("visitors")
    .delete({ count: "exact" })
    .lt("last_seen_at", cutoff180d);

  // Use the trim_emq_snapshots() function defined in migration 017.
  let emqDeleted = 0;
  try {
    const { data } = await supabase.rpc("trim_emq_snapshots");
    emqDeleted = typeof data === "number" ? data : 0;
  } catch (err) {
    // RPC failure is non-fatal — emq_snapshots is small and missing
    // a single trim run doesn't matter.
    console.warn(
      `[cron visitors-trim] trim_emq_snapshots failed: ${String(err)}`
    );
  }

  return json({
    cutoff_30d: cutoff30d,
    cutoff_180d: cutoff180d,
    visitor_events_deleted: eventsDeleted ?? 0,
    visitors_deleted: visitorsDeleted ?? 0,
    emq_snapshots_deleted: emqDeleted,
  });
};
