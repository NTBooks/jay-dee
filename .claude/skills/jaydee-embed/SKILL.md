---
name: jaydee-embed
description: Build or refresh the vector index for the Jay Dee music catalog (artists, albums, tracks) from research summaries, and run semantic searches against it. Use after research has been ingested, when the DJ's picks look stale, or when the user asks to search the library by vibe/theme.
---

# jaydee-embed

Embeddings are computed from resolved metadata + research text only (never ID3 tags) and stored as float32 blobs in `embeddings`; search is in-process cosine. Hash-gated: re-running only embeds rows whose text changed.

```bash
npm run embed -- build
```
First run downloads the local model (`Xenova/bge-small-en-v1.5`, ~130 MB into `data/models`). 18k tracks take roughly 10-20 minutes on CPU; run in the background for a full build. `--type track|album|artist` limits scope. Set `EMBED_PROVIDER=openrouter` in `.env` to use OpenRouter embeddings instead (changing provider re-embeds everything).

```bash
npm run embed -- stats
```
Embedded rows per type should match the `embeddable` research counts (done + draft + derived).

Sanity searches after a build (expectations from the taste profile):
```bash
npm run embed -- search "warm cinematic western twang" --type track -k 8
```
```bash
npm run embed -- search "spooky fun halloween novelty" --type artist -k 8
```
```bash
npm run embed -- search "quiet piano new age" --type album -k 8 --from 1980 --to 1999
```
Vetoed artists never appear (filter on by default). `--per-artist N` caps results per artist. Years filter on `original_year` (tracks) / resolved `year` (albums).

Rule: the queue must be re-embedded after `npm run research -- derive` or any ingest; the DJ reads these vectors live (the server reloads its cache after a build).
