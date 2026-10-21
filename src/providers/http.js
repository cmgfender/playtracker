export class ProviderError extends Error {
  constructor(message, { status, auth = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.auth = auth;
  }
}

/** fetch + JSON with timeout, retries on 429/5xx, and readable errors. */
export async function httpJson(url, opts = {}, { retries = 2, timeoutMs = 30_000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal, redirect: opts.redirect || 'follow' });
      if (opts.raw) return res;
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new ProviderError(`${new URL(url).host} responded ${res.status}`, { status: res.status });
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt * 2;
        if (attempt < retries) { await sleep(Math.min(retryAfter, 30) * 1000); continue; }
        throw lastErr;
      }
      if (!res.ok) {
        const auth = res.status === 401 || res.status === 403;
        throw new ProviderError(`${new URL(url).host} responded ${res.status}${auth ? ' (check credentials)' : ''}: ${text.slice(0, 200)}`, { status: res.status, auth });
      }
      return text ? JSON.parse(text) : null;
    } catch (err) {
      if (err instanceof ProviderError && !(err.status === 429 || err.status >= 500)) throw err;
      lastErr = err.name === 'AbortError' ? new ProviderError(`Request to ${new URL(url).host} timed out`) : err;
      if (attempt < retries) { await sleep(2 ** attempt * 1000); continue; }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
