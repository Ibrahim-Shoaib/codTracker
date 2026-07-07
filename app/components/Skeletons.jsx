import {
  Card,
  Box,
  BlockStack,
  InlineStack,
  InlineGrid,
  Divider,
  Text,
  Banner,
  SkeletonBodyText,
  SkeletonDisplayText,
} from "@shopify/polaris";

// Shared skeleton + error states for the dashboard's streamed (deferred)
// panels. Every panel that arrives over the wire after first paint shows a
// layout-matched skeleton instead of a blank gap, so the page structure is
// visible immediately and content pops in without reflow jumps.

// Mirrors KPICard's proportions: gradient header strip + sales headline +
// two stat rows. Neutral gray gradient so the skeleton reads as "loading",
// not as a themed card.
export function KPICardSkeleton() {
  return (
    <Card padding="0">
      <div
        style={{
          background: "linear-gradient(135deg, #E2E8F0 0%, #CBD5E1 100%)",
          borderRadius: "12px 12px 0 0",
          padding: "12px 16px",
          height: "58px",
          boxSizing: "border-box",
        }}
      >
        <div style={{ maxWidth: 120 }}>
          <SkeletonBodyText lines={2} />
        </div>
      </div>
      <Box paddingInline="400" paddingBlock="400">
        <BlockStack gap="400">
          <BlockStack gap="200">
            <div style={{ maxWidth: 60 }}>
              <SkeletonBodyText lines={1} />
            </div>
            <SkeletonDisplayText size="medium" maxWidth="140px" />
          </BlockStack>
          <Divider />
          <InlineStack align="space-between" blockAlign="start" gap="400">
            <div style={{ width: "40%" }}><SkeletonBodyText lines={2} /></div>
            <div style={{ width: "40%" }}><SkeletonBodyText lines={2} /></div>
          </InlineStack>
          <InlineStack align="space-between" blockAlign="start" gap="400">
            <div style={{ width: "40%" }}><SkeletonBodyText lines={2} /></div>
            <div style={{ width: "40%" }}><SkeletonBodyText lines={2} /></div>
          </InlineStack>
          <Divider />
          <InlineStack align="space-between" blockAlign="start" gap="400">
            <div style={{ width: "45%" }}><SkeletonBodyText lines={2} /></div>
            <div style={{ width: "35%" }}><SkeletonBodyText lines={2} /></div>
          </InlineStack>
        </BlockStack>
      </Box>
    </Card>
  );
}

export function KPIGridSkeleton() {
  return (
    <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
      <KPICardSkeleton />
      <KPICardSkeleton />
      <KPICardSkeleton />
      <KPICardSkeleton />
    </InlineGrid>
  );
}

// Generic card skeleton for the below-the-fold panels (break-even, trend
// chart, city loss). `lines` roughly matches the panel's content height so
// the page doesn't jump when real content streams in.
export function PanelSkeleton({ title = true, lines = 6 }) {
  return (
    <Card>
      <BlockStack gap="400">
        {title && <SkeletonDisplayText size="small" maxWidth="180px" />}
        <SkeletonBodyText lines={lines} />
      </BlockStack>
    </Card>
  );
}

// Rendered by <Await errorElement> when a deferred panel's promise rejects.
// The rest of the dashboard keeps working — one broken panel must never
// blank the whole page.
export function PanelError({ title = "This section couldn't load" }) {
  return (
    <Banner tone="warning" title={title}>
      <Text as="p" variant="bodySm">
        Refresh the page to try again. Your data is safe — this only affects
        the display.
      </Text>
    </Banner>
  );
}
