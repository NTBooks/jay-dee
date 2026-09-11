# Jay Dee

Jellyfin music catalog -> external research corpus -> vector search -> AI radio DJ (Kokoro voice) with a web station. Node 24 ESM, Express, better-sqlite3. Long-running backburner project: **all progress state lives in `data/jaydee.sqlite`**, never in memory or context. Start every session by running the relevant `status` command.

## Skills (project-scoped, in `.claude/skills/`)
- **jaydee-sync** — pull Jellyfin into SQLite (`npm run sync`), idempotent, never deletes.
- **jaydee-identify** — MusicBrainz identity for albums -> artists -> tracks (`npm run identify -- ...`); fills resolved year/original_year/names/type/genres; discrepancy report.
- **jaydee-research** — queue-driven research: `packets` -> Claude subagents write JSON -> `ingest`; plus `derive`, `notable`, `bulk`.
- **jaydee-embed** — `npm run embed -- build|search|stats`.
- **jaydee-dj** — `npm run serve` (station on http://localhost:3131), `npm run dj -- plan "<theme>"`, `tts-test`, `vetoes`.

## Non-negotiable rules
1. **Tags are hints, never truth.** `tag_*` columns hold Jellyfin/ID3 values (years and genres are frequently wrong in real libraries; an earlier playlist project suffered for trusting them). Everything downstream reads only resolved columns (`year`, `original_year`, `resolved_title`, `resolved_artist`, `release_type`, `genres_json`) and `research`.
2. **Never invent tracks.** The DJ and any playlist logic only use Jellyfin ids that exist in `tracks`. LLM output is filtered against the candidate list.
3. **Taste doctrine** is `data/taste/profile.md` (override with `.env` `TASTE_PROFILE_PATH`; written by the jaydee-taste skill, gitignored because it is personal). It is the DJ system context and the research subagents' listener context. Hard vetoes live in `data/taste/vetoes.json` (`npm run dj -- vetoes --apply`), also gitignored; starters for both are in `export-skills/templates/`.
4. Research may correct identification (confirmed MBIDs, years); tags never can. Drafts (bulk mode) never override identification.
5. One MusicBrainz-calling process at a time (1 req/s shared limit): `identify albums|artists|tracks --search`.
6. **The station is one shared show.** Any theme request, manual session or `dj -- manual` replaces what is playing in every browser, and a browser that calls `advance` competes for the queue (one driver at a time; others go passive with a take-over button). Never start sessions or drive playback for testing while the user may be listening; use `npm run dj -- plan --no-tts` for dry runs.
7. Jellyfin libraries are dynamic config (`npm run sync -- libraries`): include flags and seasonal months live in the `libraries` table; all track/album selection filters on `library_id` via `libraryFilterSql`.

## Layout
`src/config.mjs` (.env), `src/db/` (schema.sql idempotent + additive migrations in open.mjs), `src/jellyfin/` (client, sync + carry-over + canonicalize + queueResearch), `src/research/` (identify, sources/, packet, queue, schema, ingest, derive, notable, bulk, prompts, taste), `src/embed/` (model, text, index: float32 blobs + in-process cosine), `src/llm/openrouter.mjs`, `src/dj/` (vetoes, candidates, planner, tts, station), `src/server/` (Express app, routes), `public/` (player: Radio Mode = Webamp, TV mode), `scripts/*.mjs` thin CLIs (`node scripts/sql.mjs "<sql>"` for read-only queries).

## Deployment
`DEPLOY.md` + `nixpacks.toml`: the station runs on Coolify (Nixpacks, volume at `/app/data`, `DATA_DIR`/`DB_PATH` env). `npm run pack` bundles sqlite + taste + tts + art for upload. `STATION_PASSWORD` enables HTTP Basic auth (required on any public URL: it gates OpenRouter spend); `/healthz` is exempt. The pipeline (sync/identify/research/embed) stays on the workstation.

## Env gotchas
- The project path may contain a space: always quote it in `cd`; resolve paths from `import.meta.dirname`, never cwd.
- Windows Defender/AMSI kills complex inline PowerShell; put logic in files. Bash heredocs with backticks/quotes have bitten too: prefer the Write tool for multi-line files.
- Node scripts must `process.exit(0)` at the end (open sockets otherwise hang the tool).
- `.env` is gitignored and holds the Jellyfin key; scripts never print secrets. OpenRouter key optional until the DJ/bulk features are used.
- MusicBrainz returns 503 "busy" regularly; transient errors leave rows unprocessed (re-run), they are not failures.

## Where things stand
Run `npm run sync` / `npm run identify -- status` / `npm run research -- status` / `npm run embed -- stats` to see actual state. Do not hand-maintain counts here.
