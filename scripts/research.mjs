// Research queue CLI. Run `npm run research -- status` first in every session.
//
//   status                                   counts per type/stage, open batches, un-ingested result dirs, next entities
//   packets --type artist|album|track [--limit N] [--ids a,b,c] [--upgrade-drafts] [--min-tracks N] [--max-tracks N] [--light] [--per-agent K]
//                                            (also writes one ready-to-run subagent prompt file per agent into data/packets/<batch>/)
//                                            claim next N pending, build packets -> data/packets/<batch>.json (+ empty results dir)
//   ingest <dir>|--all                       validate + ingest data/results/<batch>/*.json
//   derive                                   template summaries for every non-notable track (idempotent)
//   notable [--cap 0.15]                     flag notable tracks for Claude research
//   bulk --type X [--limit N] [--model M]    OpenRouter first-pass drafts
//   reset-stale | retry-failed | skip <type> <id> "<reason>"
//   schema <type>                            print instructions + schema for subagents
import fs from 'node:fs';
import path from 'node:path';
import { openDb, closeDb } from '../src/db/open.mjs';
import { config } from '../src/config.mjs';
import { nextPending, claim, batchId, resetStale, retryFailed, skip, status } from '../src/research/queue.mjs';
import { buildPackets } from '../src/research/packet.mjs';
import { writePromptFiles } from '../src/research/promptfiles.mjs';
import { ingestDir, ingestAll } from '../src/research/ingest.mjs';
import { deriveTracks } from '../src/research/derive.mjs';
import { flagNotable } from '../src/research/notable.mjs';
import { bulkResearch } from '../src/research/bulk.mjs';
import { instructions } from '../src/research/prompts.mjs';
import { log } from '../src/util/log.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => { const i = rest.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`)); if (i < 0) return dflt; const a = rest[i]; return a.includes('=') ? a.split('=').slice(1).join('=') : rest[i + 1]; };
const flag = (name) => rest.includes(`--${name}`);

function printStatus(db) {
  const s = status(db);
  for (const t of ['artist', 'album', 'track']) {
    const st = s.byType[t] || {};
    console.log(`${t.padEnd(7)} ` + ['pending', 'packet', 'draft', 'derived', 'done', 'failed', 'skipped'].map((k) => `${k}=${st[k] || 0}`).join('  '));
  }
  const tiers = s.tiers.filter((x) => x.tier === 'notable');
  if (tiers.length) console.log('track notable tier: ' + tiers.map((x) => `${x.stage}=${x.n}`).join('  '));
  if (s.openBatches.length) { console.log('open batches (claimed, awaiting results):'); for (const b of s.openBatches) console.log(`  ${b.batch_id}  ${b.n} entities  claimed ${b.claimed_at}`); }
  if (s.pendingResultDirs.length) { console.log('result files NOT yet ingested:'); for (const d of s.pendingResultDirs) console.log(`  data/results/${d.batch}  (${d.files} files)  -> npm run research -- ingest data/results/${d.batch}`); }
  for (const t of ['artist', 'album', 'track']) if (s.next[t].length) console.log(`next ${t}s: ` + s.next[t].map((x) => `${x.name}${x.tier === 'notable' ? '*' : ''}`).join(' | '));
}

try {
  const db = openDb();
  if (!cmd || cmd === 'status') printStatus(db);
  else if (cmd === 'packets') {
    const type = opt('type');
    if (!['artist', 'album', 'track'].includes(type)) throw new Error('--type artist|album|track required');
    const limit = Number(opt('limit', type === 'artist' ? 10 : 20));
    const ids = opt('ids') ? opt('ids').split(',').map((s) => s.trim()).filter(Boolean) : null;
    const light = flag('light');
    const rows = nextPending(db, type, limit, { ids, tier: type === 'track' ? 'notable' : undefined, upgradeDrafts: flag('upgrade-drafts'),
      minTracks: opt('min-tracks') != null ? Number(opt('min-tracks')) : undefined, maxTracks: opt('max-tracks') != null ? Number(opt('max-tracks')) : undefined });
    if (!rows.length) { console.log(`nothing pending for ${type}`); }
    else {
      const batch = batchId(type);
      claim(db, type, rows.map((r) => r.entity_id), batch);
      const r = await buildPackets(db, type, rows, batch);
      console.log(`\nBATCH ${batch}: ${r.entities.length} ${type}(s)`);
      console.log(`  packet file : ${r.file}`);
      console.log(`  results dir : ${r.dir}`);
      const packet = JSON.parse(fs.readFileSync(r.file, 'utf8'));
      const pf = writePromptFiles(type, packet, { tier: light ? 'light' : 'deep', perAgent: opt('per-agent') ? Number(opt('per-agent')) : undefined });
      console.log(`  agent model : ${pf.model}  (tier ${light ? 'light' : 'deep'})`);
      console.log('  prompt files (one agent each; agent prompt = "Read this file and do exactly what it says"):');
      for (const f of pf.files) console.log(`    ${f.file}   [${f.names.join(' | ')}]`);
    }
  }
  else if (cmd === 'ingest') {
    if (flag('all')) { const rs = ingestAll(db); if (!rs.length) console.log('nothing to ingest'); for (const r of rs) { console.log(`${r.batch}: ok=${r.ok} failed=${r.failed}`); r.errors.forEach((e) => console.log('   ' + e)); } }
    else { const dir = path.resolve(rest[0]); const r = ingestDir(db, dir); console.log(`${r.batch}: ok=${r.ok} failed=${r.failed}`); r.errors.forEach((e) => console.log('   ' + e)); }
  }
  else if (cmd === 'derive') console.log('derive', deriveTracks(db));
  else if (cmd === 'notable') console.log('notable', flagNotable(db, { cap: Number(opt('cap', 0.15)) }));
  else if (cmd === 'bulk') {
    const type = opt('type');
    if (!['artist', 'album', 'track'].includes(type)) throw new Error('--type required');
    const limit = Number(opt('limit', 20));
    const rows = nextPending(db, type, limit, { tier: type === 'track' ? 'notable' : undefined });
    if (!rows.length) console.log('nothing pending');
    else {
      const batch = batchId(type) + '-bulk';
      claim(db, type, rows.map((r) => r.entity_id), batch);
      const p = await buildPackets(db, type, rows, batch);
      const r = await bulkResearch(db, type, p.entities, { model: opt('model', config.openrouter.bulkModel), concurrency: Number(opt('concurrency', 4)) });
      console.log('bulk', { ok: r.ok, failed: r.failed }); r.errors.forEach((e) => console.log('   ' + e));
      try { fs.rmdirSync(p.dir); } catch { /* not empty or missing */ }
    }
  }
  else if (cmd === 'reset-stale') console.log(`released ${resetStale(db)} stale claims`);
  else if (cmd === 'retry-failed') console.log(`re-queued ${retryFailed(db, Number(opt('max-attempts', 3)))} failed rows`);
  else if (cmd === 'skip') console.log(`skipped ${skip(db, rest[0], rest[1], rest.slice(2).join(' ') || 'manual skip')}`);
  else if (cmd === 'schema') console.log(instructions(rest[0] || 'artist'));
  else console.log('unknown command; see header of scripts/research.mjs');
  if (cmd && !['status', 'schema'].includes(cmd)) { console.log(''); printStatus(db); }
  closeDb();
  process.exit(0);
} catch (e) { log.error(e.stack || e.message); process.exit(1); }
