import { useState } from "react";
import {
  Modal,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Divider,
} from "@shopify/polaris";

const fmtPKR = (n) =>
  n == null ? "N/A" : `PKR ${Math.round(Number(n)).toLocaleString()}`;

const fmtCost = (n) =>
  n == null ? "N/A" : `-PKR ${Math.round(Number(n)).toLocaleString()}`;

const fmtNum = (n) => (n == null ? "N/A" : String(Math.round(Number(n))));

const fmtRatio = (n) => (n == null ? "N/A" : Number(n).toFixed(2));

const fmtPct = (n) => (n == null ? "N/A" : `${Number(n).toFixed(2)}%`);


function Row({ label, value, onClick }) {
  return (
    <InlineStack align="space-between" blockAlign="center">
      {onClick ? (
        <Button variant="plain" textAlign="start" onClick={onClick}>
          › {label}
        </Button>
      ) : (
        <Text as="span" variant="bodyMd">
          {label}
        </Text>
      )}
      <Text as="span" variant="bodyMd">
        {value}
      </Text>
    </InlineStack>
  );
}

// Props:
//   title        string — modal heading
//   stats        object from get_dashboard_stats RPC
//   dateRange    { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
//   expensesList Array<{ id, name, amount, type }>
//   open         boolean
//   onClose      () => void
export default function DetailPanel({
  title,
  stats,
  dateRange,
  expensesList,
  open,
  onClose,
}) {
  const [showExpBreakdown, setShowExpBreakdown] = useState(false);

  if (!stats) return null;

  // Compute per-expense amounts for this period
  const expenses = expensesList ?? [];
  // Count how many 1st-of-months fall within the date range — mirrors the SQL v_month_count logic.
  // Pure string comparison on YYYY-MM-DD avoids UTC vs local timezone mismatch.
  function countMonthStarts(from, to) {
    let count = 0;
    let [y, m] = from.split('-').map(Number);
    while (true) {
      const first = `${y}-${String(m).padStart(2, '0')}-01`;
      if (first > to) break;
      if (first >= from) count++;
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return count;
  }
  const monthCount = dateRange ? countMonthStarts(dateRange.from, dateRange.to) : 0;

  const expBreakdown = expenses.map((exp) => ({
    name: exp.name,
    value:
      exp.type === "monthly"
        ? Number(exp.amount) * monthCount
        : Number(exp.amount) * Number(stats.orders ?? 0),
  }));

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={title ?? "Details"}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Row label="Sales" value={fmtPKR(stats.sales)} />
            <Row label="Orders" value={fmtNum(stats.orders)} />
            <Row label="Units Sold" value={fmtNum(stats.units)} />
            <Row label="Returns" value={fmtNum(stats.returns)} />
            <Row label="In Transit" value={fmtNum(stats.in_transit)} />
            <Row label="Advertising cost" value={fmtCost(stats.ad_spend)} />
            <Row
              label="Shipping costs"
              value={fmtCost(
                stats.delivery_cost != null && stats.reversal_cost != null
                  ? stats.delivery_cost - stats.reversal_cost
                  : stats.delivery_cost
              )}
            />
            <Row label="Reversal costs" value={fmtCost(stats.reversal_cost)} />
            <Row label="Tax" value={fmtCost(stats.tax)} />
            <Row label="Cost of goods" value={fmtCost(stats.cogs)} />

            {/* Expenses row — expandable when there are named items */}
            <Row
              label="Expenses"
              value={fmtCost(stats.expenses)}
              onClick={expBreakdown.length > 0 ? () => setShowExpBreakdown((v) => !v) : undefined}
            />
            {showExpBreakdown && expBreakdown.length > 0 && (
              <BlockStack gap="100">
                {expBreakdown.map((item) => (
                  <InlineStack key={item.name} align="space-between" blockAlign="center">
                    <Text as="span" variant="bodySm" tone="subdued">
                      &nbsp;&nbsp;&nbsp;{item.name}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {fmtCost(item.value)}
                    </Text>
                  </InlineStack>
                ))}
              </BlockStack>
            )}

            <Divider />

            <Row label="Gross profit" value={fmtPKR(stats.gross_profit)} />
            <Row label="Net profit" value={fmtPKR(stats.net_profit)} />

            <Divider />

            <Row label="Average order value" value={fmtPKR(stats.aov)} />
            <Row label="Blended ROAS" value={fmtRatio(stats.roas)} />
            <Row label="Blended POAS" value={fmtRatio(stats.poas)} />
            <Row label="CAC" value={fmtPKR(stats.cac)} />
            <Row label="% Returns" value={fmtPct(stats.refund_pct)} />
            <Row label="Margin" value={fmtPct(stats.margin_pct)} />
            <Row label="ROI" value={fmtPct(stats.roi_pct)} />
          </BlockStack>
        </Modal.Section>
      </Modal>

    </>
  );
}
