---
name: jaydee-dj
description: Run the Jay Dee radio station and the AI DJ - start the web player (Winamp-style Radio Mode or full-art TV mode), request a themed set, dry-run a set plan, test the Kokoro voice, manage vetoes. Use when the user wants to listen, asks for a themed playlist/set/radio show, or wants to check the DJ or station.
---

# jaydee-dj

Prerequisites: catalog synced and identified, some research ingested, embeddings built (`npm run embed -- stats` shows tracks embedded), `OPENROUTER_API_KEY` set in `.env` (the planner needs it; playback/search work without it), Kokoro reachable (`npm run doctor`).

## Start the station
```bash
npm run serve
```
Run it in the background (it stays up). Open http://localhost:3131 in the Browser pane.
- **Radio** mode: Webamp (Winamp 2). Type a theme, press Go, wait for status `ready`, then press play in Winamp. The Winamp playlist shows the previous and upcoming items; DJ voice breaks appear as `»» …` entries. The right panel shows now playing, up next, history and the DJ transcript.
- **Call in** (Radio mode side panel): type a message to the DJ ("more Celtic energy", "nothing after 1999", "skip the vaporwave, guitars please"). The DJ answers on air (Kokoro) right after the current item and, if the message steers the music, re-plans everything queued after it (old upcoming items are marked `skipped` with reason `call-in`). Endpoint: `POST /api/dj/callin {message}`; history in `dj_calls`.
- **TV** mode (with an Album mode checkbox: whole owned albums, front to back, double-skip button drops the rest of an album): full-bleed artist/album art with rotating factoids from the research corpus; Start / Skip / Stop buttons. Only one mode plays audio at a time.
- The station refills itself when fewer than 3 tracks remain; a running session resumes after a server restart.

## Dry-run a set without the UI
```bash
npm run dj -- plan "spooky fun halloween, no dread" --length=10 --no-tts
```
Prints the plan (queries, year range), candidate count, dropped/invalid picks and the ordered items with patter text. Drop `--no-tts` to also render the voice breaks into `data/tts/` (cached by hash).

## Tuning (env in `.env`)
`DJ_SET_MIN=3` / `DJ_SET_MAX=10` (set length; first set uses the max), `DJ_REFILL_LENGTH=6`, `DJ_TRACKS_PER_SEGUE=4` (talk ration: opener once per session, then at most one segue per N tracks, no closers), `OPENROUTER_MODEL` (selection/persona), `OPENROUTER_FAST_MODEL` (theme interpretation, Haiku). LLM calls send `reasoning: {enabled:false}` and cache the system prompt; `npm run dj -- usage` shows tokens and cost per purpose. The "DJ booth" panel in the UI shows each planning step live.

## Pronunciation
Kokoro mangles heteronyms (wind/live/bass/record) and some names. `data/taste/pronunciations.json` holds regex rules applied only to the text Kokoro hears (screen text is untouched) using Misaki phoneme markup `[word](/phonemes/)` or plain respellings; edits take effect on the next render (the TTS cache key includes the rewritten text). Test a line with `npm run dj -- tts-test "<text>"`. The DJ prompt also steers away from heteronyms.

## Voice
```bash
npm run dj -- tts-test "Good evening, this is Jay Dee."
```
Voice/speed come from `.env` (`DJ_VOICE`, `DJ_VOICE_SPEED`); `curl http://localhost:3131/api/voices` lists the 68 Kokoro voices.

## Vetoes and taste
`data/taste/vetoes.json` (weight 0 = never play, 0.3 = down-weight). Apply with `npm run dj -- vetoes --apply`. The full taste profile at `TASTE_PROFILE_PATH` is the DJ's system prompt; edit it there, not here.

## Phones and servers
The same page works on phones: TV mode is the default there, Radio mode keeps the equalizer closed and adds a thumb transport bar, and lock-screen controls come from the Media Session API. For a hosted station follow `DEPLOY.md` (Coolify, `nixpacks.toml`, volume at `/app/data`, `STATION_PASSWORD` for HTTP Basic auth, `/healthz`). `npm run pack` bundles the data the server needs.

## Useful endpoints
`GET /api/station/state`, `GET /api/station/queue`, `POST /api/dj/theme {theme,length}`, `POST /api/station/stop`, `GET /api/search?q=...&type=track`, `GET /api/factoids/:trackId`, `GET /api/stats`, `GET /stream/:trackId` (Range-capable proxy), `GET /art/album|artist|track/:id`, `GET /tts/:hash`.

Rules: every played id comes from `tracks`; LLM picks outside the candidate list are dropped and logged; never more than 2 per artist per set; vetoed artists never play.
