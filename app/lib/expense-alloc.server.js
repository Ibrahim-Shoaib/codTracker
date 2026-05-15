// Single JS mirror of the SQL expense allocator (migration 025).
// Used by the Shopify-direct adapter, whose orders live in the Shopify
// Admin API rather than the `orders` table, so it can't call the RPC.
// Keep this byte-for-byte equivalent to get_dashboard_stats /
// get_expense_breakdown — there is exactly one allocation rule.
//
// All dates are 'YYYY-MM-DD' strings; lexicographic compare == chronological
// for ISO dates, which matches Postgres `date` comparison. Windows
// (effective_from / effective_to) are month-start dates or null = unbounded.

// The 1st-of-month dates M with from <= M <= to (inclusive) — mirrors the
// SQL `generate_series(... '1 month') WHERE ms BETWEEN from AND to`.
export function monthStartsInRange(from, to) {
  const out = [];
  let [y, m] = from.split("-").map(Number);
  for (;;) {
    const first = `${y}-${String(m).padStart(2, "0")}-01`;
    if (first > to) break;
    if (first >= from) out.push(first);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

const overlaps = (ef, et, from, to) =>
  (ef == null || ef <= to) && (et == null || et >= from);

// rows: [{ series_id?, name, kind, is_variable, amount, pct_base,
//          effective_from, effective_to }]
// ctx:  { delivered, adSpend, sales }
// Returns { total, breakdown: [{ series_id, name, kind, is_variable,
//                                pct_base, value, estimated }] }.
export function allocateExpenses(rows, from, to, { delivered = 0, adSpend = 0, sales = 0 } = {}) {
  const months = monthStartsInRange(from, to);
  const maxMonth = months.length ? months[months.length - 1] : null;

  const breakdown = (rows ?? []).map((e) => {
    const ef = e.effective_from ?? null;
    const et = e.effective_to ?? null;
    const amount = Number(e.amount) || 0;
    let value = 0;

    if (e.kind === "fixed") {
      const n = months.filter(
        (M) => (ef == null || M >= ef) && (et == null || M <= et)
      ).length;
      value = amount * n;
    } else if (e.kind === "per_order" && overlaps(ef, et, from, to)) {
      value = amount * delivered;
    } else if (e.kind === "percent" && overlaps(ef, et, from, to)) {
      if (e.pct_base === "ad_spend")  value = (amount / 100) * adSpend;
      if (e.pct_base === "net_sales") value = (amount / 100) * sales;
    }

    const estimated =
      e.kind === "fixed" && !!e.is_variable && et == null &&
      maxMonth != null && (ef == null || maxMonth > ef);

    return {
      series_id: e.series_id ?? e.id ?? null,
      name: e.name,
      kind: e.kind,
      is_variable: !!e.is_variable,
      pct_base: e.pct_base ?? null,
      value,
      estimated,
    };
  });

  const total = breakdown.reduce((s, b) => s + b.value, 0);
  return { total, breakdown };
}
