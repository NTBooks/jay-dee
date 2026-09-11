// Usage: npm run art -- cache [--limit N]   downloads external artist images (image_url_ext) into data/art/artist-<canonical id>.jpg
//        npm run art -- status
import fs from 'node:fs';
import path from 'node:path';
import { openDb, closeDb } from '../src/db/open.mjs';
import { config } from '../src/config.mjs';
import { log } from '../src/util/log.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const limitArg = rest.find((a) => a.startsWith('--limit'));
const limit = limitArg ? Number(limitArg.includes('=') ? limitArg.split('=')[1] : rest[rest.indexOf(limitArg) + 1]) : 500;
const dir = path.join(config.dataDir, 'art');
fs.mkdirSync(dir, { recursive: true });

try {
  const db = openDb();
  if (cmd === 'cache') {
    const rows = db.prepare(`SELECT jellyfin_id, COALESCE(resolved_name, tag_name) name, image_url_ext FROM artists WHERE removed_at IS NULL AND canonical_id = jellyfin_id AND image_url_ext LIKE 'http%' ORDER BY track_count DESC LIMIT ?`).all(limit);
    let ok = 0, skipped = 0, failed = 0;
    for (const a of rows) {
      const file = path.join(dir, `artist-${a.jellyfin_id}.jpg`);
      if (fs.existsSync(file)) { skipped++; continue; }
      try {
        const r = await fetch(a.image_url_ext, { headers: { 'user-agent': config.musicbrainz.userAgent }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
        if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) { failed++; continue; }
        fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        ok++; log.info(`cached art: ${a.name}`);
      } catch (e) { failed++; log.warn(`art ${a.name}: ${e.message}`); }
    }
    console.log({ downloaded: ok, already: skipped, failed });
  } else {
    const n = fs.readdirSync(dir).length;
    const withExt = db.prepare("SELECT COUNT(*) n FROM artists WHERE image_url_ext LIKE 'http%'").get().n;
    const withJf = db.prepare('SELECT COUNT(*) n FROM artists WHERE image_tag IS NOT NULL').get().n;
    console.log({ cachedFiles: n, artistsWithExternalUrl: withExt, artistsWithJellyfinImage: withJf });
  }
  closeDb();
  process.exit(0);
} catch (e) { log.error(e.stack || e.message); process.exit(1); }
