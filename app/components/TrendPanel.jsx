import { useEffect, useMemo, useState, useCallback, lazy, Suspense } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Card,
  Box,
  BlockStack,
  InlineStack,
  Text,
  Button,
  ButtonGroup,
  Popover,
  DatePicker,
  Spinner,
} from "@shopify/polaris";
import { CalendarIcon } from "@shopify/polaris-icons";
import "@shopify/polaris-viz/build/esm/styles.css";

// polaris-viz reads window.matchMedia synchronously during render and
// crashes Remix SSR. Lazy-load + mount-gate to keep the polaris-viz module
// browser-only without losing the SSR'd panel chrome (header, KPIs, legend).
const LazyLineChart = lazy(() =>
  import("@shopify/polaris-viz").then((m) => ({ default: m.LineChart }))
);
const LazyVizProvider = lazy(() =>
  import("@shopify/polaris-viz").then((m) => ({ default: m.PolarisVizProvider }))
);

// ── colors (intentional palette discipline) ─────────────────────────────────
// Revenue is the neutral baseline (blue). Profit is the only thing we
// reward visually (green). Costs use orange — *not* red — because growing
// costs alongside growing revenue is healthy; red would train the merchant
// to panic on every scale-up.
const COLOR_REVENUE = "#2C6ECB";
const COLOR_PROFIT  = "#108043";
const COLOR_COST    = "#C05717";

// ── formatters ──────────────────────────────────────────────────────────────
const fmtPKR = (n) => `PKR ${Math.round(Number(n ?? 0)).toLocaleString()}`;
const fmtPKRSigned = (n) => {
  const v = Math.round(Number(n ?? 0));
  if (v < 0) return `-PKR ${Math.abs(v).toLocaleString()}`;
  return `PKR ${v.toLocaleString()}`;
};
// Cost-style formatter — always renders with a leading minus, matching
// the "-PKR …" convention used by KPI card line items like Ad Spend.
// Treats the input as the magnitude of an outflow.
const fmtPKRCost = (n) => {
  const v = Math.round(Number(n ?? 0));
  if (v === 0) return "PKR 0";
  return `-PKR ${Math.abs(v).toLocaleString()}`;
};

// Compact PKR for axis labels: 12,500 → 12.5K · 1.2L · 1.2Cr (Pakistani convention)
const compactPKR = (n) => {
  const v = Number(n ?? 0);
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`;
  if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(0)}K`;
  return `${sign}${Math.round(a)}`;
};

function pctDelta(curr, prior) {
  const c = Number(curr ?? 0);
  const p = Number(prior ?? 0);
  if (p === 0) return null;
  return ((c - p) / Math.abs(p)) * 100;
}
function fmtPctDelta(d) {
  if (d == null) return "—";
  const sign = d > 0 ? "↑" : d < 0 ? "↓" : "";
  return `${sign}${Math.abs(d).toFixed(0)}%`;
}

// ── date helpers ────────────────────────────────────────────────────────────
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function ymdParts(s) {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}
function ymdOfDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function fmtBucketShort(ymd, granularity) {
  const { y, m, d } = ymdParts(ymd);
  if (granularity === "year")  return String(y);
  if (granularity === "month") return `${MONTHS[m - 1]} ${y}`;
  return `${MONTHS[m - 1]} ${d}`;
}
function fmtBucketLong(ymd, granularity) {
  const { y, m, d } = ymdParts(ymd);
  if (granularity === "year")  return String(y);
  if (granularity === "month") return `${MONTHS[m - 1]} ${y}`;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
function fmtRange(fromYmd, toYmd) {
  const a = ymdParts(fromYmd);
  const b = ymdParts(toYmd);
  if (a.y === b.y && a.m === b.m) return `${MONTHS[a.m - 1]} ${a.d} – ${b.d}, ${a.y}`;
  if (a.y === b.y)               return `${MONTHS[a.m - 1]} ${a.d} – ${MONTHS[b.m - 1]} ${b.d}, ${a.y}`;
  return `${MONTHS[a.m - 1]} ${a.d}, ${a.y} – ${MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
}

// Adaptive X-axis tick density — show ~6 evenly spaced labels, blank the rest
// so 90 daily ticks don't overlap into a smear.
function makeAxisFormatter(granularity, count) {
  const target = 6;
  const step = Math.max(1, Math.ceil(count / target));
  return (key, index) => {
    if (typeof key !== "string") return "";
    if (index != null && index % step !== 0) return "";
    return fmtBucketShort(key, granularity);
  };
}

// ── main component ──────────────────────────────────────────────────────────
// Props from loader:
//   initialPayload  { granularity, current:{from,to,points}, prior:{from,to,points} }
//   backfillInProgress  boolean — hide entirely until first sync lands
export default function TrendPanel({ initialPayload, backfillInProgress }) {
  const [days, setDays] = useState(30);
  const [payload, setPayload] = useState(initialPayload);

  // Custom-range popover
  const [popoverOpen, setPopoverOpen] = useState(false);
  const today = useMemo(() => new Date(), []);
  const [pickerMonth, setPickerMonth] = useState({
    month: today.getMonth(),
    year: today.getFullYear(),
  });
  const [pickerSel, setPickerSel] = useState({ start: null, end: null });

  // Defer chart render until after hydration (polaris-viz needs window)
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const fetcher = useFetcher();
  useEffect(() => {
    if (fetcher.data && !fetcher.data.error && fetcher.state === "idle") {
      setPayload(fetcher.data);
    }
  }, [fetcher.data, fetcher.state]);
  const isLoading = fetcher.state !== "idle";

  const loadPreset = useCallback(
    (n) => { setDays(n); fetcher.load(`/app/api/trend?days=${n}`); },
    [fetcher]
  );
  const applyCustom = useCallback(() => {
    if (!pickerSel.start || !pickerSel.end) return;
    const f = ymdOfDate(pickerSel.start);
    const t = ymdOfDate(pickerSel.end);
    setDays(null);
    setPopoverOpen(false);
    fetcher.load(`/app/api/trend?from=${f}&to=${t}`);
  }, [pickerSel, fetcher]);

  const { granularity, current, prior } = payload ?? {
    granularity: "day",
    current: { from: "", to: "", points: [] },
    prior:   { from: "", to: "", points: [] },
  };

  // ── derive series + period totals ──────────────────────────────────────────
  const { chartData, totals, axisFormatter, currKeys } = useMemo(() => {
    const curr = current.points ?? [];
    const pri  = prior.points ?? [];

    const keys      = curr.map((r) => String(r.bucket_start).slice(0, 10));
    const revenue   = curr.map((r) => Number(r.sales      ?? 0));
    const profit    = curr.map((r) => Number(r.net_profit ?? 0));
    const cost      = curr.map((r) => Number(r.total_cost ?? 0));

    const data = [
      {
        name: "Revenue",
        color: COLOR_REVENUE,
        data: keys.map((k, i) => ({ key: k, value: revenue[i] })),
      },
      {
        name: "Profit",
        color: COLOR_PROFIT,
        styleOverride: { line: { strokeDasharray: "5,4" } },
        data: keys.map((k, i) => ({ key: k, value: profit[i] })),
      },
      {
        // Cost is plotted as a negative magnitude so the line sits below
        // zero on the same axis as Revenue. Reads as "money out" mirroring
        // Revenue's "money in"; Profit visually equals the gap between
        // Revenue and the inverted Cost line. Tooltip + KPI badge still
        // render the original positive magnitude with a leading "-PKR".
        //
        // Area fill is disabled (hasArea: false) — polaris-viz's area
        // generator hardcodes y0 = chart bottom, so the gradient on a
        // negative line would extend downward past the line toward the
        // axis floor instead of upward toward the zero baseline. The
        // dashed line alone reads cleaner.
        name: "Cost",
        color: COLOR_COST,
        styleOverride: {
          line: { strokeDasharray: "5,4", hasArea: false },
        },
        data: keys.map((k, i) => ({ key: k, value: -cost[i] })),
      },
    ];

    const sumOf = (arr) => arr.reduce((a, b) => a + b, 0);
    const t = {
      revenueCurr: sumOf(revenue),
      profitCurr:  sumOf(profit),
      costCurr:    sumOf(cost),
      revenuePrior: sumOf(pri.map((r) => Number(r.sales      ?? 0))),
      profitPrior:  sumOf(pri.map((r) => Number(r.net_profit ?? 0))),
      costPrior:    sumOf(pri.map((r) => Number(r.total_cost ?? 0))),
    };

    return {
      chartData: data,
      totals: t,
      axisFormatter: makeAxisFormatter(granularity, keys.length),
      currKeys: keys,
    };
  }, [current, prior, granularity]);

  // Note: we used to hide the panel entirely while backfillInProgress was
  // true, but the dashboard now always renders the full app — even with
  // zero data — so the merchant sees what they bought. The chart's own
  // "No activity in this window yet" empty state handles the zero case
  // gracefully.
  void backfillInProgress;

  const hasAnyData = (current.points?.length ?? 0) > 0;
  const hasAnyActivity = (current.points ?? []).some(
    (r) => Number(r.sales ?? 0) > 0 || Number(r.ad_spend ?? 0) > 0
  );

  const headerRangeLabel  = days ? `Last ${days} days` : fmtRange(current.from, current.to);
  const compareRangeLabel = fmtRange(prior.from, prior.to);

  // Period-over-period deltas — preserved here as compact badges so we
  // don't need a fourth (dotted) comparison line in the chart itself.
  const dRevenue = pctDelta(totals.revenueCurr, totals.revenuePrior);
  const dProfit  = pctDelta(totals.profitCurr,  totals.profitPrior);
  const dCost    = pctDelta(totals.costCurr,    totals.costPrior);

  return (
    <Card>
      <BlockStack gap="400">
        {/* Header: title + window toggle */}
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">Performance</Text>
            <Text as="p" tone="subdued" variant="bodySm">
              {headerRangeLabel}
              {isLoading && (
                <span style={{ marginLeft: 8, display: "inline-flex", verticalAlign: "middle" }}>
                  <Spinner size="small" />
                </span>
              )}
              <Text as="span" tone="subdued" variant="bodySm">
                {"  ·  vs "}{compareRangeLabel}
              </Text>
            </Text>
          </BlockStack>

          <InlineStack gap="200" blockAlign="center">
            <ButtonGroup variant="segmented">
              <Button pressed={days === 7}  onClick={() => loadPreset(7)}>7d</Button>
              <Button pressed={days === 30} onClick={() => loadPreset(30)}>30d</Button>
              <Button pressed={days === 90} onClick={() => loadPreset(90)}>90d</Button>
            </ButtonGroup>

            <Popover
              active={popoverOpen}
              onClose={() => setPopoverOpen(false)}
              activator={
                <Button
                  pressed={days === null}
                  icon={CalendarIcon}
                  onClick={() => setPopoverOpen((v) => !v)}
                >
                  Custom
                </Button>
              }
              preferredAlignment="right"
            >
              <Box padding="300">
                <BlockStack gap="300">
                  <DatePicker
                    month={pickerMonth.month}
                    year={pickerMonth.year}
                    onChange={setPickerSel}
                    onMonthChange={(m, y) => setPickerMonth({ month: m, year: y })}
                    selected={pickerSel.start ? pickerSel : undefined}
                    allowRange
                    disableDatesAfter={new Date()}
                  />
                  <InlineStack align="end">
                    <Button
                      variant="primary"
                      disabled={!pickerSel.start || !pickerSel.end}
                      onClick={applyCustom}
                    >
                      Apply
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Box>
            </Popover>
          </InlineStack>
        </InlineStack>

        {/* KPI strip — period totals + % delta vs prior period.
            Replaces the dotted comparison line: "are we trending better?"
            answered as a compact number instead of a fourth chart series. */}
        <InlineStack gap="600" wrap>
          <KpiBadge
            label="Revenue"
            color={COLOR_REVENUE}
            value={fmtPKR(totals.revenueCurr)}
            delta={dRevenue}
            // For revenue, up is good
            goodIfPositive
          />
          <KpiBadge
            label="Profit"
            color={COLOR_PROFIT}
            value={fmtPKRSigned(totals.profitCurr)}
            delta={dProfit}
            goodIfPositive
          />
          <KpiBadge
            label="Cost"
            color={COLOR_COST}
            value={fmtPKRCost(totals.costCurr)}
            delta={dCost}
            // For cost, up is bad
            goodIfPositive={false}
          />
        </InlineStack>

        {/* Chart — three lines on one axis */}
        {hasAnyData && hasAnyActivity ? (
          <div style={{ height: 280 }}>
            {mounted ? (
              <Suspense fallback={<ChartSkeletonBox />}>
                <LazyVizProvider>
                  <LazyLineChart
                    data={chartData}
                    showLegend={false}
                    xAxisOptions={{ labelFormatter: axisFormatter }}
                    yAxisOptions={{ labelFormatter: compactPKR }}
                    // Emphasize the zero baseline — separates "money in"
                    // (Revenue, Profit above) from "money out" (inverted
                    // Cost below). Without this every gridline looks the
                    // same and the merchant has to hunt for zero.
                    annotations={[
                      { axis: "y", startKey: 0, label: "" },
                    ]}
                    renderAnnotationContent={() => null}
                    tooltipOptions={{
                      renderTooltipContent: (args) => (
                        <TrendTooltip
                          args={args}
                          currentPoints={current.points}
                          granularity={granularity}
                        />
                      ),
                    }}
                  />
                </LazyVizProvider>
              </Suspense>
            ) : (
              <ChartSkeletonBox />
            )}
          </div>
        ) : (
          <Box padding="600">
            <BlockStack gap="200" inlineAlign="center">
              <Text as="p" tone="subdued">No activity in this window yet.</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Try a wider range — your existing orders may sit outside it.
              </Text>
            </BlockStack>
          </Box>
        )}

        {/* Legend — one row, matches Shopify's compact bottom legend */}
        <InlineStack align="center" gap="500" blockAlign="center">
          <LegendDot color={COLOR_REVENUE} label="Revenue" />
          <LegendDot color={COLOR_PROFIT}  label="Profit" dashed />
          <LegendDot color={COLOR_COST}    label="Cost"   dashed />
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// ── KPI badge ───────────────────────────────────────────────────────────────
// Big number + colored delta. `goodIfPositive` flips the green/red logic
// so a rising cost goes red and a rising profit goes green.
function KpiBadge({ label, color, value, delta, goodIfPositive }) {
  const tone =
    delta == null
      ? "subdued"
      : (goodIfPositive ? delta >= 0 : delta <= 0)
      ? "success"
      : "critical";
  return (
    <BlockStack gap="050">
      <InlineStack gap="150" blockAlign="center">
        <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: "inline-block" }} />
        <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
      </InlineStack>
      <Text as="p" variant="headingLg">{value}</Text>
      <Text as="p" variant="bodySm" tone={tone}>{fmtPctDelta(delta)} vs prior</Text>
    </BlockStack>
  );
}

// ── tooltip — shows all three metrics for the hovered date ─────────────────
function TrendTooltip({ args, currentPoints, granularity }) {
  const i = args?.activeIndex;
  if (i == null || i < 0) return null;
  const row = currentPoints?.[i];
  if (!row) return null;

  const sales  = Number(row.sales      ?? 0);
  const profit = Number(row.net_profit ?? 0);
  const cost   = Number(row.total_cost ?? 0);
  const margin = sales > 0 ? ((profit / sales) * 100).toFixed(1) : null;

  return (
    <div
      style={{
        background: "white",
        border: "1px solid #E1E3E5",
        borderRadius: 8,
        boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
        padding: "12px 14px",
        minWidth: 200,
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>
        {fmtBucketLong(String(row.bucket_start).slice(0, 10), granularity)}
      </div>
      <TooltipRow color={COLOR_REVENUE} label="Revenue" value={fmtPKR(sales)} />
      <TooltipRow color={COLOR_PROFIT}  label="Profit"  value={fmtPKRSigned(profit)} valueColor={profit >= 0 ? COLOR_PROFIT : "#BF0711"} />
      <TooltipRow color={COLOR_COST}    label="Cost"    value={fmtPKRCost(cost)} />
      {margin != null && (
        <div style={{ borderTop: "1px solid #E1E3E5", marginTop: 6, paddingTop: 6, color: "#6D7175", fontSize: 12 }}>
          Margin: <span style={{ color: profit >= 0 ? COLOR_PROFIT : "#BF0711", fontWeight: 500 }}>{margin}%</span>
        </div>
      )}
    </div>
  );
}

function TooltipRow({ color, label, value, valueColor }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0" }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: "inline-block", flexShrink: 0 }} />
      <div style={{ flex: 1, color: "#6D7175" }}>{label}</div>
      <div style={{ color: valueColor ?? "#202223", fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function LegendDot({ color, label, dashed }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 18,
          height: 0,
          borderTop: dashed ? `2px dashed ${color}` : `2px solid ${color}`,
          display: "inline-block",
        }}
      />
      <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
    </span>
  );
}

function ChartSkeletonBox() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "#F4F6F8",
        borderRadius: 8,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#6D7175",
        fontSize: 13,
      }}
    >
      Loading chart…
    </div>
  );
}
