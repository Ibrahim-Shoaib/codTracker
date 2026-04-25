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
// Header strip is pinned to a fixed minHeight so the four cards stay vertically
// aligned even when one label wraps to two lines on narrow viewports.
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
          minHeight="44px"
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
// `betterWhenLower` flips the colour rule for cost-per-purchase (lower
// actual vs ceiling = good).
function ComparisonFooter({ actual, target, formatted, betterWhenLower, windowLabel }) {
  if (actual == null || target == null) {
    return (
      <Text as="span" variant="bodySm" tone="subdued">
        {windowLabel} · N/A
      </Text>
    );
  }
  const actualBeatsTarget = betterWhenLower ? actual < target : actual > target;
  const isEqual = Math.abs(actual - target) < 1e-9;
  const tone = isEqual ? "subdued" : actualBeatsTarget ? "success" : "critical";
  // Up arrow always means "good" — green up if actual is on the favourable
  // side of break-even, red down if on the losing side. Direction is
  // semantic, not numeric.
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
        {windowLabel}
      </Text>
    </InlineStack>
  );
}

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
  windowDays,
  isFallback,
}) {
  const days = windowDays ?? 30;
  const windowLabel = `last ${days} days`;

  return (
    <BlockStack gap="200">
      <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
        <StatCard
          label="Break-even ROAS"
          tooltip="The Purchase ROAS your Meta Ads Manager must report — over the same window — for the business to break even. Already converted to Meta's units (booked value ÷ ad spend), so you can compare it directly to the ROAS column in Ads Manager. Includes shipping, COGS, returns, and the fixed expenses configured in Settings."
          primary={fmtRatio(breakEvenRoas)}
          footer={
            <ComparisonFooter
              actual={actualRoas}
              target={breakEvenRoas}
              formatted={fmtRatio(actualRoas)}
              betterWhenLower={false}
              windowLabel={windowLabel}
            />
          }
        />

        <StatCard
          label="Break-even Cost / Purchase"
          tooltip="The maximum Cost per Purchase your Meta Ads Manager can show for the business to break even — same window, same units (ad spend ÷ purchases). Compare it to the Cost per Purchase column in Ads Manager: under this number = profitable, over = losing money."
          primary={fmtPKR(breakEvenCac)}
          footer={
            <ComparisonFooter
              actual={actualCac}
              target={breakEvenCac}
              formatted={fmtPKR(actualCac)}
              betterWhenLower={true}
              windowLabel={windowLabel}
            />
          }
        />

        <StatCard
          label="Delivery Success"
          tooltip="Share of bookings that actually got delivered (vs returned). The other side of the return-rate coin."
          primary={fmtPct(deliverySuccessPct)}
          footer={<PlainFooter text={`Last ${days} days`} />}
        />

        <StatCard
          label="Cost per Return"
          tooltip="Average PKR loss on each returned order — forward shipping, reverse shipping, and the unsellable portion of inventory."
          primary={fmtPKR(costPerReturn)}
          footer={<PlainFooter text={`Last ${days} days`} />}
        />
      </InlineGrid>

      {isFallback && (
        <Box paddingInlineStart="100">
          <Text as="p" variant="bodySm" tone="subdued">
            Showing the last {days} days — your last 30 days didn&apos;t have
            enough delivered orders to clear fixed expenses.
          </Text>
        </Box>
      )}
    </BlockStack>
  );
}
