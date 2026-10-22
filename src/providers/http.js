export class ProviderError extends Error {
  constructor(message, { status, auth = false, rateLimited = false, retryAfter } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.auth = auth;
    this.rateLimited = rateLimited;
    this.retryAfter = retryAfter;
  }
}

/**
 * fetch + JSON with timeout, retries on 429/5xx (honouring Retry-After), readable errors,
 * and an optional `onResult` hook used for per-account API usage accounting.
 */
export async function httpJson(url, opts = {}, { retries = 2, timeoutMs = 30_000, onResult, maxRetryWaitS = 30 } = {}) {
  let lastErr;
  const host = new URL(url).host;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal, redirect: opts.redirect || 'follow' });
      const rateLimited = res.status === 429;
      onResult?.({ url, host, status: res.status, ms: Date.now() - t0, ok: res.ok || (opts.raw && res.status < 400), rateLimited });
      if (opts.raw) return res;
      const text = await res.text();
      if (rateLimited || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt * 2;
        lastErr = new ProviderError(`${host} responded ${res.status}${rateLimited ? ' (rate limited)' : ''}`, { status: res.status, rateLimited, retryAfter });
        if (attempt < retries && retryAfter <= maxRetryWaitS) { await sleep(retryAfter * 1000); continue; }
        throw lastErr;
      }
      if (!res.ok) {
        const auth = res.status === 401 || res.status === 403;
        throw new ProviderError(`${host} responded ${res.status}${auth ? ' (check credentials / privacy settings)' : ''}: ${text.slice(0, 200)}`, { status: res.status, auth });
      }
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        throw new ProviderError(`${host} returned invalid JSON: ${text.slice(0, 120)}`, { status: res.status });
      }
    } catch (err) {
      if (err instanceof ProviderError && !(err.rateLimited || err.status >= 500)) throw err;
      if (err.name === 'AbortError') {
        onResult?.({ url, host, status: 0, ms: Date.now() - t0, ok: false, rateLimited: false });
        lastErr = new ProviderError(`Request to ${host} timed out after ${timeoutMs / 1000}s`);
      } else if (!(err instanceof ProviderError)) {
        onResult?.({ url, host, status: 0, ms: Date.now() - t0, ok: false, rateLimited: false });
        lastErr = new ProviderError(`Network error talking to ${host}: ${err.cause?.code || err.message}`);
      } else lastErr = err;
      if (attempt < retries && !lastErr.rateLimited) { await sleep(2 ** attempt * 1000); continue; }
      if (attempt < retries && lastErr.rateLimited && (lastErr.retryAfter || 0) <= maxRetryWaitS) { await sleep((lastErr.retryAfter || 2) * 1000); continue; }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Simple spacing limiter: at most one call every `ms` per key. */
export function spacer(ms) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + ms;
    if (wait) await sleep(wait);
  };
}
