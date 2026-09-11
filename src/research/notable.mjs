// Flag "notable" tracks that deserve their own Claude research pass (tier 'notable').
import { j, pj } from '../db/open.mjs';
import { titleKey } from '../util/normalize.mjs';
import { mentions } from './taste.mjs';
import { nowIso } from '../util/hash.mjs';

export function flagNotable(db, { cap = 0.15 } = {}) {
  const tracks = db.prepare(`SELECT t.jellyfin_id, COALESCE(t.resolved_title, t.tag_title) title, t.title_key, t.is_cover, t.tag_title, t.album_artist_id,
      al.release_type, al.is_compilation, ar.track_count artist_tracks, ar.canonical_id, r.stage, r.tier
    FROM tracks t
    LEFT JOIN albums al ON al.jellyfin_id = t.album_id
    LEFT JOIN artists ar ON ar.jellyfin_id = t.album_artist_id
    JOIN research r ON r.entity_type = 'track' AND r.entity_id = t.jellyfin_id
    WHERE t.removed_at IS NULL AND r.stage <> 'done'`).all();
  // artist packet knowledge: wikipedia extract + last.fm top tracks
  const artistPackets = new Map();
  for (const r of db.prepare("SELECT entity_id, packet_json FROM research WHERE entity_type='artist' AND packet_json IS NOT NULL").all()) {
    const p = pj(r.packet_json, {});
    artistPackets.set(r.entity_id, { extract: (p.wikipedia?.extract || '').toLowerCase(), top: new Set((p.lastfm?.top_tracks || []).map(titleKey)) });
  }
  const scored = [];
  for (const t of tracks) {
    const reasons = [];
    if (t.release_type === 'single') reasons.push('released as a single');
    if (t.artist_tracks != null && t.artist_tracks <= 3 && !t.is_compilation) reasons.push('seed artist (<=3 tracks in library)');
    if (t.is_cover || /\bcover\b|\bparody\b/i.test(t.tag_title || '')) reasons.push('cover/parody');
    const ap = artistPackets.get(t.canonical_id);
    if (ap && t.title.length >= 5 && ap.extract.includes(t.title.toLowerCase())) reasons.push('named in artist Wikipedia summary');
    if (ap && ap.top.has(t.title_key)) reasons.push('Last.fm top track for artist');
    if (t.title.length >= 6 && mentions(t.title, { max: 1 }).length) reasons.push('mentioned in taste profile');
    if (reasons.length) scored.push({ id: t.jellyfin_id, reasons, score: reasons.length * 10 + Math.min(50, t.artist_tracks || 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  const max = Math.floor(tracks.length * cap);
  const chosen = scored.slice(0, max);
  const chosenIds = new Set(chosen.map((c) => c.id));
  const setNotable = db.prepare(`UPDATE research SET tier='notable', stage=CASE WHEN stage IN ('derived','pending') THEN 'pending' ELSE stage END, priority=?, extra_json=?, updated_at=?
    WHERE entity_type='track' AND entity_id=?`);
  const unsetNotable = db.prepare(`UPDATE research SET tier='derived', stage=CASE WHEN stage='pending' THEN 'derived' ELSE stage END, priority=0 WHERE entity_type='track' AND entity_id=? AND tier='notable' AND stage<>'done'`);
  const tx = db.transaction(() => {
    for (const c of chosen) {
      const extra = pj(db.prepare("SELECT extra_json FROM research WHERE entity_type='track' AND entity_id=?").get(c.id)?.extra_json, {});
      setNotable.run(c.score, j({ ...extra, notable_reasons: c.reasons }), nowIso(), c.id);
    }
    for (const t of tracks) if (t.tier === 'notable' && !chosenIds.has(t.jellyfin_id)) unsetNotable.run(t.jellyfin_id);
  });
  tx();
  const byReason = {};
  for (const c of chosen) for (const r of c.reasons) byReason[r] = (byReason[r] || 0) + 1;
  return { considered: tracks.length, candidates: scored.length, flagged: chosen.length, byReason };
}
