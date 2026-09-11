// Jellyfin -> SQLite sync. Writes ONLY tag_* columns, library facts, and MBIDs found in
// ProviderIds. Never touches resolved columns or research rows.
import fs from 'node:fs';
import path from 'node:path';
import { JellyfinClient, AUDIO_FIELDS, ALBUM_FIELDS, ARTIST_FIELDS } from './client.mjs';
import { j, pj } from '../db/open.mjs';
import { nameKey, titleKey, isCompilationArtist, isCollabName, ticksToSeconds } from '../util/normalize.mjs';
import { nowIso } from '../util/hash.mjs';
import { log } from '../util/log.mjs';
import { config } from '../config.mjs';
import { upsertLibraries } from '../db/libraries.mjs';

function nextRid(db, table) {
  return (db.prepare(`SELECT COALESCE(MAX(rid), 0) + 1 AS n FROM ${table}`).get().n);
}

function prov(item, key) {
  const p = item.ProviderIds || {};
  return p[key] || null;
}

export async function syncAll(db, { dryRun = false, noRemovals = false } = {}) {
  const jf = new JellyfinClient();
  const started = nowIso();
  const runId = dryRun ? 0 : db.prepare('INSERT INTO sync_runs(started_at, status) VALUES (?, ?)').run(started, 'running').lastInsertRowid;
  const stats = { added_artists: 0, added_albums: 0, added_tracks: 0, updated_tracks: 0, removed_artists: 0, removed_albums: 0, removed_tracks: 0, carried_over: 0 };
  const totals = {};
  const seen = { artists: new Set(), albums: new Set(), tracks: new Set() };
  const notes = [];

  const upArtist = db.prepare(`
    INSERT INTO artists (jellyfin_id, rid, tag_name, tag_sort_name, tag_genres_json, overview, name_key,
      mb_artist_id, image_tag, backdrop_tags_json, path, is_compilation, is_collab, raw_json, first_seen_run, last_seen_run, removed_at, updated_at)
    VALUES (@id, @rid, @name, @sort, @genres, @overview, @key, @mbid, @image, @backdrops, @path, @comp, @collab, @raw, @run, @run, NULL, @now)
    ON CONFLICT(jellyfin_id) DO UPDATE SET
      tag_name=excluded.tag_name, tag_sort_name=excluded.tag_sort_name, tag_genres_json=excluded.tag_genres_json,
      overview=excluded.overview, name_key=excluded.name_key,
      mb_artist_id=COALESCE(artists.mb_artist_id, excluded.mb_artist_id),
      image_tag=excluded.image_tag, backdrop_tags_json=excluded.backdrop_tags_json, path=excluded.path,
      is_compilation=excluded.is_compilation, is_collab=excluded.is_collab, raw_json=excluded.raw_json,
      last_seen_run=excluded.last_seen_run, removed_at=NULL, updated_at=excluded.updated_at`);

  const upAlbum = db.prepare(`
    INSERT INTO albums (jellyfin_id, rid, tag_name, tag_year, tag_premiere_date, tag_genres_json, tag_album_artist_name, overview, title_key,
      album_artist_id, library_id, mb_album_id, mb_release_group_id, is_compilation, track_count, runtime_ticks, image_tag, path, raw_json, first_seen_run, last_seen_run, removed_at, updated_at)
    VALUES (@id, @rid, @name, @year, @premiere, @genres, @aaName, @overview, @key, @aaId, @lib, @mbAlbum, @mbRg, @comp, @childCount, @runtime, @image, @path, @raw, @run, @run, NULL, @now)
    ON CONFLICT(jellyfin_id) DO UPDATE SET
      tag_name=excluded.tag_name, tag_year=excluded.tag_year, tag_premiere_date=excluded.tag_premiere_date, tag_genres_json=excluded.tag_genres_json,
      tag_album_artist_name=excluded.tag_album_artist_name, overview=excluded.overview, title_key=excluded.title_key, album_artist_id=excluded.album_artist_id, library_id=excluded.library_id,
      mb_album_id=COALESCE(albums.mb_album_id, excluded.mb_album_id), mb_release_group_id=COALESCE(albums.mb_release_group_id, excluded.mb_release_group_id),
      is_compilation=excluded.is_compilation, track_count=excluded.track_count, runtime_ticks=excluded.runtime_ticks, image_tag=excluded.image_tag, path=excluded.path,
      raw_json=excluded.raw_json, last_seen_run=excluded.last_seen_run, removed_at=NULL, updated_at=excluded.updated_at`);

  const upTrack = db.prepare(`
    INSERT INTO tracks (jellyfin_id, rid, tag_title, tag_album, tag_artists_json, tag_album_artist, tag_year, tag_premiere_date, tag_genres_json, tag_mb_recording_id, title_key,
      album_id, album_artist_id, library_id, disc_no, track_no, runtime_ticks, duration_s, container, path, normalization_gain, has_lyrics, date_created, image_tag,
      raw_json, first_seen_run, last_seen_run, removed_at, updated_at)
    VALUES (@id, @rid, @title, @album, @artists, @albumArtist, @year, @premiere, @genres, @mbRec, @key, @albumId, @aaId, @lib, @disc, @trackNo, @runtime, @dur, @container, @path, @gain, @lyrics, @created, @image,
      @raw, @run, @run, NULL, @now)
    ON CONFLICT(jellyfin_id) DO UPDATE SET
      tag_title=excluded.tag_title, tag_album=excluded.tag_album, tag_artists_json=excluded.tag_artists_json, tag_album_artist=excluded.tag_album_artist,
      tag_year=excluded.tag_year, tag_premiere_date=excluded.tag_premiere_date, tag_genres_json=excluded.tag_genres_json, title_key=excluded.title_key,
      tag_mb_recording_id=excluded.tag_mb_recording_id, album_id=excluded.album_id, album_artist_id=excluded.album_artist_id, library_id=excluded.library_id,
      disc_no=excluded.disc_no, track_no=excluded.track_no, runtime_ticks=excluded.runtime_ticks, duration_s=excluded.duration_s, container=excluded.container,
      path=excluded.path, normalization_gain=excluded.normalization_gain, has_lyrics=excluded.has_lyrics, date_created=excluded.date_created, image_tag=excluded.image_tag,
      raw_json=excluded.raw_json, last_seen_run=excluded.last_seen_run, removed_at=NULL, updated_at=excluded.updated_at`);

  const existsArtist = db.prepare('SELECT rid FROM artists WHERE jellyfin_id = ?');
  const existsAlbum = db.prepare('SELECT rid FROM albums WHERE jellyfin_id = ?');
  const existsTrack = db.prepare('SELECT rid, raw_json FROM tracks WHERE jellyfin_id = ?');
  const delTrackArtists = db.prepare('DELETE FROM track_artists WHERE track_id = ?');
  const insTrackArtist = db.prepare('INSERT OR IGNORE INTO track_artists(track_id, artist_id, position) VALUES (?, ?, ?)');

  const now = nowIso();

  // ---- libraries (Jellyfin is the source of truth for which exist; include/exclude choices live in the table) ----
  const libs = await jf.libraries();
  if (!dryRun) upsertLibraries(db, libs, runId);
  log.info(`libraries: ${libs.map((l) => l.Name).join(', ')}`);

  // ---- artists ----
  {
    let rid = nextRid(db, 'artists');
    for await (const page of jf.pageItems('MusicArtist', ARTIST_FIELDS)) {
      totals.artists = page.total;
      const tx = db.transaction((items) => {
        for (const it of items) {
          if (seen.artists.has(it.Id)) continue;
          seen.artists.add(it.Id);
          const ex = existsArtist.get(it.Id);
          if (!ex) stats.added_artists++;
          if (dryRun) continue;
          upArtist.run({
            id: it.Id, rid: ex ? ex.rid : rid++, name: it.Name || '', sort: it.SortName || null,
            genres: j(it.Genres || []), overview: it.Overview || null, key: nameKey(it.Name),
            mbid: prov(it, 'MusicBrainzArtist'), image: it.ImageTags?.Primary || null,
            backdrops: j(it.BackdropImageTags || []), path: it.Path || null,
            comp: isCompilationArtist(it.Name) ? 1 : 0, collab: isCollabName(it.Name) ? 1 : 0,
            raw: j(it), run: runId, now,
          });
        }
      });
      tx(page.items);
      log.info(`artists ${Math.min(page.startIndex + page.items.length, page.total)}/${page.total}`);
    }
  }

  // ---- albums ----
  {
    let rid = nextRid(db, 'albums');
    totals.albums = 0;
    for (const lib of libs) for await (const page of jf.pageItems('MusicAlbum', ALBUM_FIELDS, { parentId: lib.ItemId })) {
      if (page.startIndex === 0) totals.albums += page.total;
      const tx = db.transaction((items) => {
        for (const it of items) {
          if (seen.albums.has(it.Id)) continue;
          seen.albums.add(it.Id);
          const ex = existsAlbum.get(it.Id);
          if (!ex) stats.added_albums++;
          if (dryRun) continue;
          const aa = (it.AlbumArtists && it.AlbumArtists[0]) || null;
          upAlbum.run({
            id: it.Id, rid: ex ? ex.rid : rid++, name: it.Name || '', year: it.ProductionYear ?? null,
            premiere: it.PremiereDate || null, genres: j(it.Genres || []), aaName: aa ? aa.Name : (it.AlbumArtist || null),
            overview: it.Overview || null, key: titleKey(it.Name), aaId: aa ? aa.Id : null,
            mbAlbum: prov(it, 'MusicBrainzAlbum'), mbRg: prov(it, 'MusicBrainzReleaseGroup'),
            comp: aa ? (isCompilationArtist(aa.Name) ? 1 : 0) : 1,
            childCount: it.ChildCount ?? null, runtime: it.RunTimeTicks ?? null, image: it.ImageTags?.Primary || null,
            path: it.Path || null, raw: j(it), run: runId, now, lib: lib.ItemId,
          });
        }
      });
      tx(page.items);
      log.info(`albums [${lib.Name}] ${Math.min(page.startIndex + page.items.length, page.total)}/${page.total}`);
    }
  }

  // ---- tracks ----
  {
    let rid = nextRid(db, 'tracks');
    totals.tracks = 0;
    for (const lib of libs) for await (const page of jf.pageItems('Audio', AUDIO_FIELDS, { parentId: lib.ItemId })) {
      if (page.startIndex === 0) totals.tracks += page.total;
      const tx = db.transaction((items) => {
        for (const it of items) {
          if (seen.tracks.has(it.Id)) continue;
          seen.tracks.add(it.Id);
          const ex = existsTrack.get(it.Id);
          if (!ex) stats.added_tracks++;
          else if (ex.raw_json !== JSON.stringify(it)) stats.updated_tracks++;
          if (dryRun) continue;
          const aa = (it.AlbumArtists && it.AlbumArtists[0]) || null;
          upTrack.run({
            id: it.Id, rid: ex ? ex.rid : rid++, title: it.Name || '', album: it.Album || null,
            artists: j(it.Artists || []), albumArtist: it.AlbumArtist || (aa ? aa.Name : null),
            year: it.ProductionYear ?? null, premiere: it.PremiereDate || null, genres: j(it.Genres || []),
            key: titleKey(it.Name), albumId: it.AlbumId || null, aaId: aa ? aa.Id : null,
            mbRec: prov(it, 'MusicBrainzTrack') || prov(it, 'MusicBrainzRecording'),
            disc: it.ParentIndexNumber ?? null, trackNo: it.IndexNumber ?? null,
            runtime: it.RunTimeTicks ?? null, dur: ticksToSeconds(it.RunTimeTicks), container: it.Container || null,
            path: it.Path || null, gain: it.NormalizationGain ?? null, lyrics: it.HasLyrics ? 1 : 0,
            created: it.DateCreated || null, image: it.ImageTags?.Primary || null, raw: j(it), run: runId, now, lib: lib.ItemId,
          });
          delTrackArtists.run(it.Id);
          (it.ArtistItems || []).forEach((a, i) => insTrackArtist.run(it.Id, a.Id, i));
        }
      });
      tx(page.items);
      log.info(`tracks [${lib.Name}] ${Math.min(page.startIndex + page.items.length, page.total)}/${page.total}`);
    }
  }

  // ---- integrity check ----
  const mismatch = [];
  if (seen.artists.size !== totals.artists) mismatch.push(`artists ${seen.artists.size}/${totals.artists}`);
  if (seen.albums.size !== totals.albums) mismatch.push(`albums ${seen.albums.size}/${totals.albums}`);
  if (seen.tracks.size !== totals.tracks) mismatch.push(`tracks ${seen.tracks.size}/${totals.tracks}`);

  if (dryRun) {
    return { runId: 0, dryRun: true, totals, stats, mismatch };
  }

  if (mismatch.length) {
    notes.push(`count mismatch (removals skipped): ${mismatch.join(', ')}`);
    log.warn(notes.at(-1));
  }

  // ---- removals ----
  if (!mismatch.length && !noRemovals) {
    stats.removed_tracks = db.prepare('UPDATE tracks SET removed_at = ? WHERE last_seen_run <> ? AND removed_at IS NULL').run(now, runId).changes;
    stats.removed_albums = db.prepare('UPDATE albums SET removed_at = ? WHERE last_seen_run <> ? AND removed_at IS NULL').run(now, runId).changes;
    stats.removed_artists = db.prepare('UPDATE artists SET removed_at = ? WHERE last_seen_run <> ? AND removed_at IS NULL').run(now, runId).changes;
  }

  // ---- rename carry-over: new entities inherit research/resolution from removed twins ----
  stats.carried_over = carryOver(db, runId, now);

  // ---- derived facts, canonicalization, research queue ----
  recomputeCounts(db);
  canonicalize(db);
  queueResearch(db);

  const status = mismatch.length ? 'failed' : 'ok';
  db.prepare(`UPDATE sync_runs SET finished_at=?, status=?, jf_total_audio=?, jf_total_albums=?, jf_total_artists=?,
    added_artists=?, added_albums=?, added_tracks=?, updated_tracks=?, removed_artists=?, removed_albums=?, removed_tracks=?, carried_over=?, notes=? WHERE id=?`)
    .run(nowIso(), status, totals.tracks, totals.albums, totals.artists,
      stats.added_artists, stats.added_albums, stats.added_tracks, stats.updated_tracks,
      stats.removed_artists, stats.removed_albums, stats.removed_tracks, stats.carried_over, notes.join('; ') || null, runId);
  return { runId, status, totals, stats, mismatch, notes };
}

// Jellyfin derives artist/album ids from names, so a tag fix creates a new id and retires the old.
// Copy resolution + research + embeddings from a removed twin (same MBID, else same key) to the newcomer.
function carryOver(db, runId, now) {
  let n = 0;
  const copyResearch = db.prepare(`
    INSERT OR IGNORE INTO research SELECT entity_type, @newId, stage, tier, priority, attempts, last_error, NULL, NULL, packet_json, packet_at, sources_json,
      summary, blurb, genres_json, moods_json, era, origin, tags_json, active_from, active_to, energy, dj_hooks_json, extra_json, confidence, model, result_hash, needs_review, updated_at
    FROM research WHERE entity_type=@type AND entity_id=@oldId AND stage IN ('done','draft','derived')`);
  const copyEmb = db.prepare(`INSERT OR IGNORE INTO embeddings SELECT entity_type, @newId, NULL, text_hash, model, dims, vector, updated_at FROM embeddings WHERE entity_type=@type AND entity_id=@oldId`);
  const logIt = db.prepare('INSERT INTO research_log(entity_type, entity_id, event, detail, at) VALUES (?, ?, ?, ?, ?)');

  // artists
  const newArtists = db.prepare('SELECT jellyfin_id, name_key, mb_artist_id FROM artists WHERE first_seen_run = ?').all(runId);
  const twinArtistByMb = db.prepare("SELECT * FROM artists WHERE removed_at IS NOT NULL AND mb_artist_id = ? AND resolution <> 'tag_only' ORDER BY updated_at DESC LIMIT 1");
  const twinArtistByKey = db.prepare("SELECT * FROM artists WHERE removed_at IS NOT NULL AND name_key = ? AND resolution <> 'tag_only' ORDER BY updated_at DESC LIMIT 1");
  const updArtist = db.prepare(`UPDATE artists SET mb_artist_id=COALESCE(mb_artist_id,@mb), resolved_name=@rn, resolved_sort_name=@rs, artist_type=@at, country=@c, begin_year=@by, end_year=@ey,
    genres_json=@g, image_url_ext=@img, resolution=@res, resolution_confidence=@conf, resolution_note='carried over from '||@old, resolved_at=@now, mb_json=@mbj WHERE jellyfin_id=@id`);
  for (const a of newArtists) {
    const twin = (a.mb_artist_id && twinArtistByMb.get(a.mb_artist_id)) || twinArtistByKey.get(a.name_key);
    if (!twin) continue;
    updArtist.run({ id: a.jellyfin_id, mb: twin.mb_artist_id, rn: twin.resolved_name, rs: twin.resolved_sort_name, at: twin.artist_type, c: twin.country, by: twin.begin_year, ey: twin.end_year,
      g: twin.genres_json, img: twin.image_url_ext, res: twin.resolution, conf: twin.resolution_confidence, old: twin.jellyfin_id, now, mbj: twin.mb_json });
    copyResearch.run({ type: 'artist', newId: a.jellyfin_id, oldId: twin.jellyfin_id });
    copyEmb.run({ type: 'artist', newId: a.jellyfin_id, oldId: twin.jellyfin_id });
    logIt.run('artist', a.jellyfin_id, 'carryover', twin.jellyfin_id, now);
    n++;
  }

  // albums
  const newAlbums = db.prepare('SELECT a.jellyfin_id, a.title_key, a.mb_release_group_id, ar.name_key AS akey FROM albums a LEFT JOIN artists ar ON ar.jellyfin_id = a.album_artist_id WHERE a.first_seen_run = ?').all(runId);
  const twinAlbumByMb = db.prepare("SELECT * FROM albums WHERE removed_at IS NOT NULL AND mb_release_group_id = ? AND resolution <> 'tag_only' ORDER BY updated_at DESC LIMIT 1");
  const twinAlbumByKey = db.prepare(`SELECT a.* FROM albums a LEFT JOIN artists ar ON ar.jellyfin_id = a.album_artist_id
    WHERE a.removed_at IS NOT NULL AND a.title_key = ? AND ar.name_key = ? AND a.resolution <> 'tag_only' ORDER BY a.updated_at DESC LIMIT 1`);
  const updAlbum = db.prepare(`UPDATE albums SET mb_album_id=COALESCE(mb_album_id,@mba), mb_release_group_id=COALESCE(mb_release_group_id,@mbr), resolved_title=@rt, resolved_artist=@ra,
    year=@y, release_date=@rd, release_type=@rty, genres_json=@g, resolution=@res, resolution_confidence=@conf, resolution_note='carried over from '||@old, resolved_at=@now,
    mb_tracklist_json=@tl, mb_json=@mbj WHERE jellyfin_id=@id`);
  for (const a of newAlbums) {
    const twin = (a.mb_release_group_id && twinAlbumByMb.get(a.mb_release_group_id)) || (a.akey && twinAlbumByKey.get(a.title_key, a.akey));
    if (!twin) continue;
    updAlbum.run({ id: a.jellyfin_id, mba: twin.mb_album_id, mbr: twin.mb_release_group_id, rt: twin.resolved_title, ra: twin.resolved_artist, y: twin.year, rd: twin.release_date, rty: twin.release_type,
      g: twin.genres_json, res: twin.resolution, conf: twin.resolution_confidence, old: twin.jellyfin_id, now, tl: twin.mb_tracklist_json, mbj: twin.mb_json });
    copyResearch.run({ type: 'album', newId: a.jellyfin_id, oldId: twin.jellyfin_id });
    copyEmb.run({ type: 'album', newId: a.jellyfin_id, oldId: twin.jellyfin_id });
    logIt.run('album', a.jellyfin_id, 'carryover', twin.jellyfin_id, now);
    n++;
  }

  // tracks: same album title key + track title key + duration within 2s
  const newTracks = db.prepare(`SELECT t.jellyfin_id, t.title_key, t.duration_s, al.title_key AS alkey FROM tracks t LEFT JOIN albums al ON al.jellyfin_id = t.album_id WHERE t.first_seen_run = ?`).all(runId);
  const twinTrack = db.prepare(`SELECT t.* FROM tracks t LEFT JOIN albums al ON al.jellyfin_id = t.album_id
    WHERE t.removed_at IS NOT NULL AND t.title_key = ? AND al.title_key = ? AND ABS(COALESCE(t.duration_s,0) - ?) < 2 AND t.resolution <> 'tag_only' ORDER BY t.updated_at DESC LIMIT 1`);
  const updTrack = db.prepare(`UPDATE tracks SET mb_recording_id=COALESCE(mb_recording_id,@mbr), mb_work_id=@mbw, resolved_title=@rt, resolved_artist=@ra, original_year=@oy, original_date=@od, album_year=@ay,
    genres_json=@g, is_cover=@ic, original_artist=@oa, resolution=@res, resolution_confidence=@conf, resolution_note='carried over from '||@old, resolved_at=@now, bpm=COALESCE(bpm,@bpm), key_text=COALESCE(key_text,@kt) WHERE jellyfin_id=@id`);
  for (const t of newTracks) {
    if (!t.alkey) continue;
    const twin = twinTrack.get(t.title_key, t.alkey, t.duration_s || 0);
    if (!twin) continue;
    updTrack.run({ id: t.jellyfin_id, mbr: twin.mb_recording_id, mbw: twin.mb_work_id, rt: twin.resolved_title, ra: twin.resolved_artist, oy: twin.original_year, od: twin.original_date, ay: twin.album_year,
      g: twin.genres_json, ic: twin.is_cover, oa: twin.original_artist, res: twin.resolution, conf: twin.resolution_confidence, old: twin.jellyfin_id, now, bpm: twin.bpm, kt: twin.key_text });
    copyResearch.run({ type: 'track', newId: t.jellyfin_id, oldId: twin.jellyfin_id });
    copyEmb.run({ type: 'track', newId: t.jellyfin_id, oldId: twin.jellyfin_id });
    logIt.run('track', t.jellyfin_id, 'carryover', twin.jellyfin_id, now);
    n++;
  }
  return n;
}

export function recomputeCounts(db) {
  db.exec(`
    UPDATE artists SET track_count = (
      SELECT COUNT(*) FROM tracks t WHERE t.removed_at IS NULL AND (t.album_artist_id = artists.jellyfin_id OR t.jellyfin_id IN (SELECT track_id FROM track_artists ta WHERE ta.artist_id = artists.jellyfin_id))
    );
    UPDATE artists SET album_count = (SELECT COUNT(*) FROM albums al WHERE al.removed_at IS NULL AND al.album_artist_id = artists.jellyfin_id);
    UPDATE artists SET is_album_artist = CASE WHEN album_count > 0 THEN 1 ELSE 0 END;
    UPDATE albums SET track_count = (SELECT COUNT(*) FROM tracks t WHERE t.removed_at IS NULL AND t.album_id = albums.jellyfin_id);
    UPDATE artists SET library_ids_json = (SELECT json_group_array(DISTINCT t.library_id) FROM tracks t WHERE t.removed_at IS NULL AND t.library_id IS NOT NULL AND (t.album_artist_id = artists.jellyfin_id OR t.jellyfin_id IN (SELECT track_id FROM track_artists ta WHERE ta.artist_id = artists.jellyfin_id)));
  `);
}

// canonical_id: manual merges > shared MBID > shared name_key. Winner = most tracks.
export function canonicalize(db) {
  db.exec('UPDATE artists SET canonical_id = jellyfin_id WHERE canonical_id IS NULL');
  const mergesPath = path.join(config.dataDir, 'artist-merges.json');
  const manual = fs.existsSync(mergesPath) ? pj(fs.readFileSync(mergesPath, 'utf8'), {}) : {};

  const groups = new Map(); // groupKey -> [artist rows]
  const rows = db.prepare('SELECT jellyfin_id, tag_name, name_key, mb_artist_id, track_count, is_compilation FROM artists WHERE removed_at IS NULL').all();
  for (const r of rows) {
    if (r.is_compilation) continue;
    const manualKey = Object.entries(manual).find(([, variants]) => variants.map(nameKey).includes(r.name_key))?.[0];
    const gk = manualKey ? `manual:${nameKey(manualKey)}` : r.mb_artist_id ? `mb:${r.mb_artist_id}` : `key:${r.name_key}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(r);
  }
  // Also merge key-groups into mb-groups when one member has an MBID and another with same key has none.
  const byKey = new Map();
  for (const [gk, members] of groups) for (const m of members) {
    if (!byKey.has(m.name_key)) byKey.set(m.name_key, new Set());
    byKey.get(m.name_key).add(gk);
  }
  const parent = new Map([...groups.keys()].map((k) => [k, k]));
  const find = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k; };
  for (const set of byKey.values()) {
    const arr = [...set];
    for (let i = 1; i < arr.length; i++) {
      // only union key-groups with mb-groups (not two different MBIDs)
      const a = find(arr[0]), b = find(arr[i]);
      if (a === b) continue;
      const aMb = a.startsWith('mb:'), bMb = b.startsWith('mb:');
      if (aMb && bMb) continue;
      parent.set(b, a);
    }
  }
  const merged = new Map();
  for (const [gk, members] of groups) {
    const root = find(gk);
    if (!merged.has(root)) merged.set(root, []);
    merged.get(root).push(...members);
  }
  const upd = db.prepare('UPDATE artists SET canonical_id = ? WHERE jellyfin_id = ?');
  const tx = db.transaction(() => {
    for (const members of merged.values()) {
      const winner = members.slice().sort((a, b) => (b.track_count - a.track_count) || (a.mb_artist_id ? -1 : 1))[0];
      for (const m of members) upd.run(winner.jellyfin_id, m.jellyfin_id);
    }
  });
  tx();
}

// Insert research rows for every live entity that lacks one. Priority: album-artists and heavy hitters first.
export function queueResearch(db) {
  const now = nowIso();
  db.prepare(`INSERT OR IGNORE INTO research(entity_type, entity_id, stage, tier, priority, updated_at)
    SELECT 'artist', jellyfin_id, CASE WHEN is_compilation = 1 THEN 'skipped' WHEN canonical_id <> jellyfin_id THEN 'skipped' ELSE 'pending' END,
      'deep', (is_album_artist * 100000) + track_count, ? FROM artists WHERE removed_at IS NULL`).run(now);
  db.prepare(`INSERT OR IGNORE INTO research(entity_type, entity_id, stage, tier, priority, updated_at)
    SELECT 'album', jellyfin_id, 'pending', 'medium', track_count, ? FROM albums WHERE removed_at IS NULL`).run(now);
  db.prepare(`INSERT OR IGNORE INTO research(entity_type, entity_id, stage, tier, priority, updated_at)
    SELECT 'track', jellyfin_id, 'pending', 'derived', 0, ? FROM tracks WHERE removed_at IS NULL`).run(now);
  // keep artist priorities fresh
  db.prepare(`UPDATE research SET priority = (SELECT (a.is_album_artist * 100000) + a.track_count FROM artists a WHERE a.jellyfin_id = research.entity_id)
    WHERE entity_type = 'artist' AND stage IN ('pending','packet')`).run();
  // canonical variants that got merged after queueing -> skip them
  db.prepare(`UPDATE research SET stage = 'skipped', last_error = 'merged into canonical artist'
    WHERE entity_type = 'artist' AND stage = 'pending' AND entity_id IN (SELECT jellyfin_id FROM artists WHERE canonical_id <> jellyfin_id)`).run();
}
