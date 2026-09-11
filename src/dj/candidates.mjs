// Gather real, playable candidate tracks for a plan: vector hits per query + SQL hits, minus vetoes, anti-repeat, duplicates.
import { search } from '../embed/index.mjs';
import { loadVetoes } from './vetoes.mjs';
import { nameKey } from '../util/normalize.mjs';
import { pj } from '../db/open.mjs';
import { libraryFilterSql } from '../db/libraries.mjs';

const MAX_PER_ARTIST = Math.max(1, Number(process.env.DJ_CANDIDATES_PER_ARTIST) || 3);
const MIN_DISTINCT_ARTISTS = 25;

export async function gatherCandidates(db, plan, { perQuery = 30, maxTotal = 90, recentHours = 24, recentLimit = 150, excludeIds = [] } = {}) {
  const downweights = new Map(loadVetoes().filter((v) => v.weight > 0).map((v) => [v.key, v.weight]));
  const recent = db.prepare(`SELECT track_id FROM dj_log WHERE played_at > ? ORDER BY played_at DESC LIMIT ?`)
    .all(new Date(Date.now() - recentHours * 3600_000).toISOString(), recentLimit).map((r) => r.track_id);
  const exclude = new Set([...recent, ...excludeIds]);
  // listener feedback: thumbed-down tracks and blocked artists never come back; liked tracks get a boost
  for (const r of db.prepare("SELECT entity_id FROM feedback WHERE entity_type='track' AND value='down'").all()) exclude.add(r.entity_id);
  const blockedArtists = new Set(db.prepare("SELECT entity_id FROM feedback WHERE entity_type='artist' AND value='block'").all().map((r) => r.entity_id));
  const liked = new Set(db.prepare("SELECT entity_id FROM feedback WHERE entity_type='track' AND value='up'").all().map((r) => r.entity_id));
  const artistMode = plan.mode === 'artist' && (plan.must_artists || []).length > 0;
  const wantsRemix = /\b(remix|remixes|dub|edit|mix)\b/i.test(`${plan.notes || ''} ${plan.title || ''}`);
  // Radio rotation: artists heard in the last few hours get pushed down (not banned) so the same two catalogs cannot dominate every set.
  const recentArtists = new Map(db.prepare(`SELECT ar.canonical_id id, COUNT(*) n FROM dj_log l JOIN tracks t ON t.jellyfin_id = l.track_id JOIN artists ar ON ar.jellyfin_id = t.album_artist_id
    WHERE l.played_at > ? GROUP BY ar.canonical_id`).all(new Date(Date.now() - 4 * 3600_000).toISOString()).map((r) => [r.id, r.n]));
  const avoidKeys = new Set((plan.avoid_artists || []).map(nameKey));
  const mustKeys = new Set((plan.must_artists || []).map(nameKey));
  const byId = new Map();
  const add = (r, source) => {
    if (exclude.has(r.id) || byId.has(r.id)) return;
    if (r.artist_id && blockedArtists.has(r.artist_id)) return;
    if (r.artist && avoidKeys.has(nameKey(r.artist))) return;
    let w = r.artist ? (downweights.get(nameKey(r.artist)) ?? 1) : 1;
    const heard = recentArtists.get(r.artist_id) || 0;
    if (heard && !artistMode) w *= Math.max(0.35, 1 - 0.25 * heard);
    if (!wantsRemix && /\b(remix|remixed|dub|club mix|extended mix|radio edit|re-edit|rework|mashup|megamix)\b/i.test(r.title || '')) w *= 0.3;
    if (liked.has(r.id)) { w *= 1.3; r = { ...r, liked: true }; }
    // deluxe-edition ephemera (demos, rehearsals, alternate versions) rank below the real cut unless the theme asks for them
    if (/\b(demo|rehearsal|rough mix|alternate|alt\.? version|instrumental|acoustic version|live|remix|edit|radio edit|version only|outtake)\b/i.test(r.title || '') && !/\b(demo|live|remix|acoustic|rarit|outtake)/i.test(plan.notes || plan.title || '')) w *= 0.5;
    byId.set(r.id, { ...r, weight: w, source });
  };
  const artistRows = (keys, limit) => db.prepare(`SELECT t.jellyfin_id id, COALESCE(t.resolved_title, t.tag_title) title, COALESCE(t.resolved_artist, ar.resolved_name, ar.tag_name) artist, ar.canonical_id artist_id,
        COALESCE(al.resolved_title, al.tag_name) album, t.album_id, t.original_year year, t.duration_s, t.resolution, r.blurb, r.energy, al.release_type
      FROM tracks t LEFT JOIN artists ar ON ar.jellyfin_id = t.album_artist_id LEFT JOIN albums al ON al.jellyfin_id = t.album_id
      LEFT JOIN research r ON r.entity_type='track' AND r.entity_id = t.jellyfin_id
      WHERE t.removed_at IS NULL AND ${libraryFilterSql(db, 't')} AND (${keys.map(() => "ar.name_key LIKE ?").join(' OR ')}) ORDER BY (al.release_type = 'album') DESC, RANDOM() LIMIT ?`)
    .all(...keys.map((k) => `%${k}%`), limit);
  if (artistMode) {
    // an artist request: their catalogue only (fuzzy name match handles punctuation and "The")
    artistRows([...mustKeys], 120).forEach((r) => add({ ...r, score: 1 }, 'artist'));
    if (!byId.size) { for (const q of plan.queries || []) (await search(db, { query: q, type: 'artist', k: 3 })).forEach((a) => artistRows([a.artist_id ? nameKey(a.artist) : nameKey(a.title)], 60).forEach((r) => add({ ...r, score: 0.9 }, 'artist-fuzzy'))); }
  }
  for (const q of artistMode ? [] : (plan.queries || [])) {
    const rows = await search(db, { query: q, type: 'track', k: perQuery, yearFrom: plan.year_from || undefined, yearTo: plan.year_to || undefined, excludeVetoed: true, excludeIds: [...exclude], maxPerArtist: 2 });
    rows.forEach((r) => add(r, 'vector'));
  }
  // Expand when the library is thin for this theme: lexical matches on artist / album / resolved genre names, then drop the year filter.
  const stop = new Set(['with', 'from', 'that', 'this', 'some', 'more', 'like', 'music', 'songs', 'tracks', 'radio', 'vibe', 'vibes', 'night', 'late', 'early', 'feel', 'feeling', 'style', 'sound', 'sounds', 'band']);
  const terms = [...new Set(`${plan.title || ''} ${plan.notes || ''} ${(plan.queries || []).join(' ')}`.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [])].filter((w) => !stop.has(w)).slice(0, 12);
  if (!artistMode && byId.size < 30 && terms.length) {
    const rows = db.prepare(`SELECT t.jellyfin_id id, COALESCE(t.resolved_title, t.tag_title) title, COALESCE(t.resolved_artist, ar.resolved_name, ar.tag_name) artist, ar.canonical_id artist_id,
        COALESCE(al.resolved_title, al.tag_name) album, t.album_id, t.original_year year, t.duration_s, t.resolution, r.blurb, r.energy,
        (${terms.map(() => "(CASE WHEN lower(COALESCE(ar.genres_json,'') || ' ' || COALESCE(ar.resolved_name, ar.tag_name) || ' ' || COALESCE(al.resolved_title, al.tag_name) || ' ' || COALESCE(t.genres_json,'')) LIKE ? THEN 1 ELSE 0 END)").join(' + ')}) hits
      FROM tracks t LEFT JOIN artists ar ON ar.jellyfin_id = t.album_artist_id LEFT JOIN albums al ON al.jellyfin_id = t.album_id
      LEFT JOIN research r ON r.entity_type='track' AND r.entity_id = t.jellyfin_id
      WHERE t.removed_at IS NULL AND ${libraryFilterSql(db, 't')} AND (ar.veto IS NULL OR ar.veto = 0)
      ORDER BY hits DESC, RANDOM() LIMIT 300`).all(...terms.map((w) => `%${w}%`)).filter((r) => r.hits > 0);
    const per = new Map();
    for (const r of rows) { const k = r.artist_id || r.artist; if ((per.get(k) || 0) >= 3) continue; per.set(k, (per.get(k) || 0) + 1); add({ ...r, score: 0.45 + 0.1 * r.hits }, 'lexical'); if (byId.size >= 60) break; }
  }
  if (!artistMode && byId.size < 15 && (plan.year_from || plan.year_to)) {
    for (const q of plan.queries || []) (await search(db, { query: q, type: 'track', k: perQuery, excludeVetoed: true, excludeIds: [...exclude, ...byId.keys()], maxPerArtist: 2 })).forEach((r) => add({ ...r, score: (r.score || 0) * 0.8 }, 'vector-noyear'));
  }
  // Cap each artist's share of the pool, then widen: re-run the queries excluding saturated artists until the pool is diverse.
  const capByArtist = () => {
    const per = new Map();
    for (const c of [...byId.values()].sort((a, b) => (b.score || 0) - (a.score || 0))) {
      const key = c.artist_id || c.artist; const n = per.get(key) || 0;
      if (n >= MAX_PER_ARTIST) byId.delete(c.id); else per.set(key, n + 1);
    }
    return per;
  };
  let per = artistMode ? new Map() : capByArtist();
  for (let pass = 0; pass < 2 && !artistMode && per.size < MIN_DISTINCT_ARTISTS; pass++) {
    const saturated = [...per.entries()].filter(([, n]) => n >= MAX_PER_ARTIST).map(([k]) => k).filter((k) => /^[0-9a-f]{32}$/.test(String(k)));
    for (const q of plan.queries || []) {
      const rows = await search(db, { query: q, type: 'track', k: perQuery, yearFrom: plan.year_from || undefined, yearTo: plan.year_to || undefined, excludeVetoed: true, excludeIds: [...exclude, ...byId.keys()], excludeArtistIds: saturated, maxPerArtist: 2 });
      rows.forEach((r) => add(r, 'vector-wide'));
    }
    per = capByArtist();
  }
  // explicitly requested artists: pull their tracks directly
  if (mustKeys.size) {
    const rows = db.prepare(`SELECT t.jellyfin_id id, COALESCE(t.resolved_title, t.tag_title) title, COALESCE(t.resolved_artist, ar.resolved_name, ar.tag_name) artist, ar.canonical_id artist_id,
        COALESCE(al.resolved_title, al.tag_name) album, t.album_id, t.original_year year, t.duration_s, t.resolution, r.blurb, r.energy
      FROM tracks t LEFT JOIN artists ar ON ar.jellyfin_id = t.album_artist_id LEFT JOIN albums al ON al.jellyfin_id = t.album_id
      LEFT JOIN research r ON r.entity_type='track' AND r.entity_id = t.jellyfin_id
      WHERE t.removed_at IS NULL AND ${libraryFilterSql(db, 't')} AND ar.name_key IN (${[...mustKeys].map(() => '?').join(',')}) ORDER BY RANDOM() LIMIT 30`).all(...mustKeys);
    rows.forEach((r) => add(r, 'must'));
  }
  // collapse duplicates (same artist + title on several albums): prefer studio album, then earliest year
  const collapsed = new Map();
  for (const c of byId.values()) {
    const key = `${nameKey(c.artist || '')}::${nameKey(c.title || '')}`;
    const prev = collapsed.get(key);
    if (!prev) { collapsed.set(key, c); continue; }
    const albumType = (id) => db.prepare('SELECT release_type FROM albums WHERE jellyfin_id = ?').get(id)?.release_type;
    const rank = (x) => (albumType(x.album_id) === 'album' ? 0 : 1) * 10 + (x.year || 9999) / 10000;
    if (rank(c) < rank(prev)) collapsed.set(key, c);
  }
  const list = [...collapsed.values()].sort((a, b) => (b.score || 0) * b.weight - (a.score || 0) * a.weight).slice(0, maxTotal);
  return list.map((c) => ({ ...c, moods: pj(c.moods_json, []) }));
}
