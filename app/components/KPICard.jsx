import { useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Card,
  Box,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Divider,
  Popover,
  ActionList,
  Icon,
  DatePicker,
} from "@shopify/polaris";
import { CalendarIcon } from "@shopify/polaris-icons";

// ── Number formatters ─────────────────────────────────────────────────────────
const fmtPKR = (n) => {
  if (n == null) return "N/A";
  return `PKR ${Math.round(Number(n)).toLocaleString()}`;
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

// ── Date label formatter ──────────────────────────────────────────────────────
const MONTHS_LONG = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function padTwo(n) { return String(n).padStart(2, "0"); }

function toDateStr(d) {
  return `${d.getFullYear()}-${padTwo(d.getMonth() + 1)}-${padTwo(d.getDate())}`;
}

function fmtDateLabel(from, to) {
  if (!from || !to) return "";
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  if (from === to)
    return `${fd} ${MONTHS_LONG[fm - 1]} ${fy}`;
  if (fm === tm && fy === ty)
    return `${fd}–${td} ${MONTHS_LONG[fm - 1]} ${fy}`;
  if (fy === ty)
    return `${fd} ${MONTHS_LONG[fm - 1]} – ${td} ${MONTHS_LONG[tm - 1]} ${fy}`;
  return `${fd} ${MONTHS_LONG[fm - 1]} ${fy} – ${td} ${MONTHS_LONG[tm - 1]} ${ty}`;
}

// ── Preset date ranges (browser local time — user is in PKT) ─────────────────
function computePresets() {
  const now  = new Date();
  const today = toDateStr(now);
  const yest  = new Date(now); yest.setDate(yest.getDate() - 1);

  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed

  const firstDay = (yr, mo) => new Date(yr, mo, 1);
  const lastDay  = (yr, mo) => new Date(yr, mo + 1, 0);

  const lmFrom = toDateStr(firstDay(y, m - 1));
  const lmTo   = toDateStr(lastDay(y, m - 1));
  const m2From = toDateStr(firstDay(y, m - 2));
  const m2To   = toDateStr(lastDay(y, m - 2));
  const m3From = toDateStr(firstDay(y, m - 3));
  const m3To   = toDateStr(lastDay(y, m - 3));

  const mtdFrom = toDateStr(firstDay(y, m));

  return [
    { label: "Today",           from: today,           to: today           },
    { label: "Yesterday",       from: toDateStr(yest), to: toDateStr(yest) },
    { label: "Last month",      from: lmFrom,          to: lmTo            },
    { label: "2 months ago",    from: m2From,          to: m2To            },
    { label: "3 months ago",    from: m3From,          to: m3To            },
    { label: "Month to date",   from: mtdFrom,         to: today           },
    { label: "Year to date",    from: `${y}-01-01`,    to: today           },
    { label: "Custom range",    from: null,            to: null            },
  ];
}

// ── Sub-components ────────────────────────────────────────────────────────────
function MoneyText({ value, variant = "headingMd" }) {
  if (value == null) return <Text variant={variant}>N/A</Text>;
  const v   = Math.round(Number(value));
  const neg = v < 0;
  return (
    <Text variant={variant} tone={neg ? "critical" : undefined}>
      {neg ? `-PKR ${Math.abs(v).toLocaleString()}` : `PKR ${v.toLocaleString()}`}
    </Text>
  );
}

// ── Period-over-period delta ─────────────────────────────────────────────────
// Both metrics show percent change. Net profit normalises by |prior| so the
// percent's sign always reflects the direction of improvement — works through
// negative prior values and zero crossings. Hidden when prior data is missing
// or the change is negligible. Capped at 999% to avoid noisy four-digit deltas
// during sign flips.
function fmtPctDelta(pct) {
  return Math.abs(pct) >= 1000 ? "999+%" : `${Math.abs(Math.round(pct))}%`;
}

function computeSalesDelta(current, prior) {
  if (current == null || prior == null) return null;
  const c = Number(current);
  const p = Number(prior);
  if (p === 0) {
    return c > 0 ? { dir: "up", label: "New" } : null;
  }
  const pct = ((c - p) / p) * 100;
  if (Math.abs(pct) < 0.5) return null;
  return { dir: pct >= 0 ? "up" : "down", label: fmtPctDelta(pct) };
}

function computeNetProfitDelta(current, prior) {
  if (current == null || prior == null) return null;
  const c = Number(current);
  const p = Number(prior);
  if (Math.abs(c - p) < 1) return null;
  if (p === 0) {
    return c > 0
      ? { dir: "up",   label: "New"  }
      : { dir: "down", label: "Loss" };
  }
  // |prior| denominator so signs read correctly across zero:
  //   -100 → -50 → +50%, -100 → +50 → +150%, +100 → -50 → -150%
  const pct = ((c - p) / Math.abs(p)) * 100;
  if (Math.abs(pct) < 0.5) return null;
  return { dir: pct >= 0 ? "up" : "down", label: fmtPctDelta(pct) };
}

function Delta({ delta }) {
  if (!delta) return null;
  const arrow = delta.dir === "up" ? "▲" : "▼";
  const tone  = delta.dir === "up" ? "success" : "critical";
  return (
    <Text as="span" variant="bodySm" tone={tone} fontWeight="medium">
      {arrow} {delta.label}
    </Text>
  );
}

// ── Header gradients ─────────────────────────────────────────────────────────
// Recent → past reads as emerald → teal → cyan → indigo. Tailwind 600/700
// levels keep the saturation balanced; deeper stop on the bottom-right gives
// the header subtle depth without looking decorative.
const HEADER_GRADIENTS = {
  today:     "linear-gradient(135deg, #059669 0%, #047857 100%)",
  yesterday: "linear-gradient(135deg, #0D9488 0%, #0F766E 100%)",
  mtd:       "linear-gradient(135deg, #0891B2 0%, #0E7490 100%)",
  lastMonth: "linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)",
};

const DEFAULT_NAMES = {
  today:     "Today",
  yesterday: "Yesterday",
  mtd:       "Month to date",
  lastMonth: "Last month",
};

// ── KPICard ───────────────────────────────────────────────────────────────────
export default function KPICard({
  period,
  stats: defaultStats,
  priorStats: defaultPriorStats,
  dateRange: defaultDateRange,
  onMore,
}) {
  const fetcher = useFetcher();

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [hovered,     setHovered]     = useState(false);
  const [showCustom,  setShowCustom]  = useState(false);
  const [customSel,   setCustomSel]   = useState({});
  const [customMonth, setCustomMonth] = useState({
    month: new Date().getMonth(),
    year:  new Date().getFullYear(),
  });

  const [displayName,  setDisplayName]  = useState(DEFAULT_NAMES[period]);
  const [currentLabel, setCurrentLabel] = useState(
    fmtDateLabel(defaultDateRange?.from, defaultDateRange?.to)
  );
  const [currentFrom,  setCurrentFrom]  = useState(defaultDateRange?.from ?? "");
  const [currentTo,    setCurrentTo]    = useState(defaultDateRange?.to   ?? "");
  const [activePreset, setActivePreset] = useState(null);

  // After a date-picker fetch, both stats and priorStats come from the api;
  // before any fetch (or while loading), fall back to the loader payload.
  const stats      = fetcher.data?.stats      ?? defaultStats;
  const priorStats = fetcher.data
    ? fetcher.data?.priorStats ?? null
    : defaultPriorStats;
  const loading = fetcher.state === "loading";
  const presets = computePresets();

  const salesDelta     = computeSalesDelta(stats?.sales,      priorStats?.sales);
  const netProfitDelta = computeNetProfitDelta(stats?.net_profit, priorStats?.net_profit);

  function applyPreset(preset) {
    if (preset.label === "Custom range") {
      setShowCustom(true);
      return;
    }
    setDisplayName(preset.label);
    setCurrentLabel(fmtDateLabel(preset.from, preset.to));
    setCurrentFrom(preset.from);
    setCurrentTo(preset.to);
    setActivePreset(preset.label);
    setPopoverOpen(false);
    setShowCustom(false);
    fetcher.load(`/app/api/stats?from=${preset.from}&to=${preset.to}`);
  }

  function applyCustom() {
    if (!customSel.start) return;
    const end  = customSel.end ?? customSel.start;
    const from = toDateStr(customSel.start);
    const to   = toDateStr(end);
    setDisplayName("Custom range");
    setCurrentLabel(fmtDateLabel(from, to));
    setCurrentFrom(from);
    setCurrentTo(to);
    setActivePreset("Custom range");
    setPopoverOpen(false);
    setShowCustom(false);
    fetcher.load(`/app/api/stats?from=${from}&to=${to}`);
  }

  function closePopover() {
    setPopoverOpen(false);
    setShowCustom(false);
  }

  // Soft-tint activator — borderless so it reads as a hint, not a chip.
  // Resting fill is faint enough not to compete with the gradient header,
  // but the area still announces itself as interactive; hover deepens the
  // fill so the affordance pays off when the user moves over it.
  const pillHovered = hovered || popoverOpen;
  const activator = (
    <button
      type="button"
      style={{
        background: pillHovered
          ? "rgba(255,255,255,0.20)"
          : "rgba(255,255,255,0.10)",
        border: "none",
        borderRadius: "6px",
        cursor: "pointer",
        padding: "3px 8px",
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        transition: "background-color 150ms ease",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => { setPopoverOpen((v) => !v); setShowCustom(false); }}
    >
      <span
        style={{
          fontSize: "13px",
          fontFamily: "inherit",
          color: "rgba(255,255,255,0.95)",
          fontWeight: 500,
        }}
      >
        {currentLabel}
      </span>
      <span style={{ display: "flex", color: "rgba(255,255,255,0.95)" }}>
        <Icon source={CalendarIcon} />
      </span>
    </button>
  );

  // Date-hover (or open popover) gently lifts the card and brightens the
  // header. Filter is used instead of a second gradient because background
  // images can't be CSS-transitioned smoothly.
  const isActive = hovered || popoverOpen;

  return (
    <div
      style={{
        borderRadius: "12px",
        transition: "transform 200ms ease, box-shadow 200ms ease",
        transform: isActive ? "translateY(-2px)" : "translateY(0)",
        boxShadow: isActive
          ? "0 12px 28px rgba(15, 23, 42, 0.14)"
          : "0 1px 3px rgba(15, 23, 42, 0.05)",
      }}
    >
    <Card padding="0">
      {/* ── Header ── */}
      <div
        style={{
          backgroundImage: HEADER_GRADIENTS[period] ?? HEADER_GRADIENTS.today,
          borderRadius: "12px 12px 0 0",
          padding: "12px 16px",
          transition: "filter 200ms ease",
          filter: isActive ? "brightness(1.08) saturate(1.05)" : "none",
        }}
      >
        <BlockStack gap="050">
          <Text as="span" variant="headingSm" fontWeight="bold" tone="text-inverse">
            {displayName}
          </Text>
          <Popover
            active={popoverOpen}
            activator={activator}
            onClose={closePopover}
            preferredAlignment="right"
          >
            {showCustom ? (
              <Box padding="400">
                <BlockStack gap="300">
                  <Button variant="plain" onClick={() => setShowCustom(false)}>
                    ← Back
                  </Button>
                  <DatePicker
                    month={customMonth.month}
                    year={customMonth.year}
                    onChange={setCustomSel}
                    onMonthChange={(month, year) => setCustomMonth({ month, year })}
                    selected={customSel.start ? customSel : undefined}
                    allowRange
                  />
                  <Button
                    variant="primary"
                    disabled={!customSel.start}
                    onClick={applyCustom}
                  >
                    Apply
                  </Button>
                </BlockStack>
              </Box>
            ) : (
              <ActionList
                items={presets.map((p) => ({
                  content: p.label,
                  active: p.label === activePreset,
                  onAction: () => applyPreset(p),
                }))}
              />
            )}
          </Popover>
        </BlockStack>
      </div>

      {/* ── Body ── */}
      <Box paddingInline="400" paddingBlock="400">
        <BlockStack gap="400">

          {/* Sales */}
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text variant="bodySm" tone="subdued">Sales</Text>
              <Delta delta={salesDelta} />
            </InlineStack>
            <Text variant="headingLg" fontWeight="bold">{fmtPKR(stats?.sales)}</Text>
          </BlockStack>

          <Divider />

          {/* Orders / Units | Returns */}
          <InlineStack align="space-between" blockAlign="start">
            <BlockStack gap="100">
              <Text variant="bodySm" tone="subdued">Orders / Units</Text>
              <Text variant="bodyMd" fontWeight="semibold">
                {fmtNum(stats?.orders)} / {fmtNum(stats?.units)}
              </Text>
            </BlockStack>
            <BlockStack gap="100" inlineAlign="start">
              <Text variant="bodySm" tone="subdued">Returns</Text>
              <Text variant="bodyMd" fontWeight="semibold">{fmtNum(stats?.returns)}</Text>
            </BlockStack>
          </InlineStack>

          {/* Ad Spend | ROAS */}
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

          {/* Net Profit | Margin */}
          <InlineStack align="space-between" blockAlign="start">
            <BlockStack gap="100">
              <InlineStack gap="200" blockAlign="center">
                <Text variant="bodySm" tone="subdued">Net Profit</Text>
                <Delta delta={netProfitDelta} />
              </InlineStack>
              <MoneyText value={stats?.net_profit} variant="headingSm" />
            </BlockStack>
            <BlockStack gap="100">
              <Text variant="bodySm" tone="subdued">Margin</Text>
              <Text
                variant="bodyMd"
                fontWeight="semibold"
                tone={
                  stats?.margin_pct != null && Number(stats.margin_pct) < 0
                    ? "critical"
                    : undefined
                }
              >
                {fmtPct(stats?.margin_pct)}
              </Text>
            </BlockStack>
          </InlineStack>

          {/* View breakdown */}
          <InlineStack align="end">
            <Button
              variant="plain"
              loading={loading}
              onClick={() =>
                onMore(stats, { from: currentFrom, to: currentTo }, displayName)
              }
            >
              Breakdown →
            </Button>
          </InlineStack>

        </BlockStack>
      </Box>
    </Card>
    </div>
  );
}
