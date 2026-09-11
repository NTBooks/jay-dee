import { log } from './log.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  constructor(minIntervalMs) { this.min = minIntervalMs; this.last = 0; this.chain = Promise.resolve(); }
  wait() {
    const p = this.chain.then(async () => {
      const now = Date.now();
      const delta = now - this.last;
      if (delta < this.min) await sleep(this.min - delta);
      this.last = Date.now();
    });
    this.chain = p.catch(() => {});
    return p;
  }
}

export async function fetchJson(url, { headers = {}, timeoutMs = 30_000, retries = 3, backoffMs = 2000, method = 'GET', body, limiter, okStatuses } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    if (limiter) await limiter.wait();
    try {
      const res = await fetch(url, {
        method, headers: { accept: 'application/json', ...headers },
        body, signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404 && (!okStatuses || okStatuses.includes(404))) return null;
      if (res.status === 429 || res.status === 503 || res.status >= 500) {
        const txt = await res.text().catch(() => '');
        throw Object.assign(new Error(`HTTP ${res.status} ${txt.slice(0, 120)}`), { retryable: true, status: res.status });
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw Object.assign(new Error(`HTTP ${res.status} ${txt.slice(0, 200)}`), { retryable: false, status: res.status });
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      const retryable = e.retryable || e.name === 'TimeoutError' || e.code === 'ECONNRESET' || e.code === 'UND_ERR_SOCKET' || /fetch failed/.test(e.message);
      if (!retryable || attempt === retries) throw e;
      const wait = backoffMs * 2 ** attempt;
      log.warn(`retry ${attempt + 1}/${retries} after ${wait}ms: ${e.message.slice(0, 100)}`);
      await sleep(wait);
      attempt++;
    }
  }
  throw lastErr;
}

export function safeErr(e) {
  return (e && e.message ? e.message : String(e)).slice(0, 500);
}
