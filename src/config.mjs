// Central config. Loads .env from the project root regardless of cwd.
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

export const ROOT = path.resolve(import.meta.dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

// Everything mutable (sqlite, tts cache, embedding model, art, taste files) lives under DATA_DIR so a deployment
// can mount one persistent volume there. Defaults to ./data next to the code.
const DATA_DIR = resolveFromRoot(env('DATA_DIR', './data'));

export const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  dbPath: resolveFromRoot(env('DB_PATH', path.join(DATA_DIR, 'jaydee.sqlite'))),
  station: {
    // Optional HTTP Basic auth for the web station. Set STATION_PASSWORD when the station is reachable from the
    // internet: without it anyone who finds the URL can spend the OpenRouter credit and change the show.
    user: env('STATION_USER', 'dj'),
    password: env('STATION_PASSWORD', ''),
  },
  jellyfin: {
    url: env('JELLYFIN_URL', 'http://localhost:8096').replace(/\/+$/, ''),
    apiKey: env('JELLYFIN_API_KEY', ''),
    userId: env('JELLYFIN_USER_ID', ''),
  },
  openrouter: {
    apiKey: env('OPENROUTER_API_KEY', ''),
    model: env('OPENROUTER_MODEL', 'openai/gpt-5-mini'),
    bulkModel: env('OPENROUTER_BULK_MODEL', 'openai/gpt-5-mini'),
    // cheap model for structured helper calls (theme interpretation); the persona/selection stays on `model`
    fastModel: env('OPENROUTER_FAST_MODEL', env('OPENROUTER_BULK_MODEL', 'openai/gpt-5-mini')),
    baseUrl: 'https://openrouter.ai/api/v1',
    // Hard guard on the owner's credit: the app refuses any call once today's logged spend passes this (USD).
    dailyCapUsd: Number(env('OPENROUTER_DAILY_CAP_USD', '1.00')),
    // Bulk (draft) research is off unless explicitly unlocked for a run; it is a deliberate spend, never automatic.
    allowBulk: env('OPENROUTER_ALLOW_BULK', '') === 'yes',
  },
  kokoro: {
    // any OpenAI-compatible POST /v1/audio/speech server: Kokoro-FastAPI (default), or OpenAI itself with TTS_API_KEY + TTS_MODEL
    url: env('KOKORO_URL', env('TTS_URL', 'http://localhost:8880')).replace(/\/+$/, ''),
    apiKey: env('TTS_API_KEY', ''),
    model: env('TTS_MODEL', 'kokoro'),
    voice: env('DJ_VOICE', 'am_puck'),
    speed: Number(env('DJ_VOICE_SPEED', '1.0')),
  },
  musicbrainz: {
    userAgent: env('MB_USER_AGENT', 'JayDee/0.1 (personal radio project; https://github.com/)'),
  },
  // The deployed station this workstation publishes its catalog to. Set REMOTE_STATION_URL and the station's
  // password and the Catalog panel grows a "Publish" button: no file to pick, no archive, no container shell.
  remote: {
    url: env('REMOTE_STATION_URL', '').replace(/\/+$/, ''),
    user: env('REMOTE_STATION_USER', env('STATION_USER', 'dj')),
    password: env('REMOTE_STATION_PASSWORD', ''),
  },
  lastfmKey: env('LASTFM_API_KEY', ''),
  discogsToken: env('DISCOGS_TOKEN', ''),
  tasteProfilePath: resolveFromRoot(env('TASTE_PROFILE_PATH', path.join(DATA_DIR, 'taste', 'profile.md'))),
  tasteExtraFiles: env('TASTE_EXTRA_FILES', '').split(',').map((s) => s.trim()).filter(Boolean).map(resolveFromRoot),
  embed: {
    provider: env('EMBED_PROVIDER', 'local'),
    model: env('EMBED_MODEL', 'Xenova/bge-small-en-v1.5'),
    openrouterModel: env('EMBED_OPENROUTER_MODEL', 'openai/text-embedding-3-small'),
  },
  port: Number(env('PORT', '3131')),
};

export function requireConfig(...keys) {
  const missing = [];
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o ? o[p] : undefined), config);
    if (v === undefined || v === '' || v === null) missing.push(k);
  }
  if (missing.length) {
    throw new Error(`Missing required config: ${missing.join(', ')} (set in .env)`);
  }
}

export function readTasteProfile() {
  try {
    return fs.readFileSync(config.tasteProfilePath, 'utf8');
  } catch {
    return '';
  }
}
