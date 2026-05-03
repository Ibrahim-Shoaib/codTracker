import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import {
  DEMO_POOL_STORE_ID,
  ensurePoolSeeded,
  reseedPool,
  tickPool,
} from "../lib/demo-pool.server.js";

// Daily cron: keeps the shared demo pool's data rolling forward by
// appending today + sweeping any in-transit orders past the 14-day window.
// All is_demo merchant stores read from this pool, so a single tick is
// enough no matter how many demo merchants are onboarded.
//
// Recommended Railway schedule: 0 4 * * *  (UTC = 9 AM PKT). The per-day
// idempotency check in the fabricator means re-runs are no-ops, so it's
// safe to run more often.
//
// Auth: same x-cron-secret pattern as the other crons.
//
// Optional query params:
//   ?reseed=1            → wipe the pool's orders + ad_spend and re-fabricate
//                         the last 90 days. Use after fabrication-parameter
//                         changes so existing data adopts the new math.
//   ?days=N              → with reseed, controls how many past days to seed
//                         (default 90).
//
// Both POST and GET handlers so it can be triggered manually.

async function tick(request: Request) {
  if (request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const reseed = url.searchParams.get("reseed") === "1";
  const reseedDays = Number(url.searchParams.get("days") ?? 90);

  // The pool runs under its own sentinel store_id — getSupabaseForStore
  // sets the RLS context to it (no-op since service-role bypasses RLS,
  // but keeps the convention consistent with the rest of the codebase).
  const supabase = await getSupabaseForStore(DEMO_POOL_STORE_ID);

  try {
    if (reseed) {
      const result = await reseedPool(supabase, reseedDays);
      return json({
        mode: "reseed",
        pool: DEMO_POOL_STORE_ID,
        days: reseedDays,
        ordersInserted: result.ordersInserted,
        adSpendInserted: result.adSpendInserted,
        daysFabricated: result.daysFabricated,
      });
    }

    // Default tick: ensure pool has at least its 90-day seed (no-op when
    // already populated), then append today + sweep stale in-transit.
    const seedResult = await ensurePoolSeeded(supabase);
    const tickResult = await tickPool(supabase);

    return json({
      mode: "tick",
      pool: DEMO_POOL_STORE_ID,
      seedAlreadyPresent: seedResult.alreadySeeded,
      todayOrdersInserted: tickResult.fab.ordersInserted,
      stale: tickResult.sweep,
    });
  } catch (err: any) {
    console.error("[demo-tick] failed:", err);
    return json({ error: err?.message ?? String(err) }, { status: 500 });
  }
}

export const action = async ({ request }: ActionFunctionArgs) => tick(request);
export const loader = async ({ request }: LoaderFunctionArgs) => tick(request);
