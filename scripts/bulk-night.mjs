// Unattended overnight research through OpenRouter (cheap drafts). Runs artist bulk batches until the queue
// is empty or the spend cap for this run is reached, then derives track summaries and rebuilds embeddings.
//   node scripts/bulk-night.mjs [--budget 2.50] [--batch 40]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
const budget = opt('budget', 2.5);
const batch = opt('batch', 40);
const usageFile = path.join(config.dataDir, 'reports', 'llm-usage.jsonl');
const startedAt = new Date().toISOString();

function spentSinceStart() {
  if (!fs.existsSync(usageFile)) return 0;
  return fs.readFileSync(usageFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.purpose === 'research-bulk' && r.at >= startedAt).reduce((a, r) => a + (Number(r.cost) || 0), 0);
}
function run(argv) {
  const r = spawnSync(process.execPath, argv, { cwd: config.root, stdio: 'inherit' });
  return r.status;
}
if (!config.openrouter.allowBulk) { console.error('[bulk-night] refusing: bulk research spends OpenRouter credit. The owner must set OPENROUTER_ALLOW_BULK=yes in .env for a deliberate run.'); process.exit(2); }
console.log(`[bulk-night] start ${startedAt} budget=$${budget} batch=${batch}`);
for (let i = 0; i < 200; i++) {
  const spent = spentSinceStart();
  if (spent >= budget) { console.log(`[bulk-night] budget reached ($${spent.toFixed(3)})`); break; }
  const before = fs.existsSync(usageFile) ? fs.statSync(usageFile).size : 0;
  run(['scripts/research.mjs', 'bulk', '--type', 'artist', '--limit', String(batch), '--concurrency', '4']);
  const after = fs.existsSync(usageFile) ? fs.statSync(usageFile).size : 0;
  if (after === before) { console.log('[bulk-night] no LLM calls happened (queue empty or errors); stopping'); break; }
}
console.log('[bulk-night] deriving + embedding');
run(['scripts/research.mjs', 'derive']);
run(['scripts/embed.mjs', 'build']);
run(['scripts/research.mjs', 'status']);
console.log(`[bulk-night] done, spent $${spentSinceStart().toFixed(3)}`);
