// Environment + connectivity check. Never prints secrets.
import fs from 'node:fs';
import { config } from '../src/config.mjs';
import { openDb, closeDb } from '../src/db/open.mjs';

const ok = (m) => console.log(`  OK   ${m}`);
const warn = (m) => console.log(`  WARN ${m}`);
const bad = (m) => { console.log(`  FAIL ${m}`); failures++; };
let failures = 0;

console.log(`Jay Dee doctor  (root: ${config.root})`);

// .env
if (!config.jellyfin.apiKey || config.jellyfin.apiKey.length < 20) bad('JELLYFIN_API_KEY missing or placeholder in .env');
else ok(`JELLYFIN_API_KEY present (${config.jellyfin.apiKey.length} chars)`);
if (!config.openrouter.apiKey) warn('OPENROUTER_API_KEY not set (DJ planner, bulk research and openrouter embeddings unavailable until set)');
else ok('OPENROUTER_API_KEY present');
if (fs.existsSync(config.tasteProfilePath)) ok(`taste profile found: ${config.tasteProfilePath}`);
else warn(`taste profile not found at ${config.tasteProfilePath} (run the jaydee-taste skill or copy export-skills/templates/profile.template.md there)`);

// sqlite
try {
  const db = openDb();
  const v = db.prepare('select sqlite_version() v').get().v;
  const n = db.prepare("select count(*) n from sqlite_master where type='table'").get().n;
  ok(`sqlite ${v}, ${n} tables at ${config.dbPath}`);
  closeDb();
} catch (e) { bad(`sqlite: ${e.message}`); }

// Jellyfin
try {
  const r = await fetch(`${config.jellyfin.url}/System/Info`, { headers: { 'X-Emby-Token': config.jellyfin.apiKey }, signal: AbortSignal.timeout(8000) });
  if (r.ok) { const i = await r.json(); ok(`Jellyfin ${i.Version} "${i.ServerName}" at ${config.jellyfin.url}`); }
  else bad(`Jellyfin responded ${r.status} (key rejected?)`);
} catch (e) { bad(`Jellyfin unreachable: ${e.message}`); }

// Kokoro
try {
  const r = await fetch(`${config.kokoro.url}/v1/audio/voices`, { signal: AbortSignal.timeout(8000) });
  if (r.ok) {
    const v = await r.json();
    const names = (v.voices || []).map((x) => x.id || x);
    const has = names.includes(config.kokoro.voice);
    ok(`Kokoro at ${config.kokoro.url}: ${names.length} voices${has ? '' : ` (WARN: DJ_VOICE ${config.kokoro.voice} not in list)`}`);
  } else bad(`Kokoro responded ${r.status}`);
} catch (e) { bad(`Kokoro unreachable: ${e.message}`); }

// OpenRouter
if (config.openrouter.apiKey) {
  try {
    const r = await fetch(`${config.openrouter.baseUrl}/models`, { headers: { authorization: `Bearer ${config.openrouter.apiKey}` }, signal: AbortSignal.timeout(10000) });
    if (r.ok) { const m = await r.json(); const ids = new Set((m.data || []).map((x) => x.id)); ok(`OpenRouter reachable; model ${config.openrouter.model} ${ids.has(config.openrouter.model) ? 'available' : 'NOT FOUND'}`); }
    else bad(`OpenRouter responded ${r.status}`);
  } catch (e) { bad(`OpenRouter: ${e.message}`); }
}

// MusicBrainz
try {
  const r = await fetch('https://musicbrainz.org/ws/2/artist/5b11f4ce-a62d-471e-81fc-a69a8278c7da?fmt=json', { headers: { 'user-agent': config.musicbrainz.userAgent }, signal: AbortSignal.timeout(10000) });
  if (r.ok) { const a = await r.json(); ok(`MusicBrainz reachable (test lookup: ${a.name})`); }
  else bad(`MusicBrainz responded ${r.status}`);
} catch (e) { bad(`MusicBrainz: ${e.message}`); }

// Embedding model (local) - only checks the package imports; the model downloads on first embed build.
if (config.embed.provider === 'local') {
  try { await import('@huggingface/transformers'); ok(`@huggingface/transformers importable (model ${config.embed.model} downloads on first embed build)`); }
  catch (e) { bad(`@huggingface/transformers: ${e.message}`); }
}

console.log(failures ? `\n${failures} problem(s)` : '\nAll good.');
process.exit(failures ? 1 : 0);
