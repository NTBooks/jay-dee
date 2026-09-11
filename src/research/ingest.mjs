// Ingest research results (JSON files written by subagents or bulk mode) into the research table,
// and let research correct identity/year in the entity tables (tags never can).
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import { j, pj } from '../db/open.mjs';
import { validate } from './schema.mjs';
import { sha256, nowIso } from '../util/hash.mjs';
import { log } from '../util/log.mjs';

export function ingestResult(db, type, r, { model = 'claude-code', stage = 'done' } = {}) {
  const v = validate(type, r);
  if (!v.ok) return { ok: false, errors: v.errors };
  const x = v.value;
  const row = db.prepare('SELECT * FROM research WHERE entity_type = ? AND entity_id = ?').get(type, x.entity_id);
  if (!row) return { ok: false, errors: [`no research row for ${type} ${x.entity_id}`] };
  const now = nowIso();
  const extra = { ...pj(row.extra_json, {}), identity: x.identity || null, key_albums: x.key_albums, upstream: x.upstream, notable_tracks: x.notable_tracks, context: x.context, album_type: x.album_type,
    tempo_feel: x.tempo_feel, themes: x.themes, is_cover: x.is_cover, original_artist: x.original_artist, notable_reason: x.notable_reason, year: x.year, original_year: x.original_year };
  db.prepare(`UPDATE research SET stage=@stage, summary=@summary, blurb=@blurb, genres_json=@genres, moods_json=@moods, era=@era, origin=@origin, tags_json=@tags,
      active_from=@af, active_to=@at, energy=@energy, dj_hooks_json=@hooks, extra_json=@extra, confidence=@conf, model=@model, result_hash=@hash, sources_json=@sources, tier=@tier,
      needs_review=@review, updated_at=@now, batch_id=NULL, claimed_at=NULL, last_error=NULL
    WHERE entity_type=@type AND entity_id=@id`).run({
    stage, type, id: x.entity_id, summary: x.summary, blurb: x.blurb, genres: j(x.genres || []), moods: j(x.moods || []), era: x.era || null, origin: x.origin || null, tags: j(x.tags || []),
    af: x.active_from ?? null, at: x.active_to ?? null, energy: x.energy ?? null, hooks: j(x.dj_hooks), extra: j(extra), conf: x.confidence, model, hash: sha256(JSON.stringify(x)), tier: stage === 'draft' ? 'draft' : x.tier === 'light' ? 'light' : 'deep',
    sources: j(x.sources || []), review: x.identity && x.identity.confirmed === false ? 1 : 0, now,
  });
  applyToEntity(db, type, x, now, stage);
  db.prepare('INSERT INTO research_log(entity_type, entity_id, event, detail, at) VALUES (?,?,?,?,?)').run(type, x.entity_id, stage === 'draft' ? 'draft' : 'done', model, now);
  return { ok: true };
}

function applyToEntity(db, type, x, now, stage) {
  if (stage === 'draft') return; // drafts never override identification
  const id = x.entity_id;
  if (type === 'artist') {
    const a = db.prepare('SELECT mb_artist_id, resolution, genres_json FROM artists WHERE jellyfin_id = ?').get(id);
    if (!a) return;
    const newMb = x.identity?.mb_artist_id;
    if (x.identity?.confirmed && newMb && newMb !== a.mb_artist_id && x.confidence >= 0.7) {
      db.prepare("UPDATE artists SET mb_artist_id=?, resolution='claude_confirmed', resolution_confidence=?, resolution_note=?, resolved_at=? WHERE canonical_id=(SELECT canonical_id FROM artists WHERE jellyfin_id=?)")
        .run(newMb, x.confidence, `research: ${x.identity.note || 'identity corrected'}`.slice(0, 300), now, id);
    } else if (a.resolution === 'tag_only' && x.identity?.confirmed && x.confidence >= 0.7) {
      db.prepare("UPDATE artists SET mb_artist_id=COALESCE(?, mb_artist_id), resolution='claude_confirmed', resolution_confidence=?, resolution_note='research confirmed', resolved_at=? WHERE jellyfin_id=?").run(newMb || null, x.confidence, now, id);
    }
    // research genres win over MusicBrainz tag genres (they are curated for this library)
    if (x.genres?.length) db.prepare('UPDATE artists SET genres_json=? WHERE canonical_id=(SELECT canonical_id FROM artists WHERE jellyfin_id=?)').run(j(x.genres), id);
    if (x.active_from) db.prepare('UPDATE artists SET begin_year=COALESCE(begin_year, ?) WHERE jellyfin_id=?').run(x.active_from, id);
  } else if (type === 'album') {
    const al = db.prepare('SELECT year, resolution, mb_release_group_id FROM albums WHERE jellyfin_id = ?').get(id);
    if (!al) return;
    if (x.year && x.confidence >= 0.7 && (al.resolution === 'tag_only' || al.resolution === 'mb_match_low' || (al.year && Math.abs(al.year - x.year) > 0 && x.identity?.confirmed === false))) {
      db.prepare("UPDATE albums SET year=?, resolution=CASE WHEN resolution IN ('tag_only','mb_match_low') THEN 'claude_confirmed' ELSE resolution END, resolution_note=COALESCE(resolution_note,'')||' | research year', resolved_at=? WHERE jellyfin_id=?").run(x.year, now, id);
      db.prepare("UPDATE tracks SET album_year=?, original_year=CASE WHEN resolution IN ('tag_only') OR original_year IS NULL THEN ? ELSE original_year END WHERE album_id=?").run(x.year, x.year, id);
    }
    if (x.album_type && (al.resolution === 'tag_only')) db.prepare('UPDATE albums SET release_type=COALESCE(release_type, ?) WHERE jellyfin_id=?').run(x.album_type === 'studio' ? 'album' : x.album_type, id);
    if (x.genres?.length) db.prepare('UPDATE albums SET genres_json=? WHERE jellyfin_id=?').run(j(x.genres), id);
    if (x.identity?.mb_release_group_id && !al.mb_release_group_id) db.prepare('UPDATE albums SET mb_release_group_id=? WHERE jellyfin_id=?').run(x.identity.mb_release_group_id, id);
  } else if (type === 'track') {
    const t = db.prepare('SELECT original_year, resolution FROM tracks WHERE jellyfin_id = ?').get(id);
    if (!t) return;
    if (x.original_year && x.confidence >= 0.7 && (t.resolution === 'tag_only' || t.resolution === 'mb_match_low' || t.original_year == null)) {
      db.prepare("UPDATE tracks SET original_year=?, resolution=CASE WHEN resolution IN ('tag_only','mb_match_low') THEN 'claude_confirmed' ELSE resolution END, resolved_at=? WHERE jellyfin_id=?").run(x.original_year, now, id);
    }
    if (x.is_cover != null) db.prepare('UPDATE tracks SET is_cover=?, original_artist=? WHERE jellyfin_id=?').run(x.is_cover ? 1 : 0, x.original_artist || null, id);
    if (x.identity?.mb_recording_id && t.resolution === 'tag_only') db.prepare("UPDATE tracks SET mb_recording_id=?, resolution='claude_confirmed', resolved_at=? WHERE jellyfin_id=?").run(x.identity.mb_recording_id, now, id);
  }
}

// Ingest every *.json in a results dir. Valid files move to results/_ingested/<batch>/; invalid ones get a .error.txt beside them.
export function ingestDir(db, dir) {
  const batch = path.basename(dir);
  const type = batch.split('-')[0];
  if (!['artist', 'album', 'track'].includes(type)) throw new Error(`cannot infer entity type from batch name ${batch}`);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  const out = { batch, ok: 0, failed: 0, errors: [] };
  const doneDir = path.join(config.dataDir, 'results', '_ingested', batch);
  fs.mkdirSync(doneDir, { recursive: true });
  const bump = db.prepare("UPDATE research SET attempts = attempts + 1, last_error = ?, stage = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE stage END, updated_at = ? WHERE entity_type = ? AND entity_id = ?");
  for (const f of files) {
    const full = path.join(dir, f);
    let r;
    try { r = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^﻿/, '').trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); } catch (e) { out.failed++; out.errors.push(`${f}: invalid JSON`); fs.writeFileSync(full + '.error.txt', 'invalid JSON: ' + e.message); continue; }
    if (Array.isArray(r)) r = r[0];
    if (!r.entity_id) r.entity_id = f.replace(/\.json$/, '');
    const res = ingestResult(db, type, r);
    if (res.ok) {
      out.ok++;
      fs.renameSync(full, path.join(doneDir, f));
      if (fs.existsSync(full + '.error.txt')) fs.unlinkSync(full + '.error.txt');
    } else {
      out.failed++;
      out.errors.push(`${f}: ${res.errors.join('; ')}`);
      fs.writeFileSync(full + '.error.txt', res.errors.join('\n'));
      bump.run(res.errors.join('; ').slice(0, 300), nowIso(), type, r.entity_id);
    }
  }
  // remove the batch dir if empty
  try { if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* ignore */ }
  return out;
}

export function ingestAll(db) {
  const root = path.join(config.dataDir, 'results');
  const results = [];
  if (!fs.existsSync(root)) return results;
  for (const d of fs.readdirSync(root)) {
    if (d.startsWith('_')) continue;
    const full = path.join(root, d);
    if (!fs.statSync(full).isDirectory()) continue;
    const r = ingestDir(db, full);
    if (r.ok || r.failed) { results.push(r); log.info(`ingested ${d}: ok=${r.ok} failed=${r.failed}`); }
  }
  return results;
}
