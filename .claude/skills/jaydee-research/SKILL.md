---
name: jaydee-research
description: Drive the Jay Dee research queue - external research on every artist, album and notable track in the music library, written by Claude subagents into strict JSON and ingested into SQLite for playlist/DJ use. Use when asked to research the library, continue research, work the queue, or after a sync added new entities. Long-running and resumable; state lives only in the database.
---

# jaydee-research

State lives ONLY in `data/jaydee.sqlite` (`research` table) and `data/results/`. Never track progress in memory or context. Every session starts with:

```bash
npm run research -- status
```

If it lists **result files NOT yet ingested**, ingest them first:

```bash
npm run research -- ingest --all
```

Prerequisite: identification should be done for what you research (`npm run identify -- status` shows `unprocessed=0`); packets are far richer afterwards. Research order: **artists -> derive -> albums -> notable tracks**.

## Tiers (decided Sept 2026 to keep token spend sane)

| tier | who | agent model | web | per agent |
|---|---|---|---|---|
| deep | artists with 8+ tracks in the library (`--min-tracks 8`) | sonnet | 1 WebFetch + 2 WebSearch, budget is in the prompt file | 1 artist |
| light | the long tail (`--max-tracks 7 --light`) | haiku | none, packet only | 5 artists |
| albums | every album (`--type album --limit 25 --light`), packet-only; upgrade later with a deep pass if wanted | haiku | none | 5 albums |

Every `packets` run writes one ready-to-run prompt file per agent into `data/packets/<batch>/`. The agent prompt is always the one-liner
`Read the file "<path>" and do exactly what it says. Reply with one line.` Nobody pastes packet JSON into a prompt any more.

## The loop (repeat while budget allows)

Preferred: launch ONE background conductor agent (model sonnet) with the prompt in `references/conductor.md`; it runs the loop below
by itself and reports counts. Manual version:

1. Claim a batch, build packets, get prompt files:
   ```bash
   npm run research -- packets --type artist --limit 10 --upgrade-drafts --min-tracks 8
   ```
   Light tier: `--limit 25 --upgrade-drafts --max-tracks 7 --light` (5 artists per prompt file). Other variants: `--type album --limit 20`,
   `--type track --limit 20` (notable tracks), `--ids a,b` to force entities, `--per-agent K`.
2. Spawn one `general-purpose` agent per printed prompt file, all in one message, run in background, `model: "sonnet"` for deep,
   `"haiku"` for light, prompt = the one-liner above. Each agent writes `<results dir>/<entity_id>.json` and replies one line.
3. Wait until `ls <results dir> | wc -l` equals the batch size (poll every 60 s), then:
   ```bash
   npm run research -- ingest --all
   ```
   Files failing validation stay in place with a `.error.txt`; fix or redo that entity (ingest bumps `attempts`; three failures -> `failed`).
4. Back to 1. Stop when budget/time is up or nothing is pending. End the session by printing `status` and telling the user the counts.

## After artists are (partly) done

```bash
npm run research -- derive
```
Template summaries for every non-notable track (idempotent; re-run whenever artist/album research improves, only changed rows update).

```bash
npm run research -- notable
```
Flags ~15% of tracks (singles, seed artists, covers, Wikipedia/Last.fm/taste-profile mentions) as tier `notable` for Claude research via `packets --type track`.

## Cheap bulk drafts (optional, needs OPENROUTER_API_KEY in .env)

```bash
npm run research -- bulk --type artist --limit 50
```
Writes `draft` rows with the bulk model; later deep passes upgrade them with `--upgrade-drafts`.

## Housekeeping
`reset-stale` (claims older than 24 h back to pending), `retry-failed`, `skip <type> <id> "<reason>"`, `schema <type>` (prints the instructions + schema the agents must follow).

Rules: never invent albums/tracks; research may correct identity/year (tags never can); one artist per agent for deep tier; researchers stay inside the web budget written in their prompt file; report counts to the user, not file dumps. Research runs on Claude subagents only, never on OpenRouter (user rule). After research lands, run **jaydee-embed** so vector search sees it.
