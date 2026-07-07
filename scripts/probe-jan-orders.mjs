// Probe PostEx for Jan 1-31 2026 orders to see what status they currently have.
// Cross-checks DB vs API to figure out why orders are stuck in_transit.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const TOKEN = process.env.POSTEX_API_TOKEN;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!TOKEN) { console.error('No POSTEX_API_TOKEN'); process.exit(1); }

const BASE = 'https://api.postex.pk/services/integration/api/order';

async function fetchPostex(start, end) {
  const url = `${BASE}/v1/get-all-order?orderStatusId=0&startDate=${start}&endDate=${end}`;
  const res = await fetch(url, { headers: { token: TOKEN } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data.dist || []).map(it => it.trackingResponse ?? it);
}

const DELIVERED  = new Set(['0005']);
const RETURNED   = new Set(['0002', '0006', '0007']);
const STATUS_MAP = {
  'Delivered': '0005', 'Return': '0002', 'Returned': '0002',
  'Booked': '0003', 'Out For Delivery': '0004',
  'Attempted': '0013', 'Under Verification': '0008',
  'Delivery Under Review': '0008',
};
function code(o) {
  const h = o.transactionStatusHistory;
  if (Array.isArray(h) && h.length > 0) return h[h.length - 1].transactionStatusMessageCode || '0003';
  return STATUS_MAP[o.transactionStatus] || '0003';
}
function flag(c) {
  if (DELIVERED.has(c)) return 'delivered';
  if (RETURNED.has(c))  return 'returned';
  return 'in_transit';
}

console.log('--- Fetching PostEx Jan 1-31 2026 ---');
const raw = await fetchPostex('2026-01-01', '2026-01-31');
console.log(`Total orders returned: ${raw.length}`);

// Tally by transactionStatus + computed flag
const byStatus = {};
const byFlag   = { delivered: 0, returned: 0, in_transit: 0 };
const unmapped = new Set();

for (const o of raw) {
  const s = o.transactionStatus ?? '(null)';
  byStatus[s] = (byStatus[s] || 0) + 1;
  const c = code(o);
  byFlag[flag(c)]++;
  if (!STATUS_MAP[s] && (!o.transactionStatusHistory || o.transactionStatusHistory.length === 0)) {
    unmapped.add(s);
  }
}

console.log('\nBy transactionStatus (live PostEx):');
for (const [k, v] of Object.entries(byStatus).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${k.padEnd(28)} ${v}`);
}
console.log('\nBy computed flag:');
console.log('  delivered: ', byFlag.delivered);
console.log('  returned:  ', byFlag.returned);
console.log('  in_transit:', byFlag.in_transit);
if (unmapped.size > 0) {
  console.log('\nUNMAPPED transactionStatus values (would default to in_transit):');
  for (const s of unmapped) console.log(`  - "${s}"`);
}

// Sample 3 in-transit-flagged orders
console.log('\nSample of 5 orders flagged in_transit by our code:');
let n = 0;
for (const o of raw) {
  if (flag(code(o)) === 'in_transit' && n < 5) {
    console.log(`  ${o.trackingNumber}  status="${o.transactionStatus}"  date=${o.transactionDate}  hasHistory=${Array.isArray(o.transactionStatusHistory) && o.transactionStatusHistory.length > 0}`);
    n++;
  }
}

// Now compare to DB
if (SUPA_URL && SUPA_KEY) {
  console.log('\n--- DB check ---');
  const sb = createClient(SUPA_URL, SUPA_KEY);
  const { data: dbRows, error } = await sb
    .from('orders')
    .select('tracking_number, transaction_status, is_delivered, is_returned, is_in_transit, transaction_date')
    .gte('transaction_date', '2026-01-01')
    .lt('transaction_date', '2026-02-01');
  if (error) { console.error(error); }
  else {
    console.log(`DB rows: ${dbRows.length}`);
    const dbFlag = { delivered: 0, returned: 0, in_transit: 0 };
    for (const r of dbRows) {
      if (r.is_delivered) dbFlag.delivered++;
      else if (r.is_returned) dbFlag.returned++;
      else dbFlag.in_transit++;
    }
    console.log('DB flag tally:', dbFlag);

    // Build PostEx tracking → status
    const apiByTrack = new Map();
    for (const o of raw) apiByTrack.set(o.trackingNumber, o);

    // Find rows the DB has as in_transit but PostEx has as delivered/returned
    let stale = 0;
    const examples = [];
    for (const r of dbRows) {
      if (!r.is_in_transit) continue;
      const live = apiByTrack.get(r.tracking_number);
      if (!live) continue;
      const liveFlag = flag(code(live));
      if (liveFlag !== 'in_transit') {
        stale++;
        if (examples.length < 5) {
          examples.push({ tn: r.tracking_number, db: r.transaction_status, live: live.transactionStatus });
        }
      }
    }
    console.log(`\nDB-stale rows (DB=in_transit but PostEx now says delivered/returned): ${stale}`);
    for (const e of examples) console.log(`  ${e.tn}  DB="${e.db}"  LIVE="${e.live}"`);
  }
}
