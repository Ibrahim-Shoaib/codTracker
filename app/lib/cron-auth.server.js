import { timingSafeEqual } from "node:crypto";

// Constant-time check of the x-cron-secret header. All /api/cron/* routes
// share this so none of them leak secret length/prefix via compare timing.
export function verifyCronSecret(request) {
  const provided = request.headers.get("x-cron-secret") ?? "";
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
