// Build research packets: everything a researcher (Claude subagent or bulk LLM) needs for one entity.
// No MusicBrainz calls here (identify already stored mb_json); Wikipedia + Last.fm only.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import { pj, j } from '../db/open.mjs';
import { summary as wikiSummary, findMusicPage, titleFromUrl } from './sources/wikipedia.mjs';
import { lastfm } from './sources/lastfm.mjs';
import { mentions } from './taste.mjs';
import { fetchJson, safeErr } from '../util/http.mjs';
import { nowIso } from '../util/hash.mjs';
import { log } from '../util/log.mjs';
import { SCHEMAS } from './prompts.mjs';

async function wikidataToWikipedia(url) {
  const m = /wikidata\.org\/wiki\/(Q\d+)/.exec(url || '');
  if (!m) return null;
  try {
    const r = await fetchJson(`https://www.wikidata.org/wiki/Special:EntityData/${m[1]}.json`, { retries: 1, timeoutMs: 15_000 });
    return r?.entities?.[m[1]]?.sitelinks?.enwiki?.title || null;
  } catch { return null; }
}

async function wikipediaFor(name, urls, kind) {
  try {
    let title = titleFromUrl(urls?.wikipedia);
    if (!title && urls?.wikidata) title = await wikidataToWikipedia(urls.wikidata);
    if (title) { const s = await wikiSummary(title); if (s) return s; }
    return await findMusicPage(name, kind);
  } catch (e) { log.warn(`wikipedia ${name}: ${safeErr(e)}`); return null; }
}

const flagged = (v, note = 'untrusted ID3 tag') => (v == null ? null : { value: v, note });

export async function buildArtistPacket(db, row) {
  const a = db.prepare('SELECT * FROM artists WHERE jellyfin_id = ?').get(row.entity_id);
  if (!a) return null;
  const variants = db.prepare('SELECT tag_name FROM artists WHERE canonical_id = ? AND jellyfin_id <> ?').all(a.jellyfin_id, a.jellyfin_id).map((x) => x.tag_name);
  const name = a.resolved_name || a.tag_name;
  const mbj = pj(a.mb_json, null);
  const albums = db.prepare(`SELECT COALESCE(resolved_title, tag_name) title, year, tag_year, release_type, track_count, resolution FROM albums
    WHERE album_artist_id IN (SELECT jellyfin_id FROM artists WHERE canonical_id = ?) AND removed_at IS NULL ORDER BY COALESCE(year, tag_year), title`).all(a.jellyfin_id);
  const titles = db.prepare(`SELECT COALESCE(t.resolved_title, t.tag_title) title, t.original_year FROM tracks t
    WHERE t.removed_at IS NULL AND (t.album_artist_id IN (SELECT jellyfin_id FROM artists WHERE canonical_id = ?) OR t.jellyfin_id IN (SELECT track_id FROM track_artists WHERE artist_id IN (SELECT jellyfin_id FROM artists WHERE canonical_id = ?)))
    GROUP BY COALESCE(t.resolved_title, t.tag_title) ORDER BY COUNT(*) DESC, title LIMIT 20`).all(a.jellyfin_id, a.jellyfin_id);
  const years = albums.map((x) => x.year).filter(Boolean);
  const wiki = await wikipediaFor(name, mbj?.urls, 'artist');
  const lf = lastfm.enabled() ? await lastfm.artist(name, a.mb_artist_id).catch(() => null) : null;
  return {
    entity_id: a.jellyfin_id, entity_type: 'artist', name, aliases: [...new Set([a.tag_name, ...variants, ...(mbj?.aliases || [])].filter((x) => x && x !== name))],
    identity: { resolution: a.resolution, confidence: a.resolution_confidence, note: a.resolution_note, mb_artist_id: a.mb_artist_id },
    library: { track_count: a.track_count, album_count: a.album_count, years_span: years.length ? [Math.min(...years), Math.max(...years)] : null,
      albums: albums.map((x) => ({ title: x.title, year: x.year, tag_year: x.year == null ? flagged(x.tag_year) : undefined, type: x.release_type, tracks: x.track_count })),
      top_titles: titles.map((t) => t.title), jellyfin_genres: flagged(pj(a.tag_genres_json, [])) },
    musicbrainz: mbj ? { id: mbj.id, name: mbj.name, type: mbj.type, country: mbj.country, area: mbj.area, begin_area: mbj['begin-area'], life_span: mbj['life-span'], disambiguation: mbj.disambiguation, genres: mbj.genres, tags: mbj.tags, urls: mbj.urls } : null,
    wikipedia: wiki, lastfm: lf,
    taste_profile_mentions: mentions(name),
    prior_draft: row.stage === 'draft' ? { summary: row.summary, genres: pj(row.genres_json, []), moods: pj(row.moods_json, []), model: row.model } : undefined,
    image_hint: wiki?.image || mbj?.urls?.image || null,
  };
}

export async function buildAlbumPacket(db, row) {
  const al = db.prepare('SELECT * FROM albums WHERE jellyfin_id = ?').get(row.entity_id);
  if (!al) return null;
  const artist = al.album_artist_id ? db.prepare('SELECT jellyfin_id, canonical_id, COALESCE(resolved_name, tag_name) name, mb_artist_id FROM artists WHERE jellyfin_id = ?').get(al.album_artist_id) : null;
  const artistResearch = artist ? db.prepare("SELECT summary, blurb, genres_json, moods_json, era FROM research WHERE entity_type='artist' AND entity_id=? AND stage IN ('done','draft')").get(artist.canonical_id || artist.jellyfin_id) : null;
  const title = al.resolved_title || al.tag_name;
  const tracks = db.prepare(`SELECT disc_no, track_no, COALESCE(resolved_title, tag_title) title, COALESCE(resolved_artist, tag_album_artist) artist, original_year, tag_year, duration_s, resolution FROM tracks WHERE album_id = ? AND removed_at IS NULL ORDER BY disc_no, track_no`).all(al.jellyfin_id);
  const mbj = pj(al.mb_json, null);
  const wiki = await wikipediaFor(`${title} (${artist?.name || ''} album)`.trim(), null, 'album').catch(() => null) || (artist ? await findMusicPage(`${title} ${artist.name}`, 'album').catch(() => null) : null);
  const lf = lastfm.enabled() && artist ? await lastfm.album(artist.name, title, al.mb_album_id).catch(() => null) : null;
  return {
    entity_id: al.jellyfin_id, entity_type: 'album', title, artist: artist?.name || al.tag_album_artist_name, is_compilation: !!al.is_compilation,
    identity: { resolution: al.resolution, confidence: al.resolution_confidence, note: al.resolution_note, mb_release_group_id: al.mb_release_group_id, mb_album_id: al.mb_album_id },
    resolved: { year: al.year, release_date: al.release_date, release_type: al.release_type, genres: pj(al.genres_json, []) },
    tag: { name: al.tag_name, year: flagged(al.tag_year), genres: flagged(pj(al.tag_genres_json, [])) },
    tracklist: tracks.map((t) => ({ n: t.track_no, disc: t.disc_no, title: t.title, artist: al.is_compilation ? t.artist : undefined, original_year: t.original_year, duration_s: t.duration_s && Math.round(t.duration_s) })),
    musicbrainz: mbj ? { release_group: mbj['release-group'], date: mbj.date, country: mbj.country, genres: mbj.genres, artist_credit: mbj['artist-credit']?.map((c) => c.name).join('') } : null,
    wikipedia: wiki, lastfm: lf,
    artist_context: artistResearch ? { blurb: artistResearch.blurb, genres: pj(artistResearch.genres_json, []), moods: pj(artistResearch.moods_json, []), era: artistResearch.era, summary: artistResearch.summary } : null,
    taste_profile_mentions: mentions(title),
    prior_draft: row.stage === 'draft' ? { summary: row.summary, model: row.model } : undefined,
  };
}

export async function buildTrackPacket(db, row) {
  const t = db.prepare('SELECT * FROM tracks WHERE jellyfin_id = ?').get(row.entity_id);
  if (!t) return null;
  const al = t.album_id ? db.prepare('SELECT jellyfin_id, COALESCE(resolved_title, tag_name) title, year, release_type, is_compilation FROM albums WHERE jellyfin_id = ?').get(t.album_id) : null;
  const ar = t.album_artist_id ? db.prepare('SELECT jellyfin_id, canonical_id, COALESCE(resolved_name, tag_name) name, mb_artist_id FROM artists WHERE jellyfin_id = ?').get(t.album_artist_id) : null;
  const title = t.resolved_title || t.tag_title;
  const artistName = t.resolved_artist || pj(t.tag_artists_json, [])[0] || ar?.name;
  const artistResearch = ar ? db.prepare("SELECT summary, blurb, genres_json, moods_json, era, dj_hooks_json FROM research WHERE entity_type='artist' AND entity_id=? AND stage IN ('done','draft')").get(ar.canonical_id || ar.jellyfin_id) : null;
  const albumResearch = al ? db.prepare("SELECT summary, blurb, genres_json, moods_json FROM research WHERE entity_type='album' AND entity_id=? AND stage IN ('done','draft')").get(al.jellyfin_id) : null;
  const lf = lastfm.enabled() && artistName ? await lastfm.track(artistName, title, t.mb_recording_id).catch(() => null) : null;
  const extra = pj(row.extra_json, {});
  return {
    entity_id: t.jellyfin_id, entity_type: 'track', title, artist: artistName, album: al ? { title: al.title, year: al.year, type: al.release_type, compilation: !!al.is_compilation } : null,
    identity: { resolution: t.resolution, confidence: t.resolution_confidence, note: t.resolution_note, mb_recording_id: t.mb_recording_id },
    resolved: { original_year: t.original_year, original_date: t.original_date, album_year: t.album_year, genres: pj(t.genres_json, []), is_cover: t.is_cover, original_artist: t.original_artist },
    tag: { title: t.tag_title, year: flagged(t.tag_year), genres: flagged(pj(t.tag_genres_json, [])), artists: pj(t.tag_artists_json, []) },
    facts: { duration_s: t.duration_s && Math.round(t.duration_s), track_no: t.track_no, disc_no: t.disc_no, has_lyrics: !!t.has_lyrics, bpm: t.bpm, key: t.key_text },
    notable_reasons: extra.notable_reasons || [],
    artist_context: artistResearch ? { blurb: artistResearch.blurb, genres: pj(artistResearch.genres_json, []), moods: pj(artistResearch.moods_json, []), era: artistResearch.era } : null,
    album_context: albumResearch ? { blurb: albumResearch.blurb, moods: pj(albumResearch.moods_json, []) } : null,
    lastfm: lf,
    taste_profile_mentions: mentions(title),
  };
}

export const BUILDERS = { artist: buildArtistPacket, album: buildAlbumPacket, track: buildTrackPacket };

export async function buildPackets(db, type, rows, batch) {
  const entities = [];
  const upd = db.prepare('UPDATE research SET packet_json = ?, packet_at = ? WHERE entity_type = ? AND entity_id = ?');
  for (const row of rows) {
    try {
      const p = await BUILDERS[type](db, row);
      if (!p) { log.warn(`no entity for ${type} ${row.entity_id}`); continue; }
      upd.run(j(p), nowIso(), type, row.entity_id);
      if (type === 'artist' && p.image_hint) db.prepare('UPDATE artists SET image_url_ext = COALESCE(image_url_ext, ?) WHERE jellyfin_id = ?').run(p.image_hint, row.entity_id);
      entities.push(p);
      log.info(`packet ${type}: ${p.name || p.title}`);
    } catch (e) {
      log.warn(`packet ${type} ${row.entity_id}: ${safeErr(e)}`);
    }
  }
  const dir = path.join(config.dataDir, 'results', batch);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(config.dataDir, 'packets', `${batch}.json`);
  const doc = { batch_id: batch, entity_type: type, result_schema: SCHEMAS[type].version, write_results_to: dir, count: entities.length, entities };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return { file, dir, entities };
}
