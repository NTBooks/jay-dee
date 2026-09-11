// Album mode: the DJ picks whole albums along the theme and plays them front to back.
// Only albums the listener actually owns (near-complete against the MusicBrainz tracklist) are eligible.
import { chat } from '../llm/openrouter.mjs';
import { djSystemPrompt, albumIntroPrompt } from '../llm/prompts.mjs';
import { interpretTheme } from './planner.mjs';
import { gatherCandidates } from './candidates.mjs';
import { renderPatter } from './tts.mjs';
import { config } from '../config.mjs';
import { pj } from '../db/open.mjs';
import { log } from '../util/log.mjs';
import { nameKey } from '../util/normalize.mjs';

const NOT_ALBUMS = new Set(['single', 'remix']);

// An album counts as "owned" when the library holds (nearly) all of it: 80% of the MusicBrainz tracklist,
// or at least six tracks when MusicBrainz has no tracklist for it.
export function ownedAlbum(db, albumId) {
  const al = db.prepare('SELECT * FROM albums WHERE jellyfin_id = ? AND removed_at IS NULL').get(albumId);
  if (!al || NOT_ALBUMS.has(al.release_type)) return null;
  const n = db.prepare('SELECT COUNT(*) n FROM tracks WHERE album_id = ? AND removed_at IS NULL').get(albumId).n;
  const mbLen = pj(al.mb_tracklist_json, []).length;
  const complete = mbLen ? n >= Math.max(4, Math.ceil(0.8 * mbLen)) : n >= 6;
  if (!complete) return null;
  return { id: al.jellyfin_id, title: al.resolved_title || al.tag_name, artist: al.resolved_artist || al.tag_album_artist_name, year: al.year || al.tag_year, release_type: al.release_type, tracks: n, mbTracks: mbLen, artist_id: al.album_artist_id };
}

export function albumTracks(db, albumId, { excludeIds = new Set() } = {}) {
  return db.prepare(`SELECT t.jellyfin_id id, COALESCE(t.resolved_title, t.tag_title) title, COALESCE(t.resolved_artist, ar.resolved_name, ar.tag_name, t.tag_album_artist) artist,
      COALESCE(al.resolved_title, al.tag_name) album, t.original_year year, t.album_id, t.disc_no, t.track_no
    FROM tracks t LEFT JOIN albums al ON al.jellyfin_id = t.album_id LEFT JOIN artists ar ON ar.jellyfin_id = t.album_artist_id
    WHERE t.album_id = ? AND t.removed_at IS NULL ORDER BY COALESCE(t.disc_no, 1), COALESCE(t.track_no, 999), t.tag_title`).all(albumId)
    .filter((t) => !excludeIds.has(t.id));
}

function weightedPick(pool, count) {
  const out = [];
  const left = [...pool];
  const artists = new Set();
  while (out.length < count && left.length) {
    const total = left.reduce((s, a) => s + a.score, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < left.length - 1; idx++) { r -= left[idx].score; if (r <= 0) break; }
    const [a] = left.splice(idx, 1);
    const k = nameKey(a.artist || '');
    if (artists.has(k)) continue; // one album per artist per set
    artists.add(k);
    out.push(a);
  }
  return out;
}

// count = albums to queue; excludeAlbumIds = albums already played in this session.
export async function planAlbumSet(db, theme, { count = 2, excludeAlbumIds = [], renderTts = true, opener = true, onProgress = () => {} } = {}) {
  if (!config.openrouter.apiKey) throw new Error('OPENROUTER_API_KEY missing in .env (needed for the DJ planner)');
  const plan = await interpretTheme(theme, { length: 10, onProgress, db });
  onProgress('search', `Searching the library for albums: ${plan.queries.map((q) => `"${q}"`).join(', ')}`);
  const cands = await gatherCandidates(db, plan, { perQuery: 60, maxTotal: 300 });
  // group candidate tracks by album; an album's score is the sum of its hits
  const byAlbum = new Map();
  for (const c of cands) {
    if (!c.album_id) continue;
    const cur = byAlbum.get(c.album_id) || { hits: 0, score: 0, liked: 0 };
    cur.hits++; cur.score += Math.max(0.05, (c.score || 0.2) * (c.weight ?? 1)); if (c.liked) cur.liked++;
    byAlbum.set(c.album_id, cur);
  }
  const skip = new Set(excludeAlbumIds);
  // albums heard in the last 24 h (two or more tracks) rest for a day
  const cut = new Date(Date.now() - 24 * 3600_000).toISOString();
  for (const r of db.prepare('SELECT t.album_id a, COUNT(*) n FROM dj_log l JOIN tracks t ON t.jellyfin_id = l.track_id WHERE l.played_at > ? GROUP BY t.album_id HAVING n >= 2').all(cut)) skip.add(r.a);
  const downTracks = new Set(db.prepare("SELECT entity_id FROM feedback WHERE entity_type='track' AND value='down'").all().map((r) => r.entity_id));
  const pool = [];
  for (const [albumId, agg] of byAlbum) {
    if (skip.has(albumId)) continue;
    const al = ownedAlbum(db, albumId);
    if (!al) continue;
    pool.push({ ...al, hits: agg.hits, score: agg.score * (1 + 0.5 * agg.liked) * (al.release_type === 'album' ? 1 : 0.6) });
  }
  pool.sort((a, b) => b.score - a.score);
  const top = pool.slice(0, 24);
  onProgress('search', `${pool.length} owned album(s) match; drawing ${count} from the top ${top.length}`, { done: true });
  if (!top.length) throw new Error('no complete albums match this theme (album mode only plays albums you own in full)');
  const picks = weightedPick(top, count);
  // The DJ writes the opener and one intro per album; the picks themselves are already made (random, weighted by fit).
  onProgress('select', `Writing intros for ${picks.map((a) => `${a.artist} - ${a.title}`).join(' | ')}…`);
  let out = {};
  let model = null;
  try {
    const r = await chat({ purpose: 'select', system: djSystemPrompt(), json: true, temperature: 0.8, maxTokens: 1200, messages: [{ role: 'user', content: albumIntroPrompt(theme, plan, picks, { opener }) }] });
    out = r.json || {}; model = r.model;
  } catch (e) { log.warn(`album intro LLM failed, using plain intros: ${e.message}`); }
  const introFor = new Map((out.intros || []).filter((x) => x && x.album_id && typeof x.text === 'string').map((x) => [x.album_id, x.text.trim()]));
  onProgress('select', `${picks.length} album(s) queued${out.title ? `: ${out.title}` : ''}`, { done: true, picks: picks.map((a) => `${a.artist} - ${a.title} (${a.tracks} tracks)`) });
  const items = [];
  const talk = [opener ? out.opener : null, ...picks.map((a) => introFor.get(a.id) || `Coming up in full: ${a.title} by ${a.artist}.`)].filter(Boolean);
  let spoken = 0;
  const speak = async (text) => { if (!renderTts || !text) return null; onProgress('voice', `Rendering voice ${++spoken}/${talk.length} with Kokoro (${config.kokoro.voice})…`); const t = await renderPatter(db, text); if (spoken === talk.length) onProgress('voice', `${talk.length} voice break(s) ready`, { done: true }); return t; };
  if (opener && out.opener) items.push({ kind: 'patter', text: String(out.opener).trim(), tts: await speak(String(out.opener).trim()) });
  for (const a of picks) {
    const intro = introFor.get(a.id) || `Coming up in full: ${a.title} by ${a.artist}.`;
    items.push({ kind: 'patter', text: intro, tts: await speak(intro) });
    for (const t of albumTracks(db, a.id, { excludeIds: downTracks })) items.push({ kind: 'track', track_id: t.id, title: t.title, artist: t.artist, album: t.album, year: t.year, why: `album: ${a.title}` });
  }
  return { theme, title: out.title || plan.title || theme, station: typeof out.station === 'string' ? out.station.trim().slice(0, 40) : null, plan, candidates: cands.length, albums: picks, model, dropped: [], items };
}
