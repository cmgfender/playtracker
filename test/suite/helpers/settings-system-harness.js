// Test harness for test/suite/settings-system.test.js (settings, scheduling, observability).
// Self-contained: starts the app in-process, mocks external platforms, small time helpers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../src/server.js';
import { createLogger } from '../../../src/logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', '..', 'package.json'), 'utf8'));

export const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real (persisting) logger that writes nothing to the console. */
export function quietLogger(opts = {}) {
  return createLogger({ quiet: true, level: 'debug', file: '', json: false, ...opts });
}

/** Start the app on an ephemeral 127.0.0.1 port. */
export async function startApp({ dbFile = ':memory:', password = '', log = SILENT, scheduler = false } = {}) {
  const inst = createApp({ dbFile, password, log, scheduler });
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${inst.server.address().port}`;
  let closed = false;
  async function call(method, p, body, { headers = {}, type } = {}) {
    const h = { ...headers };
    let payload;
    if (body !== undefined) {
      if (typeof body === 'string') { payload = body; h['content-type'] = type || 'application/json'; } else { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    }
    const res = await fetch(root + p, { method, headers: h, body: payload });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }
  return {
    inst, app: inst.app, db: inst.app.db, root, call,
    get: (p, o) => call('GET', p, undefined, o),
    put: (p, b, o) => call('PUT', p, b, o),
    post: (p, b, o) => call('POST', p, b ?? {}, o),
    patch: (p, b, o) => call('PATCH', p, b, o),
    del: (p, o) => call('DELETE', p, undefined, o),
    close() { if (!closed) { closed = true; inst.close(); } },
  };
}

/** Entries whose sessions do not add up to their lifetime total (must always be empty). */
export function brokenTotals(db) {
  return db.prepare(`SELECT e.id, e.playtime_min, COALESCE(SUM(s.minutes), 0) sessions_min FROM entries e
    LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min`).all();
}

export async function waitFor(fn, { timeout = 10_000, every = 50, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Timed out after ${timeout}ms waiting for ${what}`);
    await sleep(every);
  }
}

// ---------------------------------------------------------------- external platform mocks

const json = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
export { json as jsonResponse };

/**
 * Replace globalThis.fetch: 127.0.0.1 goes to the real fetch, every other host to `state.handler`
 * (which may return a Response, throw, or return null for a 404). Every external call is recorded.
 */
export function installFetchMock() {
  const real = globalThis.fetch;
  const state = { calls: [], handler: null };
  globalThis.fetch = async (input, opts = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const u = new URL(url);
    if (u.hostname === '127.0.0.1') return real(input, opts);
    const call = { url, u, method: opts.method || 'GET', headers: new Headers(opts.headers || {}), body: opts.body ?? null, at: Date.now() };
    state.calls.push(call);
    const r = state.handler ? await state.handler(u, call) : null;
    return r || new Response('not mocked', { status: 404 });
  };
  return { state, restore() { globalThis.fetch = real; } };
}

/**
 * Steam Web API keyed by the `key` query parameter. Each key maps to a mutable spec:
 * { status, body } -> every call answers that; { networkOn: 'GetOwnedGames' } -> that call fails at
 * the network level; otherwise { player, games } are served.
 */
export function steamHandler(keys) {
  return (u) => {
    if (u.hostname === 'store.steampowered.com') return json(200, {});
    if (u.hostname !== 'api.steampowered.com') return null;
    if (u.pathname.includes('IStoreBrowseService')) return json(200, { response: { store_items: [] } }); // keyless store lookup
    const spec = keys[u.searchParams.get('key')];
    if (!spec) return json(403, '<html><body>Forbidden</body></html>');
    if (spec.networkOn && u.pathname.includes(spec.networkOn)) throw new TypeError('fetch failed');
    if (spec.status) return new Response(spec.body ?? '', { status: spec.status });
    if (u.pathname.includes('GetPlayerSummaries')) return json(200, { response: { players: spec.player ? [spec.player] : [] } });
    if (u.pathname.includes('GetOwnedGames')) return json(200, { response: { game_count: (spec.games || []).length, games: spec.games || [] } });
    if (u.pathname.includes('GetPlayerAchievements')) return json(400, {});
    return json(404, {});
  };
}

/** OpenXBL keyed by the X-Authorization header: 'ok' -> empty title history, 'forbidden', 'ratelimit'. */
export function xboxHandler(keys) {
  return (u, call) => {
    if (u.hostname !== 'xbl.io') return null;
    const mode = keys[call.headers.get('x-authorization')] || 'forbidden';
    if (mode === 'forbidden') return json(403, { error: 'forbidden' });
    if (mode === 'ratelimit') return json(429, { error: 'Too many requests' }, { 'x-ratelimit-limit': '150', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800' });
    if (u.pathname.endsWith('/player/titleHistory')) return json(200, { xuid: '2533274800000001', titles: [] });
    if (u.pathname.endsWith('/presence')) return json(200, { xuid: '2533274800000001', state: 'Offline' });
    return json(200, {});
  };
}

// ---------------------------------------------------------------- local time helpers

/** Epoch ms of a local wall-clock time in the current process TZ (month is 1-based). */
export const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const p2 = (n) => String(n).padStart(2, '0');
export const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
export const hhmm = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
export const fmt = (t) => (t == null ? String(t) : `${dayKey(t)} ${hhmm(t)}`);
/** Local date (YYYY-MM-DD) `off` days from today. */
export const localDate = (off = 0) => { const d = new Date(); d.setDate(d.getDate() + off); return dayKey(d.getTime()); };
/** The calendar day after a YYYY-MM-DD key. */
export const nextDayKey = (k) => { const [y, m, d] = k.split('-').map(Number); return dayKey(new Date(y, m - 1, d + 1, 12).getTime()); };

/** First local occurrence of HH:MM strictly after t (searches today, tomorrow, the day after). */
export function nextLocalTime(t, h, m) {
  const d = new Date(t);
  for (let i = 0; i < 3; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m, 0, 0).getTime();
    if (c > t) return c;
  }
  throw new Error('unreachable');
}

/** Run fn with process.env.TZ switched to tz (Node re-reads TZ on assignment), then restore it. */
export function withTZ(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { process.env.TZ = prev; }
}

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pt-settings-system-'));
}

/** Every place a secret could leak through diagnostics (what the System page bundles + more). */
export async function diagnosticsText(S, opts) {
  const parts = [];
  for (const p of ['/api/v1/system', '/api/v1/logs?limit=1000', '/api/v1/syncs?limit=200', '/api/v1/accounts', '/api/v1/settings', '/api/v1/summary', '/api/v1/widget', '/api/v1/tokens', '/api/v1/auth/status', '/api/v1/health', '/api/v1/now-playing']) {
    const r = await S.get(p, opts);
    parts.push(`${p} ${r.status} ${r.text}`);
  }
  const m = await fetch(`${S.root}/metrics`, { headers: opts?.headers || {} });
  parts.push(`/metrics ${m.status} ${await m.text()}`);
  return parts.join('\n');
}
