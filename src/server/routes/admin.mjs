// Catalog maintenance over HTTP: upload a workstation database onto the server, download what is running now.
//
// The upload is a raw body rather than a multipart form on purpose. The catalog is a few hundred megabytes and
// streams straight to disk; multipart would mean a parser dependency and a second copy of the file.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../../config.mjs';
import { inspect, restoreFrom, listBackups, snapshot, stagingDir, backupsDir, summarize, statOf } from '../../db/restore.mjs';
import { openDb } from '../../db/open.mjs';
import { describeDataDir } from '../../util/storage.mjs';
import { startPublish, publishState, remoteStatus, isConfigured } from '../../db/publish.mjs';
import { log } from '../../util/log.mjs';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_UPLOAD = Number(process.env.RESTORE_MAX_MB || 4096) * 1048576;
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress || '');

// Replacing the catalog is the most destructive thing the station can do, so it needs a real gate. HTTP Basic
// already covers every route when STATION_PASSWORD is set; when it is not, only a local browser may restore.
function guard(req, res) {
  if (config.station.password || isLoopback(req)) return true;
  res.status(403).json({ error: 'restore is disabled: set STATION_PASSWORD so the endpoint is behind a password, or use the station from localhost' });
  return false;
}

export function adminRoutes({ station }) {
  const r = express.Router();

  // What is running right now, plus the databases we are holding onto.
  r.get('/api/admin/db', wrap(async (req, res) => {
    res.json({
      path: config.dbPath,
      file: statOf(config.dbPath),
      counts: summarize(openDb()),
      storage: describeDataDir(),
      backups: listBackups(),
      restore_enabled: Boolean(config.station.password) || isLoopback(req),
      protected: Boolean(config.station.password),
      max_upload_mb: Math.round(MAX_UPLOAD / 1048576),
    });
  }));

  // Publishing: this machine sends its own catalog to the station it feeds. No file to choose, no archive to build.
  r.get('/api/admin/publish', wrap(async (_req, res) => {
    res.json({ configured: isConfigured(), job: publishState(), remote: await remoteStatus() });
  }));

  r.post('/api/admin/publish', wrap(async (req, res) => {
    if (!guard(req, res)) return;
    if (!isConfigured()) return res.status(400).json({ error: 'no REMOTE_STATION_URL set: add it (and REMOTE_STATION_PASSWORD) to .env, then restart' });
    try { res.json({ ok: true, job: startPublish() }); }
    catch (e) { res.status(409).json({ error: e.message }); }
  }));

  // Stream the upload to the data volume, then either report on it or swap it in.
  // ?dry_run=1 validates and discards, so the browser can show what is in the file before committing.
  r.post('/api/admin/restore', wrap(async (req, res) => {
    if (!guard(req, res)) return;
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD) return res.status(413).json({ error: `upload is larger than the ${Math.round(MAX_UPLOAD / 1048576)} MB limit (raise RESTORE_MAX_MB)` });

    fs.mkdirSync(stagingDir(), { recursive: true });
    const staged = path.join(stagingDir(), `upload-${Date.now()}.sqlite`);
    let bytes = 0;
    try {
      req.on('data', (c) => { bytes += c.length; });
      await pipeline(req, fs.createWriteStream(staged));
    } catch (e) {
      fs.rmSync(staged, { force: true });
      return res.status(400).json({ error: `upload failed: ${e.message}` });
    }
    if (!bytes) { fs.rmSync(staged, { force: true }); return res.status(400).json({ error: 'empty upload' }); }
    if (declared && bytes !== declared) { fs.rmSync(staged, { force: true }); return res.status(400).json({ error: `upload truncated: expected ${declared} bytes, received ${bytes}` }); }

    const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
    try {
      if (dryRun) {
        const info = inspect(staged);
        return res.json({ dry_run: true, ok: true, upload: info, current: summarize(openDb()) });
      }
      const keepBackup = req.query.keep_backup !== '0';
      const out = restoreFrom(staged, { station, keepBackup });
      return res.json({ ok: true, ...out });
    } catch (e) {
      log.warn(`restore rejected: ${e.message}`);
      return res.status(422).json({ error: e.message });
    } finally {
      fs.rmSync(staged, { force: true }); // no-op once a successful restore has renamed it away
    }
  }));

  // A consistent copy of the live database, for keeping the server's DJ tables before overwriting them.
  r.get('/api/admin/db/download', wrap(async (req, res) => {
    if (!guard(req, res)) return;
    const tmp = path.join(stagingDir(), `snapshot-${Date.now()}.sqlite`);
    try {
      const info = snapshot(tmp);
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', String(info.bytes));
      res.setHeader('content-disposition', `attachment; filename="jaydee-${new Date().toISOString().slice(0, 10)}.sqlite"`);
      await pipeline(fs.createReadStream(tmp), res);
    } finally { fs.rmSync(tmp, { force: true }); }
  }));

  // Retrieve a database that a restore set aside, so a bad upload is recoverable from the browser.
  r.get('/api/admin/backups/:name', wrap(async (req, res) => {
    if (!guard(req, res)) return;
    const name = path.basename(String(req.params.name));
    const file = path.join(backupsDir(), name);
    if (!name.endsWith('.sqlite') || !fs.existsSync(file)) return res.status(404).json({ error: 'no such backup' });
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
    await pipeline(fs.createReadStream(file), res);
  }));

  r.delete('/api/admin/backups/:name', wrap(async (req, res) => {
    if (!guard(req, res)) return;
    const name = path.basename(String(req.params.name));
    const file = path.join(backupsDir(), name);
    if (!name.endsWith('.sqlite') || !fs.existsSync(file)) return res.status(404).json({ error: 'no such backup' });
    fs.rmSync(file, { force: true });
    res.json({ ok: true, deleted: name, backups: listBackups() });
  }));

  return r;
}
