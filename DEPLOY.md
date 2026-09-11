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
and `art/`. Re-run and re-upload whenever you have researched more of the library; the server never writes to
the catalog tables, only to the DJ tables (sessions, queue, feedback, saved sets, spend log), so copying the
workstation database over the server one loses those. If that matters, save sets on the workstation instead.

## 2. Create the app in Coolify

1. **New resource → Public/Private repository**, pick this repo and branch `main`.
2. **Build Pack: Nixpacks.** `nixpacks.toml` in the repo root sets Node 24, `npm ci --omit=dev` and
   `node scripts/serve.mjs`; no build step. **Ports Exposes: 3131.**
3. **Storage → Add volume**: destination path `/app/data` (name it `jaydee-data`). Everything mutable lives there.
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

Upload `jaydee-data.tar.gz` to the server, then from the Coolify terminal for the app container:

```bash
tar -xzf /tmp/jaydee-data.tar.gz -C /app/data
```

(or extract it straight into the volume directory on the host: `docker volume inspect jaydee-data` shows the
mountpoint). Restart the app. The embedding model (~130 MB) downloads into `/app/data/models` on the first theme
request; the container needs outbound HTTPS to huggingface.co for that.

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
- Backups: the volume is the only state. Coolify's scheduled backups can target the volume, or copy
  `/app/data/jaydee.sqlite` after `PRAGMA wal_checkpoint(TRUNCATE)`.
