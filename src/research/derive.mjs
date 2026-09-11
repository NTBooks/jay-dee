// Template-derived track summaries (no LLM). Re-runnable: regenerates when inputs change (hash),
// never touches tracks whose research stage is 'done' (notable tracks researched by Claude).
import { j, pj } from '../db/open.mjs';
import { sha256, nowIso } from '../util/hash.mjs';

const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : null);

export function deriveTrackText(t) {
  const artist = t.artist_name || 'Unknown artist';
  const title = t.title;
  const parts = [];
  let head = `"${title}" by ${artist}`;
  if (t.album_title) head += `, from ${t.album_type === 'compilation' ? 'the compilation' : t.album_type === 'soundtrack' ? 'the soundtrack' : t.album_type === 'live' ? 'the live album' : t.album_type === 'single' ? 'the single' : t.album_type === 'ep' ? 'the EP' : 'the album'} "${t.album_title}"`;
  if (t.album_year && t.original_year && t.original_year < t.album_year - 1) head += ` (${t.album_year}); the recording was first released in ${t.original_year}`;
  else if (t.original_year) head += ` (${t.original_year})`;
  parts.push(head + '.');
  if (t.is_cover) parts.push(`A cover${t.original_artist ? ` of the ${t.original_artist} original` : ''}.`);
  const genres = pj(t.genres_json, []);
  if (genres.length) parts.push(`Genre: ${genres.slice(0, 4).join(', ')}.`);
  if (t.artist_blurb) parts.push(`About the artist: ${t.artist_blurb}`);
  if (t.artist_moods) { const m = pj(t.artist_moods, []); if (m.length) parts.push(`Typical moods: ${m.slice(0, 6).join(', ')}.`); }
  if (t.artist_era || t.artist_origin) parts.push([t.artist_origin, t.artist_era].filter(Boolean).join(', ') + '.');
  if (t.album_blurb) parts.push(`About the album: ${t.album_blurb}`);
  if (t.duration_s) parts.push(`Runs ${fmtDur(t.duration_s)}.`);
  return parts.join(' ');
}

export function deriveTracks(db, { limit = 1000000 } = {}) {
  const rows = db.prepare(`SELECT r.entity_id, r.stage, r.result_hash, r.tier,
      COALESCE(t.resolved_title, t.tag_title) title, COALESCE(t.resolved_artist, ar.resolved_name, ar.tag_name, t.tag_album_artist) artist_name,
      t.original_year, t.album_year, t.duration_s, t.genres_json, t.is_cover, t.original_artist,
      COALESCE(al.resolved_title, al.tag_name) album_title, al.release_type album_type,
      ra.blurb artist_blurb, ra.moods_json artist_moods, ra.era artist_era, ra.origin artist_origin, ra.energy artist_energy, ra.genres_json artist_genres,
      rb.blurb album_blurb, rb.moods_json album_moods, rb.energy album_energy
    FROM research r
    JOIN tracks t ON t.jellyfin_id = r.entity_id
    LEFT JOIN albums al ON al.jellyfin_id = t.album_id
    LEFT JOIN artists ar ON ar.jellyfin_id = t.album_artist_id
    LEFT JOIN research ra ON ra.entity_type = 'artist' AND ra.entity_id = COALESCE(ar.canonical_id, ar.jellyfin_id) AND ra.stage IN ('done','draft')
    LEFT JOIN research rb ON rb.entity_type = 'album' AND rb.entity_id = t.album_id AND rb.stage IN ('done','draft')
    WHERE r.entity_type = 'track' AND r.stage IN ('pending','derived') AND (r.tier = 'derived' OR r.tier IS NULL) AND t.removed_at IS NULL
    LIMIT ?`).all(limit);
  const upd = db.prepare(`UPDATE research SET stage='derived', tier='derived', summary=?, blurb=?, genres_json=?, moods_json=?, era=?, origin=?, energy=?, model='template', result_hash=?, updated_at=?, batch_id=NULL, claimed_at=NULL
    WHERE entity_type='track' AND entity_id=?`);
  let changed = 0, same = 0;
  const tx = db.transaction(() => {
    for (const t of rows) {
      const text = deriveTrackText(t);
      const hash = sha256(text);
      if (t.stage === 'derived' && t.result_hash === hash) { same++; continue; }
      const moods = pj(t.album_moods, null) || pj(t.artist_moods, []);
      const genres = pj(t.genres_json, null) || pj(t.artist_genres, []);
      const blurb = `${t.title} by ${t.artist_name || 'unknown'}${t.original_year ? ` (${t.original_year})` : ''}`;
      upd.run(text, blurb, j(genres), j(moods), t.artist_era || null, t.artist_origin || null, t.album_energy ?? t.artist_energy ?? null, hash, nowIso(), t.entity_id);
      changed++;
    }
  });
  tx();
  return { candidates: rows.length, changed, unchanged: same };
}
