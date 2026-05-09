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
 * Classify the visitor's attribution at conversion time and write it into
 * order_attribution. Three-tier classification:
 *
 *   1. visitor.latest_fbc is set → Meta-attributed. Split FB vs IG via the
 *      most recent visitor_event utm_source.
 *   2. No visitor row, but order's landing_site URL carries fbclid → use
 *      URL-based classification (classifyUrlChannel). Critical for
 *      Instagram/Facebook in-app browser orders, where the IAB sandbox
 *      blocks the storefront beacons that would normally create a
 *      visitor row, but the fbclid still rides through the URL onto the
 *      Shopify order's landing_site field.
 *   3. Otherwise → direct_organic.
 *
 * Idempotent on (store_id, shopify_order_id) so orders/create +
 * orders/paid converge. Designed to never throw — webhook ack must not
 * block on this.
 *
 * @param {object} args
 * @param {string} args.storeId
 * @param {string|number} args.shopifyOrderId
 * @param {string|null} args.visitorId
 * @param {string|null} [args.landingSite]    Shopify order's landing_site URL
 * @param {Date} [args.attributedAt]
 */
export async function recordOrderAttribution({
  storeId,
  shopifyOrderId,
  visitorId,
  landingSite,
  attributedAt,
}) {
  try {
    const supabase = adminClient();

    let channel = "direct_organic";
    let utmSource = null;
    let utmMedium = null;
    let utmCampaign = null;
    let attributionUrl = null;
    let visitorHadFbc = false;

    if (visitorId) {
      const { data: visitor } = await supabase
        .from("visitors")
        .select("latest_fbc")
        .eq("store_id", storeId)
        .eq("visitor_id", visitorId)
        .maybeSingle();

      if (visitor?.latest_fbc) {
        visitorHadFbc = true;
        // Paid Meta — at minimum credit Facebook (fbclid is FB's click ID).
        // Look for the most recent visitor_event whose URL carries a
        // utm_source so we can split FB vs IG. We scan up to 50 recent
        // events; for typical visitors a utm-tagged URL is in the first
        // few rows. If no utm_source is found at all, stay on facebook_ads.
        channel = "facebook_ads";

        const { data: events } = await supabase
          .from("visitor_events")
          .select("url, occurred_at")
          .eq("store_id", storeId)
          .eq("visitor_id", visitorId)
          .order("occurred_at", { ascending: false })
          .limit(50);

        if (events && events.length > 0) {
          // Capture the most recent URL for debugging — this is what the
          // first_touch_url column actually holds now (column name kept
          // for migration stability; future rename = migration 02x).
          attributionUrl = events[0].url ?? null;
          if (attributionUrl && attributionUrl.length > 500) {
            attributionUrl = attributionUrl.slice(0, 500);
          }

          for (const e of events) {
            const c = classifyUrlChannel(e.url);
            if (c.utmSource) {
              utmSource = c.utmSource;
              utmMedium = c.utmMedium;
              utmCampaign = c.utmCampaign;
              if (c.utmSource === "instagram" || c.utmSource === "ig") {
                channel = "instagram_ads";
              }
              break;
            }
          }
        }
      }
    }

    // Tier 2: URL fallback. Triggers when visitor lookup didn't yield an
    // fbc — typical for Instagram/Facebook IAB orders where the storefront
    // beacon was blocked but the order still arrived with the fbclid in
    // landing_site. Without this, every IAB-driven Meta order falls through
    // to direct_organic, structurally undercounting Meta on the dashboard.
    if (!visitorHadFbc && landingSite) {
      const c = classifyUrlChannel(landingSite);
      if (c.channel !== "direct_organic") {
        channel = c.channel;
        utmSource = c.utmSource;
        utmMedium = c.utmMedium;
        utmCampaign = c.utmCampaign;
        attributionUrl = c.firstTouchUrl;
      }
    }

    const row = {
      store_id: storeId,
      shopify_order_id: String(shopifyOrderId),
      visitor_id: visitorId ?? null,
      channel,
      utm_source: utmSource,
      utm_medium: utmMedium,
      utm_campaign: utmCampaign,
      first_touch_url: attributionUrl,
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
