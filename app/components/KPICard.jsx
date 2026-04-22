import { Card, Box, BlockStack, InlineStack, Text, Badge, Button } from "@shopify/polaris";

const fmtPKR = (n) =>
  n == null ? "N/A" : `PKR ${Math.round(Number(n)).toLocaleString()}`;

const fmtCost = (n) =>
  n == null ? "N/A" : `-PKR ${Math.round(Number(n)).toLocaleString()}`;

const fmtNum = (n) =>
  n == null ? "N/A" : String(Math.round(Number(n)));

const fmtRatio = (n) =>
  n == null ? "N/A" : Number(n).toFixed(2);

function PctBadge({ value }) {
  if (value == null) return null;
  const up = value >= 0;
  return (
    <Badge tone={up ? "success" : "caution"}>
      {up ? "+" : ""}
      {Number(value).toFixed(1)}%
    </Badge>
  );
}

const PERIOD_NAMES = {
  today: "Today",
  yesterday: "Yesterday",
  mtd: "MTD",
  lastMonth: "Last Month",
};

// Props:
//   period       'today'|'yesterday'|'mtd'|'lastMonth'
//   stats        object from get_dashboard_stats RPC (one row)
//   comparison   { salesPctChange, profitPctChange } | null   (null for lastMonth)
//   dateLabel    string  e.g. "Apr 22" or "Apr 1–22"
//   onMore       () => void
export default function KPICard({ period, stats, comparison, dateLabel, onMore }) {
  const isGreen = period === "today" || period === "yesterday";
  const headerBg = isGreen ? "bg-fill-success" : "bg-fill-info";

  return (
    <Card padding="0">
      <Box background={headerBg} padding="300" borderRadiusStartStart="300" borderRadiusStartEnd="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="headingSm" tone="text-inverse">
            {PERIOD_NAMES[period]}
          </Text>
          <Text as="span" variant="bodySm" tone="text-inverse">
            {dateLabel}
          </Text>
        </InlineStack>
      </Box>

      <Box padding="300">
        <BlockStack gap="300">
          {/* Sales */}
          <BlockStack gap="050">
            <InlineStack gap="100" blockAlign="center">
              <Text variant="bodySm" tone="subdued">
                Sales
              </Text>
              {period !== "lastMonth" && (
                <PctBadge value={comparison?.salesPctChange} />
              )}
            </InlineStack>
            <Text variant="headingMd">{fmtPKR(stats?.sales)}</Text>
          </BlockStack>

          {/* Orders / Units  |  Returns */}
          <InlineStack align="space-between" blockAlign="start">
            <BlockStack gap="050">
              <Text variant="bodySm" tone="subdued">
                Orders / Units
              </Text>
              <Text variant="bodyMd">
                {fmtNum(stats?.orders)} / {fmtNum(stats?.units)}
              </Text>
            </BlockStack>
            <BlockStack gap="050">
              <Text variant="bodySm" tone="subdued">
                Returns
              </Text>
              <Text variant="bodyMd">{fmtNum(stats?.returns)}</Text>
            </BlockStack>
          </InlineStack>

          {/* Adv. cost  |  Blended ROAS */}
          <InlineStack align="space-between" blockAlign="start">
            <BlockStack gap="050">
              <Text variant="bodySm" tone="subdued">
                Adv. cost
              </Text>
              <Text variant="bodyMd">{fmtCost(stats?.ad_spend)}</Text>
            </BlockStack>
            <BlockStack gap="050">
              <Text variant="bodySm" tone="subdued">
                Blended ROAS
              </Text>
              <Text variant="bodyMd">{fmtRatio(stats?.roas)}</Text>
            </BlockStack>
          </InlineStack>

          {/* Net Profit  |  Orders */}
          <InlineStack align="space-between" blockAlign="start">
            <BlockStack gap="050">
              <InlineStack gap="100" blockAlign="center">
                <Text variant="bodySm" tone="subdued">
                  Net Profit
                </Text>
                {period !== "lastMonth" && (
                  <PctBadge value={comparison?.profitPctChange} />
                )}
              </InlineStack>
              <Text variant="bodyMd">{fmtPKR(stats?.net_profit)}</Text>
            </BlockStack>
            <BlockStack gap="050">
              <Text variant="bodySm" tone="subdued">
                Orders
              </Text>
              <Text variant="bodyMd">{fmtNum(stats?.orders)}</Text>
            </BlockStack>
          </InlineStack>

          {/* More button */}
          <InlineStack align="end">
            <Button variant="plain" onClick={onMore}>
              More
            </Button>
          </InlineStack>
        </BlockStack>
      </Box>
    </Card>
  );
}
