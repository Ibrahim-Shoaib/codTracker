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
// CSS-only import is SSR-safe (Vite emits a stylesheet link); the JS module
// is the part that touches `window`, so we lazy-load that below.
import "@shopify/polaris-viz/build/esm/styles.css";

// polaris-viz reads `window.matchMedia` during render and crashes Remix SSR.
// We lazy-load it so the import + first render only happen in the browser,
// and gate it behind a `mounted` flag so the SSR'd HTML and the first
// hydration render agree (no hydration mismatch).
const LazyComboChart = lazy(() =>
  import("@shopify/polaris-viz").then((m) => ({ default: m.ComboChart }))
);
const LazyVizProvider = lazy(() =>
  import("@shopify/polaris-viz").then((m) => ({ default: m.PolarisVizProvider }))
);

// ── helpers ─────────────────────────────────────────────────────────────────
const PKR = (n) => {
  const v = Math.round(Number(n ?? 0));
  return `PKR ${v.toLocaleString()}`;
};
const PKRSigned = (n) => {
  const v = Math.round(Number(n ?? 0));
  if (v < 0) return `-PKR ${Math.abs(v).toLocaleString()}`;
  return `PKR ${v.toLocaleString()}`;
};

// Compact formatter for the Y axis: 12,500 → "12.5K"; 1,200,000 → "12L"
// (Pakistani convention: 1 lakh = 100,000; 1 crore = 10,000,000)
const compactPKR = (n) => {
  const v = Number(n ?? 0);
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`;
  if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(0)}K`;
  return `${sign}${Math.round(a)}`;
};

// "2026-04-15" → "Apr 15" — short, locale-stable for axis ticks
function shortDate(ymd) {
  const [, m, d] = ymd.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[m - 1]} ${d}`;
}
function longDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[m - 1]} ${d}, ${y}`;
}
function ymdOf(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ── stacked horizontal bar (no charting lib — full control over labels) ─────
// Used for the cost-composition view. Renders a single horizontal bar split
// proportionally by cost category, then a legend showing each category in
// PKR. Profit is shown last as a green segment (or omitted if a loss).
function StackedCostBar({ totals }) {
  const { cogs, delivery, ad, returnLoss, expenses, profit, sales } = totals;

  // Bar denominator: use sales when there's revenue, otherwise sum the costs
  // so a zero-sales / pure-spend day still renders something meaningful.
  const totalCosts = cogs + delivery + ad + returnLoss + expenses;
  const denom = Math.max(sales, totalCosts) || 1;

  // Loss days: render the bar as a red "loss" segment after costs so the
  // overrun is visually called out instead of silently disappearing.
  const isLoss = profit < 0;
  const profitWidth = Math.max(0, profit);
  const lossOverrun = isLoss ? Math.abs(profit) : 0;

  const segments = [
    { label: "COGS",         value: cogs,        color: "#5C6AC4" },
    { label: "Delivery",     value: delivery,    color: "#9C6ADE" },
    { label: "Ad spend",     value: ad,          color: "#F49342" },
    { label: "Return loss",  value: returnLoss,  color: "#DE3618" },
    { label: "Expenses",     value: expenses,    color: "#637381" },
  ];
  if (!isLoss) segments.push({ label: "Net profit", value: profitWidth, color: "#108043" });
  if (isLoss)  segments.push({ label: "Loss",       value: lossOverrun, color: "#BF0711" });

  // Filter zero-width segments so the legend stays clean for sparse periods
  const visible = segments.filter((s) => s.value > 0);

  return (
    <BlockStack gap="200">
      {/* The bar itself */}
      <div
        style={{
          width: "100%",
          height: "28px",
          borderRadius: "6px",
          overflow: "hidden",
          display: "flex",
          background: "#F4F6F8",
        }}
        role="img"
        aria-label={`Cost composition: ${visible.map((s) => `${s.label} ${PKR(s.value)}`).join(", ")}`}
      >
        {visible.map((s) => (
          <div
            key={s.label}
            title={`${s.label}: ${PKR(s.value)}`}
            style={{
              width: `${(s.value / denom) * 100}%`,
              background: s.color,
            }}
          />
        ))}
      </div>

      {/* Legend below — wraps on narrow screens */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 18px", marginTop: "4px" }}>
        {segments.map((s) => (
          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span
              style={{
                display: "inline-block",
                width: "10px",
                height: "10px",
                borderRadius: "2px",
                background: s.color,
                opacity: s.value > 0 ? 1 : 0.35,
              }}
            />
            <Text as="span" variant="bodySm" tone={s.value > 0 ? undefined : "subdued"}>
              {s.label}: {PKR(s.value)}
            </Text>
          </div>
        ))}
      </div>
    </BlockStack>
  );
}

// ── main component ──────────────────────────────────────────────────────────
// Props:
//   initialSeries  Array<DailyRow>  — server-rendered first window (30 days)
//   initialFrom    "YYYY-MM-DD"
//   initialTo      "YYYY-MM-DD"
//   backfillInProgress  boolean — hide entire panel during initial sync
export default function TrendPanel({
  initialSeries,
  initialFrom,
  initialTo,
  backfillInProgress,
}) {
  // Active window state. `days` = preset (7/30/90), null when on a custom range.
  const [days, setDays] = useState(30);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [series, setSeries] = useState(initialSeries ?? []);

  // Custom date popover state
  const [popoverOpen, setPopoverOpen] = useState(false);
  const today = useMemo(() => new Date(), []);
  const [pickerMonth, setPickerMonth] = useState({
    month: today.getMonth(),
    year: today.getFullYear(),
  });
  const [pickerSel, setPickerSel] = useState({ start: null, end: null });

  // Day selected by clicking a bar in the chart. When set, the cost
  // breakdown shows that single day; otherwise it shows the period total.
  const [focusedDay, setFocusedDay] = useState(null);

  // Defer the chart's first render until after hydration. polaris-viz reads
  // `window.matchMedia` synchronously during render, so SSR-ing it crashes
  // the loader. Rendering on mount also keeps SSR HTML and first-hydration
  // HTML identical (no React mismatch warning).
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const fetcher = useFetcher();

  // When fetcher returns, sync local state. This handles preset toggles,
  // custom-range applies, and any later refetch.
  useEffect(() => {
    if (fetcher.data && !fetcher.data.error && fetcher.state === "idle") {
      setSeries(fetcher.data.series ?? []);
      setFrom(fetcher.data.from);
      setTo(fetcher.data.to);
      setFocusedDay(null);
    }
  }, [fetcher.data, fetcher.state]);

  const isLoading = fetcher.state !== "idle";

  const loadPreset = useCallback(
    (n) => {
      setDays(n);
      fetcher.load(`/app/api/trend?days=${n}`);
    },
    [fetcher]
  );

  const applyCustom = useCallback(() => {
    if (!pickerSel.start || !pickerSel.end) return;
    const f = ymdOf(pickerSel.start);
    const t = ymdOf(pickerSel.end);
    setDays(null);
    setPopoverOpen(false);
    fetcher.load(`/app/api/trend?from=${f}&to=${t}`);
  }, [pickerSel, fetcher]);

  // ── derive chart data ────────────────────────────────────────────────────
  const { chartData, totals, focusedRow } = useMemo(() => {
    const rows = (series ?? []).map((r) => ({
      day: typeof r.day === "string" ? r.day.slice(0, 10) : r.day,
      sales: Number(r.sales ?? 0),
      orders: Number(r.orders ?? 0),
      delivered: Number(r.delivered ?? 0),
      returns: Number(r.returns ?? 0),
      cogs: Number(r.cogs ?? 0),
      delivery_cost: Number(r.delivery_cost ?? 0),
      ad_spend: Number(r.ad_spend ?? 0),
      return_loss: Number(r.return_loss ?? 0),
      expenses: Number(r.expenses ?? 0),
      net_profit: Number(r.net_profit ?? 0),
    }));

    // Two profit series so we can color profit-days green and loss-days red
    // (polaris-viz ComboChart colors per series, not per data point).
    const profitData = rows.map((r) => ({
      key: r.day,
      value: r.net_profit > 0 ? r.net_profit : 0,
    }));
    const lossData = rows.map((r) => ({
      key: r.day,
      value: r.net_profit < 0 ? r.net_profit : 0, // negative bars dip below 0
    }));
    const revenueData = rows.map((r) => ({ key: r.day, value: r.sales }));

    const data = [
      {
        shape: "Bar",
        name: "Profit",
        yAxisOptions: { labelFormatter: compactPKR },
        series: [
          { name: "Profit", color: "#108043", data: profitData },
          { name: "Loss",   color: "#DE3618", data: lossData   },
        ],
      },
      {
        shape: "Line",
        name: "Revenue",
        yAxisOptions: { labelFormatter: compactPKR },
        series: [
          { name: "Revenue", color: "#2C6ECB", data: revenueData },
        ],
      },
    ];

    // Period totals — used by StackedCostBar when no day is focused
    const sum = rows.reduce(
      (a, r) => ({
        sales:    a.sales    + r.sales,
        orders:   a.orders   + r.orders,
        cogs:     a.cogs     + r.cogs,
        delivery: a.delivery + r.delivery_cost,
        ad:       a.ad       + r.ad_spend,
        returnLoss: a.returnLoss + r.return_loss,
        expenses: a.expenses + r.expenses,
        profit:   a.profit   + r.net_profit,
      }),
      { sales: 0, orders: 0, cogs: 0, delivery: 0, ad: 0, returnLoss: 0, expenses: 0, profit: 0 }
    );

    const focused = focusedDay ? rows.find((r) => r.day === focusedDay) : null;
    const totalsForBar = focused
      ? {
          sales:      focused.sales,
          cogs:       focused.cogs,
          delivery:   focused.delivery_cost,
          ad:         focused.ad_spend,
          returnLoss: focused.return_loss,
          expenses:   focused.expenses,
          profit:     focused.net_profit,
        }
      : sum;

    return { chartData: data, totals: totalsForBar, focusedRow: focused };
  }, [series, focusedDay]);

  // Empty signal: no data at all returned from RPC
  const hasAnyData = (series?.length ?? 0) > 0;
  const hasAnyActivity = useMemo(
    () => (series ?? []).some((r) => Number(r.sales) > 0 || Number(r.ad_spend) > 0),
    [series]
  );

  if (backfillInProgress) {
    // Hide the chart entirely until the first PostEx sync finishes — the
    // existing "Syncing your order history…" banner already explains why.
    return null;
  }

  // ── render ───────────────────────────────────────────────────────────────
  const headerLabel = days ? `Last ${days} days` : `${shortDate(from)} – ${shortDate(to)}`;

  return (
    <Card>
      <BlockStack gap="400">
        {/* Header: title + window toggle */}
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">Revenue & Profit</Text>
            <Text as="p" tone="subdued" variant="bodySm">
              {longDate(from)} – {longDate(to)}
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

        {/* Chart — client-only because polaris-viz reads window during render */}
        {hasAnyData && hasAnyActivity ? (
          <div style={{ height: 280 }}>
            {mounted ? (
              <Suspense fallback={<ChartSkeletonBox />}>
                <LazyVizProvider>
                  <LazyComboChart
                    data={chartData}
                    showLegend
                    xAxisOptions={{
                      labelFormatter: (v) => (typeof v === "string" ? shortDate(v) : String(v)),
                    }}
                    renderTooltipContent={(args) => (
                      <TrendTooltip args={args} rows={series} onPin={setFocusedDay} />
                    )}
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
              <Text as="p" tone="subdued">
                No activity in this window yet.
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Try a wider range — your existing orders may sit outside {headerLabel.toLowerCase()}.
              </Text>
            </BlockStack>
          </Box>
        )}

        {/* Cost composition — synced with focused day, falls back to period total */}
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingSm">
              Where the money went
              {focusedRow ? ` · ${longDate(focusedRow.day)}` : ` · ${headerLabel}`}
            </Text>
            {focusedDay && (
              <Button variant="plain" onClick={() => setFocusedDay(null)}>
                Show period total
              </Button>
            )}
          </InlineStack>
          <StackedCostBar totals={totals} />
          {/* One-line summary so the merchant doesn't need to do mental math */}
          <Text as="p" tone="subdued" variant="bodySm">
            Revenue {PKR(totals.sales)}  ·  Net{" "}
            <Text as="span" tone={totals.profit >= 0 ? "success" : "critical"} fontWeight="semibold">
              {PKRSigned(totals.profit)}
            </Text>
          </Text>
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

// Tooltip rendered on hover/tap of a chart point. Looks up the matching
// daily row by index so we can show every metric we computed server-side.
function TrendTooltip({ args, rows, onPin }) {
  const activeIndex = args?.activeIndex;
  const row = activeIndex != null ? rows[activeIndex] : null;

  // Sync hovered day → focusedDay in the parent so the cost-bar updates as
  // the merchant scrubs across the chart. useEffect is required because we
  // can't call setState during render (would loop).
  useEffect(() => {
    if (onPin && row?.day) onPin(row.day);
  }, [onPin, row?.day]);

  if (!row) return null;

  const profit = Number(row.net_profit ?? 0);
  const margin =
    Number(row.sales ?? 0) > 0
      ? ((profit / Number(row.sales)) * 100).toFixed(1)
      : null;

  return (
    <div
      style={{
        background: "white",
        border: "1px solid #E1E3E5",
        borderRadius: 8,
        boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
        padding: "10px 12px",
        minWidth: 180,
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{longDate(row.day)}</div>
      <Row label="Revenue"   value={PKR(row.sales)} />
      <Row label="Orders"    value={String(row.orders)} sub={`${row.delivered} delivered · ${row.returns} returned`} />
      <Row label="Net profit" value={PKRSigned(profit)} valueColor={profit >= 0 ? "#108043" : "#BF0711"} />
      {margin != null && <Row label="Margin" value={`${margin}%`} />}
    </div>
  );
}

// Plain neutral box used while the chart JS chunk is loading on the client.
// Same height as the chart so the layout doesn't jump on hydration.
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

function Row({ label, value, sub, valueColor }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, padding: "2px 0" }}>
      <span style={{ color: "#6D7175" }}>{label}</span>
      <span style={{ textAlign: "right" }}>
        <span style={{ color: valueColor ?? "#202223", fontWeight: 500 }}>{value}</span>
        {sub && <div style={{ color: "#6D7175", fontSize: 11 }}>{sub}</div>}
      </span>
    </div>
  );
}
