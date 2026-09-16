// Replace the live catalog database with an uploaded SQLite file.
//
// The workstation does the expensive work (sync, identify, research, embed) and the server only reads the catalog,
// so "deploy" really means "get the workstation's jaydee.sqlite onto the volume". This does that over HTTP instead
// of a container shell: validate the upload, keep the database it replaces, swap, reopen.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.mjs';
import { openDb, closeDb } from './open.mjs';
import { invalidateVectorCache } from '../embed/index.mjs';
import { log } from '../util/log.mjs';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
// Tables the station cannot run without. A file missing any of these is not a Jay Dee catalog.
const REQUIRED = ['schema_version', 'artists', 'albums', 'tracks', 'research', 'embeddings'];
// Tables the station itself writes. The workstation owns the catalog, the server owns these: play history (which the
// DJ reads to avoid repeats), shows, voice breaks cached on this volume, saved sets and feedback. A restore takes the
// catalog from the upload and keeps these from the database it replaces.
export const STATION_TABLES = ['dj_sessions', 'dj_queue', 'dj_calls', 'dj_log', 'patter', 'saved_sets', 'feedback'];

export const stagingDir = () => path.join(config.dataDir, 'restore');
export const backupsDir = () => path.join(config.dataDir, 'backups');
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

// WAL and shared-memory sidecars belong to the file they were written for; they must never survive a swap.
const sidecars = (p) => [`${p}-wal`, `${p}-shm`];
const rmSidecars = (p) => { for (const s of sidecars(p)) fs.rmSync(s, { force: true }); };

export function statOf(file) {
  try { const s = fs.statSync(file); return { bytes: s.size, mb: +(s.size / 1048576).toFixed(1), modified: s.mtime.toISOString() }; }
  catch { return null; }
}

// Read-only inspection of a candidate file. Throws with a plain-language reason when it is not usable.
export function inspect(file) {
  const size = fs.statSync(file).size;
  if (size < 512) throw new Error('file is too small to be a SQLite database');
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (!head.equals(SQLITE_MAGIC)) throw new Error('not a SQLite database (bad file header) — upload jaydee.sqlite itself, not a .tar.gz or .zip');

  let db;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); }
  catch (e) { throw new Error(`cannot open as SQLite: ${e.message}`); }
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') throw new Error(`integrity check failed: ${integrity}`);
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const missing = REQUIRED.filter((t) => !names.has(t));
    if (missing.length) throw new Error(`not a Jay Dee catalog: missing table(s) ${missing.join(', ')}`);
    const n = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
    const counts = {
      tracks: n('SELECT COUNT(*) n FROM tracks WHERE removed_at IS NULL'),
      albums: n('SELECT COUNT(*) n FROM albums WHERE removed_at IS NULL'),
      artists: n('SELECT COUNT(*) n FROM artists WHERE removed_at IS NULL'),
      artists_researched: n("SELECT COUNT(*) n FROM research WHERE entity_type='artist' AND stage='done'"),
      albums_researched: n("SELECT COUNT(*) n FROM research WHERE entity_type='album' AND stage='done'"),
      embeddings: n('SELECT COUNT(*) n FROM embeddings'),
    };
    // An empty catalog would leave the station with nothing to play; that is never what a restore is for.
    if (!counts.tracks) throw new Error('this database has no tracks — refusing to replace the live catalog with an empty one');
    return { ...statOf(file), schema_version: db.prepare('SELECT version FROM schema_version LIMIT 1').get()?.version ?? null, ...counts };
  } finally { db.close(); }
}

// Copy the station tables of `prevFile` over the ones in `db` (the freshly swapped-in upload), all or nothing.
// A database that has never served a show (a fresh server's empty one) has nothing worth keeping, so then the
// upload's own history stays. Returns { source: 'kept' | 'upload', rows }.
function carryStationData(db, prevFile) {
  db.prepare('ATTACH DATABASE ? AS prev').run(prevFile);
  try {
    const inPrev = new Set(db.prepare("SELECT name FROM prev.sqlite_master WHERE type='table'").all().map((r) => r.name));
    const tables = STATION_TABLES.filter((t) => inPrev.has(t));
    const total = tables.reduce((s, t) => s + db.prepare(`SELECT COUNT(*) n FROM prev.${t}`).get().n, 0);
    if (!total) return { source: 'upload', rows: {} };
    const cols = (schema, t) => db.prepare(`PRAGMA ${schema}.table_info(${t})`).all().map((c) => c.name);
    const rows = {};
    db.transaction(() => {
      for (const t of STATION_TABLES) db.prepare(`DELETE FROM main.${t}`).run();
      for (const t of tables) {
        // Only the columns both sides have: either file may predate an additive migration.
        const prevCols = new Set(cols('prev', t));
        const list = cols('main', t).filter((c) => prevCols.has(c)).map((c) => `"${c}"`).join(', ');
        rows[t] = db.prepare(`INSERT INTO main.${t} (${list}) SELECT ${list} FROM prev.${t}`).run().changes;
      }
    })();
    return { source: 'kept', rows };
  } finally {
    db.prepare('DETACH DATABASE prev').run();
  }
}

// Swap `file` in as the live database. Returns { restored, backup, before, after, station_data }.
// The database being replaced is renamed aside first, so a failure at any point can put it back.
// stationData: 'keep' (default) keeps this server's shows, play history, voice breaks, saved sets and feedback;
// 'upload' takes the uploaded file's instead.
export function restoreFrom(file, { station = null, keepBackup = true, stationData = 'keep' } = {}) {
  const info = inspect(file); // throws before anything is touched
  const dbPath = config.dbPath;
  const before = (() => { try { return summarize(openDb()); } catch { return null; } })();

  fs.mkdirSync(backupsDir(), { recursive: true });
  const backup = path.join(backupsDir(), `jaydee-pre-restore-${stamp()}.sqlite`);
  const hadDb = fs.existsSync(dbPath);

  // Checkpoint so the outgoing database is self-contained in one file, then let go of it.
  if (hadDb) { try { openDb().pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ } }
  closeDb();

  let movedAside = false;
  try {
    if (hadDb) { fs.renameSync(dbPath, backup); movedAside = true; rmSidecars(dbPath); }
    fs.renameSync(file, dbPath);
    rmSidecars(dbPath); // the upload's own sidecars were never sent; make sure no stale ones linger
  } catch (e) {
    if (movedAside && !fs.existsSync(dbPath)) { try { fs.renameSync(backup, dbPath); } catch { /* nothing else to try */ } }
    openDb(); // put the station back on its feet whatever happened
    throw new Error(`swap failed, original database left in place: ${e.message}`);
  }

  // openDb() applies schema.sql and the additive migrations, so an older workstation database is brought forward.
  let db = openDb();
  let stationResult = { source: 'upload', rows: {} };
  if (movedAside && stationData !== 'upload') {
    try { stationResult = carryStationData(db, backup); }
    catch (e) {
      // Publishing must never quietly cost the server its history: undo the whole swap instead.
      closeDb();
      try { fs.rmSync(dbPath, { force: true }); rmSidecars(dbPath); fs.renameSync(backup, dbPath); } catch { /* nothing else to try */ }
      openDb();
      throw new Error(`could not keep this station's play history and shows, original database left in place: ${e.message}`);
    }
  }
  invalidateVectorCache();
  // With the station's own tables kept, the show on air still refers to real rows and keeps playing.
  station?.reset?.({ keepShow: stationResult.source === 'kept' });
  const after = summarize(db);

  if (!keepBackup && movedAside) fs.rmSync(backup, { force: true });
  pruneBackups();
  const kept = stationResult.source === 'kept' ? `kept this station's DJ data (${stationResult.rows.dj_log ?? 0} plays)` : "took the upload's DJ data";
  log.info(`database restored (${info.mb} MB, ${after.tracks} tracks), ${kept}; previous database kept at ${movedAside && keepBackup ? backup : 'discarded'}`);
  return { restored: info, backup: movedAside && keepBackup ? path.basename(backup) : null, before, after, station_data: stationResult };
}

export function summarize(db) {
  const n = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
  return {
    tracks: n('SELECT COUNT(*) n FROM tracks WHERE removed_at IS NULL'),
    albums: n('SELECT COUNT(*) n FROM albums WHERE removed_at IS NULL'),
    artists: n('SELECT COUNT(*) n FROM artists WHERE removed_at IS NULL'),
    artists_researched: n("SELECT COUNT(*) n FROM research WHERE entity_type='artist' AND stage='done'"),
    albums_researched: n("SELECT COUNT(*) n FROM research WHERE entity_type='album' AND stage='done'"),
    embeddings: n('SELECT COUNT(*) n FROM embeddings'),
    saved_sets: n('SELECT COUNT(*) n FROM saved_sets'),
  };
}

// A consistent single-file copy of the live database, safe to take while the station is serving.
export function snapshot(dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });
  openDb().prepare('VACUUM INTO ?').run(dest);
  return statOf(dest);
}

// Each kept database is the size of the catalog, so on a small volume they add up fast. Keep the most recent few.
export function pruneBackups(keep = Number(process.env.RESTORE_KEEP_BACKUPS || 3)) {
  const extra = listBackups().slice(Math.max(0, keep));
  for (const b of extra) {
    fs.rmSync(path.join(backupsDir(), b.name), { force: true });
    log.info(`pruned old pre-restore database ${b.name}`);
  }
  return extra.map((b) => b.name);
}

export function listBackups() {
  try {
    return fs.readdirSync(backupsDir()).filter((f) => f.endsWith('.sqlite')).sort().reverse()
      .map((f) => ({ name: f, ...statOf(path.join(backupsDir(), f)) }));
  } catch { return []; }
}
