// Bulk first-pass research through OpenRouter (cheap model). Writes stage='draft' rows; a later deep pass upgrades them.
import { chat } from '../llm/openrouter.mjs';
import { instructions } from './prompts.mjs';
import { ingestResult } from './ingest.mjs';
import { doctrineRules } from './taste.mjs';
import { config } from '../config.mjs';
import { log } from '../util/log.mjs';
import { safeErr } from '../util/http.mjs';
import { nowIso } from '../util/hash.mjs';

export async function bulkResearch(db, type, entities, { model = config.openrouter.bulkModel, concurrency = 4 } = {}) {
  const system = `${instructions(type)}\n\nLISTENER DOCTRINE (context only; do not quote):\n${doctrineRules().slice(0, 3000)}`;
  const results = { ok: 0, failed: 0, errors: [] };
  const queue = entities.slice();
  const fail = db.prepare("UPDATE research SET attempts = attempts + 1, last_error = ?, stage = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END, batch_id = NULL, claimed_at = NULL, updated_at = ? WHERE entity_type = ? AND entity_id = ?");
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      try {
        const r = await chat({ model, purpose: 'research-bulk', system, json: true, temperature: 0.4, maxTokens: 2500, messages: [{ role: 'user', content: `PACKET:\n${JSON.stringify(p)}\n\nReturn the ${type}.v1 JSON now.` }] });
        const res = ingestResult(db, type, { ...r.json, entity_id: p.entity_id }, { model: r.model || model, stage: 'draft' });
        if (res.ok) { results.ok++; log.info(`draft ${type}: ${p.name || p.title}`); }
        else { results.failed++; results.errors.push(`${p.entity_id}: ${res.errors.join('; ')}`); fail.run(res.errors.join('; ').slice(0, 300), nowIso(), type, p.entity_id); }
      } catch (e) {
        results.failed++; results.errors.push(`${p.entity_id}: ${safeErr(e)}`);
        fail.run(safeErr(e).slice(0, 300), nowIso(), type, p.entity_id);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entities.length) }, worker));
  return results;
}
