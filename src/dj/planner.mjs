// Theme -> plan -> validated set of real track ids -> patter -> TTS.
import { chat } from '../llm/openrouter.mjs';
import { djSystemPrompt, interpretThemePrompt, selectSetPrompt } from '../llm/prompts.mjs';
import { gatherCandidates } from './candidates.mjs';
import { renderPatter } from './tts.mjs';
import { config } from '../config.mjs';
import { log } from '../util/log.mjs';
import { nameKey } from '../util/normalize.mjs';

// Match the request against the library's own artist names (the model does not know every band). Returns
// { artists: [names], radio: bool } when the request is essentially artist names, else null.
export function detectArtists(db, theme) {
  const raw = String(theme || '').trim();
  const radio = /radio/i.test(raw);
  const key = nameKey(raw.replace(/radio/ig, ''));
  if (key.length < 4) return null;
  const rows = db.prepare(`SELECT jellyfin_id, COALESCE(resolved_name, tag_name) name, name_key FROM artists WHERE removed_at IS NULL AND canonical_id = jellyfin_id AND is_compilation = 0 AND length(name_key) >= 4 AND instr(?, name_key) > 0 ORDER BY length(name_key) DESC`).all(key);
  const picked = []; let covered = 0; let rest = key;
  for (const r of rows) { if (!rest.includes(r.name_key)) continue; picked.push(r); covered += r.name_key.length; rest = rest.replace(r.name_key, '#'); if (picked.length >= 4) break; }
  if (!picked.length || covered < key.length * 0.6) return null;
  return { artists: picked.map((r) => r.name), radio };
}

export async function interpretTheme(theme, { length = 12, onProgress = () => {}, db = null } = {}) {
  onProgress('interpret', `Reading the theme with ${config.openrouter.fastModel.split('/').pop()}…`);
  const r = await chat({ model: config.openrouter.fastModel, purpose: 'interpret', system: djSystemPrompt({ brief: true }), json: true, temperature: 0.5, maxTokens: 700, messages: [{ role: 'user', content: interpretThemePrompt(theme, { length }) }] });
  const p = r.json || {};
  if (!Array.isArray(p.queries) || !p.queries.length) p.queries = [theme];
  p.length = length;
  const det = db ? detectArtists(db, theme) : null;
  if (det) { p.must_artists = det.artists; p.mode = det.radio ? 'radio' : 'artist'; p.title = p.title || det.artists.join(' & '); if (!det.radio) p.queries = det.artists; }
  else if (p.mode === 'artist' && !(p.must_artists || []).length) p.mode = 'radio';
  onProgress('interpret', `Plan: "${p.title || theme}" · ${p.queries.length} search angles${p.year_from || p.year_to ? ` · years ${p.year_from || ''}-${p.year_to || ''}` : ''}`, { done: true, usage: r.usage, queries: p.queries });
  return p;
}

export const SET_MIN = Math.max(1, Number(process.env.DJ_SET_MIN) || 3);
export const SET_MAX = Math.max(SET_MIN, Number(process.env.DJ_SET_MAX) || 10);
export const clampLength = (n) => Math.min(SET_MAX, Math.max(SET_MIN, Number(n) || SET_MAX));
// one voice break per this many tracks (plus the session opener)
export const TRACKS_PER_SEGUE = Math.max(2, Number(process.env.DJ_TRACKS_PER_SEGUE) || 4);

export async function selectSet(db, theme, plan, candidates, { length = SET_MAX, playedRecently = [], opener = true, onProgress = () => {} } = {}) {
  length = clampLength(length);
  const maxSegues = Math.max(0, Math.floor(length / TRACKS_PER_SEGUE));
  onProgress('select', `Picking ${length} tracks from ${candidates.length} candidates with ${config.openrouter.model.split('/').pop()}…`);
  const r = await chat({ purpose: 'select', system: djSystemPrompt(), json: true, temperature: 0.8, maxTokens: 3000, messages: [{ role: 'user', content: selectSetPrompt(theme, plan, candidates, { length, playedRecently, opener, maxSegues }) }] });
  const out = r.json || {};
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const seenArtist = new Map();
  const picks = [];
  let lastAlbum = null;
  const dropped = [];
  const artistMode = plan.mode === 'artist' && (plan.must_artists || []).length > 0;
  const perArtistCap = artistMode ? length : 2;
  let lastArtist = null;
  for (const p of out.picks || []) {
    const c = byId.get(p?.id);
    if (!c) { dropped.push(p?.id); continue; }
    if (picks.some((x) => x.id === c.id || (nameKey(x.artist) === nameKey(c.artist) && nameKey(x.title) === nameKey(c.title)))) { dropped.push(`${c.title} duplicate`); continue; }
    const aKey = c.artist_id || c.artist;
    if ((seenArtist.get(aKey) || 0) >= perArtistCap) { dropped.push(`${c.artist} cap`); continue; }
    if (!artistMode && lastAlbum && c.album_id === lastAlbum) { dropped.push(`${c.title} same album`); continue; }
    // same artist back to back: drop rather than reorder, so the DJ's segues still sit between the tracks they were written for
    if (!artistMode && lastArtist && aKey === lastArtist) { dropped.push(`${c.title} back-to-back artist`); continue; }
    seenArtist.set(aKey, (seenArtist.get(aKey) || 0) + 1);
    lastAlbum = c.album_id; lastArtist = aKey;
    picks.push({ ...c, why: p.why || '' });
    if (picks.length >= length) break;
  }
  if (dropped.length) log.warn(`planner dropped ${dropped.length} invalid picks: ${dropped.slice(0, 5).join(', ')}`);
  // fill up from remaining candidates if the model came up short (appended at the end, where no segue refers to them)
  for (const c of candidates) {
    if (picks.length >= length) break;
    if (picks.some((p) => p.id === c.id)) continue;
    const aKey = c.artist_id || c.artist;
    if ((seenArtist.get(aKey) || 0) >= perArtistCap) continue;
    if (!artistMode && picks.length && (picks.at(-1).artist_id || picks.at(-1).artist) === aKey) continue;
    seenArtist.set(aKey, (seenArtist.get(aKey) || 0) + 1);
    picks.push({ ...c, why: 'filled from candidates' });
  }
  // Segues are anchored to the two tracks they were written between. Keep one only if those two are still
  // adjacent in the final order (so "that was X, next up Y" is always true), then apply the talk ration.
  const posOf = new Map(picks.map((p, i) => [p.id, i]));
  let segues = (out.segues || []).map((sg) => {
    if (!sg || typeof sg.text !== 'string' || !sg.text.trim()) return null;
    let i = Number.isInteger(sg.after_index) ? sg.after_index : posOf.get(sg.after_id);
    if (!Number.isInteger(i) || i < 0 || i >= picks.length - 1) return null;
    if (sg.after_id && picks[i].id !== sg.after_id) return null;
    if (sg.before_id && picks[i + 1].id !== sg.before_id) return null;
    // The ids can be right while the words are wrong ("next up They Might Be Giants" before a Refreshments track).
    // The text must name the track it introduces, and must not name any other candidate artist.
    const text = sg.text.trim(), tl = text.toLowerCase();
    const after = picks[i], before = picks[i + 1];
    const mentions = (name) => { const k = String(name || '').toLowerCase().replace(/^the /, '').trim(); return k.length >= 3 && tl.includes(k); };
    const firstWord = (t) => String(t || '').toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 3)[0];
    if (!(mentions(before.artist) || mentions(before.title) || (firstWord(before.title) && tl.includes(firstWord(before.title))))) { log.warn(`segue dropped (does not name the next track "${before.artist} - ${before.title}"): ${text}`); return null; }
    const ownKeys = new Set([nameKey(after.artist), nameKey(before.artist)]);
    const stray = candidates.find((c) => !ownKeys.has(nameKey(c.artist)) && mentions(c.artist));
    if (stray) { log.warn(`segue dropped (names "${stray.artist}", which is not adjacent): ${text}`); return null; }
    return { after_index: i, after_id: after.id, before_id: before.id, text };
  }).filter(Boolean).sort((a, b) => a.after_index - b.after_index);
  const kept = []; let lastIdx = -TRACKS_PER_SEGUE;
  for (const sg of segues) { if (sg.after_index - lastIdx >= TRACKS_PER_SEGUE - 1 && kept.length < maxSegues) { kept.push(sg); lastIdx = sg.after_index; } }
  if (segues.length !== kept.length) log.debug(`segues kept ${kept.length}/${segues.length}`);
  segues = kept;
  onProgress('select', `Picked ${picks.length} tracks, ${segues.length + (opener && out.opener ? 1 : 0)} voice break(s)${dropped.length ? `, dropped ${dropped.length} invalid pick(s)` : ''}`, { done: true, usage: r.usage, picks: picks.map((p) => `${p.artist} - ${p.title}`) });
  return { title: out.title || plan.title || theme, station: typeof out.station === 'string' ? out.station.trim().slice(0, 40) : null, picks, opener: opener ? (out.opener || '').trim() : '', segues, model: r.model, dropped };
}

// Full pipeline used by the CLI and the station. `opener` false for refills (the show is already on).
export async function planSet(db, theme, { length = SET_MAX, renderTts = true, playedRecently = [], excludeIds = [], opener = true, onProgress = () => {} } = {}) {
  if (!config.openrouter.apiKey) throw new Error('OPENROUTER_API_KEY missing in .env (needed for the DJ planner)');
  length = clampLength(length);
  const plan = await interpretTheme(theme, { length, onProgress, db });
  onProgress('search', `Searching the library: ${plan.queries.map((q) => `"${q}"`).join(', ')}`);
  const candidates = await gatherCandidates(db, plan, { excludeIds });
  onProgress('search', `${candidates.length} candidate tracks after vetoes and anti-repeat`, { done: true });
  if (!candidates.length) throw new Error('no candidates found (is the embedding index built? npm run embed -- build)');
  const set = await selectSet(db, theme, plan, candidates, { length, playedRecently, opener, onProgress });
  const items = [];
  const talk = [set.opener, ...set.segues.map((s) => s.text)].filter(Boolean);
  let spoken = 0;
  const speak = async (text) => { if (!renderTts || !text) return null; onProgress('voice', `Rendering voice ${++spoken}/${talk.length} with Kokoro (${config.kokoro.voice})…`); const t = await renderPatter(db, text); if (spoken === talk.length) onProgress('voice', `${talk.length} voice break(s) ready${t.cached ? ' (cached)' : ''}`, { done: true }); return t; };
  if (set.opener) items.push({ kind: 'patter', text: set.opener, tts: await speak(set.opener) });
  const segueAfter = new Map(set.segues.map((s) => [s.after_index, s.text]));
  for (let i = 0; i < set.picks.length; i++) {
    const p = set.picks[i];
    items.push({ kind: 'track', track_id: p.id, title: p.title, artist: p.artist, album: p.album, year: p.year, why: p.why });
    if (segueAfter.has(i)) { const t = segueAfter.get(i); items.push({ kind: 'patter', text: t, tts: await speak(t) }); }
  }
  return { theme, title: set.title, station: set.station, plan, candidates: candidates.length, model: set.model, dropped: set.dropped, items };
}
