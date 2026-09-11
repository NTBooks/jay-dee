// Usage:
//   npm run identify -- status
//   npm run identify -- albums  [--limit N] [--retry]     (MusicBrainz, ~1.1s per album)
//   npm run identify -- artists [--limit N] [--retry]     (run AFTER albums; uses album credits as evidence)
//   npm run identify -- tracks                            (local match against stored tracklists, instant)
//   npm run identify -- tracks --search [--limit N]       (per-track MusicBrainz search for leftovers, ~1.1s each)
//   npm run identify -- report                            (writes data/reports/discrepancies.md)
//   npm run identify -- all [--limit N]                   (albums -> artists -> tracks -> report)
import { openDb, closeDb } from '../src/db/open.mjs';
import { identifyAlbums, identifyArtists, identifyTracksLocal, identifyTracksSearch, identifyStatus, writeReport } from '../src/research/identify.mjs';
import { log } from '../src/util/log.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const limitArg = rest.find((a) => a.startsWith('--limit'));
const limit = limitArg ? Number(limitArg.includes('=') ? limitArg.split('=')[1] : rest[rest.indexOf(limitArg) + 1]) : undefined;
const retry = rest.includes('--retry');

function printStatus(db) {
  const s = identifyStatus(db);
  for (const t of ['artists', 'albums', 'tracks']) {
    console.log(`${t}: ` + s[t].byResolution.map((r) => `${r.resolution}=${r.n}`).join('  ') + `  | unprocessed=${s[t].unprocessed}`);
  }
  console.log(`tracks with MB recording: ${s.tracks.withRecording}; with original_year: ${s.tracks.withOriginalYear}`);
  console.log('discrepancies: ' + (s.discrepancies.map((d) => `${d.entity_type}.${d.field}=${d.n}`).join('  ') || 'none yet'));
}

const progress = (every) => { let n = 0; return (counts, item, r) => { if (++n % every === 0) log.info(`${n} done: ${JSON.stringify(counts)}`); }; };

try {
  const db = openDb();
  if (cmd === 'status' || !cmd) printStatus(db);
  else if (cmd === 'albums') { const c = await identifyAlbums(db, { limit, retry, onProgress: progress(25) }); console.log('albums', c); }
  else if (cmd === 'artists') { const c = await identifyArtists(db, { limit, retry, onProgress: progress(25) }); console.log('artists', c); }
  else if (cmd === 'tracks') {
    if (rest.includes('--search')) { const c = await identifyTracksSearch(db, { limit: limit || 200, onProgress: progress(25) }); console.log('tracks(search)', c); }
    else { const c = identifyTracksLocal(db); console.log('tracks(local)', c); }
  }
  else if (cmd === 'report') { console.log('wrote', writeReport(db)); }
  else if (cmd === 'all') {
    console.log('albums', await identifyAlbums(db, { limit, retry, onProgress: progress(50) }));
    console.log('artists', await identifyArtists(db, { limit, retry, onProgress: progress(50) }));
    console.log('tracks(local)', identifyTracksLocal(db));
    console.log('wrote', writeReport(db));
  }
  else console.log('unknown command; see header of scripts/identify.mjs');
  if (cmd && cmd !== 'status') { console.log(''); printStatus(db); }
  closeDb();
  process.exit(0);
} catch (e) { log.error(e.stack || e.message); process.exit(1); }
