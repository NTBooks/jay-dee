// Identification: attach MusicBrainz identities to albums, artists and tracks and fill the
// RESOLVED columns (year, original_year, names, types, genres). Tag values are only used as
// search hints and are validated against library evidence before being trusted.
import fs from 'node:fs';
import path from 'node:path';
import { mb, lucene, creditName, creditIds, yearOf, topGenres, releaseType, urlRels } from './sources/musicbrainz.mjs';
import { j, pj } from '../db/open.mjs';
import { nameKey, titleKey } from '../util/normalize.mjs';
import { nowIso } from '../util/hash.mjs';
import { safeErr } from '../util/http.mjs';
import { log } from '../util/log.mjs';
import { config } from '../config.mjs';
import { canonicalize, queueResearch } from '../jellyfin/sync.mjs';

const isTransient = (e) => e?.status === 503 || e?.status === 429 || e?.name === 'TimeoutError' || /fetch failed|ECONNRESET|socket/i.test(e?.message || '');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const CONF = { mbid_tag: 0.95, mb_match_high: 0.8, mb_match_low: 0.5, tag_only: 0 };

function discrepancy(db, type, id, field, tagValue, resolvedValue) {
  const t = tagValue == null ? null : String(tagValue);
  const r = resolvedValue == null ? null : String(resolvedValue);
  if (t == null || r == null || t === r) {
    db.prepare('DELETE FROM discrepancies WHERE entity_type=? AND entity_id=? AND field=?').run(type, id, field);
    return;
  }
  db.prepare('INSERT OR REPLACE INTO discrepancies(entity_type, entity_id, field, tag_value, resolved_value, detected_at) VALUES (?,?,?,?,?,?)').run(type, id, field, t, r, nowIso());
}

function tracklistFromRelease(rel) {
  const out = [];
  for (const m of rel.media || []) {
    for (const t of m.tracks || []) {
      const rec = t.recording || {};
      out.push({
        disc: m.position ?? 1, pos: t.position ?? null, number: t.number ?? null,
        title: t.title || rec.title || '', key: titleKey(t.title || rec.title || ''),
        length_s: (t.length || rec.length) ? Math.round((t.length || rec.length) / 1000) : null,
        recording_id: rec.id || null, first_release_date: rec['first-release-date'] || null,
        artist: creditName(rec['artist-credit'] || t['artist-credit']) || null,
        artist_ids: creditIds(rec['artist-credit'] || t['artist-credit']),
      });
    }
  }
  return out;
}

function overlapRatio(db, albumId, tracklist) {
  const libKeys = db.prepare('SELECT title_key FROM tracks WHERE album_id = ? AND removed_at IS NULL').all(albumId).map((r) => r.title_key);
  if (!libKeys.length || !tracklist.length) return 0;
  const mbKeys = new Set(tracklist.map((t) => t.key));
  const hit = libKeys.filter((k) => mbKeys.has(k)).length;
  return hit / libKeys.length;
}

function applyRelease(db, album, rel, resolution, note) {
  const rg = rel['release-group'] || {};
  const tracklist = tracklistFromRelease(rel);
  const overlap = overlapRatio(db, album.jellyfin_id, tracklist);
  let res = resolution;
  let n = note || '';
  if (overlap < 0.3 && tracklist.length) { res = 'mb_match_low'; n = `${n} low tracklist overlap ${(overlap * 100).toFixed(0)}%`.trim(); }
  const year = yearOf(rg['first-release-date']) ?? yearOf(rel.date);
  const genres = topGenres(rg).length ? topGenres(rg) : topGenres(rel);
  const trimmed = {
    id: rel.id, title: rel.title, date: rel.date, country: rel.country, status: rel.status,
    'artist-credit': (rel['artist-credit'] || []).map((c) => ({ name: c.name, joinphrase: c.joinphrase, id: c.artist?.id, artist: c.artist?.name })),
    'release-group': { id: rg.id, title: rg.title, 'first-release-date': rg['first-release-date'], 'primary-type': rg['primary-type'], 'secondary-types': rg['secondary-types'] },
    genres: topGenres(rg, 10), overlap,
  };
  db.prepare(`UPDATE albums SET mb_album_id=@mba, mb_release_group_id=@mbr, resolved_title=@rt, resolved_artist=@ra, year=@y, release_date=@rd, release_type=@rty,
    genres_json=@g, resolution=@res, resolution_confidence=@conf, resolution_note=@note, resolved_at=@now, mb_tracklist_json=@tl, mb_json=@mbj WHERE jellyfin_id=@id`)
    .run({ id: album.jellyfin_id, mba: rel.id, mbr: rg.id || null, rt: rel.title || rg.title || null, ra: creditName(rel['artist-credit']), y: year, rd: rg['first-release-date'] || rel.date || null,
      rty: releaseType(rg), g: genres.length ? j(genres) : null, res, conf: CONF[res] * (overlap >= 0.5 ? 1 : 0.8), note: n || null, now: nowIso(), tl: j(tracklist), mbj: j(trimmed) });
  discrepancy(db, 'album', album.jellyfin_id, 'year', album.tag_year, year);
  if (titleKey(album.tag_name) !== titleKey(rel.title || '')) discrepancy(db, 'album', album.jellyfin_id, 'title', album.tag_name, rel.title);
  else discrepancy(db, 'album', album.jellyfin_id, 'title', null, null);
  return { res, overlap, year, tracks: tracklist.length };
}

function markFailed(db, table, id, note) {
  db.prepare(`UPDATE ${table} SET resolution='tag_only', resolution_note=?, resolved_at=? WHERE jellyfin_id=?`).run(note.slice(0, 300), nowIso(), id);
}

// ---------------------------------------------------------------- albums
export async function identifyAlbums(db, { limit = 100000, retry = false, onProgress } = {}) {
  const where = retry ? "a.removed_at IS NULL AND a.resolution = 'tag_only'" : 'a.removed_at IS NULL AND a.resolved_at IS NULL';
  const rows = db.prepare(`SELECT a.*, ar.tag_name AS artist_name, ar.mb_artist_id AS artist_mbid FROM albums a LEFT JOIN artists ar ON ar.jellyfin_id = a.album_artist_id
    WHERE ${where} ORDER BY (a.mb_album_id IS NOT NULL) DESC, a.track_count DESC LIMIT ?`).all(limit);
  const counts = { done: 0, mbid_tag: 0, mb_match_high: 0, mb_match_low: 0, tag_only: 0, errors: 0 };
  for (const album of rows) {
    try {
      let result = null;
      if (album.mb_album_id) {
        const rel = await mb.release(album.mb_album_id);
        if (rel) result = applyRelease(db, album, rel, 'mbid_tag', '');
        else markFailed(db, 'albums', album.jellyfin_id, 'tag MBID not found in MusicBrainz');
      }
      if (!result && album.mb_release_group_id) {
        const rg = await mb.releaseGroup(album.mb_release_group_id);
        const rel = pickRelease(rg?.releases || [], album.track_count);
        if (rel) { const full = await mb.release(rel.id); if (full) result = applyRelease(db, album, full, 'mbid_tag', 'via release-group MBID'); }
      }
      if (!result) {
        // search: title + artist (+ track count hint)
        const artist = album.artist_name && !album.is_compilation ? album.artist_name : null;
        const q = [`release:"${lucene(album.tag_name)}"`, artist ? `artist:"${lucene(artist)}"` : null].filter(Boolean).join(' AND ');
        const sr = await mb.searchRelease(q, 8);
        const cand = pickSearchRelease(sr?.releases || [], album);
        if (cand) {
          const full = await mb.release(cand.id);
          if (full) result = applyRelease(db, album, full, cand.score >= 90 ? 'mb_match_high' : 'mb_match_low', `search score ${cand.score}`);
        }
        if (!result) markFailed(db, 'albums', album.jellyfin_id, `no MusicBrainz match (search: ${q.slice(0, 120)})`);
      }
      if (result) counts[result.res]++; else counts.tag_only++;
      counts.done++;
      if (onProgress) onProgress(counts, album, result);
    } catch (e) {
      counts.errors++;
      log.warn(`album ${album.tag_name}: ${safeErr(e)}`);
      if (isTransient(e)) { db.prepare('UPDATE albums SET resolution_note=? WHERE jellyfin_id=?').run(`transient: ${safeErr(e).slice(0, 80)}`, album.jellyfin_id); await pause(15000); }
      else markFailed(db, 'albums', album.jellyfin_id, `error: ${safeErr(e)}`);
    }
  }
  return counts;
}

function pickRelease(releases, trackCountHint) {
  if (!releases.length) return null;
  const official = releases.filter((r) => !r.status || r.status === 'Official');
  const pool = official.length ? official : releases;
  return pool.slice().sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))[0];
}

function pickSearchRelease(releases, album) {
  const wantKey = titleKey(album.tag_name);
  const artistKey = album.artist_name ? nameKey(album.artist_name) : null;
  const scored = releases.map((r) => {
    let s = r.score || 0;
    if (titleKey(r.title) !== wantKey) s -= 25;
    const rArtist = creditName(r['artist-credit']);
    if (artistKey && rArtist && nameKey(rArtist) !== artistKey) s -= 20;
    const tc = (r.media || []).reduce((n, m) => n + (m['track-count'] || 0), 0);
    if (tc && album.track_count && tc !== album.track_count) s -= Math.min(15, Math.abs(tc - album.track_count) * 3);
    if (r.status && r.status !== 'Official') s -= 10;
    return { ...r, score: s };
  }).sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score >= 70 ? scored[0] : null;
}

// ---------------------------------------------------------------- artists
export async function identifyArtists(db, { limit = 100000, retry = false, onProgress } = {}) {
  const where = retry ? "removed_at IS NULL AND resolution = 'tag_only'" : 'removed_at IS NULL AND resolved_at IS NULL';
  const rows = db.prepare(`SELECT * FROM artists WHERE ${where} AND is_compilation = 0 AND canonical_id = jellyfin_id ORDER BY is_album_artist DESC, track_count DESC LIMIT ?`).all(limit);
  const counts = { done: 0, mbid_tag: 0, mb_match_high: 0, mb_match_low: 0, tag_only: 0, errors: 0 };
  const creditVotes = db.prepare(`SELECT al.mb_json FROM albums al WHERE al.album_artist_id IN (SELECT jellyfin_id FROM artists WHERE canonical_id = ?) AND al.mb_json IS NOT NULL`);
  for (const a of rows) {
    try {
      // evidence: MBIDs credited on this artist's identified albums (majority vote)
      const votes = new Map();
      for (const r of creditVotes.all(a.jellyfin_id)) {
        const mj = pj(r.mb_json, {});
        if ((mj.overlap ?? 1) < 0.3) continue;
        const ids = (mj['artist-credit'] || []).map((c) => c.id).filter(Boolean);
        if (ids.length === 1) votes.set(ids[0], (votes.get(ids[0]) || 0) + 1);
      }
      const evidence = [...votes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
      let mbid = null, res = 'tag_only', note = '';
      if (a.mb_artist_id && (!evidence || evidence === a.mb_artist_id)) { mbid = a.mb_artist_id; res = 'mbid_tag'; }
      else if (evidence) { mbid = evidence; res = 'mb_match_high'; note = a.mb_artist_id ? `tag MBID ${a.mb_artist_id} conflicted with album credits` : 'from album credits'; }
      else {
        const sr = await mb.searchArtist(a.tag_name, 5);
        const cand = pickSearchArtist(sr?.artists || [], a);
        if (cand) { mbid = cand.id; res = cand.score >= 95 ? 'mb_match_high' : 'mb_match_low'; note = `search score ${cand.score}${cand.disambiguation ? ` (${cand.disambiguation})` : ''}`; }
      }
      if (!mbid) { markFailed(db, 'artists', a.jellyfin_id, 'no MusicBrainz match'); counts.tag_only++; counts.done++; continue; }
      const art = await mb.artist(mbid);
      if (!art) { markFailed(db, 'artists', a.jellyfin_id, `MBID ${mbid} not found`); counts.tag_only++; counts.done++; continue; }
      const rels = urlRels(art);
      const genres = topGenres(art);
      const trimmed = { id: art.id, name: art.name, 'sort-name': art['sort-name'], type: art.type, country: art.country, area: art.area?.name, 'begin-area': art['begin-area']?.name,
        'life-span': art['life-span'], disambiguation: art.disambiguation, genres: topGenres(art, 12), tags: (art.tags || []).slice(0, 15).map((t) => t.name), urls: rels,
        aliases: (art.aliases || []).slice(0, 10).map((x) => x.name) };
      db.prepare(`UPDATE artists SET mb_artist_id=@mbid, resolved_name=@rn, resolved_sort_name=@rs, artist_type=@t, country=@c, begin_year=@by, end_year=@ey, genres_json=@g,
        image_url_ext=COALESCE(image_url_ext, @img), resolution=@res, resolution_confidence=@conf, resolution_note=@note, resolved_at=@now, mb_json=@mbj WHERE jellyfin_id=@id`)
        .run({ id: a.jellyfin_id, mbid, rn: art.name, rs: art['sort-name'], t: art.type || null, c: art.country || art.area?.name || null,
          by: yearOf(art['life-span']?.begin), ey: yearOf(art['life-span']?.end), g: genres.length ? j(genres) : null, img: rels.image || null,
          res, conf: CONF[res], note: note || null, now: nowIso(), mbj: j(trimmed) });
      // propagate to merged variants
      db.prepare(`UPDATE artists SET mb_artist_id=@mbid, resolved_name=@rn, genres_json=@g, resolution=@res, resolution_confidence=@conf, resolution_note='via canonical', resolved_at=@now WHERE canonical_id=@id AND jellyfin_id<>@id`)
        .run({ id: a.jellyfin_id, mbid, rn: art.name, g: genres.length ? j(genres) : null, res, conf: CONF[res], now: nowIso() });
      if (nameKey(a.tag_name) !== nameKey(art.name)) discrepancy(db, 'artist', a.jellyfin_id, 'name', a.tag_name, art.name);
      const tg = pj(a.tag_genres_json, []);
      if (tg.length && genres.length && !tg.some((x) => genres.map(nameKey).includes(nameKey(x)))) discrepancy(db, 'artist', a.jellyfin_id, 'genres', tg.join(', '), genres.join(', '));
      counts[res]++; counts.done++;
      if (onProgress) onProgress(counts, a, { res, mbid });
    } catch (e) {
      counts.errors++;
      log.warn(`artist ${a.tag_name}: ${safeErr(e)}`);
      if (isTransient(e)) { db.prepare('UPDATE artists SET resolution_note=? WHERE jellyfin_id=?').run(`transient: ${safeErr(e).slice(0, 80)}`, a.jellyfin_id); await pause(15000); }
      else markFailed(db, 'artists', a.jellyfin_id, `error: ${safeErr(e)}`);
    }
  }
  // corrected MBIDs may merge previously separate artists (P!nk / Pink)
  canonicalize(db);
  queueResearch(db);
  return counts;
}

function pickSearchArtist(artists, a) {
  const key = nameKey(a.tag_name);
  const scored = artists.map((x) => {
    let s = x.score || 0;
    const exact = nameKey(x.name) === key || (x.aliases || []).some((al) => nameKey(al.name) === key);
    if (!exact) s -= 30;
    return { ...x, score: s };
  }).sort((x, y) => y.score - x.score);
  const top = scored[0];
  if (!top || top.score < 85) return null;
  // ambiguity: two exact-name candidates with near-equal score -> low confidence
  if (scored[1] && nameKey(scored[1].name) === key && scored[1].score >= top.score - 5) return { ...top, score: Math.min(top.score, 90) };
  return top;
}

// ---------------------------------------------------------------- tracks (local matching against stored tracklists)
export function identifyTracksLocal(db, { limit = 1000000 } = {}) {
  const albums = db.prepare(`SELECT jellyfin_id, year, mb_tracklist_json, resolution, resolved_artist FROM albums WHERE removed_at IS NULL AND mb_tracklist_json IS NOT NULL
    AND jellyfin_id IN (SELECT DISTINCT album_id FROM tracks WHERE removed_at IS NULL AND resolved_at IS NULL) LIMIT ?`).all(limit);
  const getTracks = db.prepare('SELECT * FROM tracks WHERE album_id = ? AND removed_at IS NULL AND resolved_at IS NULL');
  const upd = db.prepare(`UPDATE tracks SET mb_recording_id=@rec, resolved_title=@rt, resolved_artist=@ra, original_year=@oy, original_date=@od, album_year=@ay,
    resolution=@res, resolution_confidence=@conf, resolution_note=@note, resolved_at=@now WHERE jellyfin_id=@id`);
  const counts = { matched: 0, unmatched: 0, albums: albums.length };
  const tx = db.transaction(() => {
    for (const al of albums) {
      const tl = pj(al.mb_tracklist_json, []);
      const byPos = new Map(tl.map((t) => [`${t.disc}-${t.pos}`, t]));
      const byKey = new Map();
      for (const t of tl) { if (!byKey.has(t.key)) byKey.set(t.key, []); byKey.get(t.key).push(t); }
      const byRec = new Map(tl.filter((t) => t.recording_id).map((t) => [t.recording_id, t]));
      const used = new Set();
      for (const tr of getTracks.all(al.jellyfin_id)) {
        let m = null, how = null, conf = 0;
        const posHit = byPos.get(`${tr.disc_no || 1}-${tr.track_no}`);
        const recHit = tr.tag_mb_recording_id ? byRec.get(tr.tag_mb_recording_id) : null;
        if (recHit && (recHit.key === tr.title_key || recHit === posHit)) { m = recHit; how = 'tag recording id confirmed'; conf = 0.97; }
        else if (posHit && posHit.key === tr.title_key) { m = posHit; how = 'position+title'; conf = 0.95; }
        else if (byKey.get(tr.title_key)?.length) {
          const cands = byKey.get(tr.title_key).filter((x) => !used.has(x.recording_id));
          m = cands.sort((x, y) => Math.abs((x.length_s || 0) - (tr.duration_s || 0)) - Math.abs((y.length_s || 0) - (tr.duration_s || 0)))[0] || byKey.get(tr.title_key)[0];
          how = 'title'; conf = 0.85;
        } else if (posHit && tr.duration_s && posHit.length_s && Math.abs(posHit.length_s - tr.duration_s) <= 3) { m = posHit; how = 'position+duration'; conf = 0.7; }
        else if (posHit && tl.length === (al.track_count || tl.length) && !tr.title_key) { m = posHit; how = 'position'; conf = 0.5; }
        if (m && m.recording_id) {
          used.add(m.recording_id);
          const res = conf >= 0.7 ? (al.resolution === 'mbid_tag' ? 'mbid_tag' : 'mb_match_high') : 'mb_match_low';
          upd.run({ id: tr.jellyfin_id, rec: m.recording_id, rt: m.title, ra: m.artist || al.resolved_artist, oy: yearOf(m.first_release_date) ?? al.year, od: m.first_release_date || null,
            ay: al.year, res, conf: Math.min(conf, CONF[al.resolution] || 0.5), note: `tracklist match: ${how}`, now: nowIso() });
          discrepancy(db, 'track', tr.jellyfin_id, 'year', tr.tag_year, yearOf(m.first_release_date) ?? al.year);
          if (tr.title_key !== m.key) discrepancy(db, 'track', tr.jellyfin_id, 'title', tr.tag_title, m.title);
          counts.matched++;
        } else {
          db.prepare(`UPDATE tracks SET album_year=?, resolution='tag_only', resolution_note='no tracklist match', resolved_at=? WHERE jellyfin_id=?`).run(al.year, nowIso(), tr.jellyfin_id);
          counts.unmatched++;
        }
      }
    }
  });
  tx();
  cascadeGenres(db);
  return counts;
}

// Per-track MusicBrainz recording search for tracks that could not be matched locally (rate limited; long pass).
export async function identifyTracksSearch(db, { limit = 200, onProgress } = {}) {
  const rows = db.prepare(`SELECT t.*, COALESCE(ar.resolved_name, ar.tag_name) AS artist_name, ar.mb_artist_id AS artist_mbid FROM tracks t
    LEFT JOIN artists ar ON ar.jellyfin_id = t.album_artist_id
    WHERE t.removed_at IS NULL AND t.mb_recording_id IS NULL AND (t.resolution_note IS NULL OR t.resolution_note NOT LIKE 'search:%')
    ORDER BY (ar.is_album_artist IS NOT NULL) DESC, ar.track_count DESC LIMIT ?`).all(limit);
  const counts = { done: 0, matched: 0, unmatched: 0, errors: 0 };
  for (const tr of rows) {
    try {
      const firstArtist = pj(tr.tag_artists_json, [])[0] || tr.artist_name;
      if (!firstArtist || !tr.tag_title) { db.prepare("UPDATE tracks SET resolution_note='search: no artist/title', resolved_at=? WHERE jellyfin_id=?").run(nowIso(), tr.jellyfin_id); counts.unmatched++; counts.done++; continue; }
      const q = tr.artist_mbid ? `recording:"${lucene(tr.tag_title)}" AND arid:${tr.artist_mbid}` : `recording:"${lucene(tr.tag_title)}" AND artist:"${lucene(firstArtist)}"`;
      const sr = await mb.searchRecording(q, 8);
      const key = tr.title_key;
      const cands = (sr?.recordings || []).map((r) => {
        let s = r.score || 0;
        if (titleKey(r.title) !== key) s -= 30;
        if (r.length && tr.duration_s && Math.abs(r.length / 1000 - tr.duration_s) > 5) s -= 15;
        if (r.video) s -= 50;
        return { ...r, score: s };
      }).sort((a, b) => b.score - a.score);
      const top = cands[0];
      if (top && top.score >= 80) {
        // earliest release date across releases attached to the search hit
        const dates = (top.releases || []).map((r) => r.date).filter(Boolean).sort();
        const fr = top['first-release-date'] || dates[0] || null;
        const res = top.score >= 95 ? 'mb_match_high' : 'mb_match_low';
        db.prepare(`UPDATE tracks SET mb_recording_id=@rec, resolved_title=@rt, resolved_artist=@ra, original_year=@oy, original_date=@od, resolution=@res, resolution_confidence=@conf,
          resolution_note=@note, resolved_at=@now WHERE jellyfin_id=@id`)
          .run({ id: tr.jellyfin_id, rec: top.id, rt: top.title, ra: creditName(top['artist-credit']), oy: yearOf(fr), od: fr, res, conf: res === 'mb_match_high' ? 0.75 : 0.5, note: `search: score ${top.score}`, now: nowIso() });
        discrepancy(db, 'track', tr.jellyfin_id, 'year', tr.tag_year, yearOf(fr));
        counts.matched++;
      } else {
        db.prepare("UPDATE tracks SET resolution_note='search: no match', resolved_at=? WHERE jellyfin_id=?").run(nowIso(), tr.jellyfin_id);
        counts.unmatched++;
      }
      counts.done++;
      if (onProgress) onProgress(counts, tr);
    } catch (e) {
      counts.errors++;
      log.warn(`track ${tr.tag_title}: ${safeErr(e)}`);
      if (isTransient(e)) { db.prepare('UPDATE tracks SET resolution_note=? WHERE jellyfin_id=?').run(`transient: ${safeErr(e).slice(0, 80)}`, tr.jellyfin_id); await pause(15000); }
      else db.prepare("UPDATE tracks SET resolution_note=?, resolved_at=? WHERE jellyfin_id=?").run(`search: error ${safeErr(e).slice(0, 100)}`, nowIso(), tr.jellyfin_id);
    }
  }
  cascadeGenres(db);
  return counts;
}

// Albums without resolved genres inherit their artist's; tracks inherit album then artist. Never ID3 genres.
export function cascadeGenres(db) {
  db.exec(`
    UPDATE albums SET genres_json = (SELECT ar.genres_json FROM artists ar WHERE ar.jellyfin_id = albums.album_artist_id)
      WHERE genres_json IS NULL AND album_artist_id IS NOT NULL;
    UPDATE tracks SET genres_json = COALESCE(
        (SELECT al.genres_json FROM albums al WHERE al.jellyfin_id = tracks.album_id),
        (SELECT ar.genres_json FROM artists ar WHERE ar.jellyfin_id = tracks.album_artist_id))
      WHERE genres_json IS NULL;
    UPDATE tracks SET album_year = (SELECT al.year FROM albums al WHERE al.jellyfin_id = tracks.album_id) WHERE album_year IS NULL;
    UPDATE tracks SET original_year = album_year WHERE original_year IS NULL AND album_year IS NOT NULL AND resolution <> 'tag_only';
  `);
}

// ---------------------------------------------------------------- status + report
export function identifyStatus(db) {
  const q = (t) => db.prepare(`SELECT resolution, COUNT(*) n FROM ${t} WHERE removed_at IS NULL GROUP BY resolution`).all();
  const pending = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE removed_at IS NULL AND resolved_at IS NULL`).get().n;
  return {
    artists: { byResolution: q('artists'), unprocessed: pending('artists') },
    albums: { byResolution: q('albums'), unprocessed: pending('albums') },
    tracks: { byResolution: q('tracks'), unprocessed: pending('tracks'), withRecording: db.prepare('SELECT COUNT(*) n FROM tracks WHERE removed_at IS NULL AND mb_recording_id IS NOT NULL').get().n,
      withOriginalYear: db.prepare('SELECT COUNT(*) n FROM tracks WHERE removed_at IS NULL AND original_year IS NOT NULL').get().n },
    discrepancies: db.prepare('SELECT entity_type, field, COUNT(*) n FROM discrepancies GROUP BY entity_type, field').all(),
  };
}

export function writeReport(db) {
  const s = identifyStatus(db);
  const lines = ['# Tag discrepancy report', '', `Generated ${nowIso()}`, ''];
  lines.push('## Resolution coverage', '');
  for (const t of ['artists', 'albums', 'tracks']) lines.push(`- **${t}**: ` + s[t].byResolution.map((r) => `${r.resolution}=${r.n}`).join(', ') + ` (unprocessed ${s[t].unprocessed})`);
  lines.push('', '## Discrepancy counts (tag value vs resolved value)', '');
  for (const d of s.discrepancies) lines.push(`- ${d.entity_type}.${d.field}: ${d.n}`);
  const yearDelta = db.prepare(`SELECT ABS(CAST(tag_value AS INT) - CAST(resolved_value AS INT)) d, COUNT(*) n FROM discrepancies WHERE entity_type='track' AND field='year' GROUP BY d ORDER BY n DESC LIMIT 12`).all();
  lines.push('', '## Track year error distribution (|tag - resolved| years)', '');
  for (const r of yearDelta) lines.push(`- off by ${r.d}: ${r.n}`);
  const worst = db.prepare(`SELECT COALESCE(ar.resolved_name, ar.tag_name) artist, COUNT(*) n FROM discrepancies d JOIN tracks t ON t.jellyfin_id = d.entity_id LEFT JOIN artists ar ON ar.jellyfin_id = t.album_artist_id
    WHERE d.entity_type='track' AND d.field='year' GROUP BY artist ORDER BY n DESC LIMIT 25`).all();
  lines.push('', '## Artists with the most wrong track years', '');
  for (const r of worst) lines.push(`- ${r.artist}: ${r.n}`);
  const genres = db.prepare(`SELECT COALESCE(ar.resolved_name, ar.tag_name) artist, d.tag_value, d.resolved_value FROM discrepancies d JOIN artists ar ON ar.jellyfin_id = d.entity_id WHERE d.entity_type='artist' AND d.field='genres' ORDER BY ar.track_count DESC LIMIT 40`).all();
  lines.push('', '## Artist genre disagreements (tag -> MusicBrainz)', '');
  for (const r of genres) lines.push(`- ${r.artist}: "${r.tag_value}" -> "${r.resolved_value}"`);
  const unresolved = db.prepare(`SELECT tag_name, track_count, resolution_note FROM artists WHERE removed_at IS NULL AND resolution='tag_only' AND is_compilation=0 AND canonical_id=jellyfin_id ORDER BY track_count DESC LIMIT 40`).all();
  lines.push('', '## Unresolved artists (top by track count)', '');
  for (const r of unresolved) lines.push(`- ${r.tag_name} (${r.track_count}): ${r.resolution_note || ''}`);
  const unresolvedAlbums = db.prepare(`SELECT a.tag_name, a.tag_album_artist_name, a.track_count, a.resolution_note FROM albums a WHERE a.removed_at IS NULL AND a.resolution='tag_only' ORDER BY a.track_count DESC LIMIT 40`).all();
  lines.push('', '## Unresolved albums (top by track count)', '');
  for (const r of unresolvedAlbums) lines.push(`- ${r.tag_album_artist_name} - ${r.tag_name} (${r.track_count}): ${r.resolution_note || ''}`);
  const out = path.join(config.dataDir, 'reports', 'discrepancies.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  return out;
}
