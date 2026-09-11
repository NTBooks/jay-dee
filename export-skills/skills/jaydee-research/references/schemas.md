# Result schemas

Authoritative source: `src/research/prompts.mjs` (print with `npm run research -- schema artist|album|track`). Validation lives in `src/research/schema.mjs`: summary 20-400 words, non-empty `moods` and `dj_hooks`, `confidence` 0-1, `sources` array; artist/album need non-empty `genres`; years must be 1900-2100.

Ingest (`src/research/ingest.mjs`) stores summary/blurb/genres/moods/era/origin/tags/energy/dj_hooks/confidence/sources on the `research` row and keeps the rest (identity, key_albums, upstream, notable_tracks, context, album_type, tempo_feel, themes, is_cover, original_artist, notable_reason, year, original_year) in `extra_json`. It also lets research correct the entity tables: confirmed artist MBIDs, album `year`, track `original_year`, `is_cover`/`original_artist`; research genres override MusicBrainz tag genres. Drafts (bulk mode) never override identification.
