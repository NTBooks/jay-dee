// Ad-hoc read-only SQL against the catalog. Usage:
//   node scripts/sql.mjs "select count(*) n from tracks"
//   node scripts/sql.mjs --file query.sql
//   node scripts/sql.mjs --json "select ..."
import fs from 'node:fs';
import { openDb, closeDb } from '../src/db/open.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const fileIdx = args.indexOf('--file');
const sql = fileIdx >= 0 ? fs.readFileSync(args[fileIdx + 1], 'utf8') : args.filter((a) => !a.startsWith('--')).join(' ');
if (!sql.trim()) { console.error('usage: node scripts/sql.mjs "<sql>" | --file q.sql [--json]'); process.exit(1); }

const db = openDb();
db.pragma('query_only = ON');
try {
  const stmts = sql.split(/;\s*(?=\S)/).map((s) => s.trim()).filter(Boolean);
  for (const s of stmts) {
    const rows = db.prepare(s).all();
    if (asJson) console.log(JSON.stringify(rows, null, 2));
    else if (rows.length === 0) console.log('(no rows)');
    else console.table(rows);
  }
} catch (e) {
  console.error('SQL error:', e.message);
  process.exit(1);
} finally { closeDb(); }
process.exit(0);
