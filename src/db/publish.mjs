// Publish this machine's catalog to the deployed station.
//
// The workstation does the research; the server only reads. Rather than making that a chore of packing archives,
// picking files out of a dialog or opening a container shell, the app sends its own database to the station it is
// configured to feed. One button, and the same validation the receiving end applies to any upload.
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { config } from '../config.mjs';
import { snapshot, summarize, statOf } from './restore.mjs';
import { openDb } from './open.mjs';
import { log } from '../util/log.mjs';

// One publish at a time. The browser polls this while it runs; it is the same shape as the DJ booth's progress.
let job = null;

export const publishState = () => (job ? { ...job } : null);
export const isConfigured = () => Boolean(config.remote.url);

function authHeader() {
  const { user, password } = config.remote;
  return password ? { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } : {};
}

const remoteUrl = (p) => `${config.remote.url}${p}`;

// What the far end is serving right now, so the panel can show local and remote side by side before sending.
export async function remoteStatus({ timeoutMs = 8000 } = {}) {
  if (!isConfigured()) return { configured: false };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(remoteUrl('/api/admin/db'), { headers: authHeader(), signal: ac.signal });
    if (res.status === 401) return { configured: true, url: config.remote.url, reachable: true, error: 'the station rejected the password (REMOTE_STATION_PASSWORD)' };
    if (!res.ok) return { configured: true, url: config.remote.url, reachable: true, error: `station answered ${res.status} ${res.statusText}` };
    const body = await res.json();
    return { configured: true, url: config.remote.url, reachable: true, ...body };
  } catch (e) {
    return { configured: true, url: config.remote.url, reachable: false, error: e.name === 'AbortError' ? 'no answer within 8s' : e.message };
  } finally { clearTimeout(t); }
}

async function send(file, bytes, { dryRun, onProgress }) {
  let sent = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) { sent += chunk.length; onProgress(sent); cb(null, chunk); },
  });
  const body = fs.createReadStream(file).pipe(counter);
  const res = await fetch(remoteUrl(`/api/admin/restore${dryRun ? '?dry_run=1' : ''}`), {
    method: 'POST',
    headers: { ...authHeader(), 'content-type': 'application/octet-stream', 'content-length': String(bytes) },
    body,
    duplex: 'half',
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('the station rejected the password (REMOTE_STATION_PASSWORD)');
    if (res.status === 403) throw new Error(out.error || 'the station refuses restores: it needs STATION_PASSWORD set');
    throw new Error(out.error || `station answered ${res.status} ${res.statusText}`);
  }
  return out;
}

// Runs in the background; the caller gets the job object and polls it.
export function startPublish() {
  if (!isConfigured()) throw new Error('no REMOTE_STATION_URL configured');
  if (job && job.state === 'running') throw new Error('a publish is already running');
  job = { state: 'running', phase: 'snapshot', startedAt: Date.now(), sent: 0, total: 0, note: 'taking a consistent copy of the catalog', result: null, error: null };
  run().catch((e) => {
    job.state = 'failed'; job.error = e.message; job.finishedAt = Date.now();
    log.warn(`publish failed: ${e.message}`);
  });
  return publishState();
}

async function run() {
  const tmp = path.join(config.dataDir, 'restore', `publish-${Date.now()}.sqlite`);
  try {
    // VACUUM INTO rather than copying the file: the station may be serving and the WAL would otherwise be missed.
    const snap = snapshot(tmp);
    job.total = snap.bytes;
    job.localCounts = summarize(openDb());

    // Dry run first. A rejection costs one upload instead of leaving the far end half-swapped.
    job.phase = 'checking'; job.sent = 0; job.note = 'sending to the station to be checked';
    const check = await send(tmp, snap.bytes, { dryRun: true, onProgress: (n) => { job.sent = n; } });
    job.remoteBefore = check.current;

    job.phase = 'uploading'; job.sent = 0; job.note = 'publishing';
    const out = await send(tmp, snap.bytes, { dryRun: false, onProgress: (n) => { job.sent = n; } });

    job.state = 'done'; job.phase = 'done'; job.sent = job.total; job.finishedAt = Date.now();
    job.result = out;
    job.note = `published ${snap.mb} MB`;
    log.info(`published catalog to ${config.remote.url} (${snap.mb} MB, ${out.after?.tracks ?? '?'} tracks)`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function localStatus() {
  return { path: config.dbPath, file: statOf(config.dbPath), counts: summarize(openDb()) };
}
