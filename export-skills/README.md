# Jay Dee: portable skills

The skills that run Jay Dee live in `.claude/skills/` and load automatically when the repository is opened in
Claude Code. This folder is a copy of them plus the starter templates, for people who want the skills somewhere
else: in `~/.claude/skills/` so they work from any folder, or adapted for another assistant.

Jay Dee is a personal radio station built on a Jellyfin music library: the catalog is mirrored into SQLite,
every artist/album/track is identified against MusicBrainz (ID3 tags are treated as untrusted hints),
researched, embedded for semantic search, and an AI DJ builds themed sets with a synthesized voice, played in a
browser with a Winamp-style mode and a "TV mode" art-and-facts mode. The top-level `README.md` explains the
project and what it costs; `DEPLOY.md` covers running the station on Coolify.

## What is in here

```
export-skills/
  README.md                       this file
  skills/
    jaydee-setup/SKILL.md         the guided onboarding: an LLM walks a new user from zero to a first show
    jaydee-taste/SKILL.md         interviews the user and writes their taste profile + vetoes (the DJ's brain)
    jaydee-sync/SKILL.md          refresh the catalog from Jellyfin (libraries, new music)
    jaydee-identify/SKILL.md      MusicBrainz identification, resolved years/genres, tag discrepancy report
    jaydee-research/SKILL.md      the long-running research queue (subagents write JSON, script ingests)
    jaydee-embed/SKILL.md         vector index build + semantic search
    jaydee-dj/SKILL.md            run the station, the DJ, call-ins, voice, cost tracking
  templates/
    env.example                   annotated .env
    profile.template.md           taste profile skeleton with the section headers the code relies on
    vetoes.json                   artists the DJ must never play (empty starter)
    pronunciations.json           words the voice mispronounces (starter rules)
```

## Install

1. Clone the repository (Node 22+, a Jellyfin server you have an API key for).
2. Nothing to copy if you use Claude Code in the project folder. Otherwise copy `skills/*` into
   `~/.claude/skills/`, or feed the SKILL.md files to whichever assistant you drive the CLI with.
3. Copy the templates into `data/taste/` (they are gitignored there: the taste profile is personal) and start a
   session with **"set up Jay Dee for me"**. The `jaydee-setup` skill takes it from there.

## Hard requirements and free alternatives

| Need | Default | Alternatives |
|---|---|---|
| Jellyfin | any 10.8+ with an API key | (required) |
| LLM for the DJ | OpenRouter key, gpt-5-mini / gpt-5-nano (fractions of a cent per set, hard daily cap) | any model on OpenRouter; the code disables hidden reasoning where allowed |
| Voice | Kokoro-FastAPI running anywhere on the LAN (free, CPU is fine) | OpenAI TTS via `KOKORO_URL=https://api.openai.com`, `TTS_API_KEY`, `TTS_MODEL=gpt-4o-mini-tts`, `DJ_VOICE=onyx`; any other OpenAI-compatible speech server |
| Embeddings | local `Xenova/bge-small-en-v1.5` via transformers.js (downloads ~130 MB once) | `EMBED_PROVIDER=openrouter` |
| Research | Claude Code subagents (the operator's own Claude subscription usage; the big up-front cost, resumable, runs unattended) | `npm run research -- bulk` through OpenRouter for cheaper drafts, locked behind an env flag |
| MusicBrainz | free, 1 request/second, needs a descriptive User-Agent | (required for identification) |
| Hosting the station | your workstation (`npm run serve`) | Coolify with the repo's `nixpacks.toml` (see `DEPLOY.md`) |

## Principles the skills enforce

- **Tags are hints, never truth.** Jellyfin/ID3 years and genres are stored as `tag_*` and only used to identify things; everything the DJ sees comes from MusicBrainz + research.
- **Never invent tracks.** Only ids from the database are ever queued.
- **State lives in the database.** Every stage is resumable; sessions start by running a `status` command.
- **One shared show.** The station is a single live queue; one browser drives it and others can take over.
- **The taste profile is the product.** A generic DJ is boring; the `jaydee-taste` interview is where a new user's station starts to sound like them.
- **Spend is guarded.** Research never runs on OpenRouter unless the user unlocks it; the DJ has a hard daily cap.
