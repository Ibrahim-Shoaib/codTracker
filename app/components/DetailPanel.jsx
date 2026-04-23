import { useState } from "react";
import {
  Modal,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Divider,
} from "@shopify/polaris";
import DrillDownTable from "./DrillDownTable.jsx";

const fmtPKR = (n) =>
  n == null ? "N/A" : `PKR ${Math.round(Number(n)).toLocaleString()}`;

const fmtCost = (n) =>
  n == null ? "N/A" : `-PKR ${Math.round(Number(n)).toLocaleString()}`;

const fmtNum = (n) => (n == null ? "N/A" : String(Math.round(Number(n))));

const fmtRatio = (n) => (n == null ? "N/A" : Number(n).toFixed(2));

const fmtPct = (n) => (n == null ? "N/A" : `${Number(n).toFixed(2)}%`);

const PERIOD_NAMES = {
  today: "Today",
  yesterday: "Yesterday",
  mtd: "Month to Date",
  lastMonth: "Last Month",
};

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
//   period           'today'|'yesterday'|'mtd'|'lastMonth'
//   stats            object from get_dashboard_stats RPC
//   dateRange        { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
//   sellableReturnsPct  number
//   expensesList     Array<{ id, name, amount, type }>
//   open             boolean
//   onClose          () => void
export default function DetailPanel({
  period,
  stats,
  dateRange,
  sellableReturnsPct,
  expensesList,
  open,
  onClose,
}) {
  const [drillFilter, setDrillFilter] = useState(null);
  const [showExpBreakdown, setShowExpBreakdown] = useState(false);

  if (!stats) return null;

  const drill = (filter) => setDrillFilter(filter);

  // Compute per-expense amounts for this period
  const expenses = expensesList ?? [];
  const daysInPeriod = dateRange
    ? Math.round(
        (new Date(dateRange.to) - new Date(dateRange.from)) / 86_400_000
      ) + 1
    : 30;

  const expBreakdown = expenses.map((exp) => ({
    name: exp.name,
    value:
      exp.type === "monthly"
        ? Number(exp.amount) * (daysInPeriod / 30)
        : Number(exp.amount) * Number(stats.orders ?? 0),
  }));

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={PERIOD_NAMES[period] ?? "Details"}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Row
              label="Sales"
              value={fmtPKR(stats.sales)}
              onClick={() => drill("delivered")}
            />
            <Row
              label="Orders"
              value={fmtNum(stats.orders)}
              onClick={() => drill("delivered")}
            />
            <Row
              label="Units Sold"
              value={fmtNum(stats.units)}
              onClick={() => drill("delivered")}
            />
            <Row
              label="Returns"
              value={fmtNum(stats.returns)}
              onClick={() => drill("returned")}
            />
            <Row
              label="In Transit"
              value={fmtNum(stats.in_transit)}
              onClick={() => drill("in_transit")}
            />
            <Row
              label="Advertising cost"
              value={fmtCost(stats.ad_spend)}
              onClick={() => drill("all")}
            />
            <Row
              label="Shipping costs"
              value={fmtCost(
                stats.delivery_cost != null && stats.reversal_cost != null
                  ? stats.delivery_cost - stats.reversal_cost
                  : stats.delivery_cost
              )}
              onClick={() => drill("all")}
            />
            <Row
              label="Reversal costs"
              value={fmtCost(stats.reversal_cost)}
              onClick={() => drill("returned")}
            />
            <Row
              label="Cost of goods"
              value={fmtCost(stats.cogs)}
              onClick={() => drill("all")}
            />

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
            <Row label="% Refunds" value={fmtPct(stats.refund_pct)} />
            <Row
              label="Sellable returns"
              value={`${sellableReturnsPct ?? 100}%`}
            />
            <Row label="Margin" value={fmtPct(stats.margin_pct)} />
            <Row label="ROI" value={fmtPct(stats.roi_pct)} />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {drillFilter && (
        <DrillDownTable
          fromDate={dateRange?.from}
          toDate={dateRange?.to}
          statusFilter={drillFilter}
          open={!!drillFilter}
          onClose={() => setDrillFilter(null)}
        />
      )}
    </>
  );
}
