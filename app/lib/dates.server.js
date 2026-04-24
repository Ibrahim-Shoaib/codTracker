// All date logic is PKT (UTC+5). Railway runs UTC — we shift by +5h to work in PKT,
// then return real UTC timestamps for Supabase queries.

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5

// Returns a Date object whose UTC fields read as PKT local time
function nowPKT() {
  return new Date(Date.now() + PKT_OFFSET_MS);
}

// Given a Date whose UTC fields = PKT local time, returns the start-of-that-day as real UTC
function startOfDayUTC(pktDate) {
  const midnight = Date.UTC(
    pktDate.getUTCFullYear(),
    pktDate.getUTCMonth(),
    pktDate.getUTCDate(),
    0, 0, 0, 0
  );
  return new Date(midnight - PKT_OFFSET_MS);
}

// Given a Date whose UTC fields = PKT local time, returns end-of-that-day as real UTC
function endOfDayUTC(pktDate) {
  const endOfDay = Date.UTC(
    pktDate.getUTCFullYear(),
    pktDate.getUTCMonth(),
    pktDate.getUTCDate(),
    23, 59, 59, 999
  );
  return new Date(endOfDay - PKT_OFFSET_MS);
}

// Shifts a PKT-offset Date back by N days (still in PKT-offset space)
function subtractDaysPKT(pktDate, days) {
  return new Date(Date.UTC(
    pktDate.getUTCFullYear(),
    pktDate.getUTCMonth(),
    pktDate.getUTCDate() - days
  ));
}

export function getTodayPKT() {
  const pkt = nowPKT();
  return { start: startOfDayUTC(pkt), end: endOfDayUTC(pkt) };
}

export function getYesterdayPKT() {
  const yesterday = subtractDaysPKT(nowPKT(), 1);
  return { start: startOfDayUTC(yesterday), end: endOfDayUTC(yesterday) };
}

export function getMTDPKT() {
  const pkt = nowPKT();
  const firstOfMonth = new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), 1));
  return { start: startOfDayUTC(firstOfMonth), end: endOfDayUTC(pkt) };
}

export function getLastMonthPKT() {
  const pkt = nowPKT();
  const firstOfLastMonth = new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth() - 1, 1));
  // Day 0 of current month = last day of previous month
  const lastOfLastMonth = new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), 0));
  return { start: startOfDayUTC(firstOfLastMonth), end: endOfDayUTC(lastOfLastMonth) };
}

// For MTD % change: e.g. Apr 1-22 compared against Mar 1-22
export function getMTDComparisonPKT() {
  const pkt = nowPKT();
  const todayDay = pkt.getUTCDate();

  const firstOfLastMonth = new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth() - 1, 1));
  // Cap to last day of that month in case current month is longer
  const lastDayOfLastMonth = new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), 0)).getUTCDate();
  const compDay = Math.min(todayDay, lastDayOfLastMonth);
  const endOfComparison = new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth() - 1, compDay));

  return { start: startOfDayUTC(firstOfLastMonth), end: endOfDayUTC(endOfComparison) };
}

// Count PKT calendar days between two UTC timestamps
export function getDaysInPeriod(startUTC, endUTC) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const startDay = Math.floor((new Date(startUTC).getTime() + PKT_OFFSET_MS) / msPerDay);
  const endDay   = Math.floor((new Date(endUTC).getTime()   + PKT_OFFSET_MS) / msPerDay);
  return endDay - startDay + 1;
}

// Returns 'YYYY-MM-DD' string in PKT — used for PostEx API calls and ad_spend date keys
export function formatPKTDate(dateUTC) {
  const pkt = new Date(new Date(dateUTC).getTime() + PKT_OFFSET_MS);
  const y = pkt.getUTCFullYear();
  const m = String(pkt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(pkt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Returns { start, end } as 'YYYY-MM-DD' PKT strings for PostEx rolling 30-day sync window
export function getLastNDaysPKT(n = 20) {
  const pkt = nowPKT();
  const nAgo = subtractDaysPKT(pkt, n);
  return {
    start: formatPKTDate(startOfDayUTC(nAgo)),
    end:   formatPKTDate(endOfDayUTC(pkt)),
  };
}

// Returns array of { start, end } 'YYYY-MM-DD' PKT strings for each calendar month
// from startDateStr ('YYYY-MM-DD') to today PKT — used by historical backfill
export function getMonthlyChunks(startDateStr) {
  const pkt = nowPKT();
  const todayStr = formatPKTDate(endOfDayUTC(pkt));
  const chunks = [];

  const [startYear, startMonth] = startDateStr.split('-').map(Number);
  let year = startYear;
  let month = startMonth; // 1-indexed

  while (true) {
    const chunkStart = `${year}-${String(month).padStart(2, '0')}-01`;
    // Last day of this month
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const chunkEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    chunks.push({ start: chunkStart, end: chunkEnd < todayStr ? chunkEnd : todayStr });

    if (chunkEnd >= todayStr) break;

    month++;
    if (month > 12) { month = 1; year++; }
  }

  return chunks;
}
