// Usage:
//   npm run embed -- build [--type artist|album|track]
//   npm run embed -- search "<query>" [--type track] [-k 10] [--from 1990 --to 1999]
//   npm run embed -- stats
import { openDb, closeDb } from '../src/db/open.mjs';
import { embedPending, search, embedStats } from '../src/embed/index.mjs';
import { log } from '../src/util/log.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => { const i = rest.findIndex((a) => a === `--${name}` || a === `-${name}` || a.startsWith(`--${name}=`)); if (i < 0) return dflt; const a = rest[i]; return a.includes('=') ? a.split('=')[1] : rest[i + 1]; };

try {
  const db = openDb();
  if (cmd === 'build') {
    const r = await embedPending(db, { type: opt('type') });
    console.log(r);
  } else if (cmd === 'search') {
    const query = rest.filter((a, i) => !a.startsWith('-') && !(i > 0 && rest[i - 1].startsWith('-'))).join(' ');
    const rows = await search(db, { query, type: opt('type', 'track'), k: Number(opt('k', 10)), yearFrom: opt('from') && Number(opt('from')), yearTo: opt('to') && Number(opt('to')), maxPerArtist: opt('per-artist') && Number(opt('per-artist')) });
    console.table(rows.map((r) => ({ score: r.score, title: r.title, artist: r.artist, album: r.album, year: r.year, energy: r.energy, blurb: (r.blurb || '').slice(0, 60) })));
  } else if (cmd === 'stats') {
    const s = embedStats(db); console.table(s.embeddings); console.table(s.embeddable);
  } else console.log('usage: build [--type X] | search "<q>" [--type track] [-k 10] [--from Y --to Y] [--per-artist N] | stats');
  closeDb();
  process.exit(0);
} catch (e) { log.error(e.stack || e.message); process.exit(1); }
