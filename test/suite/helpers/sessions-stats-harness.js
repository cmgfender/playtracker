// Harness for test/suite/sessions-stats.test.js (written from scratch for this suite).
//
// - A controllable clock: globalThis.Date is replaced by a subclass whose "now" is set by the
//   test, so ranges like "this week" or "last 7 days" are deterministic. Dates built from
//   explicit parts/timestamps behave exactly like the real Date (timezone aware).
// - A network guard: fetch() to anything but 127.0.0.1 is refused (no real network in tests).
// - startApp(): the real app in-process on an ephemeral port, plus tiny JSON helpers.
// - Independent invariant checks (entries vs sessions, rollups vs sessions).
import assert from 'node:assert/strict';

export const RealDate = globalThis.Date;
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const state = { now: null };
class ClockDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(state.now ?? RealDate.now());
    else super(...args);
  }
  static now() { return state.now ?? RealDate.now(); }
}

export const clock = {
  install(ms) { state.now = ms; globalThis.Date = ClockDate; },
  set(ms) { state.now = ms; },
  advance(ms) { state.now += ms; },
  get now() { return state.now; },
  uninstall() { globalThis.Date = RealDate; state.now = null; },
};

const realFetch = globalThis.fetch;
export function guardNetwork() {
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.hostname !== '127.0.0.1') return Promise.reject(new Error(`network access blocked in tests: ${url.host}`));
    return realFetch(input, init);
  };
}
export function restoreNetwork() { globalThis.fetch = realFetch; }

/** Local wall-clock time -> epoch ms (in the process timezone at call time). */
export function local(y, mo, d, h = 0, mi = 0, s = 0) { return new RealDate(y, mo - 1, d, h, mi, s).getTime(); }
/** Epoch ms -> local YYYY-MM-DD. */
export function dayOf(ms) {
  const d = new RealDate(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Every local calendar day from a to b inclusive (YYYY-MM-DD strings), stepping by calendar day. */
export function daysBetween(a, b) {
  const out = [];
  const [ya, ma, da] = a.split('-').map(Number);
  for (let i = 0; ; i++) {
    const k = dayOf(new RealDate(ya, ma - 1, da + i, 12).getTime());
    out.push(k);
    if (k === b) break;
    if (i > 50_000) throw new Error('daysBetween runaway');
  }
  return out;
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
let createAppFn = null;

export async function startApp({ dbFile = ':memory:' } = {}) {
  if (!createAppFn) ({ createApp: createAppFn } = await import('../../../src/server.js'));
  const inst = createAppFn({ dbFile, password: '', log: quiet, scheduler: false });
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  // the fake clock does not move while idle: keep idle sockets open so a reused keep-alive
  // socket is never closed under a request by the server's real-time idle timer
  inst.server.keepAliveTimeout = 600_000;
  const base = `http://127.0.0.1:${inst.server.address().port}`;
  async function call(method, path, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      if (typeof body === 'string') init.body = body;
      else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    }
    const res = await fetch(base + (path.startsWith('/api') ? path : `/api/v1${path}`), init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }
  // ok(): the call must succeed; returns the parsed body
  async function ok(method, path, body) {
    const r = await call(method, path, body);
    assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  const h = {
    inst, db: inst.app.db, base, call, ok,
    get: (p) => ok('GET', p),
    post: (p, b = {}) => ok('POST', p, b),
    patch: (p, b = {}) => ok('PATCH', p, b),
    put: (p, b = {}) => ok('PUT', p, b),
    del: (p) => ok('DELETE', p),
    close: () => inst.close(),
  };
  return h;
}

// ---------- domain helpers ----------
export async function addGame(h, title) { return (await h.post('/games', { title, merge: false })).id; }

/** Manual session with exact times given as epoch ms. */
export async function logSession(h, gameId, start, minutes, extra = {}) {
  return h.post('/sessions', { game_id: gameId, minutes, started_at: start, ...extra });
}

/**
 * A synced game on a custom (push) account: first report = history, then the clock moves on
 * and a second report adds `delta` minutes, pinned to end at `lastPlayedAt`.
 */
export async function syncedGame(h, { title, ext = title, history = 600, delta = 90, gap = DAY, lastPlayedAt, first = {} }) {
  const acc = await h.post('/accounts', { platform: 'custom', name: `acct-${ext}`, config: {} });
  await h.post(`/accounts/${acc.id}/report`, { games: [{ id: ext, title, playtime_minutes: history, ...first }] });
  clock.advance(gap);
  const rep = await h.post(`/accounts/${acc.id}/report`, { games: [{ id: ext, title, playtime_minutes: history + delta, last_played_at: lastPlayedAt ?? clock.now - HOUR }] });
  return { accountId: acc.id, report: rep, total: history + delta };
}

export async function report(h, accountId, games) { return h.post(`/accounts/${accountId}/report`, { games }); }

// ---------- invariants (checked against the database, independent of the app's code) ----------
export function totalsMismatch(db) {
  return db.prepare(`SELECT e.id, e.playtime_min total, COALESCE(SUM(s.minutes), 0) sessions FROM entries e
    LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min`).all();
}

/** README: rollups equal the sessions with nothing pending (play + estimated history only). */
export function rollupMismatch(db) {
  const bad = db.prepare(`SELECT s.id, s.kind, s.minutes, COALESCE((SELECT SUM(p.minutes) FROM play_days p WHERE p.session_id = s.id), 0) rolled
    FROM sessions s WHERE (s.kind IN ('play', 'estimate') AND s.minutes > 0 AND ABS(COALESCE((SELECT SUM(p.minutes) FROM play_days p WHERE p.session_id = s.id), 0) - s.minutes) > 0.001)
       OR (s.kind NOT IN ('play', 'estimate') AND EXISTS (SELECT 1 FROM play_days p WHERE p.session_id = s.id))`).all();
  const orphans = db.prepare('SELECT COUNT(*) n FROM play_days p LEFT JOIN sessions s ON s.id = p.session_id WHERE s.id IS NULL').get().n;
  const stale = db.prepare('SELECT COUNT(*) n FROM play_days p JOIN sessions s ON s.id = p.session_id JOIN entries e ON e.id = s.entry_id WHERE p.excluded != e.excluded OR p.game_id != e.game_id').get().n;
  const pending = db.prepare('SELECT COUNT(*) n FROM rollup_queue').get().n;
  return { bad, orphans, stale, pending };
}

export function assertInvariants(h, msg = '') {
  assert.deepEqual(totalsMismatch(h.db), [], `entry totals must equal the sum of their sessions ${msg}`);
  assert.deepEqual(rollupMismatch(h.db), { bad: [], orphans: 0, stale: 0, pending: 0 }, `rollups must equal sessions ${msg}`);
}

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
/** Sum of session minutes per local day for exact sessions, split proportionally to overlap. */
export function expectedDays(sessions) {
  const out = {};
  for (const { start, minutes, end = start + minutes * MIN } of sessions) {
    let k = dayOf(start);
    for (;;) {
      const [y, m, d] = k.split('-').map(Number);
      const lo = Math.max(start, local(y, m, d));
      const hi = Math.min(end, local(y, m, d + 1));
      if (hi > lo) out[k] = (out[k] || 0) + (minutes * (hi - lo)) / (end - start);
      if (local(y, m, d + 1) >= end) break;
      k = dayOf(local(y, m, d + 1, 12));
    }
  }
  return out;
}
