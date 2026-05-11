import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Railway cron: 0 6 * * * (UTC) = once daily at 06:00 UTC (~11 AM PKT)
//
// Computes a real Event Match Quality score per active connection, snapshots
// it into `emq_snapshots`, and trims older snapshots.
//
// Why not Meta's Graph API? The /{dataset_id}/stats endpoint exposes 16
// `aggregation` values; none of them returns the EMQ score Events Manager
// shows. The previous revision used `aggregation=had_pii`, which is just a
// PII-coverage rate (any-key-present ÷ total) and consistently reads ~10/10
// because every event we send carries at least one PII field. `match_keys`
// is available but may be gated by Meta features the app isn't reviewed
// for, so we don't depend on it.
//
// Instead we compute the score locally from `capi_delivery_log.match_keys`,
// which the live send path writes per event in app/lib/meta-capi.server.js.
// Score weights follow Meta's published EMQ guidance: stronger identifiers
// (email, phone) outweigh weaker ones (city, country) — same shape as the
// real Events Manager EMQ, minus penalties Meta applies for malformed
// hashes (our buildUserData normalizes correctly, so those don't apply).

const WINDOW_DAYS = 7;

// Per-key weights, capped at 10 per event. Mirrors Meta's published EMQ
// formula:
//   strong (1.5):   em, ph
//   medium (1.0):   fn, ln, fbc
//   modest (0.6):   external_id
//   light (0.3-0.5): fbp, ct, st, zp, country, ip+ua pair
const WEIGHTS: Record<string, number> = {
  em: 1.5,
  ph: 1.5,
  fn: 1.0,
  ln: 1.0,
  fbc: 1.0,
  external_id: 0.6,
  fbp: 0.5,
  ct: 0.4,
  st: 0.3,
  zp: 0.3,
  country: 0.3,
};

function scoreForKeys(keys: string[] | null): number {
  if (!keys || keys.length === 0) return 0;
  const set = new Set(keys);
  let s = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    if (set.has(k)) s += w;
  }
  // client_ip_address + client_user_agent together are worth 0.5 — neither
  // alone counts (Meta requires both for fingerprint matching).
  if (set.has("client_ip_address") && set.has("client_user_agent")) s += 0.5;
  return Math.min(10, +s.toFixed(2));
}

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
    .select("store_id, dataset_id")
    .eq("status", "active");

  if (!connections?.length) {
    return json({ snapshotted: 0, skipped: 0, errors: 0 });
  }

  let snapshotted = 0;
  let skipped = 0;
  let errors = 0;

  for (const conn of connections) {
    try {
      const snap = await computeSnapshot(supabase, conn.store_id);
      if (!snap) {
        skipped++;
        continue;
      }
      await supabase.from("emq_snapshots").insert({
        store_id: conn.store_id,
        dataset_id: conn.dataset_id,
        overall_emq: snap.overall,
        per_event: snap.perEvent,
      });
      snapshotted++;
    } catch (err) {
      console.error(`EMQ snapshot failed for ${conn.store_id}:`, err);
      errors++;
    }
  }

  await supabase
    .from("emq_snapshots")
    .delete()
    .lt(
      "captured_at",
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    );

  return json({ snapshotted, skipped, errors });
};

async function computeSnapshot(
  supabase: SupabaseClient,
  storeId: string
): Promise<{ overall: number; perEvent: Record<string, number> } | null> {
  const sinceIso = new Date(
    Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  // Pull match_keys for every successfully-sent event in the window.
  // capi_delivery_log has a 500-row-per-shop cap (trigger), so for high-
  // volume shops the effective window is shorter — that's fine, we just
  // score what's there.
  const { data: rows, error } = await supabase
    .from("capi_delivery_log")
    .select("event_name, match_keys")
    .eq("store_id", storeId)
    .eq("status", "sent")
    .gte("sent_at", sinceIso)
    .not("match_keys", "is", null);

  if (error) throw error;
  if (!rows?.length) return null;

  // Per-event-name aggregate: sum of per-event scores ÷ count.
  const buckets = new Map<string, { sum: number; count: number }>();
  for (const r of rows as Array<{ event_name: string; match_keys: string[] | null }>) {
    const s = scoreForKeys(r.match_keys);
    const b = buckets.get(r.event_name) ?? { sum: 0, count: 0 };
    b.sum += s;
    b.count++;
    buckets.set(r.event_name, b);
  }

  const perEvent: Record<string, number> = {};
  let totalEventScore = 0;
  let eventNameCount = 0;
  for (const [name, b] of buckets) {
    const score = +(b.sum / b.count).toFixed(2);
    perEvent[name] = score;
    totalEventScore += score;
    eventNameCount++;
  }

  const overall =
    eventNameCount > 0 ? +(totalEventScore / eventNameCount).toFixed(2) : 0;
  return { overall, perEvent };
}
