import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Select,
  ButtonGroup,
  Button,
  DataTable,
  EmptyState,
  Divider,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSupabaseForStore } from "../lib/supabase.server.js";
import {
  applyModel,
  collapseIabDuplicates,
  rollupCredits,
} from "../lib/attribution.server.js";

// ─── Period helpers ──────────────────────────────────────────────────────

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

function pktDate(d: Date): string {
  return new Date(d.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

function periodBounds(period: string): { fromIso: string; toIso: string; label: string } {
  const now = new Date();
  // PKT today's 00:00 in UTC
  const todayPkt = pktDate(now);
  const todayStartUtc = new Date(`${todayPkt}T00:00:00Z`).getTime() - PKT_OFFSET_MS;
  const dayMs = 24 * 60 * 60 * 1000;
  switch (period) {
    case "today":
      return {
        fromIso: new Date(todayStartUtc).toISOString(),
        toIso: new Date(todayStartUtc + dayMs).toISOString(),
        label: "Today",
      };
    case "yesterday":
      return {
        fromIso: new Date(todayStartUtc - dayMs).toISOString(),
        toIso: new Date(todayStartUtc).toISOString(),
        label: "Yesterday",
      };
    case "7d":
      return {
        fromIso: new Date(todayStartUtc - 6 * dayMs).toISOString(),
        toIso: new Date(todayStartUtc + dayMs).toISOString(),
        label: "Last 7 days",
      };
    case "30d":
    default:
      return {
        fromIso: new Date(todayStartUtc - 29 * dayMs).toISOString(),
        toIso: new Date(todayStartUtc + dayMs).toISOString(),
        label: "Last 30 days",
      };
  }
}

const MODEL_OPTIONS = [
  { label: "Last touch", value: "last_touch" },
  { label: "First touch", value: "first_touch" },
  { label: "Linear", value: "linear" },
  { label: "Position-based (40/20/40)", value: "position_based" },
  { label: "Time-decay (7-day half-life)", value: "time_decay" },
];

// ─── Loader ──────────────────────────────────────────────────────────────

type Touch = {
  event_name: string;
  occurred_at: string;
  utm_source: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  fbp: string | null;
  fbc: string | null;
  ip?: string | null;
  ua?: string | null;
};

type Journey = {
  order_id: string;
  order_created_at: string;
  order_value: string | number;
  visitor_id: string | null;
  customer_id: string | null;
  recovered_via: string;
  touch_count: number;
  time_to_convert_sec: number | null;
  touches: Touch[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "30d";
  const model = url.searchParams.get("model") ?? "last_touch";
  const { fromIso, toIso, label } = periodBounds(period);

  const supabase = await getSupabaseForStore(shop);

  const [summaryRes, lastTouchRes, journeysRes] = await Promise.all([
    supabase.rpc("get_attribution_summary", {
      p_store_id: shop,
      p_from_date: fromIso,
      p_to_date: toIso,
    }),
    supabase.rpc("get_last_touch_attribution", {
      p_store_id: shop,
      p_from_date: fromIso,
      p_to_date: toIso,
    }),
    supabase.rpc("get_buyer_journeys", {
      p_store_id: shop,
      p_from_date: fromIso,
      p_to_date: toIso,
      p_limit: 200,
      p_offset: 0,
    }),
  ]);

  const summary = summaryRes.data?.[0] ?? null;
  const lastTouchRows = lastTouchRes.data ?? [];
  const journeys: Journey[] = journeysRes.data ?? [];

  // For non-last-touch models, compute attribution in JS by walking
  // each buyer's collapsed touch journey through the chosen model and
  // rolling up credits per (utm_source, utm_campaign, utm_content).
  let modelRows: Array<{
    utm_source: string;
    utm_campaign: string;
    utm_content: string;
    credit: number;
    touches: number;
  }> = [];

  if (model === "last_touch") {
    modelRows = lastTouchRows.map((r: any) => ({
      utm_source: r.utm_source ?? "(direct)",
      utm_campaign: r.utm_campaign ?? "(none)",
      utm_content: r.utm_content ?? "(none)",
      credit: Number(r.revenue ?? 0),
      touches: Number(r.orders ?? 0),
    }));
  } else {
    const allCredits: Array<{
      utm_source: string;
      utm_campaign: string;
      utm_content: string;
      credit: number;
    }> = [];
    for (const j of journeys) {
      const collapsed = collapseIabDuplicates(j.touches ?? []);
      if (!collapsed.length) continue;
      const value = Number(j.order_value ?? 0);
      const credits = applyModel(model, collapsed, value);
      for (const c of credits) allCredits.push(c);
    }
    modelRows = rollupCredits(allCredits);
  }

  // Channel split (utm_source rollup of the model output).
  const channelMap = new Map<string, number>();
  for (const r of modelRows) {
    channelMap.set(
      r.utm_source,
      (channelMap.get(r.utm_source) ?? 0) + Number(r.credit ?? 0)
    );
  }
  const channelRows = Array.from(channelMap.entries())
    .map(([utm_source, credit]) => ({ utm_source, credit }))
    .sort((a, b) => b.credit - a.credit);

  // Time-to-convert distribution buckets.
  const ttcBuckets = [
    { label: "< 5 min", maxSec: 300, count: 0 },
    { label: "5–30 min", maxSec: 1800, count: 0 },
    { label: "30 min – 2 h", maxSec: 7200, count: 0 },
    { label: "2 – 24 h", maxSec: 86400, count: 0 },
    { label: "1 – 7 days", maxSec: 7 * 86400, count: 0 },
    { label: "7+ days", maxSec: Infinity, count: 0 },
  ];
  for (const j of journeys) {
    const t = j.time_to_convert_sec;
    if (t == null) continue;
    for (const b of ttcBuckets) {
      if (t < b.maxSec) {
        b.count++;
        break;
      }
    }
  }

  return json({
    shop,
    period,
    model,
    label,
    fromIso,
    toIso,
    summary,
    modelRows,
    channelRows,
    journeys: journeys.slice(0, 50),
    ttcBuckets,
  });
};

// ─── Component ───────────────────────────────────────────────────────────

export default function Attribution() {
  const data = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const period = params.get("period") ?? "30d";
  const model = params.get("model") ?? "last_touch";

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    navigate(`?${next.toString()}`, { replace: true });
  };

  const fmt = (n: number | string) => {
    const num = Number(n ?? 0);
    return num.toLocaleString("en-PK", { maximumFractionDigits: 0 });
  };
  const fmtPct = (a: number, b: number) => {
    if (!b) return "—";
    return `${((100 * a) / b).toFixed(0)}%`;
  };

  const totalOrders = Number(data.summary?.total_orders ?? 0);
  const attributedOrders = Number(data.summary?.attributed_orders ?? 0);
  const totalRevenue = Number(data.summary?.total_revenue ?? 0);
  const attributedRevenue = Number(data.summary?.attributed_revenue ?? 0);
  const multi = Number(data.summary?.multi_touch_orders ?? 0);
  const single = Number(data.summary?.single_touch_orders ?? 0);
  const zero = Number(data.summary?.zero_touch_orders ?? 0);
  const medianTtc = data.summary?.median_time_to_convert_sec
    ? Number(data.summary.median_time_to_convert_sec)
    : null;

  return (
    <Page>
      <TitleBar title="Attribution" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingLg">
                  Multi-touch attribution — {data.label}
                </Text>
                <InlineStack gap="200">
                  <ButtonGroup variant="segmented">
                    <Button
                      pressed={period === "today"}
                      onClick={() => setParam("period", "today")}
                    >
                      Today
                    </Button>
                    <Button
                      pressed={period === "yesterday"}
                      onClick={() => setParam("period", "yesterday")}
                    >
                      Yesterday
                    </Button>
                    <Button
                      pressed={period === "7d"}
                      onClick={() => setParam("period", "7d")}
                    >
                      7d
                    </Button>
                    <Button
                      pressed={period === "30d"}
                      onClick={() => setParam("period", "30d")}
                    >
                      30d
                    </Button>
                  </ButtonGroup>
                </InlineStack>
              </InlineStack>

              <Divider />

              <InlineStack gap="600" align="start" wrap>
                <KpiCard label="Orders" value={fmt(totalOrders)} sub={`${attributedOrders} attributed`} />
                <KpiCard
                  label="Revenue (PKR)"
                  value={fmt(totalRevenue)}
                  sub={`${fmt(attributedRevenue)} attributed`}
                />
                <KpiCard
                  label="Attribution rate"
                  value={fmtPct(attributedOrders, totalOrders)}
                  sub="orders linked to a visitor"
                />
                <KpiCard
                  label="Median time-to-convert"
                  value={medianTtc != null ? formatTtc(medianTtc) : "—"}
                  sub="first touch → purchase"
                />
                <KpiCard
                  label="Multi-touch %"
                  value={fmtPct(multi, multi + single + zero)}
                  sub={`${multi} of ${multi + single + zero} buyers`}
                />
              </InlineStack>

              {(zero > 0 || data.summary?.unattributed > 0) && (
                <Banner tone="info">
                  <Text as="p" variant="bodyMd">
                    {zero + Number(data.summary?.unattributed ?? 0)} orders in this
                    range have no attribution data — these are typically pre-deploy
                    orders or visitors whose identity-relay didn't run (e.g. ad
                    blockers, very-old browsers). They're counted in totals but not
                    in the model rollup below.
                  </Text>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  Campaign attribution
                </Text>
                <div style={{ minWidth: 240 }}>
                  <Select
                    label="Model"
                    labelHidden
                    options={MODEL_OPTIONS}
                    value={model}
                    onChange={(v) => setParam("model", v)}
                  />
                </div>
              </InlineStack>

              {data.modelRows.length === 0 ? (
                <EmptyState
                  heading="No attributed revenue in this period yet"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <Text as="p" variant="bodyMd">
                    Once orders flow through with utm-tagged ad clicks, you'll see
                    a revenue breakdown by source/campaign here.
                  </Text>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "text",
                    "numeric",
                    "numeric",
                  ]}
                  headings={["Source", "Campaign", "Content", "Touches", "Credited revenue (PKR)"]}
                  rows={data.modelRows.slice(0, 50).map((r: any) => [
                    r.utm_source,
                    r.utm_campaign,
                    r.utm_content,
                    fmt(r.touches),
                    fmt(r.credit),
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Channel split
              </Text>
              {data.channelRows.length === 0 ? (
                <Text as="p" variant="bodyMd" tone="subdued">
                  No channel data yet.
                </Text>
              ) : (
                <BlockStack gap="200">
                  {data.channelRows.map((c: any) => {
                    const total = data.channelRows.reduce(
                      (s: number, x: any) => s + Number(x.credit),
                      0
                    );
                    const pct = total ? (100 * c.credit) / total : 0;
                    return (
                      <BlockStack gap="050" key={c.utm_source}>
                        <InlineStack align="space-between">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {c.utm_source}
                          </Text>
                          <Text as="span" variant="bodyMd">
                            PKR {fmt(c.credit)} ({pct.toFixed(0)}%)
                          </Text>
                        </InlineStack>
                        <div
                          style={{
                            height: 6,
                            background: "#eee",
                            borderRadius: 3,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${pct}%`,
                              height: "100%",
                              background: "#2c6ecb",
                            }}
                          />
                        </div>
                      </BlockStack>
                    );
                  })}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Time to convert
              </Text>
              <BlockStack gap="200">
                {data.ttcBuckets.map((b: any) => {
                  const total = data.ttcBuckets.reduce(
                    (s: number, x: any) => s + x.count,
                    0
                  );
                  const pct = total ? (100 * b.count) / total : 0;
                  return (
                    <InlineStack
                      key={b.label}
                      align="space-between"
                      gap="200"
                      blockAlign="center"
                    >
                      <Text as="span" variant="bodyMd">
                        {b.label}
                      </Text>
                      <InlineStack gap="200" blockAlign="center">
                        <div
                          style={{
                            width: 120,
                            height: 6,
                            background: "#eee",
                            borderRadius: 3,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${pct}%`,
                              height: "100%",
                              background: "#2c6ecb",
                            }}
                          />
                        </div>
                        <Text as="span" variant="bodyMd" tone="subdued">
                          {b.count} ({pct.toFixed(0)}%)
                        </Text>
                      </InlineStack>
                    </InlineStack>
                  );
                })}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h3" variant="headingMd">
                  Recovery method
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  How each order's visitor was identified
                </Text>
              </InlineStack>
              <InlineStack gap="600" wrap>
                <RecoveryStat
                  label="Cart attribute"
                  value={Number(data.summary?.recovered_via_cart ?? 0)}
                  total={attributedOrders}
                  description="Regular cart-flow orders — strongest signal"
                />
                <RecoveryStat
                  label="fbclid lookup"
                  value={Number(data.summary?.recovered_via_fbclid ?? 0)}
                  total={attributedOrders}
                  description="Instagram IAB recovery"
                />
                <RecoveryStat
                  label="IP + UA fallback"
                  value={Number(data.summary?.recovered_via_ip_ua ?? 0)}
                  total={attributedOrders}
                  description="Facebook IAB (fbclid rotated)"
                />
                <RecoveryStat
                  label="Unattributed"
                  value={Number(data.summary?.unattributed ?? 0)}
                  total={totalOrders}
                  description="No visitor row found"
                />
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Recent buyer journeys
              </Text>
              {data.journeys.length === 0 ? (
                <Text as="p" variant="bodyMd" tone="subdued">
                  No buyer journeys captured yet in this period.
                </Text>
              ) : (
                <BlockStack gap="300">
                  {data.journeys.slice(0, 20).map((j: any) => (
                    <JourneyRow key={j.order_id} journey={j} />
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <BlockStack gap="050">
      <Text as="p" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="p" variant="headingLg">
        {value}
      </Text>
      {sub && (
        <Text as="p" variant="bodySm" tone="subdued">
          {sub}
        </Text>
      )}
    </BlockStack>
  );
}

function RecoveryStat({
  label,
  value,
  total,
  description,
}: {
  label: string;
  value: number;
  total: number;
  description: string;
}) {
  const pct = total ? (100 * value) / total : 0;
  return (
    <BlockStack gap="050">
      <Text as="p" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="p" variant="headingMd">
        {value} <span style={{ fontSize: 12, color: "#888" }}>({pct.toFixed(0)}%)</span>
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        {description}
      </Text>
    </BlockStack>
  );
}

function JourneyRow({ journey }: { journey: any }) {
  const touches = (journey.touches ?? []) as any[];
  return (
    <Card padding="300">
      <BlockStack gap="200">
        <InlineStack align="space-between">
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              Order {journey.order_id}
            </Text>
            <Badge>{journey.recovered_via.replace("_", " ")}</Badge>
            <Text as="span" variant="bodySm" tone="subdued">
              {touches.length} {touches.length === 1 ? "touch" : "touches"}
              {journey.time_to_convert_sec != null
                ? ` · ${formatTtc(journey.time_to_convert_sec)}`
                : ""}
            </Text>
          </InlineStack>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            PKR {Number(journey.order_value ?? 0).toLocaleString("en-PK", {
              maximumFractionDigits: 0,
            })}
          </Text>
        </InlineStack>
        {touches.length > 0 && (
          <div
            style={{
              display: "flex",
              gap: 4,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {touches.slice(0, 8).map((t: any, i: number) => (
              <span
                key={i}
                style={{
                  padding: "2px 8px",
                  background: "#f4f6f8",
                  borderRadius: 4,
                  fontSize: 12,
                }}
                title={`${t.event_name} at ${t.occurred_at}`}
              >
                {t.event_name}
                {t.utm_source ? ` · ${t.utm_source}` : ""}
              </span>
            ))}
            {touches.length > 8 && (
              <Text as="span" variant="bodySm" tone="subdued">
                +{touches.length - 8} more
              </Text>
            )}
          </div>
        )}
      </BlockStack>
    </Card>
  );
}

function formatTtc(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
