import { createClient } from "@supabase/supabase-js";

// First-touch URL → channel classifier for the Ad Tracking dashboard.
//
// Rules (locked to three buckets — see migration 020 comment):
//   facebook_ads   — fbclid present + (utm_source=facebook OR no utm_source)
//   instagram_ads  — fbclid present + utm_source=instagram
//   direct_organic — no fbclid (organic-Meta, true direct, search, etc.)
//
// We treat "fbclid present" as the strong signal of paid Meta traffic.
// utm_source is only used to disambiguate FB vs IG when fbclid is set —
// without an fbclid, utm_source=facebook on its own can come from organic
// link shares, which we don't want counted as ad-attributed.

const FACEBOOK_AD_HOSTS = new Set(["facebook", "fb"]);
const INSTAGRAM_AD_HOSTS = new Set(["instagram", "ig"]);

/**
 * Parse a URL safely. Returns null on any failure (malformed, empty, non-URL).
 * Accepts both absolute URLs and path-only forms ("/products/x?fbclid=...").
 */
function parseUrl(maybeUrl) {
  if (!maybeUrl || typeof maybeUrl !== "string") return null;
  try {
    return new URL(maybeUrl, "https://example.com");
  } catch {
    return null;
  }
}

/**
 * Returns:
 *   {
 *     channel: 'facebook_ads' | 'instagram_ads' | 'direct_organic',
 *     utmSource: string|null,
 *     utmMedium: string|null,
 *     utmCampaign: string|null,
 *     firstTouchUrl: string|null,    // truncated for storage hygiene
 *   }
 *
 * @param {string|null|undefined} url - First-touch landing URL
 */
export function classifyUrlChannel(url) {
  const parsed = parseUrl(url);
  if (!parsed) {
    return {
      channel: "direct_organic",
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      firstTouchUrl: null,
    };
  }

  const params = parsed.searchParams;
  const fbclid = params.get("fbclid");
  const utmSource = params.get("utm_source")?.toLowerCase() ?? null;
  const utmMedium = params.get("utm_medium")?.toLowerCase() ?? null;
  const utmCampaign = params.get("utm_campaign") ?? null; // keep case (may be a campaign id)

  let channel;
  if (fbclid) {
    if (utmSource && INSTAGRAM_AD_HOSTS.has(utmSource)) {
      channel = "instagram_ads";
    } else {
      // fbclid + (utm_source=facebook OR null OR anything else FB-ish)
      // defaults to facebook_ads since fbclid is Meta's click ID
      channel = "facebook_ads";
    }
  } else {
    channel = "direct_organic";
  }

  // Truncate to keep storage bounded — we only need the URL for occasional
  // debugging, never for re-classification or display.
  const firstTouchUrl = url.length > 500 ? url.slice(0, 500) : url;

  return {
    channel,
    utmSource,
    utmMedium,
    utmCampaign,
    firstTouchUrl,
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function adminClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

/**
 * Look up the visitor's earliest tracked URL (first touch) and write the
 * pre-classified channel into order_attribution. Idempotent: re-firing
 * for the same (store_id, shopify_order_id) just overwrites the row,
 * which matters because orders/create + orders/paid both call this.
 *
 * If visitorId is null (visitor lookup missed all three tiers), we still
 * write a direct_organic row so the dashboard's order count matches the
 * actual order count.
 *
 * Designed to never throw — webhook ack must not block on this.
 *
 * @param {object} args
 * @param {string} args.storeId
 * @param {string|number} args.shopifyOrderId
 * @param {string|null} args.visitorId
 * @param {Date} [args.attributedAt]
 */
export async function recordOrderAttribution({
  storeId,
  shopifyOrderId,
  visitorId,
  attributedAt,
}) {
  try {
    const supabase = adminClient();

    let firstTouchUrl = null;
    if (visitorId) {
      const { data: firstTouchRow } = await supabase
        .from("visitor_events")
        .select("url")
        .eq("store_id", storeId)
        .eq("visitor_id", visitorId)
        .order("occurred_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      firstTouchUrl = firstTouchRow?.url ?? null;
    }

    const classified = classifyUrlChannel(firstTouchUrl);

    const row = {
      store_id: storeId,
      shopify_order_id: String(shopifyOrderId),
      visitor_id: visitorId ?? null,
      channel: classified.channel,
      utm_source: classified.utmSource,
      utm_medium: classified.utmMedium,
      utm_campaign: classified.utmCampaign,
      first_touch_url: classified.firstTouchUrl,
      attributed_at: (attributedAt ?? new Date()).toISOString(),
    };

    const { error } = await supabase
      .from("order_attribution")
      .upsert(row, { onConflict: "store_id,shopify_order_id" });

    if (error) {
      console.warn(
        `[channel-attribution] upsert failed for ${storeId}/${shopifyOrderId}:`,
        error.message
      );
    }
  } catch (err) {
    console.warn(
      `[channel-attribution] recordOrderAttribution threw for ${storeId}/${shopifyOrderId}:`,
      String(err?.message ?? err)
    );
  }
}
