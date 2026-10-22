export class ProviderError extends Error {
  constructor(message, { status, auth = false, rateLimited = false, retryAfter, resetAt } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.auth = auth;
    this.rateLimited = rateLimited;
    this.retryAfter = retryAfter;
    this.resetAt = resetAt;
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
      const rate = rateHeaders(res.headers);
      if (opts.raw) {
        onResult?.({ url, host, status: res.status, ms: Date.now() - t0, ok: res.status < 400, rateLimited, rate });
        return res;
      }
      const text = await res.text();
      // some APIs (OpenXBL) put the quota reset in the 429 body instead of a header
      const header = retryAfterSeconds(res.headers.get('retry-after'));
      if (rateLimited && !rate.resetAt) rate.resetAt = bodyResetAt(text) || (header ? Date.now() + header * 1000 : null);
      onResult?.({ url, host, status: res.status, ms: Date.now() - t0, ok: res.ok, rateLimited, rate });
      if (rateLimited || res.status >= 500) {
        const retryAfter = header || (rateLimited && rate.resetAt ? Math.ceil((rate.resetAt - Date.now()) / 1000) : 0) || 2 ** attempt * 2;
        lastErr = new ProviderError(`${host} responded ${res.status}${rateLimited ? ' (rate limited)' : ''}`, { status: res.status, rateLimited, retryAfter, resetAt: rate.resetAt });
        // a 429 without a short Retry-After means a quota is used up: retrying now only burns more of it
        if (rateLimited && !header) { lastErr.final = true; throw lastErr; }
        if (attempt < retries && retryAfter <= maxRetryWaitS) { await sleep(retryAfter * 1000); continue; }
        lastErr.final = true; // waited enough, or told to wait longer than we will: stop here
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
      if (err instanceof ProviderError && (err.final || !(err.rateLimited || err.status >= 500))) throw err;
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

/** Retry-After as seconds: a number, or an HTTP date. 0 when absent or unreadable. */
export function retryAfterSeconds(v, now = Date.now()) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(1, Math.ceil((d - now) / 1000)) : 0;
}

/** Reset time from a JSON rate-limit body: { resetAt: ISO | epoch } or { retryAfter: seconds }. */
export function bodyResetAt(text, now = Date.now()) {
  try {
    const b = JSON.parse(text);
    const r = b?.resetAt ?? b?.reset_at ?? b?.error?.resetAt;
    if (r != null) {
      const t = typeof r === 'number' ? (r > 1e12 ? r : r * 1000) : Date.parse(r);
      if (Number.isFinite(t) && t > now) return t;
    }
    const after = Number(b?.retryAfter ?? b?.retry_after);
    if (Number.isFinite(after) && after > 0) return now + after * 1000;
  } catch { /* not JSON */ }
  return null;
}

/**
 * Quota headers (X-RateLimit-* / RateLimit-*), as OpenXBL and many APIs send them. The reset
 * may be epoch seconds, epoch ms or seconds from now. Fields are null when absent.
 */
export function rateHeaders(headers, now = Date.now()) {
  const get = (k) => headers.get(`x-ratelimit-${k}`) ?? headers.get(`ratelimit-${k}`);
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const limit = num(get('limit'));
  const remaining = num(get('remaining'));
  const reset = num(get('reset'));
  const resetAt = reset == null ? null : reset > 1e12 ? reset : reset > 1e9 ? reset * 1000 : now + reset * 1000;
  return { limit, remaining, resetAt };
}

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
