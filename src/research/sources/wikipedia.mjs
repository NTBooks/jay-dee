// Wikipedia REST API (no key, generous limits). Used for summaries + page images.
import { fetchJson } from '../../util/http.mjs';
import { config } from '../../config.mjs';

const headers = () => ({ 'user-agent': config.musicbrainz.userAgent, 'api-user-agent': config.musicbrainz.userAgent });

export function titleFromUrl(url) {
  const m = /wikipedia\.org\/wiki\/([^#?]+)/.exec(url || '');
  return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : null;
}

export async function summary(title) {
  if (!title) return null;
  const r = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, { headers: headers(), retries: 2, timeoutMs: 15_000 });
  if (!r || r.type === 'disambiguation') return null;
  return { title: r.title, extract: r.extract, url: r.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title)}`, image: r.originalimage?.source || r.thumbnail?.source || null, description: r.description || null };
}

// Search for an artist/album page when MusicBrainz has no wikipedia link. Returns summary or null.
export async function findMusicPage(name, kind = 'artist') {
  const q = kind === 'artist' ? `${name} band OR musician OR singer OR rapper OR composer` : `${name} album`;
  const r = await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=${encodeURIComponent(q)}`, { headers: headers(), retries: 2, timeoutMs: 15_000 });
  const hits = r?.query?.search || [];
  const want = name.toLowerCase();
  for (const h of hits) {
    const t = h.title.toLowerCase();
    const base = t.replace(/\s*\(.*\)$/, '');
    if (base !== want && !t.startsWith(want)) continue;
    const s = await summary(h.title);
    if (!s) continue;
    const text = `${s.description || ''} ${s.extract || ''}`.toLowerCase();
    const ok = kind === 'artist' ? /band|musician|singer|rapper|composer|duo|group|producer|dj|songwriter|project/.test(text) : /album|ep|soundtrack|mixtape|record/.test(text);
    if (ok) return s;
  }
  return null;
}
