---
name: jaydee-sync
description: Refresh the Jay Dee music catalog from the Jellyfin server (new/removed/renamed tracks, albums, artists) and queue new entities for identification and research. Use when the user says they added music, asks to sync/refresh/update the catalog, or before any research or DJ session that should see recent additions.
---

# jaydee-sync

Run from the project root (quote the path if it contains spaces):

```bash
npm run doctor
```

```bash
npm run sync
```

What it does: pulls every MusicArtist, MusicAlbum and Audio item from Jellyfin (`JELLYFIN_URL` and `JELLYFIN_API_KEY` in `.env`), upserts by Jellyfin id into `data/jaydee.sqlite`, marks vanished rows `removed_at` (never deletes), carries research/identity over to renamed items, recomputes counts, merges artist name variants into `canonical_id`, and inserts `pending` research rows for new entities.

Read the summary block it prints:
- `status=ok` and Jellyfin totals equal DB live rows: good.
- `MISMATCH ... removals skipped` (`status=failed`, exit code 2): a page was lost mid-pull. Run it again; never force removals.
- `carried over=N`: N renamed items inherited existing research.

Then always continue with identification for anything new:

```bash
npm run identify -- status
```

If any type shows `unprocessed > 0`, follow the **jaydee-identify** skill (albums first, then artists, then tracks). After that, `npm run research -- status` shows the new pending research work (follow **jaydee-research**).

## Libraries (Jellyfin is the source of truth for which exist)
Sync pulls every music library Jellyfin reports (e.g. Music, Singles, Christmas) and records each track's `library_id`. New libraries appear automatically and default to included. The include/season choice lives in the `libraries` table:

```bash
npm run sync -- libraries
```
`--include "Name"`, `--exclude "Name"`, `--months "Name" "11,12"` (seasonal: only active in those months; `--months "Name" ""` clears). Example: a Christmas library set to December only. Search, candidates and the DJ only ever draw from libraries active right now.

Rules:
- Sync writes only `tag_*` columns and library facts. It never changes resolved year/genre/name columns.
- Do not run `identify albums/artists` concurrently with another MusicBrainz job (shared 1 req/s limit). Sync itself does not call MusicBrainz.
- Inspection helper: `node scripts/sql.mjs "select ..."` (read-only SQL, prints a table; `--json` for JSON).
