---
slopscore: 2
spec: https://slopscore.org/spec
ai_generated: entirely
human_touch: light
content_rating: everyone
contains: [scraping]
category: [media, agent, web-app]
status: works-on-my-machine
tagline: Your Jellyfin music library as a radio station with an AI DJ that only plays what you already own.
built_with: [claude-code]
models: [claude-fable-5-1, gpt-5-mini, gpt-5-nano]
interface: [web, cli]
frameworks: [express, webamp]
platforms: [windows, linux, docker]
audience: [end-users, me]
data: [local-only, needs-api-key]
needs: [jellyfin, openrouter, kokoro-fastapi, musicbrainz]
domain: [music, radio, jellyfin]
tags: [jellyfin, musicbrainz, winamp, webamp, kokoro, sqlite, vector-search, coolify, self-hosted]
slopbucket: [media, vibe-coded]
maintainers: [NTBooks]
---
## A DJ for the music you already have

Type "rainy afternoon vaporwave with a Celtic detour" and get ten tracks from your own Jellyfin library, in an order that makes sense, with a synthesized DJ who knows why each one is there. Call in mid-set to steer it. Thumbs down an artist and it never comes back.

Under the hood: the library is mirrored into SQLite, every artist, album and track is identified against MusicBrainz (ID3 tags are treated as hints, never truth), Claude Code subagents research every act you own, the research is embedded for semantic search, and a cheap OpenRouter model builds each set from candidates it is not allowed to invent. Playback is Webamp (Winamp 2) in the browser, or a full-art TV mode. Works on phones, deploys to Coolify.

The honest cost: the station runs on pennies with a hard daily cap, but researching a whole library burns Claude subscription usage up front. It is built to run unattended in the hours your allowance would otherwise expire, stop cleanly at a limit, and never redo anything.
