// Is DATA_DIR actually persistent?
//
// A container that is missing its volume looks completely healthy: the station starts, the catalog can be
// published to it, playback works. The damage only shows up at the next redeploy, when the writable layer goes
// away and the catalog with it. That is a bad way to find out, so say it at startup instead.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import { log } from './log.mjs';

const inContainer = () => fs.existsSync('/.dockerenv') || (() => {
  try { return /docker|containerd|kubepods/.test(fs.readFileSync('/proc/1/cgroup', 'utf8')); } catch { return false; }
})();

// A mounted volume is a different filesystem from the image it is mounted into, so the device id differs from the
// parent directory's. Same device means the directory is just part of the container's writable layer.
function isMountPoint(dir) {
  try {
    const here = fs.statSync(dir);
    const up = fs.statSync(path.dirname(dir));
    return here.dev !== up.dev;
  } catch { return null; } // cannot tell (the directory may not exist yet)
}

export function describeDataDir() {
  const dir = config.dataDir;
  fs.mkdirSync(dir, { recursive: true });
  const container = inContainer();
  const mounted = isMountPoint(dir);
  return { dir, container, mounted, persistent: !container || mounted === true };
}

export function warnIfEphemeral() {
  const s = describeDataDir();
  if (s.container && s.mounted === false) {
    log.warn('='.repeat(78));
    log.warn(`DATA_DIR (${s.dir}) is NOT a mounted volume: it lives in the container's writable layer.`);
    log.warn('The station will work, but the catalog, voice cache and embedding model are thrown away on the');
    log.warn('next redeploy. In Coolify: Storages -> Volumes -> Destination Path = ' + s.dir);
    log.warn('='.repeat(78));
  } else if (s.container) {
    log.info(`data directory ${s.dir} is a mounted volume`);
  } else {
    log.debug(`data directory ${s.dir}`);
  }
  return s;
}
