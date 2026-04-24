import { Banner, BlockStack } from "@shopify/polaris";

// Props:
//   unmatchedCOGSCount  number  — orders with cogs_match_source = 'none'
//   metaConnected       boolean
//   isMetaExpired       boolean
//   isMetaExpiringSoon  boolean
//   metaExpiresAt       string | null  (ISO date string)
//   backfillInProgress  boolean
export default function WarningBanner({
  unmatchedCOGSCount,
  metaConnected,
  isMetaExpired,
  isMetaExpiringSoon,
  metaExpiresAt,
  backfillInProgress,
}) {
  const banners = [];

  if (unmatchedCOGSCount > 0) {
    banners.push(
      <Banner key="cogs-none" tone="warning">
        {unmatchedCOGSCount} order{unmatchedCOGSCount > 1 ? "s have" : " has"} missing
        COGS. Update your product costs in Settings.
      </Banner>
    );
  }

  if (isMetaExpired) {
    banners.push(
      <Banner key="meta-expired" tone="critical">
        Meta Ads disconnected — token expired. Reconnect in Settings to restore
        ad spend data.
      </Banner>
    );
  } else if (isMetaExpiringSoon && metaExpiresAt) {
    const expDate = new Date(metaExpiresAt).toLocaleDateString("en-PK", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    banners.push(
      <Banner key="meta-expiring" tone="warning">
        Your Meta Ads connection expires on {expDate}. Reconnect in Settings.
      </Banner>
    );
  } else if (!metaConnected) {
    banners.push(
      <Banner key="meta-missing" tone="info">
        Connect Meta Ads in Settings to see advertising costs and ROAS.
      </Banner>
    );
  }

  if (backfillInProgress) {
    banners.push(
      <Banner key="backfill" tone="info">
        Syncing your order history… This may take a few minutes.
      </Banner>
    );
  }

  if (banners.length === 0) return null;

  return <BlockStack gap="200">{banners}</BlockStack>;
}
