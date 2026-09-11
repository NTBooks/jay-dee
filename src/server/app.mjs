import path from 'node:path';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { config } from '../config.mjs';
import { openDb } from '../db/open.mjs';
import { Station } from '../dj/station.mjs';
import { JellyfinClient } from '../jellyfin/client.mjs';
import { stationRoutes } from './routes/station.mjs';
import { streamRoutes } from './routes/stream.mjs';
import { log } from '../util/log.mjs';

// HTTP Basic auth for every route except the health check. Browsers cache the credentials per origin, so the
// <audio> element, art and API calls all pass once the page has been unlocked; lock-screen controls keep working.
function basicAuth({ user, password }) {
  const want = Buffer.from(`${user}:${password}`);
  const same = (a) => a.length === want.length && timingSafeEqual(a, want);
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) { try { if (same(Buffer.from(h.slice(6), 'base64'))) return next(); } catch { /* malformed */ } }
    res.setHeader('www-authenticate', 'Basic realm="Jay Dee Radio", charset="UTF-8"');
    res.status(401).send('Jay Dee Radio: sign in');
  };
}

export function createApp() {
  const db = openDb();
  const station = new Station(db);
  const jf = new JellyfinClient();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Coolify's Traefik (or any reverse proxy)
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { if (!req.path.startsWith('/stream') && !req.path.startsWith('/art')) log.debug(`${req.method} ${req.path}`); next(); });

  // Liveness for the container platform: no auth, no database work.
  app.get('/healthz', (_req, res) => res.json({ ok: true, uptime_s: Math.round(process.uptime()) }));

  if (config.station.password) { app.use(basicAuth(config.station)); log.info(`station protected with HTTP Basic auth (user "${config.station.user}")`); }
  else log.warn('STATION_PASSWORD not set: anyone who can reach this port can drive the show and spend OpenRouter credit');

  app.use('/', stationRoutes({ db, station }));
  app.use('/', streamRoutes({ db, jf }));

  const pub = path.join(config.root, 'public');
  // Webamp's bundle is gitignored under public/vendor (a local copy); fall back to the npm package so a fresh
  // checkout or a container build serves it without a copy step.
  app.use('/vendor', express.static(path.join(pub, 'vendor'), { maxAge: '7d' }));
  app.use('/vendor/webamp', express.static(path.join(config.root, 'node_modules', 'webamp', 'built'), { maxAge: '7d' }));
  app.use(express.static(pub, { maxAge: 0, etag: true, index: 'index.html' }));
  app.use('/skins', express.static(path.join(pub, 'skins')));

  app.use((err, _req, res, _next) => {
    log.error(err.stack || err.message);
    res.status(500).json({ error: err.message });
  });
  fs.mkdirSync(path.join(config.dataDir, 'tts'), { recursive: true });
  return { app, db, station };
}
