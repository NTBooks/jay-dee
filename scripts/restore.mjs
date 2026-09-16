// Catalog database maintenance from the command line — the same code path the station's Catalog panel uses.
//
// Usage:
//   node scripts/restore.mjs check <file.sqlite>      what is inside a database, without touching anything
//   node scripts/restore.mjs apply <file.sqlite>      replace the live catalog with it (keeps the old one)
//   node scripts/restore.mjs push  <file.sqlite> <url>  upload it to a running station (Coolify)
//   node scripts/restore.mjs status                   what the local database holds
//   node scripts/restore.mjs list                     databases kept by previous restores
//   node scripts/restore.mjs snapshot [out.sqlite]    consistent copy of the live database
// apply and push keep the station's own shows, play history, voice breaks, saved sets and feedback;
// add --station-data=upload to take the file's instead.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.mjs';
import { openDb } from '../src/db/open.mjs';
import { inspect, restoreFrom, listBackups, snapshot, summarize, statOf } from '../src/db/restore.mjs';

const [cmd, arg, arg2] = process.argv.slice(2);
const show = (o) => console.log(JSON.stringify(o, null, 1));
const stationData = process.argv.includes('--station-data=upload') ? 'upload' : 'keep';
const need = (what) => { if (!arg) { console.error(`usage: node scripts/restore.mjs ${cmd} <${what}>`); process.exit(1); } };

try {
  if (cmd === 'check') {
    need('file.sqlite');
    show({ file: path.resolve(arg), ...inspect(path.resolve(arg)) });
  } else if (cmd === 'apply') {
    need('file.sqlite');
    const src = path.resolve(arg);
    if (path.resolve(config.dbPath) === src) { console.error('that is already the live database'); process.exit(1); }
    // restoreFrom renames the file into place, so work from a copy and leave the user's original where it is.
    const staged = path.join(config.dataDir, `restore-cli-${Date.now()}.sqlite`);
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.copyFileSync(src, staged);
    try { show(restoreFrom(staged, { stationData })); }
    finally { fs.rmSync(staged, { force: true }); }
  } else if (cmd === 'push') {
    need('file.sqlite');
    if (!arg2) { console.error('usage: node scripts/restore.mjs push <file.sqlite> <https://station-url> [--dry-run]'); process.exit(1); }
    const file = path.resolve(arg);
    const info = inspect(file); // fail locally before sending hundreds of megabytes
    const dry = process.argv.includes('--dry-run');
    const base = arg2.replace(/\/+$/, '');
    const query = [dry && 'dry_run=1', stationData === 'upload' && 'station_data=upload'].filter(Boolean).join('&');
    const url = `${base}/api/admin/restore${query ? `?${query}` : ''}`;
    // Credentials come from the environment so they never end up in shell history: STATION_USER / STATION_PASSWORD.
    const headers = { 'content-type': 'application/octet-stream', 'content-length': String(info.bytes) };
    if (config.station.password) headers.authorization = `Basic ${Buffer.from(`${config.station.user}:${config.station.password}`).toString('base64')}`;
    console.log(`uploading ${info.mb} MB (${info.tracks} tracks) to ${url}`);
    const res = await fetch(url, { method: 'POST', headers, body: fs.createReadStream(file), duplex: 'half' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { console.error(`station refused it (${res.status}): ${body.error || res.statusText}`); process.exit(1); }
    show(body);
  } else if (cmd === 'status') {
    show({ path: config.dbPath, file: statOf(config.dbPath), counts: summarize(openDb()) });
  } else if (cmd === 'list') {
    show(listBackups());
  } else if (cmd === 'snapshot') {
    const out = path.resolve(arg || path.join(config.dataDir, `jaydee-${new Date().toISOString().slice(0, 10)}.sqlite`));
    show({ wrote: out, ...snapshot(out) });
  } else {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
process.exit(0);
