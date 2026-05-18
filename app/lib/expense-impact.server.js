// Presentation helper for the Expenses page's "this month's impact" card.
//
// Takes the per-expense breakdown rows the dashboard already produces —
// either from the get_expense_breakdown RPC (PostEx / demo) or from the
// shared JS allocator's `_expenseBreakdown` (shopify_direct) — and folds
// them into the three buckets the card shows. By construction the total
// equals the dashboard's MTD `expenses` figure, so the page and the
// dashboard can never disagree.
//
// Pure + dependency-free so it is unit-tested directly (no Supabase).
//
// Row shape: { kind: 'fixed'|'per_order'|'percent', value: number,
//              estimated: boolean }. Unknown/zero, non-estimated rows are
// skipped — same rule DetailPanel uses so inactive expenses don't show.

export function summarizeImpact(rows) {
  let total = 0;
  let fixed = 0;
  let perOrder = 0;
  let percent = 0;
  let anyEstimated = false;
  let count = 0;

  for (const r of rows ?? []) {
    const value = Number(r?.value) || 0;
    const estimated = !!r?.estimated;
    // Mirror DetailPanel: drop rows that contribute nothing this period
    // (e.g. a per-order expense before any orders deliver) unless they're
    // an estimate the merchant should still see flagged.
    if (value === 0 && !estimated) continue;

    count += 1;
    total += value;
    if (r.kind === "fixed") fixed += value;
    else if (r.kind === "per_order") perOrder += value;
    else if (r.kind === "percent") percent += value;
    if (estimated) anyEstimated = true;
  }

  return { total, fixed, perOrder, percent, anyEstimated, count };
}
