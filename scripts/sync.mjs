// Usage: npm run sync [-- --dry-run] [--no-removals]
import { openDb, closeDb } from '../src/db/open.mjs';
import { syncAll } from '../src/jellyfin/sync.mjs';
import { log } from '../src/util/log.mjs';

const args = process.argv.slice(2);
if (args[0] === 'libraries') {
  // npm run sync -- libraries [--include "Name" | --exclude "Name" | --months "Name" "11,12" | --months "Name" ""]
  const { openDb: od, closeDb: cd } = await import('../src/db/open.mjs');
  const { listLibraries, setLibrary, allowedLibraryIds } = await import('../src/db/libraries.mjs');
  const db = od();
  const i = (f) => args.indexOf(f);
  if (i('--include') > 0) setLibrary(db, args[i('--include') + 1], { included: true });
  if (i('--exclude') > 0) setLibrary(db, args[i('--exclude') + 1], { included: false });
  if (i('--months') > 0) setLibrary(db, args[i('--months') + 1], { only_months: args[i('--months') + 2] || null });
  const allowed = new Set(allowedLibraryIds(db));
  console.table(listLibraries(db).map((l) => ({ name: l.name, tracks: l.track_count, included: !!l.included, only_months: l.only_months || '', active_now: allowed.has(l.id) })));
  cd(); process.exit(0);
}
const dryRun = args.includes('--dry-run');
const noRemovals = args.includes('--no-removals');

try {
  const db = openDb();
  const r = await syncAll(db, { dryRun, noRemovals });
  console.log('');
  console.log(`SYNC ${r.dryRun ? '(dry run)' : `run #${r.runId}`} status=${r.status || 'n/a'}`);
  console.log(`  Jellyfin totals: tracks=${r.totals.tracks} albums=${r.totals.albums} artists=${r.totals.artists}`);
  console.log(`  added: artists=${r.stats.added_artists} albums=${r.stats.added_albums} tracks=${r.stats.added_tracks}  updated tracks=${r.stats.updated_tracks}`);
  console.log(`  removed: artists=${r.stats.removed_artists} albums=${r.stats.removed_albums} tracks=${r.stats.removed_tracks}  carried over=${r.stats.carried_over}`);
  if (r.mismatch?.length) console.log(`  MISMATCH: ${r.mismatch.join(', ')} -> removals skipped`);
  if (!dryRun) {
    const live = db.prepare(`SELECT
      (SELECT COUNT(*) FROM tracks WHERE removed_at IS NULL) t,
      (SELECT COUNT(*) FROM albums WHERE removed_at IS NULL) al,
      (SELECT COUNT(*) FROM artists WHERE removed_at IS NULL) ar,
      (SELECT COUNT(*) FROM artists WHERE removed_at IS NULL AND mb_artist_id IS NOT NULL) armb,
      (SELECT COUNT(*) FROM albums WHERE removed_at IS NULL AND mb_release_group_id IS NOT NULL) almb,
      (SELECT COUNT(DISTINCT canonical_id) FROM artists WHERE removed_at IS NULL) canon`).get();
    console.log(`  DB live rows: tracks=${live.t} albums=${live.al} artists=${live.ar} (canonical ${live.canon}); MBIDs: artists=${live.armb} albums=${live.almb}`);
    const q = db.prepare(`SELECT entity_type, stage, COUNT(*) n FROM research GROUP BY entity_type, stage ORDER BY entity_type, stage`).all();
    console.log('  research queue: ' + q.map((x) => `${x.entity_type}/${x.stage}=${x.n}`).join('  '));
  }
  closeDb();
  process.exit(r.status === 'failed' ? 2 : 0);
} catch (e) {
  log.error(e.stack || e.message);
  process.exit(1);
}
