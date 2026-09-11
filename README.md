# Jay Dee

Your Jellyfin music library as a radio station with an AI DJ.

Jay Dee mirrors a Jellyfin music library into SQLite, identifies every album, artist and track against
MusicBrainz (your ID3 tags are treated as hints, never truth), has Claude research every act you own, embeds
the research for semantic search, and puts an AI DJ on top: you type a theme, it builds a set from *your*
library, writes and voices the patter, and plays it in a browser station with a Winamp-style **Radio mode**
and a full-art **TV mode**. Works on phones too, and deploys to Coolify.

Ask for "rainy afternoon vaporwave with a Celtic detour" and you get ten tracks you already own, in an order
that makes sense, with a DJ who knows why each one is there and what to say about it. Call in mid-set to steer
it. Thumbs down an artist and it never comes back.

## What you need

| | Required | Notes |
|---|---|---|
| **Jellyfin** | yes | Any recent server with an API key. The browser never talks to Jellyfin directly; audio and art are proxied. |
| **Node 22+** | yes | Runs the pipeline on your workstation and the station wherever you like. |
| **Claude Code** | yes, for research | The skills in `.claude/skills/` drive setup, identification, research and the DJ. See the cost section before you start. |
| **OpenRouter key** | for the DJ | The planner runs on cheap models (gpt-5-mini / gpt-5-nano by default). Fractions of a cent per set, hard daily cap in code. |
| **A voice** | for the DJ | [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (free, CPU is fine) or OpenAI TTS via the same env vars. |
| **Coolify** | optional | For running the station on a server. `nixpacks.toml` and `DEPLOY.md` are ready. |

MusicBrainz, the local embedding model and Kokoro are free.

## What it costs, honestly

The station itself is cheap: a ten-track set with an opener and a couple of segues costs well under a cent on
OpenRouter, and the code refuses to spend past `OPENROUTER_DAILY_CAP_USD` (default one dollar). Weeks of
daily listening came to a few dollars.

**The up-front cost is research, and it is paid in Claude usage, not dollars.** Every artist and album you own
gets its own Claude Code subagent: Sonnet with a small web budget for the acts you play most, Haiku working
from a prepared packet for the long tail (five per agent), the same for albums. A library of a couple of
thousand artists is several hundred agent runs. That is a real bite out of a Claude subscription's limits,
spread over days or weeks.

The design leans into that instead of hiding it:

- **It runs unattended.** One "conductor" agent claims a batch, spawns the researchers, waits, ingests, and
  loops. Your own session stays tiny; the subagents do the reading, and the context is only carried around
  before it drops.
- **It stops cleanly at a usage limit and resumes later.** State lives only in SQLite. Nothing is ever
  redone, and nothing has to finish in one sitting. Point it at the queue in the hours your plan's allowance
  would otherwise expire unused: overnight, or the tail end of a reset window.
- **Your heaviest-played artists come first**, so the DJ gets good early and the long tail fills in behind it.
- **What it produces is yours forever**: a research corpus about your own collection, queryable by vibe,
  with sources noted. That is the thing the DJ reads from, and it never needs an LLM again once written.

If you would rather not spend subscription usage on the long tail there is an optional bulk-draft mode through
OpenRouter (`npm run research -- bulk`), locked behind an explicit env flag because it spends money.

## Quick start

```bash
git clone https://github.com/NTBooks/jay-dee.git
cd jay-dee
npm install
cp .env.example .env      # Jellyfin URL + API key, OpenRouter key, voice server
npm run doctor
```

Then open the folder in Claude Code and say **"set up Jay Dee for me"**. The `jaydee-setup` skill walks
through `.env`, interviews you for a taste profile (this is the DJ's system prompt; do not skip it), picks
which Jellyfin libraries count, runs the first sync and MusicBrainz pass, researches a first batch of
artists, builds the index and starts your first show at http://localhost:3131.

Doing it by hand instead:

| Step | Command | What happens |
|---|---|---|
| Sync | `npm run sync` | Jellyfin -> SQLite. Idempotent, never deletes, carries research across renames. `npm run sync -- libraries` picks which libraries count (and seasonal months for holiday music). |
| Identify | `npm run identify -- albums` / `artists` / `tracks` / `report` | MusicBrainz identities: real release years, original years, canonical names, release types, genres. One request per second, resumable. The report shows how wrong your tags were. |
| Research | `npm run research -- status` / `packets` / `ingest` / `derive` / `notable` | The queue. Claude Code subagents write strict JSON, the script validates and ingests it. Drive it with the `jaydee-research` skill (or its conductor prompt) rather than by hand. |
| Embed | `npm run embed -- build` / `search "<query>"` / `stats` | Local bge-small embeddings, in-process cosine search. Hash-gated, so re-runs only touch what changed. |
| Listen | `npm run serve`, then `npm run dj -- plan "<theme>" --no-tts` for dry runs | The station on http://localhost:3131. |
| Deploy | `npm run pack`, then follow `DEPLOY.md` | Bundles the database, taste files, voice cache and art for a Coolify volume. |

## The station

- **Radio mode**: Webamp (Winamp 2 in the browser) plays the queue; the side panel shows now playing, up next,
  history, saved sets, a call-in box and the DJ transcript. On phones the equalizer stays closed and a
  thumb-sized transport bar appears.
- **TV mode**: full-bleed artist and album art, rotating facts from the research corpus, big transport. The
  default on phones. **Album mode** plays whole owned albums front to back along the theme.
- **Call in**: tell the DJ "more of that, nothing after 1999, skip the synths". It answers on air and re-plans
  what is queued after the current track.
- **Thumbs**: up to hear more like it, down to never hear it again, double-tap down to block the artist.
- **Lock-screen controls** on phones (Media Session API), installable as a home-screen app.
- **One shared show.** Everyone on the URL hears the same queue; one browser drives it and others can take
  over. That is deliberate: it is a station, not a personal player.
- **Cost tracker** in the header: this show, today, all-time, straight from OpenRouter.

## Principles the code enforces

1. **Tags are hints, never truth.** ID3 years and genres are stored as `tag_*` and used only to find the right
   MusicBrainz entity. Everything the DJ sees comes from resolved columns and research.
2. **Never invent tracks.** Only Jellyfin ids that exist in the database are ever queued; LLM picks outside
   the candidate list are dropped and logged.
3. **State lives in the database.** Every stage is resumable and every session starts with a `status` command.
4. **The taste profile is the product.** A generic DJ is boring. `data/taste/profile.md` (gitignored, written
   by the `jaydee-taste` interview) is the DJ's system prompt and the researchers' listener context.
5. **Spend is guarded.** Hard daily cap on OpenRouter, bulk research locked unless unlocked, research never
   runs on OpenRouter by default.

## Layout

`src/config.mjs` (.env) · `src/db/` (idempotent schema + additive migrations) · `src/jellyfin/` (client,
sync) · `src/research/` (identify, sources, packets, queue, ingest, derive, notable, bulk) · `src/embed/`
(model, index) · `src/llm/` (OpenRouter, prompts) · `src/dj/` (candidates, planner, albums, tts, station,
vetoes) · `src/server/` (Express app, routes) · `public/` (the player) · `scripts/` (thin CLIs) ·
`.claude/skills/` (the Claude Code skills) · `export-skills/` (the same skills plus templates, for use from
another assistant or `~/.claude/skills`).

Project rules for Claude Code sessions are in `CLAUDE.md`. Deployment is in `DEPLOY.md`.

## Skills

Open the repo in Claude Code and they are available immediately:

| Skill | Use it when |
|---|---|
| `jaydee-setup` | Fresh checkout, no `.env` or database yet. |
| `jaydee-taste` | Writing or revising the taste profile and veto list. |
| `jaydee-sync` | You added music, or before anything that should see recent additions. |
| `jaydee-identify` | After a sync shows unprocessed items. |
| `jaydee-research` | Working the research queue. Long-running; hand it to the conductor agent. |
| `jaydee-embed` | After research lands, or to search the library by vibe. |
| `jaydee-dj` | Listening, themed sets, dry runs, voice tests, vetoes. |

## License

MIT. See `LICENSE`.
