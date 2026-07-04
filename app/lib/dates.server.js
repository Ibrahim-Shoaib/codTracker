// Date logic is per-store: every function takes an IANA timezone (e.g.
// 'Asia/Karachi', 'Europe/London') and computes that store's local calendar
// day, then returns real UTC timestamps for Supabase queries. Railway and the
// DB session both run UTC; we derive the local day via Intl.DateTimeFormat so
// DST (e.g. UK BST/GMT) is handled correctly — no fixed offset.
//
// The default 'Asia/Karachi' preserves the historical PKT behaviour for any
// caller that hasn't threaded a store timezone yet.

const DEFAULT_TZ = 'Asia/Karachi';

// Milliseconds `tz` is ahead of UTC at the given instant (DST-aware, signed).
function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? 0 : Number(p.hour); // some engines emit '24' for midnight
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  // Compare at whole-second precision (formatToParts has no ms); tz offsets are
  // always whole minutes, so this keeps the caller's sub-second field intact.
  return asUTC - (date.getTime() - date.getMilliseconds());
}

// Real UTC Date for a store-local wall-clock time. Single offset lookup is
// exact for day boundaries (00:00 / 23:59) — those never fall inside a DST gap
// in the zones we support.
function zonedToUTC(y, m, d, hh, mm, ss, ms, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss, ms);
  return new Date(guess - tzOffsetMs(new Date(guess), tz));
}

// { y, m (1-12), d } of "now" in tz.
function todayParts(tz) {
  const now = new Date();
  const local = new Date(now.getTime() + tzOffsetMs(now, tz));
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
}

// Calendar-shift parts by whole days (handles month/year rollover).
function shiftDays({ y, m, d }, delta) {
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + delta);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function ymdOf(dateUTC) {
  return { y: dateUTC.getUTCFullYear(), m: dateUTC.getUTCMonth() + 1, d: dateUTC.getUTCDate() };
}

function partsToYmd({ y, m, d }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const startOfDayUTC = ({ y, m, d }, tz) => zonedToUTC(y, m, d, 0, 0, 0, 0, tz);
const endOfDayUTC   = ({ y, m, d }, tz) => zonedToUTC(y, m, d, 23, 59, 59, 999, tz);

export function getToday(tz = DEFAULT_TZ) {
  const p = todayParts(tz);
  return { start: startOfDayUTC(p, tz), end: endOfDayUTC(p, tz) };
}

export function getYesterday(tz = DEFAULT_TZ) {
  const p = shiftDays(todayParts(tz), -1);
  return { start: startOfDayUTC(p, tz), end: endOfDayUTC(p, tz) };
}

export function getMTD(tz = DEFAULT_TZ) {
  const today = todayParts(tz);
  const first = { y: today.y, m: today.m, d: 1 };
  return { start: startOfDayUTC(first, tz), end: endOfDayUTC(today, tz) };
}

export function getLastMonth(tz = DEFAULT_TZ) {
  const { y, m } = todayParts(tz);
  const first = ymdOf(new Date(Date.UTC(y, m - 2, 1)));   // first of previous month
  const last  = ymdOf(new Date(Date.UTC(y, m - 1, 0)));   // day 0 of this month = last day prev
  return { start: startOfDayUTC(first, tz), end: endOfDayUTC(last, tz) };
}

// For MTD % change: e.g. Apr 1-22 compared against Mar 1-22
export function getMTDComparison(tz = DEFAULT_TZ) {
  const { y, m, d } = todayParts(tz);
  const first = ymdOf(new Date(Date.UTC(y, m - 2, 1)));
  const lastDayOfLastMonth = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const compDay = Math.min(d, lastDayOfLastMonth);
  const end = ymdOf(new Date(Date.UTC(y, m - 2, compDay)));
  return { start: startOfDayUTC(first, tz), end: endOfDayUTC(end, tz) };
}

// Day before yesterday — prior comparison for the "Yesterday" card
export function getDayBeforeYesterday(tz = DEFAULT_TZ) {
  const p = shiftDays(todayParts(tz), -2);
  return { start: startOfDayUTC(p, tz), end: endOfDayUTC(p, tz) };
}

// Full month before last month — prior comparison for the "Last month" card
export function getMonthBeforeLast(tz = DEFAULT_TZ) {
  const { y, m } = todayParts(tz);
  const first = ymdOf(new Date(Date.UTC(y, m - 3, 1)));
  const last  = ymdOf(new Date(Date.UTC(y, m - 2, 0)));
  return { start: startOfDayUTC(first, tz), end: endOfDayUTC(last, tz) };
}

// Equal-length range immediately preceding [fromYMD, toYMD]. Inputs and
// outputs are 'YYYY-MM-DD' strings — pure calendar math, timezone-independent.
//   length = (to - from) + 1 inclusive days
//   prior  = [from - length, from - 1]
export function getPriorEqualLengthRange(fromYMD, toYMD) {
  const [fy, fm, fd] = fromYMD.split('-').map(Number);
  const [ty, tm, td] = toYMD.split('-').map(Number);
  const fromDate = new Date(Date.UTC(fy, fm - 1, fd));
  const toDate   = new Date(Date.UTC(ty, tm - 1, td));
  const dayMs    = 24 * 60 * 60 * 1000;
  const lengthDays = Math.round((toDate - fromDate) / dayMs) + 1;

  const priorTo   = new Date(fromDate); priorTo.setUTCDate(priorTo.getUTCDate() - 1);
  const priorFrom = new Date(fromDate); priorFrom.setUTCDate(priorFrom.getUTCDate() - lengthDays);

  const ymd = (d) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { from: ymd(priorFrom), to: ymd(priorTo) };
}

// UTC instant of the start (00:00) of a store-local calendar day given as a
// 'YYYY-MM-DD' string — used to build precise created_at_min bounds for
// Shopify API calls.
export function dayStartUTC(ymd, tz = DEFAULT_TZ) {
  const [y, m, d] = ymd.split('-').map(Number);
  return zonedToUTC(y, m, d, 0, 0, 0, 0, tz);
}

// Returns the 'YYYY-MM-DD' store-local calendar date of a UTC instant — used
// for PostEx API calls and ad_spend date keys.
export function formatDate(dateUTC, tz = DEFAULT_TZ) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(dateUTC)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// Returns { start, end } as 'YYYY-MM-DD' store-local strings for a rolling
// N-day sync window (PostEx).
export function getLastNDays(n = 20, tz = DEFAULT_TZ) {
  const today = todayParts(tz);
  return {
    start: partsToYmd(shiftDays(today, -n)),
    end:   partsToYmd(today),
  };
}

// Array of { start, end } 'YYYY-MM-DD' store-local strings for each calendar
// month from startDateStr ('YYYY-MM-DD') to today — used by historical backfill.
export function getMonthlyChunks(startDateStr, tz = DEFAULT_TZ) {
  const todayStr = partsToYmd(todayParts(tz));
  const chunks = [];

  const [startYear, startMonth] = startDateStr.split('-').map(Number);
  let year = startYear;
  let month = startMonth; // 1-indexed

  while (true) {
    const chunkStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const chunkEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    chunks.push({ start: chunkStart, end: chunkEnd < todayStr ? chunkEnd : todayStr });

    if (chunkEnd >= todayStr) break;

    month++;
    if (month > 12) { month = 1; year++; }
  }

  return chunks;
}
