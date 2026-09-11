// OpenRouter chat + embeddings (OpenAI-compatible), with Anthropic prompt caching on the system prompt
// and per-call usage/cost logging to data/reports/llm-usage.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';
import { log } from '../util/log.mjs';

const USAGE_FILE = () => path.join(config.dataDir, 'reports', 'llm-usage.jsonl');

function headers() {
  if (!config.openrouter.apiKey) throw new Error('OPENROUTER_API_KEY missing in .env');
  return { authorization: `Bearer ${config.openrouter.apiKey}`, 'content-type': 'application/json', 'HTTP-Referer': 'http://localhost:3131', 'X-Title': 'Jay Dee radio' };
}

function logUsage(entry) {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE()), { recursive: true });
    fs.appendFileSync(USAGE_FILE(), JSON.stringify(entry) + '\n');
  } catch { /* never block on logging */ }
}

// Spend guard: today's spend from the local per-call log (which now includes billed failures), UTC-agnostic local day.
export function spentTodayUsd() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  // bulk research is excluded here because it has its own explicit lock; this cap protects against the DJ/day-to-day use running away
  return usageRows().filter((r) => Date.parse(r.at) >= dayStart.getTime() && r.purpose !== 'research-bulk').reduce((a, r) => a + (Number(r.cost) || 0), 0);
}
export function assertBudget(purpose) {
  const spent = spentTodayUsd();
  const cap = config.openrouter.dailyCapUsd;
  if (cap > 0 && spent >= cap) throw Object.assign(new Error(`OpenRouter daily cap reached ($${spent.toFixed(2)} of $${cap.toFixed(2)} today). Raise OPENROUTER_DAILY_CAP_USD in .env if you mean to spend more.`), { status: 402, budget: true });
  if (purpose === 'research-bulk' && !config.openrouter.allowBulk) throw Object.assign(new Error('Bulk research is locked: it spends OpenRouter credit. Set OPENROUTER_ALLOW_BULK=yes in .env for a deliberate run.'), { status: 402, budget: true });
}

export async function chat({ model = config.openrouter.model, system, messages, json = false, temperature = 0.7, maxTokens = 4000, timeoutMs = 120_000, retries = 2, purpose = 'chat', reasoning = false }) {
  assertBudget(purpose);
  const body = {
    model, temperature, max_tokens: maxTokens,
    usage: { include: true },
    // structured DJ calls do not need extended thinking; reasoning tokens are billed and count against max_tokens.
    // OpenAI's GPT-5 family cannot turn reasoning off, only down to "minimal"; Anthropic/Google accept enabled:false.
    reasoning: reasoning ? { effort: 'low' } : (/^openai\//.test(model) ? { effort: 'minimal' } : { enabled: false }),
    messages: [
      // system prompt as a cacheable block: Anthropic models via OpenRouter honour cache_control (5-min TTL, ~90% cheaper on hits)
      ...(system ? [{ role: 'system', content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }] : []),
      ...messages,
    ],
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const r = await fetch(`${config.openrouter.baseUrl}/chat/completions`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        // provider insists on reasoning: retry once with the lowest effort it allows
        if (r.status === 400 && /reasoning/i.test(txt) && body.reasoning?.enabled === false) { body.reasoning = { effort: 'low' }; throw Object.assign(new Error(`reasoning mandatory for ${model}; retrying with effort=low`), { status: 500 }); }
        if (r.status === 400 && /reasoning/i.test(txt) && body.reasoning?.effort === 'minimal') { body.reasoning = { effort: 'low' }; throw Object.assign(new Error(`minimal reasoning rejected for ${model}; retrying with effort=low`), { status: 500 }); }
        throw Object.assign(new Error(`OpenRouter ${r.status}: ${txt.slice(0, 300)}`), { status: r.status });
      }
      const data = await r.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      const usage = data.usage || {};
      const finish = data.choices?.[0]?.finish_reason;
      if (!String(content).trim()) {
        // empty visible output: usually the budget went to reasoning or the model was cut off; retry with more room.
        // Still billed, so still logged.
        logUsage({ at: new Date().toISOString(), purpose, model: data.model || model, in: usage.prompt_tokens ?? null, out: usage.completion_tokens ?? null,
          cached: usage.prompt_tokens_details?.cached_tokens ?? null, cost: usage.cost ?? null, ms: Date.now() - started, error: 'empty response' });
        body.max_tokens = Math.min(16000, Math.round(body.max_tokens * 2));
        throw Object.assign(new Error(`empty response (finish=${finish}, out=${usage.completion_tokens}); retrying with max_tokens=${body.max_tokens}`), { status: 500 });
      }
      if (finish === 'length') log.warn(`llm ${purpose}: output truncated at max_tokens=${body.max_tokens}`);
      const entry = { at: new Date().toISOString(), purpose, model: data.model || model, in: usage.prompt_tokens ?? null, out: usage.completion_tokens ?? null,
        cached: usage.prompt_tokens_details?.cached_tokens ?? null, cost: usage.cost ?? null, ms: Date.now() - started };
      logUsage(entry);
      log.info(`llm ${purpose} ${entry.model}: in=${entry.in} (cached ${entry.cached ?? 0}) out=${entry.out}${entry.cost != null ? ` $${Number(entry.cost).toFixed(4)}` : ''}`);
      if (!json) return { text: content, usage, model: data.model };
      return { json: parseJsonLoose(content), text: content, usage, model: data.model };
    } catch (e) {
      lastErr = e;
      if (e.budget) throw e;
      const retryable = e.status === 429 || e.status >= 500 || e.name === 'TimeoutError' || /invalid json/i.test(e.message);
      if (!retryable || attempt === retries) throw e;
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export function parseJsonLoose(text) {
  const t = String(text).trim();
  try { return JSON.parse(t); } catch { /* fallthrough */ }
  const fence = /```(?:json)?\s*([\s\S]*?)(?:```|$)/.exec(t);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* fallthrough */ } }
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch { /* fallthrough */ } }
  throw new Error('invalid JSON from model: ' + t.slice(0, 200));
}

export async function embedTexts(texts, { model = config.embed.openrouterModel } = {}) {
  assertBudget('embed');
  const r = await fetch(`${config.openrouter.baseUrl}/embeddings`, { method: 'POST', headers: headers(), body: JSON.stringify({ model, input: texts }), signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`OpenRouter embeddings ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  logUsage({ at: new Date().toISOString(), purpose: 'embed', model, in: data.usage?.prompt_tokens ?? null, out: 0, cost: data.usage?.cost ?? null });
  return data.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
}

// Authoritative spend for this API key straight from OpenRouter (GET /key): lifetime + daily + limit. Cached 60 s.
let _key = { at: 0, data: null, pending: null };
export function keyUsage({ maxAgeMs = 60_000 } = {}) {
  if (!config.openrouter.apiKey) return null;
  if (Date.now() - _key.at > maxAgeMs && !_key.pending) {
    _key.pending = fetch(`${config.openrouter.baseUrl}/key`, { headers: headers(), signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { const d = j?.data; if (d) _key.data = { usage: d.usage, daily: d.usage_daily, weekly: d.usage_weekly, monthly: d.usage_monthly, limit: d.limit, remaining: d.limit_remaining, reset: d.limit_reset, fetched_at: new Date().toISOString() }; _key.at = Date.now(); })
      .catch(() => { _key.at = Date.now(); })
      .finally(() => { _key.pending = null; });
  }
  return _key.data; // may be null on first call; the next poll will have it
}

// Cheap rolling totals for the UI: cost since a timestamp, today, and all time (file re-read only when it grows).
let _cache = { size: -1, rows: [] };
function usageRows() {
  const file = USAGE_FILE();
  if (!fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  if (size !== _cache.size) {
    _cache = { size, rows: fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) };
  }
  return _cache.rows;
}
export function costTotals({ since } = {}) {
  const rows = usageRows();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const sum = (pred) => rows.filter(pred).reduce((a, r) => a + (Number(r.cost) || 0), 0);
  const calls = (pred) => rows.filter(pred).length;
  const sinceTs = since ? Date.parse(since) : null;
  return {
    session: sinceTs ? sum((r) => Date.parse(r.at) >= sinceTs) : 0,
    session_calls: sinceTs ? calls((r) => Date.parse(r.at) >= sinceTs) : 0,
    today: sum((r) => Date.parse(r.at) >= dayStart.getTime()),
    today_calls: calls((r) => Date.parse(r.at) >= dayStart.getTime()),
    all: sum(() => true),
    last: rows.at(-1) ? { purpose: rows.at(-1).purpose, model: rows.at(-1).model, cost: Number(rows.at(-1).cost) || 0, at: rows.at(-1).at } : null,
    key: keyUsage(),
    cap: config.openrouter.dailyCapUsd,
  };
}

// Summarise the usage log: totals overall and per purpose, plus the last N hours.
export function usageSummary({ hours = 24 } = {}) {
  const file = USAGE_FILE();
  if (!fs.existsSync(file)) return { calls: 0 };
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const cut = Date.now() - hours * 3600_000;
  const agg = (list) => {
    const by = {};
    for (const r of list) {
      const k = r.purpose || 'chat';
      by[k] ??= { calls: 0, in: 0, cached: 0, out: 0, cost: 0 };
      by[k].calls++; by[k].in += r.in || 0; by[k].cached += r.cached || 0; by[k].out += r.out || 0; by[k].cost += Number(r.cost) || 0;
    }
    const total = Object.values(by).reduce((a, b) => ({ calls: a.calls + b.calls, in: a.in + b.in, cached: a.cached + b.cached, out: a.out + b.out, cost: a.cost + b.cost }), { calls: 0, in: 0, cached: 0, out: 0, cost: 0 });
    return { by, total };
  };
  return { all: agg(rows), recent: agg(rows.filter((r) => Date.parse(r.at) >= cut)), hours, file };
}
