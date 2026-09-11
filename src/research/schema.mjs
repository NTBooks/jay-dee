// Strict-ish validation of research results. Returns { ok, errors, value } with light normalization.
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const isStr = (v) => typeof v === 'string';
const arrOfStr = (v) => Array.isArray(v) && v.every(isStr);

function base(r, errors) {
  if (!r || typeof r !== 'object') { errors.push('not an object'); return; }
  if (!isStr(r.entity_id) || !r.entity_id) errors.push('entity_id missing');
  if (!isStr(r.summary) || words(r.summary) < 20) errors.push('summary too short (<20 words)');
  if (isStr(r.summary) && words(r.summary) > 400) errors.push('summary too long (>400 words)');
  if (!isStr(r.blurb) || !r.blurb.trim()) errors.push('blurb missing');
  if (!arrOfStr(r.moods) || r.moods.length < 1) errors.push('moods must be a non-empty string array');
  if (!Array.isArray(r.dj_hooks) || r.dj_hooks.length < 1 || !r.dj_hooks.every(isStr)) errors.push('dj_hooks must be a non-empty string array');
  if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) errors.push('confidence must be 0-1');
  if (!Array.isArray(r.sources)) errors.push('sources must be an array');
  if (r.energy != null && (typeof r.energy !== 'number' || r.energy < 1 || r.energy > 5)) errors.push('energy must be 1-5');
}

export function validate(type, r) {
  const errors = [];
  base(r, errors);
  if (errors.length && errors[0] === 'not an object') return { ok: false, errors };
  if (type === 'artist') {
    if (!arrOfStr(r.genres) || r.genres.length < 1) errors.push('genres must be a non-empty string array');
    if (!isStr(r.era)) errors.push('era missing');
    if (r.active_from != null && typeof r.active_from !== 'number') errors.push('active_from must be a number or null');
    if (r.key_albums != null && !arrOfStr(r.key_albums)) errors.push('key_albums must be string array');
    if (r.upstream != null && !arrOfStr(r.upstream)) errors.push('upstream must be string array');
    if (r.tags != null && !arrOfStr(r.tags)) errors.push('tags must be string array');
  } else if (type === 'album') {
    if (!arrOfStr(r.genres) || r.genres.length < 1) errors.push('genres must be a non-empty string array');
    if (r.year != null && (typeof r.year !== 'number' || r.year < 1900 || r.year > 2100)) errors.push('year invalid');
    if (r.notable_tracks != null && !arrOfStr(r.notable_tracks)) errors.push('notable_tracks must be string array');
    if (r.album_type != null && !isStr(r.album_type)) errors.push('album_type must be string');
  } else if (type === 'track') {
    if (r.original_year != null && (typeof r.original_year !== 'number' || r.original_year < 1900 || r.original_year > 2100)) errors.push('original_year invalid');
    if (r.is_cover != null && typeof r.is_cover !== 'boolean') errors.push('is_cover must be boolean');
    if (r.themes != null && !arrOfStr(r.themes)) errors.push('themes must be string array');
  } else errors.push(`unknown type ${type}`);
  const value = errors.length ? null : normalize(type, r);
  return { ok: errors.length === 0, errors, value };
}

function normalize(type, r) {
  const lc = (a) => (a || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = { ...r, genres: lc(r.genres), moods: lc(r.moods), tags: lc(r.tags || r.themes), dj_hooks: r.dj_hooks.map((s) => s.trim()).filter(Boolean) };
  if (type === 'track') out.themes = lc(r.themes);
  return out;
}
