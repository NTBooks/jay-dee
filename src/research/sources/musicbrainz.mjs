// MusicBrainz web service v2. Hard rate limit 1 req/s, descriptive User-Agent required.
import { config } from '../../config.mjs';
import { fetchJson, RateLimiter } from '../../util/http.mjs';

const BASE = 'https://musicbrainz.org/ws/2';
const limiter = new RateLimiter(1250);
const headers = () => ({ 'user-agent': config.musicbrainz.userAgent });

async function get(pathAndQuery) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  return fetchJson(`${BASE}/${pathAndQuery}${sep}fmt=json`, { headers: headers(), limiter, timeoutMs: 30_000, retries: 5, backoffMs: 3000 });
}

// Lucene escaping for search queries
export function lucene(s) {
  return String(s).replace(/([+\-!(){}\[\]^"~*?:\\\/&|])/g, '\\$1');
}

export const mb = {
  artist: (mbid) => get(`artist/${mbid}?inc=genres+tags+url-rels+aliases`),
  searchArtist: (name, limit = 5) => get(`artist?query=${encodeURIComponent(`artist:"${lucene(name)}"`)}&limit=${limit}`),
  release: (mbid) => get(`release/${mbid}?inc=recordings+artist-credits+release-groups+media+genres+tags`),
  releaseGroup: (mbid) => get(`release-group/${mbid}?inc=releases+artist-credits+genres+tags`),
  searchRelease: (q, limit = 5) => get(`release?query=${encodeURIComponent(q)}&limit=${limit}`),
  searchReleaseGroup: (q, limit = 5) => get(`release-group?query=${encodeURIComponent(q)}&limit=${limit}`),
  recording: (mbid) => get(`recording/${mbid}?inc=artist-credits+releases+release-groups+work-rels+genres+tags`),
  searchRecording: (q, limit = 5) => get(`recording?query=${encodeURIComponent(q)}&limit=${limit}`),
  browseReleaseGroups: (artistMbid, offset = 0) => get(`release-group?artist=${artistMbid}&limit=100&offset=${offset}&inc=genres`),
};

export function creditName(artistCredit) {
  if (!Array.isArray(artistCredit)) return null;
  return artistCredit.map((c) => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join('').trim() || null;
}
export function creditIds(artistCredit) {
  if (!Array.isArray(artistCredit)) return [];
  return artistCredit.map((c) => c.artist?.id).filter(Boolean);
}
export function yearOf(date) {
  if (!date) return null;
  const m = /^(\d{4})/.exec(String(date));
  return m ? Number(m[1]) : null;
}
export function topGenres(obj, n = 6) {
  const g = (obj?.genres && obj.genres.length ? obj.genres : obj?.tags) || [];
  return g.slice().sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, n).map((x) => x.name);
}
export function releaseType(rg) {
  const sec = (rg?.['secondary-types'] || []).map((s) => s.toLowerCase());
  const prim = (rg?.['primary-type'] || '').toLowerCase();
  if (sec.includes('soundtrack')) return 'soundtrack';
  if (sec.includes('compilation')) return 'compilation';
  if (sec.includes('live')) return 'live';
  if (sec.includes('remix')) return 'remix';
  if (prim === 'album') return 'album';
  if (prim === 'single') return 'single';
  if (prim === 'ep') return 'ep';
  return prim || 'other';
}
export function urlRels(entity) {
  const out = {};
  for (const r of entity?.relations || []) {
    if (r['target-type'] !== 'url' || !r.url?.resource) continue;
    const t = r.type;
    if (!out[t]) out[t] = r.url.resource;
  }
  return out;
}
