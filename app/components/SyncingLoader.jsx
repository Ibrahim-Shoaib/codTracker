import { Card, BlockStack, InlineStack, Text } from "@shopify/polaris";

// In-line app-branded loader. Used at the top of the dashboard whenever a
// store's data is still being populated (real stores doing PostEx historical
// backfill; demo stores waiting on the 90-day fabrication). Renders ABOVE
// the KPI/trend cards rather than replacing them, so the merchant sees the
// full app immediately even before any orders have landed.
//
// SVG mirrors the CODProfit app icon so the loader feels native — green
// rounded square with three bars and an "Rs" badge.
export default function SyncingLoader({
  title = "Setting up your dashboard…",
  subtitle = "Your sales, profit and orders will appear here in a moment.",
}) {
  return (
    <Card padding="400">
      <InlineStack gap="400" blockAlign="center" wrap={false}>
        <BrandIcon />
        <BlockStack gap="100">
          <Text as="p" variant="headingSm">{title}</Text>
          <Text as="p" tone="subdued" variant="bodySm">{subtitle}</Text>
        </BlockStack>
      </InlineStack>
    </Card>
  );
}

function BrandIcon() {
  // 64×64 SVG matching the CODProfit app icon — green rounded square,
  // three bars (small/medium/large) with a pulse animation, "Rs" badge
  // in the top-right corner. Stroke-less so it looks crisp at any size.
  return (
    <span
      aria-hidden="true"
      style={{ display: "inline-flex", flexShrink: 0, width: 56, height: 56 }}
    >
      <svg viewBox="0 0 100 100" width="56" height="56" xmlns="http://www.w3.org/2000/svg">
        {/* Rounded square background */}
        <rect x="0" y="0" width="100" height="100" rx="22" ry="22" fill="#0F6B47" />

        {/* Bars: small / medium / large, with a staggered pulse */}
        <g>
          <rect x="22" y="56" width="14" height="22" rx="3" fill="#FFFFFF" opacity="0.45">
            <animate attributeName="opacity" values="0.45;0.85;0.45" dur="1.6s" begin="0s"   repeatCount="indefinite" />
          </rect>
          <rect x="43" y="44" width="14" height="34" rx="3" fill="#FFFFFF" opacity="0.65">
            <animate attributeName="opacity" values="0.65;1;0.65"    dur="1.6s" begin="0.3s" repeatCount="indefinite" />
          </rect>
          <rect x="64" y="28" width="14" height="50" rx="3" fill="#FFFFFF" opacity="0.95">
            <animate attributeName="opacity" values="0.95;0.5;0.95"  dur="1.6s" begin="0.6s" repeatCount="indefinite" />
          </rect>
        </g>

        {/* "Rs" badge — green circle with darker text */}
        <circle cx="80" cy="22" r="13" fill="#7FCB54" />
        <text
          x="80"
          y="27"
          textAnchor="middle"
          fontSize="13"
          fontWeight="700"
          fill="#0A2E1F"
          fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        >
          Rs
        </text>
      </svg>
    </span>
  );
}
