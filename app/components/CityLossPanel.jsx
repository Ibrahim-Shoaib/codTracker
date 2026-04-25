import { useState, useMemo } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Card,
  Box,
  BlockStack,
  InlineStack,
  Text,
  Button,
  ButtonGroup,
  Badge,
  Popover,
  ActionList,
  DatePicker,
  Divider,
  EmptyState,
  Spinner,
} from "@shopify/polaris";
import { CalendarIcon } from "@shopify/polaris-icons";

const fmtPKR = (n) => `PKR ${Math.round(Number(n)).toLocaleString()}`;
const fmtNum = (n) => Number(n).toLocaleString();
const fmtPct = (n) => `${Number(n).toFixed(1)}%`;

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const padTwo = (n) => String(n).padStart(2, "0");
const toDateStr = (d) =>
  `${d.getFullYear()}-${padTwo(d.getMonth() + 1)}-${padTwo(d.getDate())}`;

function fmtDateLabel(from, to) {
  if (!from || !to) return "";
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  if (from === to) return `${fd} ${MONTHS_LONG[fm - 1]} ${fy}`;
  if (fm === tm && fy === ty) return `${fd}–${td} ${MONTHS_LONG[fm - 1]} ${fy}`;
  if (fy === ty) return `${fd} ${MONTHS_LONG[fm - 1]} – ${td} ${MONTHS_LONG[tm - 1]} ${fy}`;
  return `${fd} ${MONTHS_LONG[fm - 1]} ${fy} – ${td} ${MONTHS_LONG[tm - 1]} ${ty}`;
}

function computePresets() {
  const now = new Date();
  const today = toDateStr(now);
  const y = now.getFullYear();
  const m = now.getMonth();

  const firstDay = (yr, mo) => new Date(yr, mo, 1);
  const lastDay  = (yr, mo) => new Date(yr, mo + 1, 0);

  const lmFrom = toDateStr(firstDay(y, m - 1));
  const lmTo   = toDateStr(lastDay(y, m - 1));
  const m2From = toDateStr(firstDay(y, m - 2));
  const m2To   = toDateStr(lastDay(y, m - 2));
  const mtdFrom = toDateStr(firstDay(y, m));

  const last30 = new Date(now); last30.setDate(last30.getDate() - 29);

  return [
    { label: "Last 30 days",  from: toDateStr(last30), to: today },
    { label: "Month to date", from: mtdFrom,           to: today },
    { label: "Last month",    from: lmFrom,            to: lmTo  },
    { label: "2 months ago",  from: m2From,            to: m2To  },
    { label: "Year to date",  from: `${y}-01-01`,      to: today },
    { label: "Custom range",  from: null,              to: null  },
  ];
}

// Pakistan COD averages 20–25% return rate; ≥35% is a "stop COD here"
// signal, <10% is a healthy market.
function severity(returnPct) {
  if (returnPct >= 35) return { tone: "critical", label: "High" };
  if (returnPct >= 20) return { tone: "warning",  label: "Watch" };
  if (returnPct < 10)  return { tone: "success",  label: "Healthy" };
  return null;
}

// ── A single city row ────────────────────────────────────────────────────────
// Layout matches Shopify's analytics reports: dimension on the left, sparkline
// bar in the middle taking remaining width, primary number right-aligned.
function CityRow({ city, returnLoss, returned, total, returnPct, maxLoss }) {
  const widthPct = maxLoss > 0 ? Math.max(2, (returnLoss / maxLoss) * 100) : 0;
  const sev = severity(returnPct);

  return (
    <Box paddingInline="400" paddingBlock="300">
      <BlockStack gap="150">
        <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
          {/* City + severity */}
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <Text as="span" variant="bodyMd" fontWeight="semibold">{city}</Text>
            {sev && <Badge tone={sev.tone} size="small">{sev.label}</Badge>}
          </InlineStack>

          {/* Loss amount — the single most important number */}
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {fmtPKR(returnLoss)}
          </Text>
        </InlineStack>

        {/* Sparkline-style thin bar — Polaris critical token, not custom red */}
        <div
          style={{
            width: "100%",
            height: 4,
            borderRadius: 999,
            backgroundColor: "var(--p-color-bg-surface-tertiary, #EBEBEB)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${widthPct}%`,
              height: "100%",
              borderRadius: 999,
              backgroundColor: "var(--p-color-bg-fill-critical, #E51C00)",
              transition: "width 280ms ease",
            }}
          />
        </div>

        {/* Secondary stats */}
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="bodySm" tone="subdued">
            {fmtNum(returned)} of {fmtNum(total)} orders returned
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {fmtPct(returnPct)} return rate
          </Text>
        </InlineStack>
      </BlockStack>
    </Box>
  );
}

// ── CityLossPanel ────────────────────────────────────────────────────────────
export default function CityLossPanel({
  initialCities,
  initialFrom,
  initialTo,
  initialLabel = "Last 30 days",
}) {
  const fetcher = useFetcher();

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [showCustom,  setShowCustom]  = useState(false);
  const [customSel,   setCustomSel]   = useState({});
  const [customMonth, setCustomMonth] = useState({
    month: new Date().getMonth(),
    year:  new Date().getFullYear(),
  });

  const [dateLabel, setDateLabel] = useState(initialLabel);
  const [activePreset, setActivePreset] = useState(initialLabel);

  const [sortKey, setSortKey] = useState("loss");
  const [showAll, setShowAll] = useState(false);

  const presets = computePresets();
  const cities  = fetcher.data?.cities ?? initialCities ?? [];
  const loading = fetcher.state === "loading";

  const sorted = useMemo(() => {
    const copy = [...cities].map((c) => ({
      ...c,
      return_loss:  Number(c.return_loss),
      return_pct:   Number(c.return_pct),
      delivered:    Number(c.delivered),
      returned:     Number(c.returned),
      total_orders: Number(c.total_orders),
    }));
    if (sortKey === "loss") {
      return copy
        .filter((c) => c.return_loss > 0)
        .sort((a, b) => b.return_loss - a.return_loss);
    }
    if (sortKey === "rate") {
      // Filter tiny-sample cities so 1 return on a 1-order city doesn't
      // dominate at 100% return rate.
      return copy
        .filter((c) => c.total_orders >= 5)
        .sort((a, b) => b.return_pct - a.return_pct);
    }
    return copy.sort((a, b) => b.total_orders - a.total_orders);
  }, [cities, sortKey]);

  const visible = showAll ? sorted : sorted.slice(0, 5);
  const maxLoss = visible.reduce((m, c) => Math.max(m, c.return_loss), 0);

  function applyPreset(preset) {
    if (preset.label === "Custom range") {
      setShowCustom(true);
      return;
    }
    setDateLabel(preset.label);
    setActivePreset(preset.label);
    setPopoverOpen(false);
    setShowCustom(false);
    fetcher.load(`/app/api/city-breakdown?from=${preset.from}&to=${preset.to}`);
  }
  function applyCustom() {
    if (!customSel.start) return;
    const end  = customSel.end ?? customSel.start;
    const from = toDateStr(customSel.start);
    const to   = toDateStr(end);
    setDateLabel(fmtDateLabel(from, to));
    setActivePreset("Custom range");
    setPopoverOpen(false);
    setShowCustom(false);
    fetcher.load(`/app/api/city-breakdown?from=${from}&to=${to}`);
  }
  function closePopover() {
    setPopoverOpen(false);
    setShowCustom(false);
  }

  const dateActivator = (
    <Button
      icon={CalendarIcon}
      onClick={() => { setPopoverOpen((v) => !v); setShowCustom(false); }}
      disclosure
      size="slim"
      variant="tertiary"
    >
      {dateLabel}
    </Button>
  );

  const totalReturns = cities.reduce((s, c) => s + Number(c.returned), 0);
  const isEmpty = !loading && totalReturns === 0;

  return (
    <Card padding="0">
      {/* ── Header ── */}
      <Box paddingInline="400" paddingBlockStart="400" paddingBlockEnd="300">
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
            <Text as="h2" variant="headingMd" fontWeight="semibold">
              Returns by city
            </Text>
            <Popover
              active={popoverOpen}
              activator={dateActivator}
              onClose={closePopover}
              preferredAlignment="right"
            >
              {showCustom ? (
                <Box padding="400">
                  <BlockStack gap="300">
                    <Button variant="plain" onClick={() => setShowCustom(false)}>← Back</Button>
                    <DatePicker
                      month={customMonth.month}
                      year={customMonth.year}
                      onChange={setCustomSel}
                      onMonthChange={(month, year) => setCustomMonth({ month, year })}
                      selected={customSel.start ? customSel : undefined}
                      allowRange
                    />
                    <Button variant="primary" disabled={!customSel.start} onClick={applyCustom}>
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
          </InlineStack>

          <InlineStack align="space-between" blockAlign="center" gap="300">
            <ButtonGroup variant="segmented">
              <Button pressed={sortKey === "loss"}   onClick={() => setSortKey("loss")}   size="slim">Money lost</Button>
              <Button pressed={sortKey === "rate"}   onClick={() => setSortKey("rate")}   size="slim">Return rate</Button>
              <Button pressed={sortKey === "volume"} onClick={() => setSortKey("volume")} size="slim">Volume</Button>
            </ButtonGroup>
            {loading && <Spinner size="small" accessibilityLabel="Loading" />}
          </InlineStack>
        </BlockStack>
      </Box>

      <Divider />

      {/* ── Body ── */}
      {isEmpty ? (
        <Box padding="600">
          <EmptyState heading="No returns in this period — nicely done." image="">
            <Text as="p" tone="subdued">
              When orders start coming back, the cities driving the loss will surface here.
            </Text>
          </EmptyState>
        </Box>
      ) : visible.length === 0 ? (
        <Box padding="600">
          <Text as="p" tone="subdued" alignment="center">
            {sortKey === "rate"
              ? "Need at least 5 orders in a city to rank it by return rate."
              : "No cities match the current view."}
          </Text>
        </Box>
      ) : (
        <BlockStack gap="0">
          {visible.map((c, i) => (
            <div key={c.city}>
              {i > 0 && <Divider borderColor="border-tertiary" />}
              <CityRow
                city={c.city}
                returnLoss={c.return_loss}
                returned={c.returned}
                total={c.total_orders}
                returnPct={c.return_pct}
                maxLoss={maxLoss}
              />
            </div>
          ))}
        </BlockStack>
      )}

      {/* ── Footer ── */}
      {!isEmpty && sorted.length > 5 && (
        <>
          <Divider />
          <Box paddingInline="400" paddingBlock="300">
            <InlineStack align="end">
              <Button variant="plain" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show top 5" : `View all ${sorted.length} cities`}
              </Button>
            </InlineStack>
          </Box>
        </>
      )}
    </Card>
  );
}
