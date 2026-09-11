// Text to embed per entity. Reads ONLY resolved columns + research. Names first so they survive truncation.
import { pj } from '../db/open.mjs';

const list = (s) => pj(s, []).filter(Boolean).join(', ');

export function buildEmbedText(type, r) {
  const parts = [];
  if (type === 'artist') {
    parts.push(`Artist: ${r.name}`);
    if (r.origin) parts.push(`from ${r.origin}`);
    if (r.era) parts.push(`era ${r.era}`);
  } else if (type === 'album') {
    parts.push(`Album: ${r.name} by ${r.artist_name || 'unknown'}`);
    if (r.year) parts.push(`released ${r.year}`);
    if (r.release_type) parts.push(r.release_type);
  } else {
    parts.push(`Track: ${r.name} by ${r.artist_name || 'unknown'}`);
    if (r.album_name) parts.push(`on ${r.album_name}`);
    if (r.original_year) parts.push(`(${r.original_year})`);
  }
  const g = list(r.genres_json); if (g) parts.push(`genres: ${g}`);
  const m = list(r.moods_json); if (m) parts.push(`moods: ${m}`);
  const t = list(r.tags_json); if (t) parts.push(`tags: ${t}`);
  if (r.energy) parts.push(`energy ${r.energy}/5`);
  const head = parts.join(' | ');
  return `${head}\n${r.blurb || ''}\n${(r.summary || '').slice(0, 1800)}`.trim();
}

// Rows for embedding: research joined to entity, resolved names only.
export const EMBED_SQL = {
  artist: `SELECT r.entity_id, r.summary, r.blurb, r.genres_json, r.moods_json, r.tags_json, r.era, r.origin, r.energy, r.stage,
             COALESCE(a.resolved_name, a.tag_name) name, NULL artist_name, a.rid
           FROM research r JOIN artists a ON a.jellyfin_id = r.entity_id
           WHERE r.entity_type='artist' AND r.stage IN ('done','draft') AND a.removed_at IS NULL`,
  album: `SELECT r.entity_id, r.summary, r.blurb, r.genres_json, r.moods_json, r.tags_json, r.era, r.origin, r.energy, r.stage,
            COALESCE(al.resolved_title, al.tag_name) name, COALESCE(ar.resolved_name, ar.tag_name, al.tag_album_artist_name) artist_name, al.year, al.release_type, al.rid
          FROM research r JOIN albums al ON al.jellyfin_id = r.entity_id LEFT JOIN artists ar ON ar.jellyfin_id = al.album_artist_id
          WHERE r.entity_type='album' AND r.stage IN ('done','draft') AND al.removed_at IS NULL`,
  track: `SELECT r.entity_id, r.summary, r.blurb, r.genres_json, r.moods_json, r.tags_json, r.era, r.origin, r.energy, r.stage,
            COALESCE(t.resolved_title, t.tag_title) name, COALESCE(t.resolved_artist, ar.resolved_name, ar.tag_name, t.tag_album_artist) artist_name,
            COALESCE(al.resolved_title, al.tag_name) album_name, t.original_year, t.rid
          FROM research r JOIN tracks t ON t.jellyfin_id = r.entity_id LEFT JOIN albums al ON al.jellyfin_id = t.album_id LEFT JOIN artists ar ON ar.jellyfin_id = t.album_artist_id
          WHERE r.entity_type='track' AND r.stage IN ('done','draft','derived') AND t.removed_at IS NULL`,
};
