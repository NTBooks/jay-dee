---
name: jaydee-identify
description: Resolve Jay Dee catalog entities against MusicBrainz so that year, original release year, names, release type and genres come from external sources instead of untrusted ID3 tags. Use after a sync shows unprocessed items, when the user asks how bad their tags are, or when asked to identify/resolve/fix metadata.
---

# jaydee-identify

Core rule of this project: **ID3/Jellyfin values are hints, never truth.** Every entity table has `tag_*` columns (from Jellyfin) and resolved columns (`year`, `original_year`, `resolved_title`, `resolved_artist`, `release_type`, `genres_json`) filled here. Downstream code (embeddings, DJ, playlists) reads only resolved columns.

Order matters (albums provide the evidence used to validate artist MBIDs):

```bash
npm run identify -- albums
```
One MusicBrainz call per album (about 1.3 s each; ~1 h for the whole library the first time, afterwards only new albums). Safe to interrupt and re-run: it only processes rows with `resolved_at IS NULL`. For long runs use a background shell and check `npm run identify -- status`.

```bash
npm run identify -- artists
```
Uses the MBIDs credited on identified albums as evidence; a tag MBID that conflicts with album credits is overridden (this is how "Pink" tagged with a wrong MBID becomes P!nk). Re-runs canonicalization afterwards.

```bash
npm run identify -- tracks
```
Instant and local: matches library tracks to stored MusicBrainz tracklists and sets `mb_recording_id` and `original_year` (the recording's FIRST release, so best-of/compilation cuts get their real year). Leftovers can get a slow per-track search pass: `npm run identify -- tracks --search --limit 300` (1.3 s each; run in chunks across sessions).

```bash
npm run identify -- report
```
Writes `data/reports/discrepancies.md` (tag vs resolved: year error distribution, worst artists, genre disagreements, unresolved lists). Summarize it for the user when they ask how wrong their tags are.

`resolution` values: `mbid_tag` (tag MBID confirmed), `mb_match_high`, `mb_match_low`, `claude_confirmed` (set by research ingest), `tag_only` (unresolved: falls back to tag values, DJ down-weights). `--retry` re-processes `tag_only` rows. Transient MusicBrainz "busy" errors leave rows unprocessed for the next run; they are not failures.

Never run two MusicBrainz-calling commands at the same time (`identify albums`, `identify artists`, `identify tracks --search`).
