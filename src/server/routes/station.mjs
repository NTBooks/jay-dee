import express from 'express';
import fs from 'node:fs';
import { pj } from '../../db/open.mjs';
import { search } from '../../embed/index.mjs';
import { listVoices } from '../../dj/tts.mjs';
import { config } from '../../config.mjs';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function stationRoutes({ db, station }) {
  const r = express.Router();

  r.get('/api/station/state', (req, res) => res.json(station.state()));

  r.post('/api/dj/theme', wrap(async (req, res) => {
    const theme = String(req.body?.theme || '').trim();
    if (!theme) return res.status(400).json({ error: 'theme required' });
    if (!config.openrouter.apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY not set in .env; the DJ cannot plan sets yet' });
    const id = await station.startSession(theme, { length: Number(req.body?.length) || 10, mode: req.body?.mode === 'albums' ? 'albums' : 'tracks' });
    res.json({ sessionId: id, status: 'planning' });
  }));

  // Manual session: {title, track_ids: [...], intro?} or {title, query: "<semantic search>", k?, intro?}
  r.post('/api/dj/manual', wrap(async (req, res) => {
    let ids = Array.isArray(req.body?.track_ids) ? req.body.track_ids : [];
    if (!ids.length && req.body?.query) {
      const rows = await search(db, { query: String(req.body.query), type: 'track', k: Number(req.body.k) || 10, maxPerArtist: 2 });
      ids = rows.map((r) => r.id);
    }
    if (!ids.length) return res.status(400).json({ error: 'track_ids or query required' });
    const id = await station.startManual(String(req.body?.title || 'Manual set'), ids, { intro: req.body?.intro });
    res.json({ sessionId: id, status: 'ready', tracks: ids.length });
  }));

  // Listener call-in: {message} -> DJ replies on air, may re-plan the upcoming queue.
  r.post('/api/dj/callin', wrap(async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'message required' });
    const s = station.current();
    if (!s) return res.status(409).json({ error: 'no active session; ask for a theme first' });
    if (!config.openrouter.apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY not set in .env; call-ins need the DJ brain' });
    const r = await station.callIn(s.id, message);
    res.json({ ...r, state: station.state() });
  }));

  r.post('/api/station/skip-album', (req, res) => {
    const s = station.current();
    if (!s) return res.status(409).json({ error: 'nothing playing' });
    const r2 = station.skipAlbum(s.id);
    res.json({ ...r2, state: station.state() });
  });

  r.get('/api/sets', (req, res) => res.json(station.savedSets()));
  r.post('/api/sets', (req, res) => { const s = station.current(); if (!s) return res.status(409).json({ error: 'nothing playing to save' }); res.json(station.saveSet(s.id, req.body?.name)); });
  r.post('/api/sets/:id/play', wrap(async (req, res) => res.json({ sessionId: await station.playSaved(Number(req.params.id)) })));
  r.delete('/api/sets/:id', (req, res) => res.json({ deleted: station.deleteSaved(Number(req.params.id)) }));

  r.post('/api/client-log', (req, res) => { console.log(`[client ${String(req.body?.clientId || '?').slice(0, 6)} ${req.body?.mode || ''}] ${String(req.body?.msg || '').slice(0, 500)}`); res.json({ ok: true }); });

  r.post('/api/feedback', (req, res) => {
    const { track_id, action } = req.body || {};
    if (!track_id || !['up', 'down', 'clear', 'block_artist', 'unblock_artist'].includes(action)) return res.status(400).json({ error: 'track_id and a valid action required' });
    res.json(station.setFeedback(track_id, action));
  });

  // Claim the driver role (on play) or refresh it (heartbeat while playing). Does not touch the queue.
  r.post('/api/station/control', wrap(async (req, res) => {
    const s = station.current();
    if (!s) return res.json({ ok: true, controller: null });
    try {
      const controller = station.claim(s.id, req.body?.clientId, { takeover: !!req.body?.takeover });
      res.json({ ok: true, controller });
    } catch (e) {
      if (e.controller) return res.status(409).json({ error: e.message, controller: true, state: station.state() });
      throw e;
    }
  }));

  r.post('/api/station/advance', wrap(async (req, res) => {
    const s = station.current();
    if (!s) return res.json({ item: null, session: null });
    try {
      const item = await station.advance(s.id, { itemId: req.body?.itemId, reason: req.body?.reason || 'ended', nextItemId: req.body?.nextItemId, clientId: req.body?.clientId, takeover: !!req.body?.takeover, noRefill: !!req.body?.shuffle });
      res.json({ item: item ? decorate(item) : null, state: station.state() });
    } catch (e) {
      if (e.controller) return res.status(409).json({ error: e.message, controller: true, state: station.state() });
      throw e;
    }
  }));

  r.post('/api/station/stop', (req, res) => {
    const s = station.current();
    if (s) station.endSession(s.id, 'stopped');
    res.json({ ok: true });
  });

  r.get('/api/station/queue', (req, res) => {
    const s = station.current();
    if (!s) return res.json({ session: null, items: [] });
    res.json({ session: { id: s.id, theme: s.theme, status: s.status }, items: station.queue(s.id).map(decorate) });
  });

  r.get('/api/factoids/:trackId', (req, res) => {
    const t = db.prepare(`SELECT t.*, COALESCE(al.resolved_title, al.tag_name) album_title, al.year album_year_r, al.release_type, ar.canonical_id, COALESCE(ar.resolved_name, ar.tag_name) artist_name
      FROM tracks t LEFT JOIN albums al ON al.jellyfin_id = t.album_id LEFT JOIN artists ar ON ar.jellyfin_id = t.album_artist_id WHERE t.jellyfin_id = ?`).get(req.params.trackId);
    if (!t) return res.status(404).json({ error: 'no such track' });
    const rt = db.prepare("SELECT * FROM research WHERE entity_type='track' AND entity_id=?").get(t.jellyfin_id);
    const ra = t.canonical_id ? db.prepare("SELECT * FROM research WHERE entity_type='artist' AND entity_id=? AND stage IN ('done','draft')").get(t.canonical_id) : null;
    const rb = t.album_id ? db.prepare("SELECT * FROM research WHERE entity_type='album' AND entity_id=? AND stage IN ('done','draft')").get(t.album_id) : null;
    const facts = [];
    const push = (s, kind) => { if (s && typeof s === 'string' && s.trim()) facts.push({ text: s.trim(), kind }); };
    if (t.original_year && t.album_year_r && t.original_year < t.album_year_r - 1) push(`First released in ${t.original_year}; this version comes from the ${t.album_year_r} ${t.release_type === 'compilation' ? 'compilation' : 'release'} "${t.album_title}".`, 'year');
    else if (t.original_year) push(`Released in ${t.original_year}.`, 'year');
    if (t.is_cover) push(`A cover${t.original_artist ? ` of ${t.original_artist}` : ''}.`, 'cover');
    for (const h of pj(rt?.dj_hooks_json, [])) push(h, 'track');
    if (rt?.blurb && rt.model !== 'template') push(rt.blurb, 'track');
    for (const h of pj(rb?.dj_hooks_json, [])) push(h, 'album');
    if (rb?.blurb) push(rb.blurb, 'album');
    for (const h of pj(ra?.dj_hooks_json, [])) push(h, 'artist');
    if (ra?.blurb) push(ra.blurb, 'artist');
    if (ra?.origin || ra?.era) push([ra.origin ? `From ${ra.origin}` : null, ra.era ? `active ${ra.era}` : null].filter(Boolean).join(', ') + '.', 'artist');
    const genres = pj(t.genres_json, []); if (genres.length) push(`Genres: ${genres.slice(0, 4).join(', ')}.`, 'genre');
    const moods = pj(ra?.moods_json, []); if (moods.length) push(`Moods: ${moods.slice(0, 5).join(', ')}.`, 'mood');
    res.json({ track: { id: t.jellyfin_id, title: t.resolved_title || t.tag_title, artist: t.artist_name, album: t.album_title, year: t.original_year, artist_id: t.canonical_id, album_id: t.album_id }, facts, artist_summary: ra?.summary || null, album_summary: rb?.summary || null });
  });

  r.get('/api/search', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    const rows = await search(db, { query: q, type: String(req.query.type || 'track'), k: Number(req.query.k) || 20, yearFrom: req.query.from && Number(req.query.from), yearTo: req.query.to && Number(req.query.to), maxPerArtist: req.query.perArtist && Number(req.query.perArtist) });
    res.json(rows);
  }));

  r.get('/api/voices', wrap(async (req, res) => res.json({ current: config.kokoro.voice, voices: await listVoices() })));

  r.get('/api/stats', (req, res) => {
    const c = (sql) => db.prepare(sql).get().n;
    res.json({
      tracks: c('SELECT COUNT(*) n FROM tracks WHERE removed_at IS NULL'), albums: c('SELECT COUNT(*) n FROM albums WHERE removed_at IS NULL'), artists: c('SELECT COUNT(*) n FROM artists WHERE removed_at IS NULL AND canonical_id = jellyfin_id'),
      researched_artists: c("SELECT COUNT(*) n FROM research WHERE entity_type='artist' AND stage IN ('done','draft')"), researched_albums: c("SELECT COUNT(*) n FROM research WHERE entity_type='album' AND stage IN ('done','draft')"),
      embedded_tracks: c("SELECT COUNT(*) n FROM embeddings WHERE entity_type='track'"), resolved_tracks: c("SELECT COUNT(*) n FROM tracks WHERE removed_at IS NULL AND resolution <> 'tag_only'"),
      dj_ready: Boolean(config.openrouter.apiKey),
    });
  });

  return r;
}

// Untagged rips show their filename as a title ("07-rob_zombie-feel_so_numb-pms"); tidy that for display only.
export function prettyTitle(title, artist) {
  let t = String(title || '');
  if (!/_/.test(t) && !/^\d{1,3}[-. ]/.test(t)) return t;
  t = t.replace(/^\d{1,3}[-._ ]+/, '').replace(/[-_]pms$/i, '').replace(/[_]+/g, ' ').replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim();
  if (artist) {
    const a = String(artist).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const tl = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (a && tl.startsWith(a + ' ')) t = t.slice(t.toLowerCase().indexOf(a) + a.length).replace(/^[\s\-–:]+/, '');
  }
  return t.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function decorate(it) {
  if (!it) return it;
  if (it.kind === 'track') it = { ...it, title: prettyTitle(it.title, it.artist) };
  const base = { id: it.id, position: it.position, kind: it.kind, status: it.status, reason: it.reason || null };
  if (it.kind === 'patter') return { ...base, text: it.patter_text || it.why, url: it.patter_hash ? `/tts/${it.patter_hash}?q=${it.id}` : null, duration_s: it.patter_duration };
  return { ...base, track_id: it.track_id, title: it.title, artist: it.artist, album: it.album, year: it.year, album_id: it.album_id, artist_id: it.artist_id, duration_s: it.duration_s, why: it.why, feedback: it.feedback || null,
    url: `/stream/${it.track_id}?q=${it.id}`, art: it.album_id ? `/art/album/${it.album_id}` : `/art/track/${it.track_id}`, artist_art: it.artist_id ? `/art/artist/${it.artist_id}` : null };
}
