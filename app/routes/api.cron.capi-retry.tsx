import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { drainRetries } from "../lib/meta-capi.server.js";

// Railway cron: */5 * * * * (UTC) = every 5 minutes
//
// Drains capi_retries with exponential backoff (5m → 30m → 2h → 6h → 8h).
// Events that fail 5 times are dropped (Meta won't accept events older than
// 7 days anyway, and 5 attempts spans those 7 days).
//
// Auth: x-cron-secret header (matches existing api.cron.* pattern).

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await drainRetries({ limit: 100 });

  return json(result);
};
