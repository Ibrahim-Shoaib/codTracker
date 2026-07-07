// Phase 0 safety net. Captures EVERYTHING needed to prove "no behavior change"
// and to roll back:
//   1. Full store_expenses backup (JSON)
//   2. Current get_dashboard_stats / get_daily_series / get_trend_series defs (SQL)
//   3. Exact RPC outputs the app produces today, for every store, over a
//      date-range matrix that exercises the month-count edge cases.
// Re-run with --verify after the migration+function swap to diff against this.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const OUT = path.join(process.cwd(), 'scripts', '.expense-v2');
fs.mkdirSync(OUT, { recursive: true });
const VERIFY = process.argv.includes('--verify');
const DEMO_POOL = '__codprofit_demo_pool__';

const c = new pg.Client({ connectionString: process.env.SUPABASE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

// Stores that have expenses + their demo flag
const stores = (await c.query(`
  SELECT DISTINCT se.store_id, s.is_demo
  FROM store_expenses se JOIN stores s USING (store_id) ORDER BY se.store_id
`)).rows;

// Date matrix — today is 2026-05-15
const RANGES = {
  today:            ['2026-05-15', '2026-05-15'],
  this_month:       ['2026-05-01', '2026-05-15'],
  last_month:       ['2026-04-01', '2026-04-30'],
  last_30:          ['2026-04-16', '2026-05-15'],
  last_60:          ['2026-03-17', '2026-05-15'],
  last_90:          ['2026-02-15', '2026-05-15'],
  this_year:        ['2026-01-01', '2026-05-15'],
  mid_month_only:   ['2026-05-05', '2026-05-11'],   // no 1st-of-month -> monthly expense must be 0
  spans_two_firsts: ['2026-04-01', '2026-05-15'],   // Apr 1 + May 1
  single_first:     ['2026-03-01', '2026-03-01'],
  last_year_full:   ['2025-01-01', '2025-12-31'],
};

// stable stringify so diffs are exact
const stable = (o) => JSON.stringify(o, Object.keys(o ?? {}).sort());

async function snapshot() {
  const result = { generatedAt: new Date().toISOString(), verify: VERIFY, stores: {} };

  for (const st of stores) {
    const shop = st.store_id;
    const dataStoreId = st.is_demo ? DEMO_POOL : shop;

    // exactly how the app sums today
    const agg = (await c.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE type='monthly'),0) m,
              COALESCE(SUM(amount) FILTER (WHERE type='per_order'),0) p
       FROM store_expenses WHERE store_id=$1`, [shop])).rows[0];
    const monthlyExp = Number(agg.m), perOrderExp = Number(agg.p);

    const entry = { shop, is_demo: st.is_demo, dataStoreId, monthlyExp, perOrderExp, calls: {} };

    for (const [rk, [from, to]] of Object.entries(RANGES)) {
      // Old = positional scalar signature. New = named, table-driven with
      // p_expense_store_id (so demo reads pool orders + own expenses).
      const ds = VERIFY
        ? await c.query(`SELECT * FROM get_dashboard_stats(p_store_id:=$1, p_from_date:=$2, p_to_date:=$3, p_expense_store_id:=$4)`,
            [dataStoreId, from, to, shop])
        : await c.query(`SELECT * FROM get_dashboard_stats($1,$2,$3,$4,$5)`,
            [dataStoreId, from, to, monthlyExp, perOrderExp]);
      entry.calls[`dashboard:${rk}`] = ds.rows[0];

      const dl = VERIFY
        ? await c.query(`SELECT * FROM get_daily_series(p_store_id:=$1, p_from_date:=$2, p_to_date:=$3, p_expense_store_id:=$4)`, [dataStoreId, from, to, shop])
        : await c.query(`SELECT * FROM get_daily_series($1,$2,$3,$4,$5)`, [dataStoreId, from, to, monthlyExp, perOrderExp]);
      entry.calls[`daily:${rk}`] = dl.rows;

      for (const g of ['day', 'month', 'year']) {
        const tr = VERIFY
          ? await c.query(`SELECT * FROM get_trend_series(p_store_id:=$1, p_from_date:=$2, p_to_date:=$3, p_granularity:=$4, p_expense_store_id:=$5)`, [dataStoreId, from, to, g, shop])
          : await c.query(`SELECT * FROM get_trend_series($1,$2,$3,$4,$5,$6)`, [dataStoreId, from, to, monthlyExp, perOrderExp, g]);
        entry.calls[`trend:${rk}:${g}`] = tr.rows;
      }
    }
    result.stores[shop] = entry;
  }
  return result;
}

if (!VERIFY) {
  // 1. data backup
  const rows = (await c.query(`SELECT * FROM store_expenses ORDER BY store_id, created_at`)).rows;
  fs.writeFileSync(path.join(OUT, 'store_expenses.backup.json'), JSON.stringify(rows, null, 2));
  // 2. function defs for rollback
  const defs = (await c.query(`
    SELECT proname, pg_get_functiondef(oid) src FROM pg_proc
    WHERE proname IN ('get_dashboard_stats','get_daily_series','get_trend_series') ORDER BY proname`)).rows;
  fs.writeFileSync(path.join(OUT, 'rollback_functions.sql'),
    defs.map(d => `-- ${d.proname}\n${d.src};\n`).join('\n'));
  console.log(`Backed up ${rows.length} expense rows + ${defs.length} function defs to ${OUT}`);
}

const snap = await snapshot();
const file = path.join(OUT, VERIFY ? 'after.json' : 'baseline.json');
fs.writeFileSync(file, JSON.stringify(snap, null, 2));
console.log(`${VERIFY ? 'AFTER' : 'BASELINE'} snapshot -> ${file}`);

if (VERIFY) {
  const base = JSON.parse(fs.readFileSync(path.join(OUT, 'baseline.json'), 'utf8'));
  let diffs = 0;
  for (const shop of Object.keys(base.stores)) {
    const a = base.stores[shop].calls, b = snap.stores[shop]?.calls ?? {};
    for (const k of Object.keys(a)) {
      if (stable(a[k]) !== stable(b[k])) {
        diffs++;
        console.log(`\n  MISMATCH  ${shop}  ${k}`);
        console.log(`   before: ${stable(a[k]).slice(0, 400)}`);
        console.log(`   after : ${stable(b[k]).slice(0, 400)}`);
      }
    }
  }
  console.log(diffs === 0
    ? '\n✅ ZERO DIFFERENCES — dashboard numbers byte-identical before/after.'
    : `\n❌ ${diffs} mismatch(es) — DO NOT PROCEED. Roll back.`);
  process.exitCode = diffs === 0 ? 0 : 1;
}

await c.end();
