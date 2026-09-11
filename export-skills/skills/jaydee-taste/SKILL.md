---
name: jaydee-taste
description: Interview the user about their music taste and write the Jay Dee taste profile (data/taste/profile.md) and veto list that the AI DJ uses as its system prompt. Use during setup, when the user says the DJ "doesn't get them", or whenever they want to update what the station should and should not play.
---

# jaydee-taste

The taste profile is the DJ's system prompt and the research subagents' listener context. Write it as a document of **rules learned from specific examples**, not adjectives. Keep the section headers below exactly; the code slices on them.

## The interview (15-25 minutes; adapt, do not read it like a form)
Ask in small groups, listen, and reflect back what you heard before moving on. Use their library as evidence: `node scripts/sql.mjs "select coalesce(resolved_name,tag_name) a, track_count from artists where canonical_id=jellyfin_id order by track_count desc limit 40"` gives you the forty heaviest artists to ask about.

1. **Load-bearing favorites.** Which five to ten artists would they be gutted to lose? For each: what is it about them (riff, voice, wit, texture)? Any artist whose big catalog in the library is misleading (bought once, never played)?
2. **Lanes.** What distinct moods/scenes does the library hold (e.g. nerd-rock, Celtic, vaporwave, game scores, novelty)? Which are deep vs. occasional?
3. **What kills a song for them.** Get specific rejections with reasons (too ironic, too gross, too polished, mumbled vocals, sounds like a knock-off of X). Turn each into a rule with the example attached.
4. **Vetoes.** Artists that must never play, and mild "rather not" ones. These go in `data/taste/vetoes.json` (weight 0 = never, 0.3 = down-weight).
5. **Covers, parodies, novelty.** When are they welcome? (e.g. "only if the cover transforms the song".)
6. **Eras and blind spots.** Is the digital library the whole collection or a time-window of it (vinyl elsewhere)? Which years feel like home?
7. **How they discover.** Do they follow side projects and collaborators? Trust "people who like X recommend Y" over "sounds similar"? This shapes how the DJ picks.
8. **Radio manners.** How much talk (default: an opener, then one break per four tracks)? Station name? Anything the DJ should never do (no shouting, no "folks", no fake enthusiasm)?

## Write the profile
Path: `data/taste/profile.md` (or `TASTE_PROFILE_PATH`). Structure, headers verbatim:

```
# Music Taste Profile
## Critical caveats (read first)
## Core sensibility
## The rules (in order of discovery, each from a correction)
## Relationship tiers
## Confirmed data points
## Vetoes (do not re-recommend)
## How to apply
```
Rules should read like: "**Clean-not-gross.** Band X = 'gross'. Likes weird but constructed (Band Y), never scuzzy." Attach the user's own words in quotes where you have them. Aim for 800-1,500 words; the whole file is sent to the DJ (prompt-cached), so tighter is cheaper.

Then write `data/taste/vetoes.json`:
```json
{ "vetoes": [ { "name": "Artist", "weight": 0, "reason": "their words" } ] }
```
and apply: `npm run dj -- vetoes --apply`.

## Check it
`npm run dj -- plan "<a theme they care about>" --length=8 --no-tts` prints a set without touching the live station. Read the picks and the opener back to the user; adjust the profile from their reaction and repeat once. Tell them the file is theirs to edit any time; changes apply to the next set planned.
