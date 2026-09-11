// Embedding build (hash-gated) + in-process cosine search over float32 blobs.
import { getEmbedder } from './model.mjs';
import { buildEmbedText, EMBED_SQL } from './text.mjs';
import { sha256, nowIso } from '../util/hash.mjs';
import { log } from '../util/log.mjs';
import { libraryFilterSql } from '../db/libraries.mjs';

export async function embedPending(db, { type, limit = 1000000, batch = 32 } = {}) {
  const types = type ? [type] : ['artist', 'album', 'track'];
  const embedder = await getEmbedder();
  const result = {};
  for (const t of types) {
    const rows = db.prepare(`${EMBED_SQL[t]} LIMIT ?`).all(limit);
    const existing = new Map(db.prepare('SELECT entity_id, text_hash, model FROM embeddings WHERE entity_type = ?').all(t).map((r) => [r.entity_id, r]));
    const todo = [];
    for (const r of rows) {
      const text = buildEmbedText(t, r);
      const hash = sha256(text);
      const ex = existing.get(r.entity_id);
      if (ex && ex.text_hash === hash && ex.model === embedder.name) continue;
      todo.push({ id: r.entity_id, rid: r.rid, text, hash });
    }
    const upsert = db.prepare(`INSERT INTO embeddings(entity_type, entity_id, rid, text_hash, model, dims, vector, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET rid=excluded.rid, text_hash=excluded.text_hash, model=excluded.model, dims=excluded.dims, vector=excluded.vector, updated_at=excluded.updated_at`);
    let done = 0;
    for (let i = 0; i < todo.length; i += batch) {
      const chunk = todo.slice(i, i + batch);
      const vecs = await embedder.embed(chunk.map((c) => c.text));
      const tx = db.transaction(() => {
        chunk.forEach((c, k) => upsert.run(t, c.id, c.rid, c.hash, embedder.name, vecs[k].length, Buffer.from(vecs[k].buffer, vecs[k].byteOffset, vecs[k].byteLength), nowIso()));
      });
      tx();
      done += chunk.length;
      if (done % (batch * 10) === 0 || done === todo.length) log.info(`${t}: embedded ${done}/${todo.length}`);
    }
    // drop embeddings whose research row vanished or entity removed
    result[t] = { candidates: rows.length, embedded: todo.length, unchanged: rows.length - todo.length };
    cache.delete(t);
  }
  return result;
}

const cache = new Map(); // type -> { ids, rids, vectors: Float32Array (n*dims), dims, loadedAt }

export function loadVectors(db, type) {
  if (cache.has(type)) return cache.get(type);
  const rows = db.prepare('SELECT entity_id, dims, vector FROM embeddings WHERE entity_type = ?').all(type);
  if (!rows.length) { const empty = { ids: [], dims: 0, vectors: new Float32Array(0), n: 0 }; cache.set(type, empty); return empty; }
  const dims = rows[0].dims;
  const usable = rows.filter((r) => r.dims === dims);
  const vectors = new Float32Array(usable.length * dims);
  const ids = new Array(usable.length);
  usable.forEach((r, i) => { ids[i] = r.entity_id; vectors.set(new Float32Array(r.vector.buffer, r.vector.byteOffset, dims), i * dims); });
  const v = { ids, dims, vectors, n: usable.length, loadedAt: Date.now() };
  cache.set(type, v);
  return v;
}
export function invalidateVectorCache() { cache.clear(); }

export async function embedQuery(text) {
  const e = await getEmbedder();
  const [v] = await e.embed([`${e.queryPrefix}${text}`]);
  return v;
}

// Cosine similarity (vectors are normalized so it's a dot product). allow: optional Set of entity ids to consider.
export function knn(db, type, queryVec, { k = 50, allow = null, exclude = null } = {}) {
  const { ids, dims, vectors, n } = loadVectors(db, type);
  if (!n || dims !== queryVec.length) return [];
  const scores = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if ((allow && !allow.has(ids[i])) || (exclude && exclude.has(ids[i]))) { scores[i] = -Infinity; continue; }
    let s = 0; const off = i * dims;
    for (let d = 0; d < dims; d++) s += vectors[off + d] * queryVec[d];
    scores[i] = s;
  }
  const idx = [];
  for (let i = 0; i < n; i++) if (scores[i] !== -Infinity) idx.push(i);
  idx.sort((a, b) => scores[b] - scores[a]);
  return idx.slice(0, k).map((i) => ({ id: ids[i], score: scores[i] }));
}

// Filtered search returning hydrated rows. Filters read ONLY resolved columns.
export async function search(db, { query, type = 'track', k = 20, yearFrom, yearTo, excludeVetoed = true, excludeIds, artistIds, excludeArtistIds, maxPerArtist, minResolution = false }) {
  const q = await embedQuery(query);
  let allow = null;
  if (yearFrom || yearTo || excludeVetoed || artistIds || excludeArtistIds || minResolution || type !== 'artist') {
    const conds = ['removed_at IS NULL'];
    const params = [];
    if (type === 'track') {
      conds.push(libraryFilterSql(db, 'tracks'));
      if (yearFrom) { conds.push('COALESCE(original_year, album_year) >= ?'); params.push(yearFrom); }
      if (yearTo) { conds.push('COALESCE(original_year, album_year) <= ?'); params.push(yearTo); }
      if (excludeVetoed) conds.push('(album_artist_id IS NULL OR album_artist_id NOT IN (SELECT jellyfin_id FROM artists WHERE veto = 1))');
      if (artistIds?.length) { conds.push(`album_artist_id IN (${artistIds.map(() => '?').join(',')})`); params.push(...artistIds); }
      if (excludeArtistIds?.length) { conds.push(`(album_artist_id IS NULL OR album_artist_id NOT IN (SELECT jellyfin_id FROM artists WHERE canonical_id IN (${excludeArtistIds.map(() => '?').join(',')})))`); params.push(...excludeArtistIds); }
      if (minResolution) conds.push("resolution <> 'tag_only'");
      allow = new Set(db.prepare(`SELECT jellyfin_id FROM tracks WHERE ${conds.join(' AND ')}`).all(...params).map((r) => r.jellyfin_id));
    } else if (type === 'album') {
      conds.push(libraryFilterSql(db, 'albums'));
      if (yearFrom) { conds.push('year >= ?'); params.push(yearFrom); }
      if (yearTo) { conds.push('year <= ?'); params.push(yearTo); }
      if (excludeVetoed) conds.push('(album_artist_id IS NULL OR album_artist_id NOT IN (SELECT jellyfin_id FROM artists WHERE veto = 1))');
      allow = new Set(db.prepare(`SELECT jellyfin_id FROM albums WHERE ${conds.join(' AND ')}`).all(...params).map((r) => r.jellyfin_id));
    } else {
      if (excludeVetoed) conds.push('veto = 0');
      allow = new Set(db.prepare(`SELECT jellyfin_id FROM artists WHERE ${conds.join(' AND ')}`).all(...params).map((r) => r.jellyfin_id));
    }
  }
  const hits = knn(db, type, q, { k: maxPerArtist ? k * 4 : k, allow, exclude: excludeIds ? new Set(excludeIds) : null });
  const rows = hydrate(db, type, hits);
  if (!maxPerArtist) return rows.slice(0, k);
  const per = new Map(); const out = [];
  for (const r of rows) {
    const key = r.artist_id || r.artist;
    const c = per.get(key) || 0;
    if (c >= maxPerArtist) continue;
    per.set(key, c + 1); out.push(r);
    if (out.length >= k) break;
  }
  return out;
}

export function hydrate(db, type, hits) {
  if (!hits.length) return [];
  const sql = {
    track: `SELECT t.jellyfin_id id, COALESCE(t.resolved_title, t.tag_title) title, COALESCE(t.resolved_artist, ar.resolved_name, ar.tag_name, t.tag_album_artist) artist, ar.canonical_id artist_id,
              COALESCE(al.resolved_title, al.tag_name) album, t.album_id, t.original_year year, t.album_year, t.duration_s, t.container, t.resolution, t.genres_json, r.blurb, r.energy, r.moods_json
            FROM tracks t LEFT JOIN albums al ON al.jellyfin_id = t.album_id LEFT JOIN artists ar ON ar.jellyfin_id = t.album_artist_id
            LEFT JOIN research r ON r.entity_type='track' AND r.entity_id = t.jellyfin_id WHERE t.jellyfin_id = ?`,
    album: `SELECT al.jellyfin_id id, COALESCE(al.resolved_title, al.tag_name) title, COALESCE(ar.resolved_name, ar.tag_name) artist, ar.canonical_id artist_id, al.year, al.release_type, r.blurb, r.energy
            FROM albums al LEFT JOIN artists ar ON ar.jellyfin_id = al.album_artist_id LEFT JOIN research r ON r.entity_type='album' AND r.entity_id = al.jellyfin_id WHERE al.jellyfin_id = ?`,
    artist: `SELECT a.jellyfin_id id, COALESCE(a.resolved_name, a.tag_name) title, COALESCE(a.resolved_name, a.tag_name) artist, a.canonical_id artist_id, a.track_count, a.genres_json, r.blurb, r.era, r.energy
             FROM artists a LEFT JOIN research r ON r.entity_type='artist' AND r.entity_id = a.jellyfin_id WHERE a.jellyfin_id = ?`,
  }[type];
  const st = db.prepare(sql);
  return hits.map((h) => { const r = st.get(h.id); return r ? { ...r, score: Number(h.score.toFixed(4)) } : null; }).filter(Boolean);
}

export function embedStats(db) {
  const rows = db.prepare('SELECT entity_type, model, dims, COUNT(*) n FROM embeddings GROUP BY entity_type, model, dims').all();
  const research = db.prepare("SELECT entity_type, COUNT(*) n FROM research WHERE stage IN ('done','draft','derived') GROUP BY entity_type").all();
  return { embeddings: rows, embeddable: research };
}
