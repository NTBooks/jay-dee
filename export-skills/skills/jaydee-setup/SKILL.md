---
name: jaydee-setup
description: Guided first-time setup of Jay Dee (Jellyfin music catalog + MusicBrainz identification + research + AI radio DJ) for a new user on their own Jellyfin server. Use when someone says "set up Jay Dee", "install the radio DJ", "get this working with my Jellyfin", or is on a fresh checkout with no .env or database yet.
---

# jaydee-setup

You are guiding a person through setting up their own Jay Dee station. Be conversational, one step at a time, and verify each step with a command before moving on. Everything below runs from the project root. Never ask the user to paste secrets into chat: tell them which file and line to edit, then verify with `npm run doctor` (it never prints secrets).

## 0. Ground rules to explain up front (two sentences each)
- Their ID3 tags will NOT be trusted; the system identifies everything against MusicBrainz and researches it. That is why the first identification pass takes a while.
- The station is one shared show; whoever presses Go changes what everyone hears.

## 1. Prerequisites (check, do not assume)
```bash
node --version
```
Need Node 22+. Then `npm install` in the project root. Ask where Jellyfin lives (URL) and confirm it answers:
```bash
curl -s http://<jellyfin-host>:8096/System/Info/Public
```
Ask which voice backend they have: Kokoro-FastAPI (free, local; suggest it if they have any always-on box) or OpenAI TTS. Ask for an OpenRouter account (https://openrouter.ai/keys); recommend the default cheap models.

## 2. Configure `.env`
`cp .env.example .env` (Windows: `copy`). Walk through the sections in order; the file is annotated:
- Jellyfin URL and an API key (Dashboard -> Administration -> API Keys -> +). Optional user id.
- OpenRouter key. Leave the model defaults.
- Voice: Kokoro URL, or the OpenAI settings shown in the comments.
- `MB_USER_AGENT`: MusicBrainz wants an app name and a contact URL or email. Ask what the user is comfortable sharing; never put in an address they did not choose.
- `STATION_NAME`: ask what they want the station called (call letters, a joke, anything). The DJ says it on air.
Verify:
```bash
npm run doctor
```
Every line should be OK except the taste profile (next step). Fix anything FAIL before continuing.

## 3. Taste profile (do not skip)
Run the **jaydee-taste** skill now: it interviews the user and writes `data/taste/profile.md` and `data/taste/vetoes.json`. The DJ literally uses that file as its system prompt; without it the station is generic.

## 4. First sync and libraries
```bash
npm run sync
```
Read the summary back to the user (counts of tracks/albums/artists; they should match what Jellyfin shows). Then:
```bash
npm run sync -- libraries
```
Show the libraries Jellyfin reported and ask which to include and whether any are seasonal (holiday music -> `--months "Name" "11,12"`). Apply with `--include/--exclude/--months`.

## 5. Identification (the long one)
Explain: one MusicBrainz call per album, about 1.3 s each, so ~1 hour per 2,500 albums, resumable. Start it in the background and move on:
```bash
npm run identify -- albums
```
then, when it finishes, `npm run identify -- artists`, `npm run identify -- tracks`, `npm run identify -- report`. Show the user the discrepancy report summary: it is usually eye-opening how wrong their tag years were.

## 6. First research batch and derived summaries
Follow **jaydee-research** for two or three batches of artists (their heaviest-played acts come first automatically), then:
```bash
npm run research -- derive
npm run embed -- build
```
The index build takes 10-20 minutes for a large library on CPU; run it in the background.

## 7. First show
```bash
npm run serve
```
Open http://localhost:3131. Ask for a theme in their own words, press Go, and stay with them through the first set: check the DJ booth panel shows the steps, that audio plays (the big play button appears if the browser blocked autoplay), and that the cost tracker in the header shows fractions of a cent. Show them the call-in box.

## 8. What to leave them with
- The five operating skills and when to use each (sync after adding music; identify after sync; research as an ongoing background hobby; embed after research; dj to listen).
- `npm run dj -- usage` and the header cost tracker.
- `data/taste/profile.md` is theirs to edit; `data/taste/vetoes.json` for hard bans; `data/taste/pronunciations.json` for words the voice mangles.
- Everything is resumable; nothing needs to finish in one sitting.
