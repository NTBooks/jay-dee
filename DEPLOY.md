# Deploying the station with Coolify

The web station (`npm run serve`) runs anywhere Node 22+ runs. The catalog pipeline (sync, identify, research,
embed) stays on your workstation: it needs Claude Code for research and MusicBrainz rate limits make it a
background hobby, not a server job. The server only needs the resulting database plus your taste files.

What the container talks to:

| Service | Env var | Notes |
|---|---|---|
| Jellyfin | `JELLYFIN_URL`, `JELLYFIN_API_KEY` | Must be reachable from the container (LAN address, Tailscale, or a public URL). The browser never sees it; audio and art are proxied. |
| OpenRouter | `OPENROUTER_API_KEY` | The DJ brain. Optional: without it playback and saved sets work, themes and call-ins do not. |
| Voice | `KOKORO_URL` (+ `TTS_API_KEY`, `TTS_MODEL` for OpenAI) | Kokoro-FastAPI as a second Coolify service (`ghcr.io/remsky/kokoro-fastapi-cpu:latest`, port 8880) or OpenAI TTS. |

## 1. Prepare the data once (workstation)

```bash
npm run pack
```

That checkpoints the SQLite WAL and writes `jaydee-data.tar.gz` containing `jaydee.sqlite`, `taste/`, `tts/`
and `art/`. This is for the first load; after that, publish new research through the Catalog panel (below), which
keeps the server's own DJ data. Untarring over the volume does not: it replaces the server's shows, play history,
saved sets and feedback with the workstation's.

## 2. Create the app in Coolify

1. **New resource → Public/Private repository**, pick this repo and branch `main`.
2. **Build Pack: Nixpacks.** `nixpacks.toml` in the repo root sets Node 24, `npm ci --omit=dev` and
   `node scripts/serve.mjs`; no build step. **Ports Exposes: 3131.**
3. **Storages → Volumes → Add**: **Destination Path `/app/data`**. The volume name does not matter (Coolify
   generates one); leave Source Path empty so Docker manages it. Everything mutable lives there: the catalog
   database, the voice cache, the embedding model, cached art, taste files and the databases restores set aside.
   `nixpacks.toml` pins `DATA_DIR=/app/data` so this path is not a guess.

   Miss this and nothing appears wrong — the station runs, publishing works, playback works — until the next
   redeploy throws the catalog away. So the app checks: if it is in a container and `DATA_DIR` is not a mount
   point, it prints a boxed warning at startup and the Catalog panel says so, on the server and to any workstation
   publishing to it.
4. **Environment variables** (all runtime, none are build-time):

   ```
   JELLYFIN_URL=http://<jellyfin-host>:8096
   JELLYFIN_API_KEY=...
   OPENROUTER_API_KEY=...
   OPENROUTER_DAILY_CAP_USD=1.00
   KOKORO_URL=http://<kokoro-service>:8880
   STATION_NAME=W-LLM
   STATION_PASSWORD=<something long>
   MB_USER_AGENT=JayDee/0.1 (your contact)
   ```

   `STATION_PASSWORD` turns on HTTP Basic auth for the whole site (user `dj`, change with `STATION_USER`).
   Do not skip it on a public URL: anyone who finds the station can otherwise change the show and spend your
   OpenRouter credit. The daily cap in code is the second line of defence.
5. **Health check**: path `/healthz`, port 3131 (it is exempt from the password).
6. Deploy. The first start creates an empty database; the station shows an empty catalog until step 3 below.

## 3. Load the data into the volume

### One button, from the workstation (no file handling)

Put the server's address and password in the workstation's `.env`:

```
REMOTE_STATION_URL=https://<your-domain>
REMOTE_STATION_PASSWORD=<the server's STATION_PASSWORD>
```

Restart `npm run serve` on the workstation, open its station, click **Catalog**. The panel now shows the server,
what it is currently serving, and **Publish this catalog**. That takes a consistent snapshot of the local database,
sends it to the server to be checked, and on success swaps it in — with a progress bar, and nothing to pick, pack
or paste. This is the normal way to publish after a research session.

### Uploading a database by hand (no container shell)

Open the station, sign in, and click **Catalog** in the header. Choose (or drop in) `data/jaydee.sqlite` from the
workstation. The file uploads, the server reports what is inside it next to what it is about to replace, and
**Replace catalog** commits the swap. No restart: the station reopens the new database in place.

What that endpoint does before it touches anything:

- rejects a file that is not SQLite, fails `PRAGMA integrity_check`, lacks the catalog tables, or holds no tracks
  (so a `.tar.gz`, a half-finished upload or an empty database cannot take the station down);
- renames the database it is replacing into `data/backups/` and lists it under **Kept databases** with a download
  link, so a wrong upload is one click from being undone. The three most recent are kept (`RESTORE_KEEP_BACKUPS`);
- applies `schema.sql` and the additive migrations afterwards, so an older workstation database is brought forward.

**Restore is refused unless `STATION_PASSWORD` is set**, or the request comes from localhost. Everything else on the
station is only worth a listener's mischief; this one replaces the catalog, so it does not run unauthenticated.

The same thing from the workstation, without opening a browser:

```bash
npm run restore -- check  data/jaydee.sqlite                      # what is in the file
npm run restore -- push   data/jaydee.sqlite https://<your-domain> # upload it to the station
npm run restore -- push   data/jaydee.sqlite https://<your-domain> --dry-run
```

`push` sends `STATION_USER` / `STATION_PASSWORD` from your `.env` as Basic auth, so the password stays out of your
shell history. It validates the file locally first and refuses to send hundreds of megabytes of something unusable.

Uploads are capped at 4 GB (`RESTORE_MAX_MB`). On the container itself, `node scripts/restore.mjs apply <file>`
swaps a file already on the volume, and `snapshot`/`list`/`status` cover the rest.

### The voice cache, art and taste files

Those are not in the database. Use `npm run pack` and unpack the archive into the volume — from the Coolify
terminal for the app container:

```bash
tar -xzf /tmp/jaydee-data.tar.gz -C /app/data
```

(or extract it straight into the volume directory on the host: `docker volume inspect jaydee-data` shows the
mountpoint). Restart the app. The embedding model (~130 MB) downloads into `/app/data/models` on the first theme
request; the container needs outbound HTTPS to huggingface.co for that.

### Which way to use

`pack` + untar is the one-shot first load: it carries the voice cache and art as well. After that, when all you
have done is research more of the library, the Catalog panel is the whole update — and it keeps the database it
replaced, which untarring over the volume does not.

The server's own DJ tables (shows and their queues, play history, voice breaks, call-ins, saved sets, feedback) live
in the same file as the catalog, but they belong to the server: a restore or publish takes the catalog from the upload
and copies those tables over from the database it replaces, so the DJ still knows what it played recently and the show
on air keeps going. A server that has never played anything keeps the upload's instead. To take the upload's on
purpose, add `?station_data=upload` to the restore request or `--station-data=upload` to `restore apply|push`. The
spend log is a file next to the database and is never touched.

## 4. Check

- `https://<your-domain>/healthz` answers `{"ok":true,...}` without a password.
- The page asks for the password, then the queue panel lists a saved set or an empty "Up next".
- The header cost tracker shows OpenRouter totals if the key is set.
- Ask for a theme. The DJ booth should step through interpret → search → pick → voice; a Kokoro error here means
  `KOKORO_URL` is wrong from inside the container (service names resolve only within the same Coolify network/project).

## Kokoro as a Coolify service

New resource → Docker image `ghcr.io/remsky/kokoro-fastapi-cpu:latest`, port 8880, no public domain needed.
Put it in the same project/environment as the station and set `KOKORO_URL=http://<its-service-name>:8880`.
A GPU build (`kokoro-fastapi-gpu`) renders voice breaks in a second or two instead of ten.

## Notes

- Coolify's Traefik terminates TLS; the app trusts one proxy hop (`trust proxy`).
- The station is one shared show: everyone on the URL hears and controls the same queue. That is by design.
- Backups: the volume is the only state. Coolify's scheduled backups can target the volume; for a single file,
  `GET /api/admin/db/download` (or `npm run restore -- snapshot`) writes a consistent copy with `VACUUM INTO`,
  which is safe to take while the station is serving — a plain `cp` of a WAL-mode database is not.
- `data/restore/` is scratch space for uploads in flight and is safe to delete; `data/backups/` holds the
  databases that restores set aside.
