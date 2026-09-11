import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import { nameKey } from '../util/normalize.mjs';
import { pj } from '../db/open.mjs';

export function loadVetoes() {
  const p = path.join(config.dataDir, 'taste', 'vetoes.json');
  if (!fs.existsSync(p)) return [];
  return (pj(fs.readFileSync(p, 'utf8'), {}).vetoes || []).map((v) => ({ ...v, key: nameKey(v.name) }));
}

// Apply hard vetoes (weight 0) to artists.veto. Down-weights are read at candidate time.
export function applyVetoes(db) {
  const vetoes = loadVetoes();
  db.prepare('UPDATE artists SET veto = 0, veto_reason = NULL').run();
  const upd = db.prepare('UPDATE artists SET veto = 1, veto_reason = ? WHERE name_key = ? OR canonical_id IN (SELECT jellyfin_id FROM artists WHERE name_key = ?)');
  const hits = [];
  for (const v of vetoes) {
    if (v.weight > 0) continue;
    const n = upd.run(v.reason || 'veto', v.key, v.key).changes;
    hits.push({ name: v.name, matched: n });
  }
  return hits;
}
