import { json } from "@remix-run/node";
import { getAdminClient } from "../lib/supabase.server.js";

// Deploy/uptime health probe (Railway healthcheckPath + container HEALTHCHECK).
// Verifies the process is serving AND its database dependency answers.
// Unauthenticated by design — returns no data beyond ok/degraded.
export const loader = async () => {
  try {
    const supabase = getAdminClient();
    const { error } = await supabase
      .from("stores")
      .select("store_id", { head: true, count: "exact" })
      .limit(1);
    if (error) throw error;
    return json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[healthz] degraded:", err);
    return json(
      { ok: false },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
};
