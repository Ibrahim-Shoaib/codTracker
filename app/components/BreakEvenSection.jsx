import {
  Card,
  Box,
  BlockStack,
  InlineGrid,
  InlineStack,
  Text,
  Icon,
  Tooltip,
} from "@shopify/polaris";
import { CaretUpIcon, CaretDownIcon } from "@shopify/polaris-icons";

// ── Number formatters ────────────────────────────────────────────────────────
const fmtRatio = (n) =>
  n == null ? "N/A" : `${Number(n).toFixed(2)}×`;

const fmtPKR = (n) =>
  n == null ? "N/A" : `PKR ${Math.round(Number(n)).toLocaleString()}`;

const fmtPct = (n) =>
  n == null ? "N/A" : `${Number(n).toFixed(1)}%`;

// ── Card chrome ─────────────────────────────────────────────────────────────
// One uniform card. Header strip is a soft neutral so the section reads as a
// distinct row from the colourful KPI cards above without competing for focus.
function StatCard({ label, primary, footer, tooltip }) {
  return (
    <Card padding="0">
      <BlockStack gap="0">
        <Box
          paddingInline="400"
          paddingBlock="300"
          background="bg-surface-secondary"
          borderColor="border"
          borderBlockEndWidth="025"
        >
          <Tooltip content={tooltip} dismissOnMouseOut>
            <Text as="span" variant="bodySm" tone="subdued" fontWeight="medium">
              {label}
            </Text>
          </Tooltip>
        </Box>
        <Box paddingInline="400" paddingBlock="500">
          <BlockStack gap="200" inlineAlign="center">
            <Text as="p" variant="heading2xl" fontWeight="bold">
              {primary}
            </Text>
            <Box minHeight="20px">{footer}</Box>
          </BlockStack>
        </Box>
      </BlockStack>
    </Card>
  );
}

// Footer for break-even cards: actual number with directional arrow.
// `betterWhenLower` flips the colour rule for CAC (lower CAC vs ceiling = good).
function ComparisonFooter({ actual, target, formatted, betterWhenLower }) {
  if (actual == null || target == null) {
    return (
      <Text as="span" variant="bodySm" tone="subdued">
        Last 30 days · N/A
      </Text>
    );
  }
  const actualBeatsTarget = betterWhenLower ? actual < target : actual > target;
  const isEqual = Math.abs(actual - target) < 1e-9;
  const tone = isEqual ? "subdued" : actualBeatsTarget ? "success" : "critical";
  // Up arrow always means "good" — green up if actual is on the favourable side
  // of break-even, red down if on the losing side. Direction is semantic, not
  // numeric, so a CAC card under its ceiling reads as "↑" too.
  const ArrowIcon = isEqual ? null : actualBeatsTarget ? CaretUpIcon : CaretDownIcon;

  return (
    <InlineStack gap="100" blockAlign="center">
      {ArrowIcon && (
        <Box>
          <Icon source={ArrowIcon} tone={tone} />
        </Box>
      )}
      <Text as="span" variant="bodySm" tone={tone} fontWeight="semibold">
        {formatted}
      </Text>
      <Text as="span" variant="bodySm" tone="subdued">
        last 30 days
      </Text>
    </InlineStack>
  );
}

// Footer for plain-metric cards (boxes 3 & 4).
function PlainFooter({ text }) {
  return (
    <Text as="span" variant="bodySm" tone="subdued">
      {text}
    </Text>
  );
}

// ── Section ─────────────────────────────────────────────────────────────────
export default function BreakEvenSection({
  breakEvenRoas,
  breakEvenCac,
  actualRoas,
  actualCac,
  deliverySuccessPct,
  costPerReturn,
}) {
  return (
    <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
      <StatCard
        label="Break-even ROAS"
        tooltip="Minimum ROAS where ads cover delivery + COGS. Above the line you keep money on every ad rupee; below it you're burning."
        primary={fmtRatio(breakEvenRoas)}
        footer={
          <ComparisonFooter
            actual={actualRoas}
            target={breakEvenRoas}
            formatted={fmtRatio(actualRoas)}
            betterWhenLower={false}
          />
        }
      />

      <StatCard
        label="Break-even CAC"
        tooltip="Maximum ad cost per delivered order before profit goes negative. If your actual CAC is below this number, ads are paying for themselves."
        primary={fmtPKR(breakEvenCac)}
        footer={
          <ComparisonFooter
            actual={actualCac}
            target={breakEvenCac}
            formatted={fmtPKR(actualCac)}
            betterWhenLower={true}
          />
        }
      />

      <StatCard
        label="Delivery Success"
        tooltip="Share of bookings that actually got delivered (vs returned). The other side of the return-rate coin."
        primary={fmtPct(deliverySuccessPct)}
        footer={<PlainFooter text="Last 30 days" />}
      />

      <StatCard
        label="Cost per Return"
        tooltip="Average PKR loss on each returned order — forward shipping, reverse shipping, and the unsellable portion of inventory."
        primary={fmtPKR(costPerReturn)}
        footer={<PlainFooter text="Last 30 days" />}
      />
    </InlineGrid>
  );
}
