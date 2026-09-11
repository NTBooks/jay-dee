// Usage: npm run dj -- vetoes --apply | plan "<theme>" | tts-test "<text>"
import { openDb, closeDb } from '../src/db/open.mjs';
import { applyVetoes, loadVetoes } from '../src/dj/vetoes.mjs';
import { log } from '../src/util/log.mjs';

const [cmd, ...rest] = process.argv.slice(2);
try {
  const db = openDb();
  if (cmd === 'vetoes') {
    if (rest.includes('--apply')) {
      const hits = applyVetoes(db);
      console.table(hits);
    } else console.table(loadVetoes().map(({ name, weight, reason }) => ({ name, weight, reason })));
    const n = db.prepare('SELECT COUNT(*) n FROM artists WHERE veto = 1').get().n;
    console.log(`artists.veto = 1 on ${n} rows`);
  } else if (cmd === 'plan') {
    const { planSet } = await import('../src/dj/planner.mjs');
    const theme = rest.filter((a) => !a.startsWith('--')).join(' ');
    const lenArg = rest.find((a) => a.startsWith('--length='));
    const set = await planSet(db, theme, { length: lenArg ? Number(lenArg.split('=')[1]) : 10, renderTts: !rest.includes('--no-tts') });
    console.log(JSON.stringify(set, null, 2));
  } else if (cmd === 'manual') {
    // npm run dj -- manual "<title>" --query "<semantic query>" [--intro "<spoken intro>"]   (server must be running: uses the HTTP API)
    const title = rest.find((a) => !a.startsWith('--')) || 'Manual set';
    const get = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
    const { config } = await import('../src/config.mjs');
    const r = await fetch(`http://localhost:${config.port}/api/dj/manual`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, query: get('query'), intro: get('intro'), k: Number(get('k') || 8) }) });
    console.log(await r.json());
  } else if (cmd === 'usage') {
    const { usageSummary } = await import('../src/llm/openrouter.mjs');
    const u = usageSummary({ hours: Number(rest.find((a) => a.startsWith('--hours='))?.split('=')[1] || 24) });
    if (!u.all) console.log('no LLM usage logged yet');
    else {
      const fmt = (o) => ({ calls: o.calls, prompt_tokens: o.in, cached: o.cached, completion_tokens: o.out, cost_usd: +o.cost.toFixed(4) });
      console.log(`last ${u.hours}h by purpose:`); console.table(Object.fromEntries(Object.entries(u.recent.by).map(([k, v]) => [k, fmt(v)])));
      console.log('last period total:', fmt(u.recent.total)); console.log('all time total:', fmt(u.all.total)); console.log('log:', u.file);
    }
  } else if (cmd === 'tts-test') {
    const { renderPatter } = await import('../src/dj/tts.mjs');
    const r = await renderPatter(db, rest.join(' ') || 'Good evening, this is Jay Dee.');
    console.log(r);
  } else {
    console.log('usage: npm run dj -- vetoes [--apply] | plan "<theme>" [--length=10] [--no-tts] | tts-test "<text>"');
  }
  closeDb();
  process.exit(0);
} catch (e) { log.error(e.stack || e.message); process.exit(1); }
