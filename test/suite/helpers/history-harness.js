// Test harness for test/suite/history.test.js (own helpers, nothing shared with other suites).
//
//  - clock: a controllable Date. "Now" starts at a fixed instant chosen by the test and then
//    either stays frozen or ticks with real time from that instant (needed where the app spaces
//    calls with real timers, e.g. Steam enrichment). Tests never depend on the machine's clock.
//  - network: globalThis.fetch is replaced; 127.0.0.1 goes to the real fetch (the app under
//    test), everything else is answered by the mock platform installed by the test, or fails.
//  - startApp(): the real app in-process (in-memory DB, no scheduler) plus small API helpers.
//  - checkInvariants(): what must hold after every history operation.
import assert from 'node:assert/strict';
import { createApp } from '../../../src/server.js';

export const RealDate = globalThis.Date;
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

// ---------------------------------------------------------------------------- clock
export const clock = {
  base: RealDate.now(), anchor: RealDate.now(), frozen: true,
  now() { return this.frozen ? this.base : this.base + (RealDate.now() - this.anchor); },
  /** Jump to t; frozen (default) or ticking with real time from t. */
  set(t, { tick = false } = {}) { this.base = t; this.anchor = RealDate.now(); this.frozen = !tick; },
  advance(ms) { this.set(this.now() + ms, { tick: !this.frozen }); },
  install(t, opts) {
    this.set(t, opts);
    const c = this;
    class FakeDate extends RealDate {
      constructor(...args) { if (args.length) super(...args); else super(c.now()); }
      static now() { return c.now(); }
    }
    globalThis.Date = FakeDate;
  },
  uninstall() { globalThis.Date = RealDate; },
};

/** Local wall-clock time (process TZ) as epoch ms. Month is 1-based. */
export const local = (y, mo, d, h = 12, mi = 0) => new RealDate(y, mo - 1, d, h, mi, 0, 0).getTime();
export const dayKey = (t) => { const d = new RealDate(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const startOfDay = (t) => { const d = new RealDate(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const addDays = (t, n) => { const d = new RealDate(t); d.setDate(d.getDate() + n); return d.getTime(); };
export const iso = (t) => new RealDate(t).toISOString();
export const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + f(x), 0);

// ---------------------------------------------------------------------------- network
const realFetch = globalThis.fetch;
let platform = null; // (url: URL, init) => Response | object | undefined
export const netLog = [];
export function guardNetwork() {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    netLog.push(url.href);
    const out = platform ? await platform(url, init) : undefined;
    if (out instanceof Response) return out;
    if (out === undefined) throw new TypeError(`fetch failed (no network in tests): ${url.host}`);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
export function setPlatform(fn) { platform = fn; }
export function restoreNetwork() { globalThis.fetch = realFetch; platform = null; }
export const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A mock Steam (Web API + store). world = { timecreated?: ms, games: [{ appid, name, minutes,
 * recent?, lastPlayed?: ms, achievements?: ms[], release?: 'Mar 3, 2021' | null }] }
 */
export function steamWorld(world) {
  return (url) => {
    const p = url.pathname;
    if (p.includes('/ISteamUser/GetPlayerSummaries/')) {
      return { response: { players: [{ steamid: '76561198000000001', personaname: 'Tester', communityvisibilitystate: 3, ...(world.timecreated ? { timecreated: Math.floor(world.timecreated / 1000) } : {}) }] } };
    }
    if (p.includes('/IPlayerService/GetOwnedGames/')) {
      return { response: { game_count: world.games.length, games: world.games.map((g) => ({
        appid: g.appid, name: g.name, playtime_forever: g.minutes, playtime_2weeks: g.recent || 0,
        rtime_last_played: g.lastPlayed ? Math.floor(g.lastPlayed / 1000) : 0, has_community_visible_stats: true,
        playtime_windows_forever: g.minutes, playtime_mac_forever: 0, playtime_linux_forever: 0, playtime_deck_forever: 0, playtime_disconnected: 0,
      })) } };
    }
    if (p.includes('/ISteamUserStats/GetPlayerAchievements/')) {
      const g = world.games.find((x) => String(x.appid) === url.searchParams.get('appid'));
      if (!g?.achievements) return jsonResponse(400, { playerstats: { error: 'Requested app has no stats', success: false } });
      return { playerstats: { steamID: '76561198000000001', gameName: g.name, success: true,
        achievements: [...g.achievements.map((t, i) => ({ apiname: `A${i}`, achieved: 1, unlocktime: Math.floor(t / 1000) })), { apiname: 'LOCKED', achieved: 0, unlocktime: 0 }] } };
    }
    if (p.includes('/api/appdetails')) {
      const id = url.searchParams.get('appids');
      const g = world.games.find((x) => String(x.appid) === id);
      return { [id]: g?.release ? { success: true, data: { release_date: { coming_soon: false, date: g.release } } } : { success: false } };
    }
    if (p.includes('/IStoreBrowseService/GetItems/')) return { response: { store_items: [] } };
    return undefined;
  };
}

// ---------------------------------------------------------------------------- app
export async function startApp() {
  const errors = [];
  const log = { info() {}, warn() {}, debug() {}, error(m) { errors.push(String(m)); } };
  const inst = createApp({ dbFile: ':memory:', password: '', log, scheduler: false });
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${inst.server.address().port}/api/v1`;
  const call = async (method, path, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      if (typeof body === 'string') { init.body = body; init.headers['content-type'] ||= 'text/csv'; } else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  const ok = async (method, path, body) => {
    const r = await call(method, path, body);
    assert.equal(r.status, 200, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const h = {
    inst, db: inst.app.db, sync: inst.app.sync, errors, call,
    get: (p) => ok('GET', p), post: (p, b = {}) => ok('POST', p, b), put: (p, b) => ok('PUT', p, b),
    patch: (p, b) => ok('PATCH', p, b), del: (p) => ok('DELETE', p),
    async idle() {
      for (let i = 0; i < 50; i++) {
        const busy = [...inst.app.sync.running.values(), ...inst.app.sync.enriching.values()];
        if (!busy.length) return;
        await Promise.allSettled(busy);
      }
    },
    async close() { await h.idle(); inst.close(); },
    /** Custom (API push) account; returns its id. */
    async customAccount(name = 'Switch') { return (await h.post('/accounts', { platform: 'custom', name, config: {} })).id; },
    report: (accountId, games) => h.post(`/accounts/${accountId}/report`, { games }),
    /** The single entry of a game title, with its history block (from GET /games/:id). */
    async entryOf(title) {
      const row = h.db.prepare('SELECT e.id, e.game_id FROM entries e JOIN games g ON g.id = e.game_id WHERE g.title = ? ORDER BY e.id').get(title);
      assert.ok(row, `no entry for ${title}`);
      const game = await h.get(`/games/${row.game_id}`);
      return { game, entry: game.entries.find((e) => e.id === row.id) };
    },
  };
  return h;
}

// ---------------------------------------------------------------------------- DB views
/** Inferred history sessions of an entry, oldest first. */
export const historySessions = (db, entryId) => db.prepare("SELECT * FROM sessions WHERE entry_id = ? AND source = 'inferred' ORDER BY COALESCE(window_start, 0), id").all(entryId);
export const estimates = (db, entryId) => historySessions(db, entryId).filter((s) => s.kind === 'estimate');
/** Estimated minutes per local day (from the per-day rollup the charts use). */
export function estimatedByDay(db, { entryId = null } = {}) {
  const rows = db.prepare(`SELECT day, SUM(minutes) m FROM play_days WHERE estimated = 1 AND excluded = 0 ${entryId ? 'AND entry_id = ?' : ''} GROUP BY day ORDER BY day`).all(...(entryId ? [entryId] : []));
  return new Map(rows.map((r) => [r.day, r.m]));
}
export const trackedByDay = (db) => new Map(db.prepare('SELECT day, SUM(minutes) m FROM play_days WHERE estimated = 0 AND excluded = 0 GROUP BY day').all().map((r) => [r.day, r.m]));
export const entryIdByTitle = (db, title) => db.prepare('SELECT e.id FROM entries e JOIN games g ON g.id = e.game_id WHERE g.title = ? ORDER BY e.id').get(title)?.id;
export const trackingStartOf = (db, entryId) => {
  const e = db.prepare('SELECT hist, first_seen_at FROM entries WHERE id = ?').get(entryId);
  return JSON.parse(e.hist || '{}').tracking_start || e.first_seen_at;
};
/** Comparable fingerprint of an entry's dated history. */
export const fingerprint = (db, entryId) => historySessions(db, entryId).map((s) => `${s.kind}|${s.minutes}|${s.window_start}|${s.window_end}`);

/**
 * Totals that must hold after any history operation:
 *  1. every entry's sessions add up to its lifetime total (nothing lost, nothing counted twice)
 *  2. its dated + undated history adds up to its pre-tracking minutes
 *  3. estimated history lies before tracking began, in a real window, in whole positive minutes
 *  4. the chart rollups hold exactly the estimated minutes (nothing pending or dropped)
 */
export function checkTotals(db, { label = '' } = {}) {
  const at = label ? ` [${label}]` : '';
  const bad = db.prepare(`SELECT e.id, e.title, e.playtime_min, COALESCE(SUM(s.minutes), 0) m FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id
    GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min`).all();
  assert.deepEqual(bad.map((b) => ({ ...b })), [], `sessions must add up to entries.playtime_min${at}`);
  const hist = db.prepare(`SELECT e.id, e.title, e.baseline_min, COALESCE(SUM(s.minutes), 0) m FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id AND s.source = 'inferred'
    GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.baseline_min`).all();
  assert.deepEqual(hist.map((b) => ({ ...b })), [], `dated + undated history must add up to the pre-tracking minutes${at}`);
  for (const e of db.prepare('SELECT id, title, hist, first_seen_at FROM entries WHERE baseline_min > 0').all()) {
    const ts = JSON.parse(e.hist || '{}').tracking_start || e.first_seen_at;
    for (const s of db.prepare("SELECT * FROM sessions WHERE entry_id = ? AND kind = 'estimate'").all(e.id)) {
      assert.ok(s.window_start != null && s.window_end != null && s.window_start < s.window_end, `${e.title}: estimate needs a real window${at}`);
      assert.ok(s.window_end <= ts, `${e.title}: estimate ends ${iso(s.window_end)} after tracking began ${iso(ts)}${at}`);
      assert.ok(s.minutes > 0 && Number.isInteger(s.minutes), `${e.title}: estimate minutes must be positive integers${at}`);
    }
  }
  const est = db.prepare("SELECT COALESCE(SUM(s.minutes), 0) m FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE s.kind = 'estimate' AND e.excluded = 0").get().m;
  const rolled = db.prepare('SELECT COALESCE(SUM(minutes), 0) m FROM play_days WHERE estimated = 1 AND excluded = 0').get().m;
  assert.ok(Math.abs(est - rolled) < 0.01, `chart rollups hold ${rolled} estimated minutes, sessions ${est}${at}`);
}

/**
 * Plausibility of dated history:
 *  - no estimate holds more minutes than the wall-clock time of its window
 *  - per local day: one game at most `gameCap` estimated minutes, all games together at most
 *    `dayCap` (README: 10 h per game, 12 h shared across the whole library)
 * `tol` absorbs whole-minute rounding only.
 */
export function checkCaps(db, { gameCap = 600, dayCap = 720, tol = 1, label = '' } = {}) {
  const at = label ? ` [${label}]` : '';
  const tight = db.prepare(`SELECT e.title, s.minutes, s.window_start, s.window_end FROM sessions s JOIN entries e ON e.id = s.entry_id
    WHERE s.kind = 'estimate' AND s.minutes > (s.window_end - s.window_start) / 60000.0 + ? ORDER BY s.minutes DESC LIMIT 3`).all(tol);
  assert.deepEqual(tight.map((r) => `${r.title}: ${r.minutes} min in ${Math.round((r.window_end - r.window_start) / MIN)} min (${iso(r.window_start)}..${iso(r.window_end)})`), [],
    `an estimate can never hold more minutes than its window lasts${at}`);
  const perGame = db.prepare('SELECT entry_id, day, ROUND(SUM(minutes), 1) m FROM play_days WHERE estimated = 1 AND excluded = 0 GROUP BY entry_id, day HAVING SUM(minutes) > ? ORDER BY SUM(minutes) DESC LIMIT 5').all(gameCap + tol);
  assert.deepEqual(perGame.map((r) => ({ ...r })), [], `no game may get more than ${gameCap} estimated minutes on one day${at}`);
  const perDay = db.prepare('SELECT day, ROUND(SUM(minutes), 1) m FROM play_days WHERE estimated = 1 AND excluded = 0 GROUP BY day HAVING SUM(minutes) > ? ORDER BY SUM(minutes) DESC LIMIT 5').all(dayCap + tol);
  assert.deepEqual(perDay.map((r) => ({ ...r })), [], `all games together may get at most ${dayCap} estimated minutes per day${at}`);
}

export function checkInvariants(db, opts = {}) { checkTotals(db, opts); checkCaps(db, opts); }

/** Estimates holding more minutes than their window lasts (physically impossible). */
export const tightEstimates = (db, tol = 1) => db.prepare(`SELECT e.title, s.minutes, s.window_start, s.window_end FROM sessions s JOIN entries e ON e.id = s.entry_id
  WHERE s.kind = 'estimate' AND s.minutes > (s.window_end - s.window_start) / 60000.0 + ?`).all(tol)
  .map((r) => `${r.title}: ${r.minutes} min in ${Math.round((r.window_end - r.window_start) / MIN)} min (${iso(r.window_start)}..${iso(r.window_end)})`);
