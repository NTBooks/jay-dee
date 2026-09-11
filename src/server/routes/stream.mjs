// Audio + art proxies. The browser never sees the Jellyfin API key.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from '../../config.mjs';
import { log } from '../../util/log.mjs';

const NATIVE = new Set(['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'mp4', 'oga', 'webm']);
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

async function proxy(res, upstream, { cacheControl } = {}) {
  res.status(upstream.status);
  for (const h of PASS_HEADERS) { const v = upstream.headers.get(h); if (v) res.setHeader(h, v); }
  if (cacheControl) res.setHeader('cache-control', cacheControl);
  if (!upstream.body) return res.end();
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => res.end());
  stream.pipe(res);
}

export function streamRoutes({ db, jf }) {
  const r = express.Router();

  r.get('/stream/:id', async (req, res, next) => {
    try {
      const t = db.prepare('SELECT jellyfin_id, container FROM tracks WHERE jellyfin_id = ?').get(req.params.id);
      if (!t) return res.status(404).send('no such track');
      const ac = new AbortController();
      req.on('close', () => ac.abort());
      const native = NATIVE.has((t.container || '').toLowerCase());
      const url = native ? jf.streamUrl(t.jellyfin_id) : jf.universalUrl(t.jellyfin_id);
      const upstream = await jf.fetchRaw(url, { range: native ? req.headers.range : undefined, signal: ac.signal });
      if (!upstream.ok && upstream.status !== 206) return res.status(upstream.status).send('upstream error');
      if (!native) res.setHeader('x-jaydee-transcoded', '1');
      await proxy(res, upstream);
    } catch (e) { if (e.name !== 'AbortError') next(e); }
  });

  const artHandler = (kind) => async (req, res, next) => {
    try {
      const id = req.params.id;
      let candidates = [];
      if (kind === 'album') candidates = [jf.imageUrl(id, { type: 'Primary', maxWidth: 800 })];
      else if (kind === 'track') {
        const t = db.prepare('SELECT album_id, image_tag FROM tracks WHERE jellyfin_id = ?').get(id);
        candidates = [t?.album_id ? jf.imageUrl(t.album_id, { type: 'Primary', maxWidth: 800 }) : null, t?.image_tag ? jf.imageUrl(id, { type: 'Primary', maxWidth: 800 }) : null].filter(Boolean);
      } else {
        const a = db.prepare('SELECT jellyfin_id, canonical_id, image_tag, backdrop_tags_json, image_url_ext FROM artists WHERE jellyfin_id = ?').get(id);
        const ids = [...new Set([id, a?.canonical_id].filter(Boolean))];
        for (const aid of ids) {
          const row = db.prepare('SELECT image_tag, backdrop_tags_json FROM artists WHERE jellyfin_id = ?').get(aid);
          if (row?.backdrop_tags_json && row.backdrop_tags_json !== '[]') candidates.push(jf.imageUrl(aid, { type: 'Backdrop', index: 0, maxWidth: 1600 }));
          if (row?.image_tag) candidates.push(jf.imageUrl(aid, { type: 'Primary', maxWidth: 1200 }));
        }
        const local = path.join(config.dataDir, 'art', `artist-${a?.canonical_id || id}.jpg`);
        if (fs.existsSync(local)) { res.setHeader('cache-control', 'public, max-age=86400'); return res.sendFile(local); }
        if (a?.image_url_ext && /^https?:\/\//.test(a.image_url_ext)) candidates.push({ external: a.image_url_ext });
      }
      for (const c of candidates) {
        try {
          const upstream = typeof c === 'string' ? await jf.fetchRaw(c, { signal: AbortSignal.timeout(10000) }) : await fetch(c.external, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': config.musicbrainz.userAgent } });
          if (upstream.ok) return await proxy(res, upstream, { cacheControl: 'public, max-age=86400' });
        } catch { /* try next */ }
      }
      res.setHeader('cache-control', 'public, max-age=3600'); // stop the UI re-requesting missing art every poll
      res.status(404).end();
    } catch (e) { next(e); }
  };
  r.get('/art/album/:id', artHandler('album'));
  r.get('/art/track/:id', artHandler('track'));
  r.get('/art/artist/:id', artHandler('artist'));

  r.get('/tts/:hash', (req, res) => {
    const hash = String(req.params.hash).replace(/[^a-f0-9]/g, '');
    const file = path.join(config.dataDir, 'tts', `${hash}.mp3`);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.setHeader('cache-control', 'public, max-age=31536000');
    res.sendFile(file);
  });

  return r;
}
