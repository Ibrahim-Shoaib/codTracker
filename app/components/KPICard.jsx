import { Card, Box, BlockStack, InlineStack, Text, Badge, Button, Divider } from "@shopify/polaris";

const fmtPKR = (n) => {
  if (n == null) return "N/A";
  const v = Math.round(Number(n));
  return `PKR ${v.toLocaleString()}`;
};

const fmtCost = (n) => {
  if (n == null) return "N/A";
  const v = Math.round(Number(n));
  if (v === 0) return "PKR 0";
  return `-PKR ${v.toLocaleString()}`;
};

const fmtNum = (n) =>
  n == null ? "N/A" : Math.round(Number(n)).toLocaleString();

const fmtRatio = (n) =>
  n == null ? "N/A" : Number(n).toFixed(2);

const fmtPct = (n) =>
  n == null ? "N/A" : `${Number(n).toFixed(1)}%`;

function PctBadge({ value }) {
  if (value == null) return null;
  const up = value >= 0;
  return (
    <Badge tone={up ? "success" : "critical"}>
      {up ? "+" : ""}{Number(value).toFixed(1)}%
    </Badge>
  );
}

function MoneyText({ value, variant = "headingMd" }) {
  if (value == null) return <Text variant={variant}>N/A</Text>;
  const v = Math.round(Number(value));
  const neg = v < 0;
  return (
    <Text variant={variant} tone={neg ? "critical" : undefined}>
      {neg ? `-PKR ${Math.abs(v).toLocaleString()}` : `PKR ${v.toLocaleString()}`}
    </Text>
  );
}

const PERIOD_NAMES = {
  today:     "Today",
  yesterday: "Yesterday",
  mtd:       "MTD",
  lastMonth: "Last Month",
};

export default function KPICard({ period, stats, comparison, dateLabel, onMore }) {
  const isGreen = period === "today" || period === "yesterday";
  const headerBg = isGreen ? "bg-fill-success" : "bg-fill-info";

  return (
    <Card padding="0">
      {/* Header */}
      <Box
        background={headerBg}
        paddingInline="400"
        paddingBlock="300"
        borderRadiusStartStart="300"
        borderRadiusStartEnd="300"
      >
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="headingSm" fontWeight="bold" tone="text-inverse">
            {PERIOD_NAMES[period]}
          </Text>
          <Text as="span" variant="bodySm" tone="text-inverse">
            {dateLabel}
          </Text>
        </InlineStack>
      </Box>

      <Box paddingInline="400" paddingBlock="400">
        <BlockStack gap="400">

          {/* Sales — hero metric */}
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text variant="bodySm" tone="subdued">Sales</Text>
              {period !== "lastMonth" && <PctBadge value={comparison?.salesPctChange} />}
            </InlineStack>
            <Text variant="headingLg" fontWeight="bold">{fmtPKR(stats?.sales)}</Text>
          </BlockStack>

          <Divider />

          {/* Orders / Units  |  Returns */}
          <InlineStack align="space-between" blockAlign="start">
            <BlockStack gap="100">
              <Text variant="bodySm" tone="subdued">Orders / Units</Text>
              <Text variant="bodyMd" fontWeight="semibold">
                {fmtNum(stats?.orders)} / {fmtNum(stats?.units)}
              </Text>
            </BlockStack>
            <BlockStack gap="100">
              <Text variant="bodySm" tone="subdued">Returns</Text>
              <Text variant="bodyMd" fontWeight="semibold">{fmtNum(stats?.returns)}</Text>
            </BlockStack>
          </InlineStack>

          {/* Ad Spend  |  ROAS */}
          <InlineStack align="space-between" blockAlign="start">
            <BlockStack gap="100">
              <Text variant="bodySm" tone="subdued">Ad Spend</Text>
              <Text variant="bodyMd" fontWeight="semibold">{fmtCost(stats?.ad_spend)}</Text>
            </BlockStack>
            <BlockStack gap="100">
              <Text variant="bodySm" tone="subdued">ROAS</Text>
              <Text variant="bodyMd" fontWeight="semibold">{fmtRatio(stats?.roas)}</Text>
            </BlockStack>
          </InlineStack>

          <Divider />

          {/* Net Profit  |  Margin */}
          <InlineStack align="space-between" blockAlign="start">
            <BlockStack gap="100">
              <InlineStack gap="200" blockAlign="center">
                <Text variant="bodySm" tone="subdued">Net Profit</Text>
                {period !== "lastMonth" && <PctBadge value={comparison?.profitPctChange} />}
              </InlineStack>
              <MoneyText value={stats?.net_profit} variant="headingSm" />
            </BlockStack>
            <BlockStack gap="100">
              <Text variant="bodySm" tone="subdued">Margin</Text>
              <Text
                variant="bodyMd"
                fontWeight="semibold"
                tone={stats?.margin_pct != null && Number(stats.margin_pct) < 0 ? "critical" : undefined}
              >
                {fmtPct(stats?.margin_pct)}
              </Text>
            </BlockStack>
          </InlineStack>

          {/* More */}
          <InlineStack align="end">
            <Button variant="plain" onClick={onMore}>More</Button>
          </InlineStack>

        </BlockStack>
      </Box>
    </Card>
  );
}
