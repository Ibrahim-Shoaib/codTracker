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
  Tabs,
} from "@shopify/polaris";
import { CalendarIcon } from "@shopify/polaris-icons";
import "@shopify/polaris-viz/build/esm/styles.css";

// polaris-viz reads window.matchMedia synchronously during render and
// crashes Remix SSR. We lazy-load both the chart + provider so the polaris-viz
// JS module only evaluates in the browser, and gate the render behind a
// `mounted` flag so SSR/hydration HTML stay aligned.
const LazyLineChart = lazy(() =>
  import("@shopify/polaris-viz").then((m) => ({ default: m.LineChart }))
);
const LazyVizProvider = lazy(() =>
  import("@shopify/polaris-viz").then((m) => ({ default: m.PolarisVizProvider }))
);

// ── metrics ────────────────────────────────────────────────────────────────
const METRICS = [
  { id: "sales",      label: "Total sales",  field: "sales",      kind: "money" },
  { id: "net_profit", label: "Net profit",   field: "net_profit", kind: "money" },
  { id: "total_cost", label: "Total cost",   field: "total_cost", kind: "money" },
  { id: "orders",     label: "Orders",       field: "orders",     kind: "count" },
];

// ── formatters ─────────────────────────────────────────────────────────────
const fmtPKR = (n) => `PKR ${Math.round(Number(n ?? 0)).toLocaleString()}`;
const fmtInt = (n) => Math.round(Number(n ?? 0)).toLocaleString();
const fmtSignedPct = (curr, prior) => {
  const c = Number(curr ?? 0);
  const p = Number(prior ?? 0);
  if (p === 0) return c === 0 ? "0%" : "—";
  const delta = ((c - p) / Math.abs(p)) * 100;
  const sign = delta > 0 ? "↑" : delta < 0 ? "↓" : "";
  return `${sign}${Math.abs(delta).toFixed(0)}% from comparison`;
};

// Compact PKR for axis: 12,500 → 12.5K · 1.2L · 1.2Cr (Pakistani convention)
const compactPKR = (n) => {
  const v = Number(n ?? 0);
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e7) return `PKR ${sign}${(a / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`;
  if (a >= 1e5) return `PKR ${sign}${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e3) return `PKR ${sign}${(a / 1e3).toFixed(0)}K`;
  return `PKR ${sign}${Math.round(a)}`;
};
const compactInt = (n) => {
  const v = Math.round(Number(n ?? 0));
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(v);
};

// ── date helpers ───────────────────────────────────────────────────────────
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
  return `${MONTHS[m - 1]} ${d}`; // day
}
function fmtBucketLong(ymd, granularity) {
  const { y, m, d } = ymdParts(ymd);
  if (granularity === "year")  return String(y);
  if (granularity === "month") return `${MONTHS[m - 1]} ${y}`;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// "Feb 1 – 28, 2026" or "Mar 5, 2025 – Apr 4, 2026"
function fmtRange(fromYmd, toYmd) {
  const a = ymdParts(fromYmd);
  const b = ymdParts(toYmd);
  if (a.y === b.y && a.m === b.m) return `${MONTHS[a.m - 1]} ${a.d} – ${b.d}, ${a.y}`;
  if (a.y === b.y)               return `${MONTHS[a.m - 1]} ${a.d} – ${MONTHS[b.m - 1]} ${b.d}, ${a.y}`;
  return `${MONTHS[a.m - 1]} ${a.d}, ${a.y} – ${MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
}

// ── Adaptive X-axis tick density ────────────────────────────────────────────
// Show roughly N labels evenly spaced; hide the rest. Without this, 90 daily
// ticks overlap into a smear.
function makeAxisFormatter(granularity, count) {
  const target = 6;
  const step = Math.max(1, Math.ceil(count / target));
  return (key, index) => {
    if (typeof key !== "string") return "";
    if (index != null && index % step !== 0) return "";
    return fmtBucketShort(key, granularity);
  };
}

// ── main component ─────────────────────────────────────────────────────────
// Props from loader:
//   initialPayload  { granularity, current:{from,to,points}, prior:{from,to,points} }
//   backfillInProgress  boolean — hide entirely until first sync lands
export default function TrendPanel({ initialPayload, backfillInProgress }) {
  const [days, setDays] = useState(30);
  const [payload, setPayload] = useState(initialPayload);
  const [metricId, setMetricId] = useState("sales");

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

  // ── derive chart data ───────────────────────────────────────────────────
  const metric = METRICS.find((m) => m.id === metricId) ?? METRICS[0];
  const { granularity, current, prior } = payload ?? {
    granularity: "day",
    current: { from: "", to: "", points: [] },
    prior:   { from: "", to: "", points: [] },
  };

  const { chartData, periodTotalCurr, periodTotalPrior, axisFormatter } = useMemo(() => {
    const curr = current.points ?? [];
    const pri  = prior.points ?? [];

    // Each point's bucket_start is a YYYY-MM-DD string from Postgres
    const currKeys = curr.map((r) => String(r.bucket_start).slice(0, 10));
    const currVals = curr.map((r) => Number(r[metric.field] ?? 0));
    // Align by index — the prior array has the same length (equal-length range)
    const priVals  = curr.map((_, i) => Number(pri[i]?.[metric.field] ?? 0));

    const sumCurr = currVals.reduce((a, b) => a + b, 0);
    const sumPri  = priVals.reduce((a, b) => a + b, 0);

    // polaris-viz LineChart series shape
    const data = [
      {
        name: "Current",
        color: "#2C6ECB",
        data: currKeys.map((k, i) => ({ key: k, value: currVals[i] })),
      },
      {
        name: "Comparison",
        color: "#9DBEEB",
        isComparison: true,
        data: currKeys.map((k, i) => ({ key: k, value: priVals[i] })),
      },
    ];

    return {
      chartData: data,
      periodTotalCurr: sumCurr,
      periodTotalPrior: sumPri,
      axisFormatter: makeAxisFormatter(granularity, currKeys.length),
    };
  }, [current, prior, metric, granularity]);

  if (backfillInProgress) return null;

  const hasAnyData = (current.points?.length ?? 0) > 0;
  const hasAnyActivity = (current.points ?? []).some(
    (r) => Number(r.sales ?? 0) > 0 || Number(r.ad_spend ?? 0) > 0
  );

  const headerRangeLabel = days ? `Last ${days} days` : fmtRange(current.from, current.to);
  const compareRangeLabel = fmtRange(prior.from, prior.to);

  // Tabs config — Polaris Tabs API
  const tabs = METRICS.map((m) => ({
    id: m.id,
    content: m.label,
    accessibilityLabel: m.label,
    panelID: `metric-${m.id}`,
  }));

  return (
    <Card>
      <BlockStack gap="400">
        {/* Header: window toggle */}
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

        {/* Metric tabs */}
        <Tabs
          tabs={tabs}
          selected={METRICS.findIndex((m) => m.id === metricId)}
          onSelect={(i) => setMetricId(METRICS[i].id)}
          fitted
        />

        {/* Headline number — current period total + delta vs comparison */}
        <BlockStack gap="050">
          <Text as="p" variant="headingLg">
            {metric.kind === "money" ? fmtPKR(periodTotalCurr) : fmtInt(periodTotalCurr)}
          </Text>
          <Text
            as="p"
            variant="bodySm"
            tone={periodTotalCurr >= periodTotalPrior ? "success" : "critical"}
          >
            {fmtSignedPct(periodTotalCurr, periodTotalPrior)}
            {"  ·  "}
            <Text as="span" tone="subdued" variant="bodySm">
              vs {metric.kind === "money" ? fmtPKR(periodTotalPrior) : fmtInt(periodTotalPrior)}{" "}
              ({compareRangeLabel})
            </Text>
          </Text>
        </BlockStack>

        {/* Chart */}
        {hasAnyData && hasAnyActivity ? (
          <div style={{ height: 280 }}>
            {mounted ? (
              <Suspense fallback={<ChartSkeletonBox />}>
                <LazyVizProvider>
                  <LazyLineChart
                    data={chartData}
                    showLegend={false}
                    xAxisOptions={{ labelFormatter: axisFormatter }}
                    yAxisOptions={{
                      labelFormatter:
                        metric.kind === "money" ? compactPKR : compactInt,
                    }}
                    tooltipOptions={{
                      renderTooltipContent: (args) => (
                        <TrendTooltip
                          args={args}
                          currentPoints={current.points}
                          priorPoints={prior.points}
                          metric={metric}
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

        {/* Legend below — matches Shopify's layout */}
        <InlineStack align="center" gap="400" blockAlign="center">
          <LegendDot color="#2C6ECB" label={fmtRange(current.from, current.to)} />
          <LegendDot color="#9DBEEB" label={compareRangeLabel} />
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// ── tooltip — Shopify-style: metric name, current point, % delta, prior point
function TrendTooltip({ args, currentPoints, priorPoints, metric, granularity }) {
  const i = args?.activeIndex;
  if (i == null || i < 0) return null;
  const cur = currentPoints?.[i];
  const pri = priorPoints?.[i];
  if (!cur) return null;

  const cVal = Number(cur[metric.field] ?? 0);
  const pVal = Number(pri?.[metric.field] ?? 0);
  const fmt = metric.kind === "money" ? fmtPKR : fmtInt;

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
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{metric.label}</div>

      <TooltipRow
        dotColor="#2C6ECB"
        label={fmtBucketLong(String(cur.bucket_start).slice(0, 10), granularity)}
        value={fmt(cVal)}
      />
      <div
        style={{
          color: cVal >= pVal ? "#108043" : "#BF0711",
          fontSize: 12,
          padding: "4px 0 8px 18px",
        }}
      >
        {fmtSignedPct(cVal, pVal)}
      </div>
      {pri && (
        <TooltipRow
          dotColor="#9DBEEB"
          label={fmtBucketLong(String(pri.bucket_start).slice(0, 10), granularity)}
          value={fmt(pVal)}
        />
      )}
    </div>
  );
}

function TooltipRow({ dotColor, label, value }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: dotColor, display: "inline-block" }} />
      <div style={{ flex: 1 }}>
        <div style={{ color: "#202223" }}>{label}</div>
        <div style={{ background: "#F4F6F8", borderRadius: 4, padding: "2px 6px", display: "inline-block", marginTop: 2 }}>
          <Text as="span" variant="bodySm" fontWeight="medium">{value}</Text>
        </div>
      </div>
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: 5, background: color, display: "inline-block" }} />
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
