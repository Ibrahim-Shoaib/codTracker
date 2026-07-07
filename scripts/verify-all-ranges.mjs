// Verify the orders=delivered+returned behavior across every range a card can show.
import 'dotenv/config';
import pg from 'pg';

const url = process.env.SUPABASE_DATABASE_URL;
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows: stores } = await client.query(`SELECT store_id FROM stores LIMIT 1`);
const storeId = stores[0].store_id;

const ranges = [
  ['Today',           '2026-04-25', '2026-04-25'],
  ['Yesterday',       '2026-04-24', '2026-04-24'],
  ['Month to date',   '2026-04-01', '2026-04-25'],
  ['Last month',      '2026-03-01', '2026-03-31'],
  ['2 months ago',    '2026-02-01', '2026-02-28'],
  ['3 months ago',    '2026-01-01', '2026-01-31'],
  ['Year to date',    '2026-01-01', '2026-04-25'],
  ['Custom (Q1)',     '2026-01-01', '2026-03-31'],
];

console.log('Range            From         To           Delivered  Returned  RPC.orders  AOV         CAC         Refund%   ✓');
console.log('───────────────  ───────────  ───────────  ─────────  ────────  ──────────  ──────────  ──────────  ────────  ──');
for (const [label, from, to] of ranges) {
  const { rows: s } = await client.query(
    `SELECT * FROM get_dashboard_stats($1, $2::date, $3::date, 0::numeric, 0::numeric)`,
    [storeId, from, to]
  );
  const { rows: r } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE is_delivered) AS d,
            COUNT(*) FILTER (WHERE is_returned)  AS rt
     FROM orders
     WHERE store_id = $1
       AND transaction_date >= $2::timestamptz
       AND transaction_date <  ($3::date + 1)::timestamptz`,
    [storeId, from, to]
  );
  const delivered = Number(r[0].d), returned = Number(r[0].rt);
  const expected = delivered + returned;
  const got = Number(s[0].orders);
  const ok = expected === got ? '✓' : '✗';
  const aov = s[0].aov == null ? 'N/A' : Number(s[0].aov).toFixed(2);
  const cac = s[0].cac == null ? 'N/A' : Number(s[0].cac).toFixed(2);
  const refund = Number(s[0].refund_pct).toFixed(2) + '%';
  console.log(
    `${label.padEnd(15)}  ${from}  ${to}  ${String(delivered).padStart(9)}  ${String(returned).padStart(8)}  ${String(got).padStart(10)}  ${aov.padStart(10)}  ${cac.padStart(10)}  ${refund.padStart(8)}  ${ok}`
  );
}
await client.end();
