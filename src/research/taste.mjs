// Mentions of an artist/album/track in the user's taste doctrine files (taste profile, extra notes from TASTE_EXTRA_FILES).
import fs from 'node:fs';
import path from 'node:path';
import { config, readTasteProfile } from '../config.mjs';

let cache = null;
function corpus() {
  if (cache) return cache;
  const lines = [];
  const add = (label, text) => { for (const l of text.split(/\r?\n/)) if (l.trim()) lines.push({ label, line: l.trim() }); };
  const prof = readTasteProfile();
  if (prof) add('taste-profile', prof);
  for (const p of config.tasteExtraFiles || []) {
    if (fs.existsSync(p)) add(path.basename(p), fs.readFileSync(p, 'utf8'));
  }
  cache = lines;
  return cache;
}

export function mentions(name, { max = 6 } = {}) {
  if (!name || name.length < 3) return [];
  const needle = name.toLowerCase();
  const out = [];
  for (const { label, line } of corpus()) {
    if (line.toLowerCase().includes(needle)) {
      out.push(`[${label}] ${line.length > 300 ? line.slice(0, 300) + '…' : line}`);
      if (out.length >= max) break;
    }
  }
  return out;
}

// The doctrine block the DJ and research subagents get as context.
export function doctrineRules() {
  const prof = readTasteProfile();
  if (!prof) return '';
  const start = prof.indexOf('## Core sensibility');
  const end = prof.indexOf('## Confirmed data points');
  return start >= 0 ? prof.slice(start, end > start ? end : undefined) : prof.slice(0, 4000);
}
