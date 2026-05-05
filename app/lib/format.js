// Central money-formatting layer. Replaces ~14 ad-hoc fmtPKR functions
// scattered across app/components/*. Backed by Intl.NumberFormat which
// knows how to render every ISO 4217 code (USD, PKR, EUR, INR, AED,
// GBP, …) with the right symbol, separator, and decimal convention.
//
// Defaults:
//   - currency: PKR — keeps legacy callers (which assumed PKR) working
//     without modification.
//   - locale: "en" — uses English number grouping (1,234.56) regardless
//     of currency. Pakistan rupee with English formatting renders as
//     "PKR 12,345" via Intl, which matches the prior fmtPKR output
//     "PKR 12,345" exactly.
//   - maximumFractionDigits: 0 — money on the dashboard shows whole
//     units. Per-product COGS pages override to 2.

const DEFAULT_LOCALE = "en";

// Render a money amount in the given currency. Returns "—" when amount
// is null/undefined so charts and tables display a clean empty cell
// rather than "PKR 0" (which suggests a real zero).
//
// `currency` accepts:
//   - ISO 4217 code (e.g. "PKR", "USD") — the normal case
//   - undefined → defaults to "PKR" (legacy contract)
//   - unknown code (e.g. "ABC") → graceful fallback to `${code} ${num}`
export function formatMoney(
  amount,
  currency = "PKR",
  { fractionDigits = 0, sign = false, locale = DEFAULT_LOCALE, nullDisplay = "—" } = {}
) {
  if (amount == null || amount === "") return nullDisplay;
  const n = Number(amount);
  if (!Number.isFinite(n)) return nullDisplay;

  const code = String(currency || "PKR").toUpperCase();
  try {
    const opts = {
      style: "currency",
      currency: code,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    };
    if (sign) opts.signDisplay = "exceptZero";
    return new Intl.NumberFormat(locale, opts).format(n);
  } catch {
    // Intl threw — usually because `code` isn't a recognized ISO 4217.
    // Render the bare value with the code prefix so we never crash a
    // dashboard render over a typo'd currency setting.
    const num = n.toLocaleString(locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    const prefix = sign && n > 0 ? "+" : "";
    return `${prefix}${code} ${num}`;
  }
}

// Format a negative cost with a minus sign in front of the symbol.
// "Costs are negative" rendering convention used throughout the
// dashboard's DetailPanel ("-PKR 1,200" for delivery cost rows).
export function formatNegative(amount, currency = "PKR", opts = {}) {
  if (amount == null || amount === "") return opts.nullDisplay ?? "—";
  const n = Number(amount);
  if (!Number.isFinite(n)) return opts.nullDisplay ?? "—";
  if (n === 0) return formatMoney(0, currency, opts);
  const positive = formatMoney(Math.abs(n), currency, opts);
  return `-${positive}`;
}

// Convenience wrapper for tooltips / labels needing the currency
// code (not symbol). E.g. "PKR" for tooltip text where symbols
// would be ambiguous (Rs. could mean rupee or rial).
export function currencyCode(currency) {
  return String(currency || "PKR").toUpperCase();
}
