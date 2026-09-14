// Kokoro-FastAPI (OpenAI-compatible) text-to-speech with on-disk cache keyed by voice|speed|text.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import { sha1, nowIso } from '../util/hash.mjs';
import { log } from '../util/log.mjs';

export const ttsDir = () => path.join(config.dataDir, 'tts');

// Pronunciation dictionary (data/taste/pronunciations.json): regex rules applied to the text Kokoro hears,
// never to the text shown on screen. Kokoro/Misaki accept inline phoneme markup: [word](/phonemes/).
let _pron = { at: 0, rules: [] };
export function loadPronunciations() {
  const p = path.join(config.dataDir, 'taste', 'pronunciations.json');
  try {
    const st = fs.statSync(p);
    if (st.mtimeMs !== _pron.at) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')).rules || [];
      _pron = { at: st.mtimeMs, rules: raw.filter((r) => r.match && r.say && !r.skip).map((r) => ({ re: new RegExp('\\b(?:' + r.match + ')\\b', 'gi'), say: r.say })) };
    }
  } catch { _pron = { at: 0, rules: [] }; }
  return _pron.rules;
}
export function speakable(text) {
  // typography Kokoro stumbles on, cleaned BEFORE the dictionary (whose phoneme markup legitimately contains slashes)
  let t = String(text).replace(/[—–]/g, ', ').replace(/\s*\/\s*/g, ' or ').replace(/&/g, ' and ').replace(/\s{2,}/g, ' ').trim();
  for (const r of loadPronunciations()) t = t.replace(r.re, (m, ...groups) => r.say.replace(/\$(\d)/g, (_, n) => groups[Number(n) - 1] ?? ''));
  return t;
}

export function patterHash(text, voice = config.kokoro.voice, speed = config.kokoro.speed) {
  return sha1(`${voice}|${speed}|${speakable(text)}`);
}

// Voice breaks are written for one show and are dead the moment a new theme replaces it: the words were about
// those tracks, in that order. Left alone the cache grows for the life of the server, a few hundred KB per break.
//
// Only the mp3 goes. The patter row keeps the text, so transcripts of past shows still read, and renderPatter
// treats a missing file as a cache miss and speaks it again — so deleting too eagerly costs a re-render, nothing
// worse. Saved sets store track ids only and never reference a voice file, so nothing else can be holding one.
export function pruneVoiceCache(db, { graceMs = 120_000 } = {}) {
  if (process.env.TTS_KEEP_ALL === '1') return { removed: 0, freedBytes: 0, skipped: 'TTS_KEEP_ALL=1' };
  const dir = ttsDir();
  if (!fs.existsSync(dir)) return { removed: 0, freedBytes: 0 };
  const keep = new Set(db.prepare(`
    SELECT DISTINCT q.patter_hash h FROM dj_queue q JOIN dj_sessions s ON s.id = q.session_id
    WHERE q.patter_hash IS NOT NULL AND s.status IN ('planning','ready','playing','refilling')
  `).all().map((r) => r.h));
  const now = Date.now();
  let removed = 0, freedBytes = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.mp3')) continue;
    if (keep.has(f.slice(0, -4))) continue;
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs < graceMs) continue; // a player may still be fetching one that was just rendered
      fs.rmSync(p, { force: true });
      removed++; freedBytes += st.size;
    } catch { /* vanished under us, or in use on Windows: it will be caught next time */ }
  }
  if (removed) log.info(`voice cache: removed ${removed} orphaned break(s), freed ${(freedBytes / 1048576).toFixed(1)} MB`);
  return { removed, freedBytes };
}

export async function renderPatter(db, text, { voice = config.kokoro.voice, speed = config.kokoro.speed } = {}) {
  const hash = patterHash(text, voice, speed);
  const spoken = speakable(text);
  const file = path.join(ttsDir(), `${hash}.mp3`);
  const existing = db.prepare('SELECT * FROM patter WHERE hash = ?').get(hash);
  if (existing && fs.existsSync(file)) return { hash, file, cached: true, duration_s: existing.duration_s };
  fs.mkdirSync(ttsDir(), { recursive: true });
  const r = await fetch(`${config.kokoro.url}/v1/audio/speech`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(config.kokoro.apiKey ? { authorization: `Bearer ${config.kokoro.apiKey}` } : {}) },
    body: JSON.stringify({ model: config.kokoro.model, voice, input: spoken, speed, response_format: 'mp3' }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`Kokoro ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  const duration = estimateMp3Seconds(buf, text);
  db.prepare('INSERT OR REPLACE INTO patter(hash, text, voice, speed, file_path, duration_s, created_at) VALUES (?,?,?,?,?,?,?)').run(hash, text, voice, speed, file, duration, nowIso());
  log.info(`tts rendered ${hash} (${buf.length} bytes, ~${duration}s)`);
  return { hash, file, cached: false, duration_s: duration };
}

// Rough duration: words / 2.6 per second at speed 1 (Kokoro averages ~155 wpm). Good enough for UI.
function estimateMp3Seconds(buf, text) {
  const words = text.trim().split(/\s+/).length;
  return Math.round((words / 2.6) * 10) / 10;
}

export async function listVoices() {
  const r = await fetch(`${config.kokoro.url}/v1/audio/voices`, { signal: AbortSignal.timeout(8000), headers: config.kokoro.apiKey ? { authorization: `Bearer ${config.kokoro.apiKey}` } : {} });
  if (!r.ok) return ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']; // servers without a voices endpoint (OpenAI): the standard set
  const v = await r.json();
  return (v.voices || []).map((x) => x.id || x);
}
