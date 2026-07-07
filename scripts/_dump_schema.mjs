// One-shot schema dumper for codtracker -> supabase/schema.sql
// Uses pg_get_*def() introspection so the output is exactly what Postgres would replay.

import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) { console.error('SUPABASE_DATABASE_URL missing'); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const q = (sql, params = []) => client.query(sql, params).then(r => r.rows);

// ---- Tables (columns + table-level constraints, FKs split out) ----
const tables = await q(`
  SELECT c.oid, c.relname AS name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  ORDER BY c.relname
`);

const cols = await q(`
  SELECT table_name, column_name, data_type, udt_name, character_maximum_length,
         numeric_precision, numeric_scale, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY table_name, ordinal_position
`);

const cons = await q(`
  SELECT conrelid::regclass::text AS table_name,
         conname,
         pg_get_constraintdef(oid) AS def,
         contype
  FROM pg_constraint
  WHERE connamespace = 'public'::regnamespace
  ORDER BY conrelid::regclass::text, contype, conname
`);

const indexes = await q(`
  SELECT schemaname, tablename, indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname NOT IN (
      SELECT conname FROM pg_constraint WHERE contype IN ('p','u')
    )
  ORDER BY tablename, indexname
`);

const views = await q(`
  SELECT viewname, pg_get_viewdef(format('public.%I', viewname)::regclass, true) AS def
  FROM pg_views WHERE schemaname='public'
  ORDER BY viewname
`);

const funcs = await q(`
  SELECT p.proname, pg_get_functiondef(p.oid) AS def, p.prokind
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
  ORDER BY p.proname
`);

const triggers = await q(`
  SELECT tgname, pg_get_triggerdef(t.oid) AS def, c.relname AS table_name
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname='public' AND NOT t.tgisinternal
  ORDER BY c.relname, t.tgname
`);

await client.end();

// ---- Format DDL ----
const out = [];
const push = (s) => out.push(s);
const blank = () => out.push('');

push('-- ============================================================');
push('-- codtracker schema (consolidated)');
push(`-- Generated ${new Date().toISOString()} from live Supabase DB`);
push('-- Run once on a fresh database. No incremental migrations exist.');
push('-- ============================================================');
blank();
push('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
blank();

// Tables: columns + non-FK constraints inline; FKs separated
const fmtType = (c) => {
  const u = c.udt_name;
  if (c.data_type === 'character varying') return `varchar${c.character_maximum_length ? `(${c.character_maximum_length})` : ''}`;
  if (c.data_type === 'character') return `char${c.character_maximum_length ? `(${c.character_maximum_length})` : ''}`;
  if (c.data_type === 'numeric' && c.numeric_precision) return `numeric(${c.numeric_precision},${c.numeric_scale ?? 0})`;
  if (c.data_type === 'timestamp with time zone') return 'timestamptz';
  if (c.data_type === 'timestamp without time zone') return 'timestamp';
  if (c.data_type === 'ARRAY') return `${u.replace(/^_/, '')}[]`;
  if (c.data_type === 'USER-DEFINED') return u;
  return c.data_type;
};

push('-- ---------- Tables ----------');
blank();
for (const t of tables) {
  const tcols = cols.filter(c => c.table_name === t.name);
  push(`CREATE TABLE ${t.name} (`);
  const lines = tcols.map(c => {
    const parts = [`  ${c.column_name}`, fmtType(c)];
    if (c.column_default) parts.push(`DEFAULT ${c.column_default}`);
    if (c.is_nullable === 'NO') parts.push('NOT NULL');
    return parts.join(' ');
  });
  // PK + UNIQUE + CHECK inline
  const inline = cons.filter(k => k.table_name === t.name && (k.contype === 'p' || k.contype === 'u' || k.contype === 'c'));
  for (const k of inline) lines.push(`  CONSTRAINT ${k.conname} ${k.def}`);
  push(lines.join(',\n'));
  push(');');
  blank();
}

// FKs at the end
push('-- ---------- Foreign keys ----------');
blank();
for (const k of cons.filter(c => c.contype === 'f')) {
  push(`ALTER TABLE ${k.table_name} ADD CONSTRAINT ${k.conname} ${k.def};`);
}
blank();

push('-- ---------- Indexes ----------');
blank();
for (const i of indexes) push(`${i.indexdef};`);
blank();

push('-- ---------- Views ----------');
blank();
for (const v of views) {
  push(`CREATE OR REPLACE VIEW ${v.viewname} AS`);
  push(v.def);
  blank();
}

push('-- ---------- Functions / Procedures ----------');
blank();
for (const f of funcs) {
  push(f.def.trimEnd() + ';');
  blank();
}

push('-- ---------- Triggers ----------');
blank();
for (const t of triggers) push(`${t.def};`);
blank();

const outPath = path.resolve('supabase/schema.sql');
fs.writeFileSync(outPath, out.join('\n') + '\n');
console.log(`Wrote ${outPath} (${out.length} lines, ${tables.length} tables, ${views.length} views, ${funcs.length} functions, ${triggers.length} triggers, ${indexes.length} indexes)`);
