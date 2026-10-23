// Harness for test/suite/steam-sync.test.js (own helpers; nothing imported from other tests).
//
//  - a controllable clock (Date.now is replaced; frozen by default, can "flow" with real time)
//  - FakeSteam: an in-memory Steam Web API + store API that answers the requests PlayTracker makes
//  - a fetch router: 127.0.0.1 goes to the real network stack, every other host to the current fake
//  - startApp(): PlayTracker in-process on :memory:, talked to over plain node:http
//  - invariant checks that must hold after any sync
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { createApp } from '../../../src/server.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const KEY = 'STEAMKEY0123456789ABCDEFSECRET42';
export const STEAMID = '76561198012345678';
export const VANITY = 'playtester';

/** Epoch ms of a LOCAL wall-clock time (TZ is set by steam-sync-tz.js). */
export const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
export const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const unix = (ms) => Math.floor(ms / 1000);
export const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- clock
const realDateNow = Date.now.bind(Date);
export const clock = {
  t: realDateNow(),
  flowing: false,
  anchorReal: 0,
  now() { return this.flowing ? this.t + (performance.now() - this.anchorReal) : this.t; },
  set(t) { this.t = Math.round(t); this.anchorReal = performance.now(); return this.t; },
  advance(ms) { return this.set(this.now() + ms); },
  /** Let virtual time pass with real time (needed where the app spaces calls with real sleeps). */
  flow() { this.t = this.now(); this.anchorReal = performance.now(); this.flowing = true; },
  freeze() { this.t = Math.round(this.now()); this.flowing = false; },
  install() { Date.now = () => Math.floor(clock.now()); },
  restore() { Date.now = realDateNow; },
};

// ---------------------------------------------------------------- fetch router
const realFetch = globalThis.fetch;
let external = null;
export function installFetch() {
  globalThis.fetch = async (url, opts) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(url, opts);
    if (!external) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    return external.handle(u, opts);
  };
}
export function restoreFetch() { globalThis.fetch = realFetch; external = null; }
export function useExternal(fake) { external = fake; }

// ---------------------------------------------------------------- fake Steam
const json = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
});

function endpointOf(u) {
  const p = u.pathname;
  if (u.host === 'api.steampowered.com') {
    if (p.startsWith('/ISteamUser/ResolveVanityURL/')) return 'resolve';
    if (p.startsWith('/ISteamUser/GetPlayerSummaries/')) return 'summaries';
    if (p.startsWith('/IPlayerService/GetOwnedGames/')) return 'owned';
    if (p.startsWith('/ISteamUserStats/GetPlayerAchievements/')) return 'achievements';
    if (p.startsWith('/IStoreBrowseService/GetItems/')) return 'items';
  }
  if (u.host === 'store.steampowered.com' && p === '/api/appdetails') return 'appdetails';
  return 'unknown';
}

/**
 * Minimal Steam Web API. Game rows use Steam's own field names (playtime_forever, playtime_2weeks,
 * rtime_last_played, playtime_*_forever, playtime_disconnected). Behaviour can be overridden per
 * endpoint (`fake.on.owned = (u) => Response`) or for the next N calls (`fake.failNext('owned', ...)`).
 */
export class FakeSteam {
  constructor({ key = KEY, steamid = STEAMID, vanity = VANITY, persona = 'Play Tester', timecreated = local(2012, 5, 1, 12), visibility = 3 } = {}) {
    this.key = key;
    this.steamid = steamid;
    this.vanities = new Map([[vanity, steamid]]);
    this.player = { steamid, personaname: persona, communityvisibilitystate: visibility, timecreated: unix(timecreated), avatarfull: 'https://avatars.example/full.jpg' };
    this.games = new Map();
    this.gameDetailsPrivate = false;
    this.achievements = new Map(); // appid -> [{ apiname, achieved, unlocktime }] | { status, body }
    this.appdetails = new Map(); // appid -> { release_date: { coming_soon, date } } | { status }
    this.storeAssets = new Map(); // appid -> assets object (IStoreBrowseService)
    this.calls = [];
    this.queued = {};
    this.on = {};
  }

  game(appid, fields = {}) {
    const g = this.games.get(appid) || { appid, name: `Game ${appid}`, playtime_forever: 0, playtime_2weeks: undefined, rtime_last_played: 0, img_icon_url: `icon${appid}`, has_community_visible_stats: true,
      playtime_windows_forever: 0, playtime_mac_forever: 0, playtime_linux_forever: 0, playtime_deck_forever: 0, playtime_disconnected: 0 };
    Object.assign(g, fields);
    this.games.set(appid, g);
    return g;
  }

  /** Steam behaviour when a session ends: totals written on exit, launch time stamped. */
  play(appid, { start, minutes, device = 'windows', offline = false, recent = true }) {
    const g = this.games.get(appid) || this.game(appid);
    g.playtime_forever += minutes;
    g[`playtime_${device}_forever`] = (g[`playtime_${device}_forever`] || 0) + minutes;
    if (offline) g.playtime_disconnected += minutes;
    if (recent) g.playtime_2weeks = (g.playtime_2weeks || 0) + minutes;
    if (start != null && unix(start) > (g.rtime_last_played || 0)) g.rtime_last_played = unix(start);
    return g;
  }

  remove(appid) { this.games.delete(appid); }
  setPlaying(appid, title) { if (appid == null) { delete this.player.gameid; delete this.player.gameextrainfo; } else { this.player.gameid = String(appid); this.player.gameextrainfo = title; } }
  failNext(endpoint, ...responses) { (this.queued[endpoint] ||= []).push(...responses); }
  count(endpoint) { return this.calls.filter((c) => c.ep === endpoint).length; }

  async handle(u) {
    const ep = endpointOf(u);
    const params = Object.fromEntries(u.searchParams);
    const rec = { ep, host: u.host, path: u.pathname, params, at: Date.now(), real: performance.now(), url: u.toString() };
    this.calls.push(rec);
    this.beforeRequest?.(rec);
    const q = this.queued[ep];
    if (q?.length) {
      const r = q.shift();
      if (r.network) throw Object.assign(new TypeError('fetch failed'), { cause: { code: r.network } });
      return json(r.status, r.body ?? { error: 'injected' }, r.headers || {});
    }
    if (this.on[ep]) { const r = await this.on[ep](u, params); if (r) return r; }
    if (ep === 'unknown') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    if (u.host === 'api.steampowered.com' && ep !== 'items' && params.key !== this.key) {
      return new Response('<html><head><title>Forbidden</title></head><body><h1>Forbidden</h1>Access is denied. Retrying will not help. Please verify your <pre>key=</pre> parameter.</body></html>', { status: 403, headers: { 'content-type': 'text/html' } });
    }
    switch (ep) {
      case 'resolve': {
        const id = this.vanities.get(params.vanityurl);
        return json(200, id ? { response: { steamid: id, success: 1 } } : { response: { success: 42, message: 'No match' } });
      }
      case 'summaries': {
        const ids = String(params.steamids || '').split(',');
        const p = ids.includes(this.steamid) ? { ...this.player } : null;
        if (p && p.communityvisibilitystate !== 3) { delete p.gameid; delete p.gameextrainfo; delete p.timecreated; }
        return json(200, { response: { players: p ? [p] : [] } });
      }
      case 'owned': {
        if (params.steamid !== this.steamid || this.gameDetailsPrivate || this.player.communityvisibilitystate !== 3) return json(200, { response: {} });
        const games = [...this.games.values()].map((g) => {
          const o = { ...g };
          if (o.playtime_2weeks === undefined || o.playtime_2weeks === 0) delete o.playtime_2weeks; // Steam omits it
          return o;
        });
        return json(200, { response: { game_count: games.length, games } });
      }
      case 'achievements': {
        const a = this.achievements.get(Number(params.appid));
        if (!a) return json(400, { playerstats: { error: 'Requested app has no stats', success: false } });
        if (a.status) return json(a.status, a.body ?? { playerstats: { error: 'Profile is not public', success: false } });
        return json(200, { playerstats: { steamID: this.steamid, gameName: this.games.get(Number(params.appid))?.name, achievements: a, success: true } });
      }
      case 'appdetails': {
        const id = String(params.appids);
        const d = this.appdetails.get(Number(id));
        if (d?.status) return json(d.status, { error: 'injected' });
        return json(200, { [id]: d ? { success: true, data: d } : { success: false } });
      }
      case 'items': {
        const input = JSON.parse(params.input_json || '{}');
        rec.appids = (input.ids || []).map((x) => x.appid);
        const store_items = rec.appids.map((appid) => {
          const assets = this.storeAssets.get(appid);
          return assets ? { item_type: 0, id: appid, success: 1, visible: true, name: this.games.get(appid)?.name, appid, assets } : { item_type: 0, id: appid, success: 1, appid };
        });
        return json(200, { response: { store_items } });
      }
      default: return json(404, { error: 'not found' });
    }
  }
}

// ---------------------------------------------------------------- app
function client(port) {
  const call = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (data != null) {
      h['content-type'] ||= typeof body === 'string' ? 'text/csv' : 'application/json';
      h['content-length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: path.startsWith('/api') || path.startsWith('/metrics') ? path : `/api/v1${path}`, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    patch: (p, b = {}) => call('PATCH', p, b),
    put: (p, b = {}) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
    raw: call,
  };
}

/** Throw a readable error unless the response has the expected status. */
export function expect200(res, what = 'request') {
  if (res.status !== 200) throw new Error(`${what} -> HTTP ${res.status}: ${res.text.slice(0, 400)}`);
  return res.body;
}

export async function startApp({ backgroundEnrichment = false } = {}) {
  const logs = [];
  const rec = (level) => (m, d) => logs.push({ level, message: String(m), details: d });
  const log = { info: rec('info'), warn: rec('warn'), error: rec('error'), debug() {} };
  const inst = createApp({ dbFile: ':memory:', password: '', log, scheduler: false });
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  const port = inst.server.address().port;
  const sync = inst.app.sync;
  // Background enrichment spaces store calls 1.6 s apart in real time and re-dates history while
  // a test is looking at it. Unless a test is about enrichment it is kept from running (the
  // service's own "stopping" switch only affects enrichment loops and cover-lookup continuation).
  if (!backgroundEnrichment) sync.stopping = true;
  const api = client(port);
  const h = {
    inst, app: inst.app, db: inst.app.db, sync, api, logs, port,
    /** Wait until no sync / enrichment is in flight for any account, then let callbacks run. */
    async settle(timeoutMs = 20_000) {
      const t0 = performance.now();
      while (sync.running.size || sync.enriching.size) {
        if (performance.now() - t0 > timeoutMs) throw new Error('background work did not settle');
        await Promise.allSettled([...sync.running.values(), ...sync.enriching.values()]);
      }
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      await realSleep(5);
    },
    async close() {
      try { await h.settle(); } catch { /* closing anyway */ }
      inst.close();
    },
    /** POST /accounts and wait for the initial import it starts. */
    async link(config = {}, extra = {}) {
      const res = await api.post('/accounts', { platform: 'steam', name: 'Steam', config: { api_key: KEY, steam_id: VANITY, ...config }, ...extra });
      const acc = expect200(res, 'link account');
      await h.settle();
      return acc;
    },
    async syncNow(id) { const r = await api.post(`/accounts/${id}/sync?wait=true`); await h.settle(); return r; },
    async account(id) { return (expect200(await api.get('/accounts'), 'accounts')).find((a) => a.id === id); },
    /** Emulate one presence poll of the scheduler. */
    async poll(id) { await sync.pollPresence(sync.account(id)); },
    entry(accountId, appid) { return h.db.prepare('SELECT * FROM entries WHERE account_id = ? AND ext_id = ?').get(accountId, String(appid)); },
    sessionsOf(entryId, kind = null) {
      return h.db.prepare(`SELECT * FROM sessions WHERE entry_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY COALESCE(started_at, window_start, window_end), id`).all(...(kind ? [entryId, kind] : [entryId]));
    },
    sum(sql, ...args) { return h.db.prepare(sql).get(...args).m ?? 0; },
  };
  return h;
}

// ---------------------------------------------------------------- invariants
/** For every entry, its sessions (tracked + dated history + undated) add up to its total. */
export function totalsMismatch(db) {
  return db.prepare(`SELECT e.id, e.title, e.playtime_min, COALESCE(SUM(s.minutes), 0) s FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id
    GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min`).all();
}

/** Problems that must never exist after any sync: returns a list of human-readable violations. */
export function violations(db, { now = Date.now(), accountId = null } = {}) {
  const out = [];
  for (const r of totalsMismatch(db)) out.push(`entry ${r.id} (${r.title}): sessions ${r.s} != total ${r.playtime_min}`);
  const neg = db.prepare('SELECT COUNT(*) n FROM sessions WHERE minutes <= 0').get().n;
  if (neg) out.push(`${neg} sessions with minutes <= 0`);
  const negE = db.prepare('SELECT COUNT(*) n FROM entries WHERE playtime_min < 0 OR baseline_min < 0').get().n;
  if (negE) out.push(`${negE} entries with negative minutes`);
  const fut = db.prepare("SELECT id, kind, ended_at, window_end FROM sessions WHERE kind IN ('play', 'estimate') AND COALESCE(ended_at, window_end) > ?").all(now + 1000);
  for (const s of fut) out.push(`session ${s.id} (${s.kind}) ends in the future (${new Date(s.ended_at ?? s.window_end).toISOString()})`);
  // single-title platform: tracked sessions with known times never overlap
  const acc = accountId == null ? db.prepare('SELECT id FROM accounts').all().map((a) => a.id) : [accountId];
  for (const id of acc) {
    const rows = db.prepare(`SELECT s.id, s.started_at, s.ended_at, s.minutes FROM sessions s JOIN entries e ON e.id = s.entry_id
      WHERE e.account_id = ? AND s.kind = 'play' AND s.started_at IS NOT NULL AND s.ended_at IS NOT NULL ORDER BY s.started_at, s.id`).all(id);
    for (let i = 0; i + 1 < rows.length; i++) {
      if (rows[i].ended_at > rows[i + 1].started_at + MIN) out.push(`sessions ${rows[i].id} and ${rows[i + 1].id} overlap (${new Date(rows[i].started_at).toISOString()}..${new Date(rows[i].ended_at).toISOString()} vs ${new Date(rows[i + 1].started_at).toISOString()})`);
    }
  }
  const q = db.prepare('SELECT (SELECT COUNT(*) FROM rollup_queue) + (SELECT COUNT(*) FROM rollup_entry_queue) n').get().n;
  if (q) out.push(`${q} rollup rows still queued`);
  return out;
}

/** Tracked sessions whose minutes cannot fit the time span they are placed in. */
export function impossibleSessions(db) {
  return db.prepare(`SELECT id, minutes, started_at, ended_at, window_start, window_end FROM sessions WHERE kind = 'play' AND (
      (started_at IS NOT NULL AND ended_at IS NOT NULL AND minutes > (ended_at - started_at) / 60000.0 + 1)
      OR (started_at IS NULL AND window_start IS NOT NULL AND window_end IS NOT NULL AND minutes > (window_end - window_start) / 60000.0 + 1))`).all();
}

/** Deterministic PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Split [a, b) into local calendar days: Map day -> minutes. */
export function minutesByDay(a, b, minutes = (b - a) / MIN, into = new Map()) {
  const len = b - a;
  for (let d = startOfDay(a); d < b;) {
    const next = (() => { const x = new Date(d); x.setDate(x.getDate() + 1); x.setHours(0, 0, 0, 0); return x.getTime(); })();
    const lo = Math.max(a, d); const hi = Math.min(b, next);
    if (hi > lo) into.set(dayKey(d), (into.get(dayKey(d)) || 0) + (minutes * (hi - lo)) / len);
    d = next;
  }
  return into;
}

/**
 * Ground truth for long simulations: the real play history of one Steam user. `apply(t)` makes the
 * fake report exactly what Steam would at time t: totals written when a game exits, launch time
 * stamped at launch, a rolling 14-day counter, per-device counters, offline play uploaded late,
 * purchases and refunds, and the game running right now (presence).
 */
export class SteamWorld {
  constructor(fake) {
    this.fake = fake;
    this.games = new Map();
    this.sessions = [];
    this.uploads = [];
    fake.beforeRequest = () => this.apply(Date.now());
  }
  addGame(appid, { name, initial = 0, initialLast = 0, initialRecent = null, ownedFrom = -Infinity, removedAt = Infinity, device = 'windows' }) {
    this.games.set(appid, { appid, name, initial, initialLast, initialRecent, ownedFrom, removedAt, device });
  }
  addSession(appid, start, minutes, device = 'windows') { this.sessions.push({ appid, start, minutes, end: start + minutes * MIN, device }); }
  addUpload(appid, at, minutes, device = 'deck') { this.uploads.push({ appid, at, minutes, device }); }
  owned(appid, t) { const g = this.games.get(appid); return g && t >= g.ownedFrom && t < g.removedAt; }
  apply(t) {
    this.fake.games.clear();
    for (const g of this.games.values()) {
      if (!this.owned(g.appid, t)) continue;
      const row = { appid: g.appid, name: g.name, playtime_forever: g.initial, rtime_last_played: g.initialLast ? unix(g.initialLast) : 0, img_icon_url: `icon${g.appid}`, has_community_visible_stats: true,
        playtime_windows_forever: 0, playtime_mac_forever: 0, playtime_linux_forever: 0, playtime_deck_forever: 0, playtime_disconnected: 0 };
      row[`playtime_${g.device}_forever`] += g.initial;
      let recent = g.initialRecent && g.initialRecent.at > t - 14 * DAY ? g.initialRecent.minutes : 0;
      for (const s of this.sessions) {
        if (s.appid !== g.appid) continue;
        if (s.start <= t) row.rtime_last_played = Math.max(row.rtime_last_played, unix(s.start));
        if (s.end <= t) {
          row.playtime_forever += s.minutes;
          row[`playtime_${s.device}_forever`] += s.minutes;
          if (s.end > t - 14 * DAY) recent += s.minutes;
        }
      }
      for (const u of this.uploads) {
        if (u.appid !== g.appid || u.at > t) continue;
        row.playtime_forever += u.minutes; row.playtime_disconnected += u.minutes; row[`playtime_${u.device}_forever`] += u.minutes;
      }
      if (recent) row.playtime_2weeks = recent;
      this.fake.games.set(g.appid, row);
    }
    const now = this.sessions.find((s) => s.start <= t && t < s.end && this.owned(s.appid, t));
    this.fake.setPlaying(now ? now.appid : null, now ? this.games.get(now.appid).name : null);
  }
  /** Lifetime minutes Steam reports for a title at time t (last value while it was owned). */
  totalAt(appid, t) {
    const g = this.games.get(appid);
    const at = Math.min(t, g.removedAt - 1);
    return g.initial + this.sessions.filter((s) => s.appid === appid && s.end <= at).reduce((a, s) => a + s.minutes, 0)
      + this.uploads.filter((u) => u.appid === appid && u.at <= at).reduce((a, u) => a + u.minutes, 0);
  }
}

/** Random non-overlapping evening sessions: up to 3 a day, some crossing midnight. */
export function generateSessions(rng, { firstDay, days, pick, maxMinutes = 230 }) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(firstDay); day.setDate(day.getDate() + i);
    const n = Math.floor(rng() * 4);
    const slots = [0, 1, 2].sort(() => rng() - 0.5).slice(0, n).sort();
    for (const k of slots) {
      const base = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10, 0).getTime() + k * 300 * MIN;
      const start = base + Math.floor(rng() * 45) * MIN;
      const minutes = 15 + Math.floor(rng() * (maxMinutes - 15));
      out.push({ ...pick(rng, start, i), start, minutes, dayIndex: i });
    }
  }
  return out;
}
