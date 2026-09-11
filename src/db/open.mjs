import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.mjs';

const SCHEMA_VERSION = 3;
let _db = null;

export function openDb({ readonly = false } = {}) {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath, { readonly });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 10000');
  if (!readonly) {
    const schema = fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8');
    db.exec(schema);
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
    if (!row) db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(SCHEMA_VERSION);
    migrate(db, row ? row.version : SCHEMA_VERSION);
    db.exec('CREATE INDEX IF NOT EXISTS ix_tracks_lib ON tracks(library_id)'); // after migrations so the column exists on older DBs
    addColumnIfMissing(db, 'dj_sessions', 'mode', 'TEXT');
  }
  _db = db;
  return db;
}

// Additive migrations: add columns that older DBs lack. Each entry is idempotent.
export function addColumnIfMissing(db, table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

function migrate(db, from) {
  if (from < 2) {
    // v2: tag-level recording MBIDs move out of the resolved column
    addColumnIfMissing(db, 'tracks', 'tag_mb_recording_id', 'TEXT');
    db.exec('UPDATE tracks SET tag_mb_recording_id = mb_recording_id, mb_recording_id = NULL WHERE resolved_at IS NULL AND mb_recording_id IS NOT NULL');
  }
  if (from < 3) {
    // v3: Jellyfin libraries as dynamic config
    addColumnIfMissing(db, 'tracks', 'library_id', 'TEXT');
    addColumnIfMissing(db, 'albums', 'library_id', 'TEXT');
    addColumnIfMissing(db, 'artists', 'library_ids_json', 'TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS ix_tracks_lib ON tracks(library_id)');
  }
  if (from < SCHEMA_VERSION) db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}

export const j = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
export const pj = (s, fallback = null) => { if (s == null) return fallback; try { return JSON.parse(s); } catch { return fallback; } };
