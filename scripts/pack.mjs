// Bundle the mutable state a deployment needs into one archive: the catalog + research database (checkpointed so
// the WAL is folded in), taste files, the rendered voice cache and downloaded artist art. Models, packets, results
// and reports are left out (the server re-downloads the embedding model on first use).
// Usage: node scripts/pack.mjs [out.tar.gz]     -> jaydee-data.tar.gz in the project root by default
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '../src/config.mjs';
import { openDb, closeDb } from '../src/db/open.mjs';

const out = path.resolve(process.argv[2] || path.join(config.root, 'jaydee-data.tar.gz'));
const db = openDb();
const ck = db.pragma('wal_checkpoint(TRUNCATE)');
closeDb();
console.log(`checkpointed ${config.dbPath} (${JSON.stringify(ck)})`);

const dataDir = config.dataDir;
const entries = ['jaydee.sqlite', 'taste', 'tts', 'art'].filter((e) => fs.existsSync(path.join(dataDir, e)));
if (!entries.includes('jaydee.sqlite')) { console.error(`no jaydee.sqlite under ${dataDir}`); process.exit(1); }
// --force-local: GNU tar on Windows otherwise reads "C:" in the output path as a remote host
const r = spawnSync('tar', [...(process.platform === 'win32' ? ['--force-local'] : []), '-czf', out, '-C', dataDir, ...entries], { stdio: 'inherit' });
if (r.status !== 0) { console.error(`tar failed (${r.status}); is tar on PATH?`); process.exit(1); }
const mb = (fs.statSync(out).size / 1e6).toFixed(1);
console.log(`wrote ${out} (${mb} MB): ${entries.join(', ')}`);
console.log('on the server: tar -xzf jaydee-data.tar.gz -C /app/data   (inside the container, or into the volume directory on the host)');
process.exit(0);
