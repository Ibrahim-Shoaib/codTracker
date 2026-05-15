import { useState } from "react";
import {
  Modal,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Badge,
  Divider,
} from "@shopify/polaris";
import { formatMoney, formatNegative } from "../lib/format.js";

const fmtPKR = (n, currency) => formatMoney(n, currency, { nullDisplay: "N/A" });
const fmtCost = (n, currency) => formatNegative(n, currency, { nullDisplay: "N/A" });

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
//   title            string — modal heading
//   stats            object from get_dashboard_stats RPC
//   dateRange        { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
//   expenseBreakdown Array<{ name, value, estimated }> — from get_expense_breakdown
//                    (or the shared JS allocator for shopify_direct). Already
//                    period-correct and always sums to stats.expenses.
//   open             boolean
//   onClose          () => void
export default function DetailPanel({
  title,
  stats,
  dateRange,
  expenseBreakdown,
  open,
  onClose,
  currency = "PKR",
  caps = { returnsLabel: "Returns", returnsUnit: "count" },
}) {
  const [showExpBreakdown, setShowExpBreakdown] = useState(false);

  if (!stats) return null;

  // Per-expense amounts come straight from the allocator (SQL or shared
  // JS mirror) — already period-correct and reconcile to stats.expenses.
  // Hide zero-contribution rows (e.g. an expense not active this period).
  const expBreakdown = (expenseBreakdown ?? [])
    .map((e) => ({
      name: e.name,
      value: Number(e.value ?? 0),
      estimated: !!e.estimated,
    }))
    .filter((e) => e.value !== 0 || e.estimated);

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={title ?? "Details"}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Row label="Sales" value={fmtPKR(stats.sales, currency)} />
            <Row label="Orders" value={fmtNum(stats.orders)} />
            <Row label="Units Sold" value={fmtNum(stats.units)} />
            <Row
              label={caps.returnsLabel}
              value={
                caps.returnsUnit === "money"
                  ? fmtPKR(stats.return_loss, currency)
                  : fmtNum(stats.returns)
              }
            />
            <Row label="In Transit" value={fmtNum(stats.in_transit)} />
            <Row label="Advertising cost" value={fmtCost(stats.ad_spend, currency)} />
            <Row
              label="Shipping costs"
              value={fmtCost(
                stats.delivery_cost != null && stats.reversal_cost != null && stats.tax != null
                  ? stats.delivery_cost - stats.reversal_cost - stats.tax
                  : stats.delivery_cost,
                currency
              )}
            />
            <Row label="Reversal costs" value={fmtCost(stats.reversal_cost, currency)} />
            <Row label="Tax" value={fmtCost(stats.tax, currency)} />
            <Row label="Cost of goods" value={fmtCost(stats.cogs, currency)} />

            {/* Expenses row — expandable when there are named items */}
            <Row
              label="Expenses"
              value={fmtCost(stats.expenses, currency)}
              onClick={expBreakdown.length > 0 ? () => setShowExpBreakdown((v) => !v) : undefined}
            />
            {showExpBreakdown && expBreakdown.length > 0 && (
              <BlockStack gap="100">
                {expBreakdown.map((item, i) => (
                  <InlineStack key={`${item.name}-${i}`} align="space-between" blockAlign="center">
                    <InlineStack gap="150" blockAlign="center">
                      <Text as="span" variant="bodySm" tone="subdued">
                        &nbsp;&nbsp;&nbsp;{item.name}
                      </Text>
                      {item.estimated && (
                        <Badge tone="attention" size="small">est.</Badge>
                      )}
                    </InlineStack>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {fmtCost(item.value, currency)}
                    </Text>
                  </InlineStack>
                ))}
              </BlockStack>
            )}

            <Divider />

            <Row label="Gross profit" value={fmtPKR(stats.gross_profit, currency)} />
            <Row label="Net profit" value={fmtPKR(stats.net_profit, currency)} />

            <Divider />

            <Row label="Average order value" value={fmtPKR(stats.aov, currency)} />
            <Row label="Blended ROAS" value={fmtRatio(stats.roas)} />
            <Row label="Blended POAS" value={fmtRatio(stats.poas)} />
            <Row label="CAC" value={fmtPKR(stats.cac, currency)} />
            <Row label="% Returns" value={fmtPct(stats.refund_pct)} />
            <Row label="Margin" value={fmtPct(stats.margin_pct)} />
            <Row label="ROI" value={fmtPct(stats.roi_pct)} />
          </BlockStack>
        </Modal.Section>
      </Modal>

    </>
  );
}
