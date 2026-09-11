// Research queue: claim, release, status. All state in the `research` table.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import { nowIso } from '../util/hash.mjs';

const STALE_HOURS = 24;

export function batchId(type) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = `${type}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  // two claims in the same second (deep + light back to back) must not share a batch id
  let id = base;
  for (let i = 0; fs.existsSync(path.join(config.dataDir, 'packets', id + '.json')) || fs.existsSync(path.join(config.dataDir, 'results', id)); i++) id = `${base}${String.fromCharCode(98 + i)}`;
  return id;
}

export function nextPending(db, type, n, { ids, tier, upgradeDrafts = false, minTracks, maxTracks } = {}) {
  if (ids?.length) {
    const marks = ids.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM research WHERE entity_type = ? AND entity_id IN (${marks})`).all(type, ...ids);
  }
  const staleCut = new Date(Date.now() - STALE_HOURS * 3600_000).toISOString();
  const stages = upgradeDrafts ? "('pending','draft')" : "('pending')";
  // artist track-count window (deep tier = big acts, light tier = the long tail); canonical rows carry the count
  const sizeSql = type === 'artist' && (minTracks != null || maxTracks != null)
    ? ` AND COALESCE((SELECT track_count FROM artists a WHERE a.jellyfin_id = research.entity_id), 0) BETWEEN ${Number(minTracks ?? 0)} AND ${Number(maxTracks ?? 1e9)}` : '';
  const sql = `SELECT * FROM research WHERE entity_type = ? AND stage IN ${stages} ${tier ? 'AND tier = ?' : ''}${sizeSql}
    AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY priority DESC, entity_id LIMIT ?`;
  return db.prepare(sql).all(...(tier ? [type, tier, staleCut, n] : [type, staleCut, n]));
}

export function claim(db, type, entityIds, batch) {
  const now = nowIso();
  const st = db.prepare("UPDATE research SET stage = CASE WHEN stage = 'draft' THEN 'draft' ELSE 'packet' END, batch_id = ?, claimed_at = ? WHERE entity_type = ? AND entity_id = ?");
  const tx = db.transaction(() => { for (const id of entityIds) st.run(batch, now, type, id); });
  tx();
}

export function resetStale(db) {
  const staleCut = new Date(Date.now() - STALE_HOURS * 3600_000).toISOString();
  return db.prepare("UPDATE research SET stage = 'pending', batch_id = NULL, claimed_at = NULL WHERE stage = 'packet' AND claimed_at < ?").run(staleCut).changes;
}

export function retryFailed(db, maxAttempts = 3) {
  return db.prepare("UPDATE research SET stage = 'pending', batch_id = NULL, claimed_at = NULL WHERE stage = 'failed' AND attempts < ?").run(maxAttempts).changes;
}

export function skip(db, type, id, reason) {
  return db.prepare("UPDATE research SET stage = 'skipped', last_error = ?, updated_at = ? WHERE entity_type = ? AND entity_id = ?").run(reason, nowIso(), type, id).changes;
}

export function status(db) {
  const rows = db.prepare('SELECT entity_type, stage, COUNT(*) n FROM research GROUP BY entity_type, stage').all();
  const byType = {};
  for (const r of rows) { byType[r.entity_type] ??= {}; byType[r.entity_type][r.stage] = r.n; }
  const tiers = db.prepare("SELECT entity_type, tier, stage, COUNT(*) n FROM research WHERE entity_type='track' GROUP BY entity_type, tier, stage").all();
  const openBatches = db.prepare("SELECT batch_id, entity_type, COUNT(*) n, MIN(claimed_at) claimed_at FROM research WHERE stage = 'packet' AND batch_id IS NOT NULL GROUP BY batch_id ORDER BY claimed_at").all();
  const resultsDir = path.join(config.dataDir, 'results');
  const pendingResultDirs = [];
  if (fs.existsSync(resultsDir)) {
    for (const d of fs.readdirSync(resultsDir)) {
      if (d.startsWith('_')) continue;
      const full = path.join(resultsDir, d);
      if (!fs.statSync(full).isDirectory()) continue;
      const files = fs.readdirSync(full).filter((f) => f.endsWith('.json'));
      if (files.length) pendingResultDirs.push({ batch: d, files: files.length });
    }
  }
  const next = {};
  for (const t of ['artist', 'album', 'track']) {
    next[t] = db.prepare(`SELECT r.entity_id, r.tier, r.priority,
        CASE r.entity_type WHEN 'artist' THEN (SELECT COALESCE(resolved_name, tag_name) FROM artists WHERE jellyfin_id = r.entity_id)
                           WHEN 'album' THEN (SELECT COALESCE(resolved_title, tag_name) FROM albums WHERE jellyfin_id = r.entity_id)
                           ELSE (SELECT COALESCE(resolved_title, tag_title) FROM tracks WHERE jellyfin_id = r.entity_id) END AS name
      FROM research r WHERE r.entity_type = ? AND r.stage = 'pending' ORDER BY r.priority DESC LIMIT 5`).all(t);
  }
  return { byType, tiers, openBatches, pendingResultDirs, next };
}
