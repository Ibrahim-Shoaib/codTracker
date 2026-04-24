import { readFileSync } from 'node:fs';
import pg from 'pg';
import 'dotenv/config';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/run-migration.mjs <path-to-sql>');
  process.exit(1);
}

const sql = readFileSync(path, 'utf8');
const raw = process.env.SUPABASE_DATABASE_URL;
const u = new URL(raw);

// u.password is URL-encoded by the URL constructor — decode once.
const password = decodeURIComponent(u.password);
const user = decodeURIComponent(u.username);

console.log(`Connecting as: ${user} @ ${u.hostname}:${u.port || 5432}`);
console.log(`Password length: ${password.length}`);

const client = new pg.Client({
  host: u.hostname,
  port: Number(u.port || 5432),
  user,
  password,
  database: u.pathname.replace(/^\//, ''),
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query(sql);
  console.log(`Applied: ${path}`);
} finally {
  await client.end();
}
