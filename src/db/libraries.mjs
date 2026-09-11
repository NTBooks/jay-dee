// Jellyfin libraries ("virtual folders") as a dynamic include/exclude config. Jellyfin is the source of truth
// for WHICH libraries exist (sync upserts them, new ones default to included); this table only holds the choice.
import { nowIso } from '../util/hash.mjs';

export function upsertLibraries(db, folders, runId) {
  const up = db.prepare(`INSERT INTO libraries(id, name, collection_type, locations_json, last_seen_run, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, collection_type=excluded.collection_type, locations_json=excluded.locations_json, last_seen_run=excluded.last_seen_run, updated_at=excluded.updated_at`);
  const tx = db.transaction(() => {
    for (const f of folders) up.run(f.ItemId, f.Name, f.CollectionType || null, JSON.stringify(f.Locations || []), runId, nowIso());
  });
  tx();
}

export function listLibraries(db) {
  return db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM tracks t WHERE t.library_id = l.id AND t.removed_at IS NULL) track_count FROM libraries l ORDER BY l.name`).all();
}

// Library ids allowed right now: included, and if only_months is set (e.g. "11,12"), the current month is in it.
export function allowedLibraryIds(db, date = new Date()) {
  const month = date.getMonth() + 1;
  return listLibraries(db).filter((l) => l.included && (!l.only_months || l.only_months.split(',').map((m) => Number(m.trim())).includes(month))).map((l) => l.id);
}

// SQL fragment for track/album filters: "<alias>.library_id IN (...)" (or a no-op if nothing is allowed, which excludes everything).
export function libraryFilterSql(db, alias = 't') {
  const ids = allowedLibraryIds(db);
  if (!ids.length) return `${alias}.library_id IS NULL AND 0`;
  return `(${alias}.library_id IS NULL OR ${alias}.library_id IN (${ids.map((i) => `'${i}'`).join(',')}))`;
}

export function setLibrary(db, name, patch) {
  const lib = db.prepare('SELECT * FROM libraries WHERE lower(name) = lower(?)').get(name);
  if (!lib) throw new Error(`no library named "${name}" (run npm run sync first; known: ${listLibraries(db).map((l) => l.name).join(', ')})`);
  if (patch.included != null) db.prepare('UPDATE libraries SET included = ?, updated_at = ? WHERE id = ?').run(patch.included ? 1 : 0, nowIso(), lib.id);
  if (patch.only_months !== undefined) db.prepare('UPDATE libraries SET only_months = ?, updated_at = ? WHERE id = ?').run(patch.only_months || null, nowIso(), lib.id);
  return db.prepare('SELECT * FROM libraries WHERE id = ?').get(lib.id);
}
