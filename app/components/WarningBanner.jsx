import { Banner, BlockStack, Text } from "@shopify/polaris";

// Props:
//   unmatchedCOGSCount  number  — orders with cogs_match_source = 'none'
//   metaConnected       boolean — store has any meta_access_token row
//   isMetaExpired       boolean — stored expiry timestamp is in the past
//   isMetaExpiringSoon  boolean — within 7 days of stored expiry
//   metaExpiresAt       string | null  (ISO date string)
//   metaSyncError       string | null  — last cron error; presence ⇒ disconnected
//   lastMetaSyncAt      string | null  — ISO of the last successful sync
//   backfillInProgress  boolean
export default function WarningBanner({
  unmatchedCOGSCount,
  metaConnected,
  isMetaExpired,
  isMetaExpiringSoon,
  metaExpiresAt,
  metaSyncError,
  lastMetaSyncAt,
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

  // Meta status — single critical signal: the cron is the source of truth.
  // metaSyncError is set on any cron failure (token invalidated, network, etc.)
  // and cleared on success or reconnect. Falling back to the stored expiry
  // covers the case where a token has expired but no cron has run yet.
  const metaIsBroken = metaConnected && (!!metaSyncError || isMetaExpired);

  if (metaIsBroken) {
    const sinceLabel = lastMetaSyncAt
      ? new Date(lastMetaSyncAt).toLocaleString("en-PK", {
          day: "numeric",
          month: "short",
          hour: "numeric",
          minute: "2-digit",
        })
      : null;
    banners.push(
      <Banner
        key="meta-broken"
        tone="critical"
        title="Meta Ads disconnected"
        action={{ content: "Reconnect Meta Ads", url: "/app/settings" }}
      >
        <BlockStack gap="100">
          <Text as="p" variant="bodyMd">
            {sinceLabel
              ? `Ad spend hasn't synced since ${sinceLabel}. ROAS and net profit on this dashboard won't include today's spend until you reconnect.`
              : `Ad spend isn't syncing. ROAS and net profit on this dashboard won't include today's spend until you reconnect.`}
          </Text>
          {metaSyncError && (
            <Text as="p" variant="bodySm" tone="subdued">
              Reason: {metaSyncError}
            </Text>
          )}
        </BlockStack>
      </Banner>
    );
  } else if (isMetaExpiringSoon && metaExpiresAt) {
    const expDate = new Date(metaExpiresAt).toLocaleDateString("en-PK", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    banners.push(
      <Banner
        key="meta-expiring"
        tone="warning"
        action={{ content: "Reconnect", url: "/app/settings" }}
      >
        Your Meta Ads connection expires on {expDate}.
      </Banner>
    );
  } else if (!metaConnected) {
    banners.push(
      <Banner
        key="meta-missing"
        tone="info"
        action={{ content: "Connect Meta Ads", url: "/app/settings" }}
      >
        Connect Meta Ads to see advertising costs and ROAS.
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
