# Jay Dee

A personal radio station built on a Jellyfin music library: the catalog is mirrored into SQLite, every artist/album/track is identified against MusicBrainz and researched externally (ID3 tags are treated as untrusted hints), the research is embedded for semantic search, and an AI DJ builds themed sets with Kokoro-voiced patter, played in a browser station with a Winamp-style Radio mode and a full-art TV mode.

## Setup
```
npm install
copy .env.example .env      # fill JELLYFIN_API_KEY, OPENROUTER_API_KEY (DJ), optional LASTFM_API_KEY / DISCOGS_TOKEN
npm run doctor
```

## Pipeline
| Step | Command | Notes |
|---|---|---|
| Sync catalog | `npm run sync` | Jellyfin -> SQLite (`data/jaydee.sqlite`). Idempotent, never deletes, carries research over renames. |
| Identify | `npm run identify -- albums` / `artists` / `tracks` / `report` | MusicBrainz identities; fills resolved year / original_year / names / type / genres. |
| Research | `npm run research -- status` / `packets` / `ingest` / `derive` / `notable` / `bulk` | Queue-driven; Claude Code subagents write JSON results (see `.claude/skills/jaydee-research`). |
| Embed | `npm run embed -- build` / `search "<q>"` / `stats` | Local bge-small embeddings, in-process cosine search. |
| DJ / station | `npm run serve` (http://localhost:3131), `npm run dj -- plan "<theme>"` | OpenRouter planner, Kokoro TTS, Webamp player. |
| Ad-hoc SQL | `node scripts/sql.mjs "select ..."` | Read-only. |

Deploying the station on a server (Coolify, Nixpacks): see `DEPLOY.md`. `npm run pack` bundles the data the server needs.

Claude Code skills in `.claude/skills/` (`jaydee-sync`, `jaydee-identify`, `jaydee-research`, `jaydee-embed`, `jaydee-dj`) document each stage for future sessions. Project rules live in `CLAUDE.md`.

## Data model in one line
`artists` / `albums` / `tracks` (each with untrusted `tag_*` columns and resolved columns + `resolution` state), `research` (one row per entity: stage, packet, summary, genres, moods, hooks…), `embeddings` (float32 blobs), `discrepancies` (tag vs resolved), DJ tables (`dj_sessions`, `dj_queue`, `patter`, `dj_log`).
