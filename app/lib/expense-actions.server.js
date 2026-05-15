// Shared expense mutations for the Settings page and onboarding step 4.
// One place so the two screens can't drift. All writes are scoped by
// store_id. Segments of one logical expense share a series_id; changing
// an amount "from this month" closes the open segment and opens a new one
// (history stays correct) — the minimal-storage strategy from the plan.

function monthStart(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}
function prevMonthStart(ms) {
  let [y, m] = ms.split("-").map(Number);
  m -= 1;
  if (m < 1) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, "0")}-01`;
}
function firstOfYYYYMM(s) {
  const [y, m] = String(s).split("-");
  return `${y}-${String(Number(m)).padStart(2, "0")}-01`;
}

// UI kind -> storage shape
function mapKind(kindUI) {
  switch (kindUI) {
    case "fixed":     return { kind: "fixed",     is_variable: false, type: "monthly" };
    case "variable":  return { kind: "fixed",     is_variable: true,  type: "monthly" };
    case "per_order": return { kind: "per_order", is_variable: false, type: "per_order" };
    case "percent":   return { kind: "percent",   is_variable: false, type: null };
    default:          return null;
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

// Returns { handled, result } — result is what the route should json() back.
export async function handleExpenseAction(supabase, shop, formData) {
  const intent = String(formData.get("intent") ?? "");

  // ── Add ──────────────────────────────────────────────────────────────────
  if (intent === "expense_add") {
    const name = String(formData.get("name") ?? "").trim();
    const kindUI = String(formData.get("kind") ?? "fixed");
    const amount = num(formData.get("amount"));
    const pctBase = String(formData.get("pct_base") ?? "");

    const mapped = mapKind(kindUI);
    if (!name) return { handled: true, result: { intent, error: "Expense name is required." } };
    if (!mapped) return { handled: true, result: { intent, error: "Invalid expense type." } };
    if (!Number.isFinite(amount) || amount < 0)
      return { handled: true, result: { intent, error: "Amount must be a number ≥ 0." } };
    if (mapped.kind === "percent" && !["ad_spend", "net_sales"].includes(pctBase))
      return { handled: true, result: { intent, error: "Pick what the percentage applies to." } };

    await supabase.from("store_expenses").insert({
      store_id: shop,
      name,
      kind: mapped.kind,
      is_variable: mapped.is_variable,
      type: mapped.type,
      amount,
      pct_base: mapped.kind === "percent" ? pctBase : null,
      effective_from: monthStart(),   // "from this month on"
      effective_to: null,
    });
    return { handled: true, result: { intent, success: true } };
  }

  // ── Edit amount / confirm this month's variable value ────────────────────
  if (intent === "expense_edit_amount" || intent === "expense_set_month") {
    const seriesId = String(formData.get("series_id") ?? "");
    const amount = num(formData.get("amount"));
    // expense_set_month is always a "forward" change for the current month.
    const mode = intent === "expense_set_month"
      ? "forward"
      : String(formData.get("mode") ?? "forward");
    if (!seriesId) return { handled: true, result: { intent, error: "Missing expense." } };
    if (!Number.isFinite(amount) || amount < 0)
      return { handled: true, result: { intent, error: "Amount must be a number ≥ 0." } };

    const { data: rows } = await supabase
      .from("store_expenses")
      .select("id, name, kind, is_variable, pct_base, type, amount, effective_from, effective_to")
      .eq("store_id", shop)
      .eq("series_id", seriesId)
      .order("effective_from", { ascending: true, nullsFirst: true });
    if (!rows || rows.length === 0)
      return { handled: true, result: { intent, error: "Expense not found." } };

    const open = rows.find((r) => r.effective_to == null) ?? rows[rows.length - 1];

    if (mode === "fix") {
      // Correct a typo — overwrite the latest segment in place (history changes).
      await supabase.from("store_expenses")
        .update({ amount }).eq("id", open.id).eq("store_id", shop);
      return { handled: true, result: { intent, success: true } };
    }

    // forward: new value applies from the current month onward.
    const cms = monthStart();
    if (open.effective_from && open.effective_from >= cms) {
      // Already a segment that starts this month — just update it.
      await supabase.from("store_expenses")
        .update({ amount }).eq("id", open.id).eq("store_id", shop);
      return { handled: true, result: { intent, success: true } };
    }
    if (Number(open.amount) === amount) {
      // No real change — keep storage minimal, write nothing.
      return { handled: true, result: { intent, success: true } };
    }
    // Close the running segment at the end of last month, open a new one.
    await supabase.from("store_expenses")
      .update({ effective_to: prevMonthStart(cms) })
      .eq("id", open.id).eq("store_id", shop);
    await supabase.from("store_expenses").insert({
      store_id: shop,
      series_id: seriesId,
      name: open.name,
      kind: open.kind,
      is_variable: open.is_variable,
      pct_base: open.pct_base,
      type: open.type,
      amount,
      effective_from: cms,
      effective_to: null,
    });
    return { handled: true, result: { intent, success: true } };
  }

  // ── Stop after a chosen month (keeps history) ────────────────────────────
  if (intent === "expense_stop") {
    const seriesId = String(formData.get("series_id") ?? "");
    const stopMonth = String(formData.get("stop_month") ?? "");
    if (!seriesId || !/^\d{4}-\d{1,2}$/.test(stopMonth))
      return { handled: true, result: { intent, error: "Pick a month to stop after." } };
    const cut = firstOfYYYYMM(stopMonth);

    // Drop segments that start after the cutoff entirely.
    await supabase.from("store_expenses")
      .delete().eq("store_id", shop).eq("series_id", seriesId).gt("effective_from", cut);
    // End the still-running segment at the cutoff month.
    await supabase.from("store_expenses")
      .update({ effective_to: cut })
      .eq("store_id", shop).eq("series_id", seriesId).is("effective_to", null);
    return { handled: true, result: { intent, success: true } };
  }

  // ── Delete completely (also removes it from past periods) ────────────────
  if (intent === "expense_delete") {
    const seriesId = String(formData.get("series_id") ?? "");
    const legacyId = String(formData.get("id") ?? "");
    const q = supabase.from("store_expenses").delete().eq("store_id", shop);
    if (seriesId) await q.eq("series_id", seriesId);
    else if (legacyId) await q.eq("id", legacyId);
    return { handled: true, result: { intent, success: true } };
  }

  return { handled: false, result: null };
}

// View-model helper for the UI: collapse segments into one card per series.
// Returns the current (open) amount, whether this month still needs a value
// for a variable expense, and a human label.
export function summarizeExpenses(rows, now = new Date()) {
  const cms = monthStart(now);
  const bySeries = new Map();
  for (const r of rows ?? []) {
    const k = r.series_id ?? r.id;
    if (!bySeries.has(k)) bySeries.set(k, []);
    bySeries.get(k).push(r);
  }
  const out = [];
  for (const [seriesId, segs] of bySeries) {
    segs.sort((a, b) => String(a.effective_from ?? "").localeCompare(String(b.effective_from ?? "")));
    const open = segs.find((s) => s.effective_to == null) ?? segs[segs.length - 1];
    const needsThisMonth =
      open.kind === "fixed" && open.is_variable && open.effective_to == null &&
      (open.effective_from == null || open.effective_from < cms);
    out.push({
      seriesId,
      id: open.id,
      name: open.name,
      kind: open.kind,
      isVariable: !!open.is_variable,
      pctBase: open.pct_base ?? null,
      amount: Number(open.amount),
      effectiveFrom: open.effective_from,
      needsThisMonth,
    });
  }
  return out;
}

export { monthStart };
