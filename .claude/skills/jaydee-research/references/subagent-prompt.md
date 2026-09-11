# Subagent prompts

Since Sept 2026 the prompt is generated: `npm run research -- packets ...` writes one file per agent into `data/packets/<batch>/`
(see `src/research/promptfiles.mjs`: deep = one artist, Sonnet, 1 fetch + 2 searches; light = 5 artists, Haiku, packet only).
Spawn each with:

```
Read the file "<prompt file path>" and do exactly what it says. Reply with one line.
```

The generated file contains the rules, the schema, the packet facts and the output path. The legacy hand-written template
below is kept for ad-hoc single entities (e.g. `--ids`) and for albums/tracks.


Agent type: `general-purpose`, run_in_background: true, about 5 in parallel. One artist per agent; 3-4 albums or 5 tracks per agent.

```
You are a music researcher for a personal radio-DJ knowledge base. Research and write JSON result files.

1. Read the packet file `<PACKET FILE PATH>` and find the entity/entities with entity_id in: <ENTITY IDS AND NAMES>.
   The packet holds: identity (MusicBrainz MBID + resolution confidence), library evidence (albums/tracks the listener owns; resolved values, with tag_* values flagged "untrusted ID3 tag"), MusicBrainz genres/urls, Wikipedia summary (if found), Last.fm data (if present), taste_profile_mentions (how the listener relates to it), and for albums/tracks the researched artist_context.
2. Run `npm run research -- schema <artist|album|track>` (from the project root) to print the exact instructions and JSON schema. Follow them precisely.
3. Research with WebSearch / WebFetch (Wikipedia, AllMusic, Bandcamp, Discogs, reviews, interviews). Be concrete and specific: formation/origin, sound and evolution, key records, collaborations and side projects (these become "upstream" advocacy-graph edges), placements in film/TV/games, anything usable as on-air patter. Tag values may be wrong: verify years from sources. For albums the ORIGINAL release year is a research target. For tracks, original_year is the recording's first release, not the compilation/reissue it sits on here.
4. Never invent albums or tracks: key_albums / notable_tracks must come from the packet lists.
5. If the packet identity looks wrong (a different act with the same name), set identity.confirmed=false, explain in identity.note, and research the act the LIBRARY actually contains (use its album/track titles as evidence).
6. Write ONE JSON object per entity to `<RESULTS DIR>\<entity_id>.json` with the Write tool. entity_id must match exactly. Include the real source URLs you used in `sources`.
7. Reply with one line per file written: path + confidence. Nothing else.
```
