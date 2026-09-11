// Last.fm (optional; needs LASTFM_API_KEY). Gives listener counts, top tags, wiki blurbs, top tracks.
import { fetchJson } from '../../util/http.mjs';
import { config } from '../../config.mjs';

const BASE = 'https://ws.audioscrobbler.com/2.0/';
const enabled = () => Boolean(config.lastfmKey);

async function call(params) {
  if (!enabled()) return null;
  const q = new URLSearchParams({ ...params, api_key: config.lastfmKey, format: 'json' });
  const r = await fetchJson(`${BASE}?${q}`, { retries: 2, timeoutMs: 15_000 });
  if (r?.error) return null;
  return r;
}

const strip = (s) => (s || '').replace(/<a href.*$/s, '').replace(/\s+Read more on Last\.fm.*$/s, '').trim();

export const lastfm = {
  enabled,
  async artist(name, mbid) {
    const r = await call({ method: 'artist.getInfo', ...(mbid ? { mbid } : { artist: name }), autocorrect: 1 });
    const a = r?.artist; if (!a) return null;
    const top = await call({ method: 'artist.getTopTracks', ...(mbid ? { mbid } : { artist: name }), limit: 10 });
    return { name: a.name, listeners: Number(a.stats?.listeners || 0), playcount: Number(a.stats?.playcount || 0), tags: (a.tags?.tag || []).map((t) => t.name), bio: strip(a.bio?.summary),
      similar: (a.similar?.artist || []).map((s) => s.name), top_tracks: (top?.toptracks?.track || []).map((t) => t.name) };
  },
  async album(artist, album, mbid) {
    const r = await call({ method: 'album.getInfo', ...(mbid ? { mbid } : { artist, album }), autocorrect: 1 });
    const a = r?.album; if (!a) return null;
    return { name: a.name, artist: a.artist, listeners: Number(a.listeners || 0), tags: (a.tags?.tag || []).map((t) => t.name), wiki: strip(a.wiki?.summary) };
  },
  async track(artist, track, mbid) {
    const r = await call({ method: 'track.getInfo', ...(mbid ? { mbid } : { artist, track }), autocorrect: 1 });
    const t = r?.track; if (!t) return null;
    return { name: t.name, artist: t.artist?.name, listeners: Number(t.listeners || 0), tags: (t.toptags?.tag || []).map((x) => x.name), wiki: strip(t.wiki?.summary) };
  },
};
