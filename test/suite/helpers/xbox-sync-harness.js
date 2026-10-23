// Harness for test/suite/xbox-sync.test.js (own helpers; nothing imported from other tests).
//
//  - a virtual clock: Date.now is frozen at a value the test controls
//  - FakeXbl: an in-memory OpenXBL (xbl.io/api/v2) answering with the reply shapes seen in
//    production: { content, code: 200 } envelopes, x-ratelimit-limit / -remaining / -spent quota
//    headers (no reset header), a 429 body with resetAt / retryAfter, MinutesPlayed stats that are
//    present, absent (empty Hero group) or present without a value
//  - a fetch router: 127.0.0.1 goes to the real network stack, xbl.io to the fake that owns the
//    API key, anything else fails like a missing DNS entry (and is recorded)
//  - setup(): PlayTracker in-process on :memory:, called over plain node:http
//  - invariant checks that must hold after anything the app does
import http from 'node:http';
import { createApp } from '../../../src/server.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Tue 20 Oct 2026 14:05:00 UTC - a fixed "now" (start of each test), 55 min before an hour turns. */
export const T0 = Date.UTC(2026, 9, 20, 14, 5, 0);

/** OpenXBL timestamps carry 7 fractional digits ("2026-10-20T13:02:11.4370000Z"). */
export const xblTime = (ms) => new Date(ms).toISOString().replace('Z', '0000Z');
const LOCKED = '0001-01-01T00:00:00.0000000Z';

// ---------------------------------------------------------------- clock
const realDateNow = Date.now.bind(Date);
export const clock = {
  t: T0,
  set(t) { this.t = Math.round(t); return this.t; },
  advance(ms) { return this.set(this.t + ms); },
  now() { return this.t; },
  install(t = T0) { this.t = t; Date.now = () => clock.t; },
  restore() { Date.now = realDateNow; },
};

// ---------------------------------------------------------------- fetch router
const realFetch = globalThis.fetch;
const router = { fakes: [], unexpected: [] };
function headerOf(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? headers[k] : undefined;
}
export function installFetch() {
  router.fakes = [];
  router.unexpected = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(typeof url === 'string' ? url : url.url ?? String(url));
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(url, opts);
    if (u.host !== 'xbl.io') {
      router.unexpected.push(u.href);
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }
    const key = headerOf(opts.headers, 'x-authorization');
    const fake = router.fakes.find((f) => f.key === key);
    if (!fake) {
      // no account owns this key: OpenXBL refuses it (and it costs nobody's quota)
      const any = router.fakes[0];
      any?.calls.push({ ep: 'badkey', path: u.pathname, at: Date.now(), status: 401, key });
      return new Response(JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing API key' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return fake.handle(u, opts);
  };
}
export function restoreFetch() { globalThis.fetch = realFetch; router.fakes = []; }
export function unexpectedHosts() { return [...router.unexpected]; }

// ---------------------------------------------------------------- fake OpenXBL
const json = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
});

function endpointOf(p) {
  if (p === '/api/v2/player/titleHistory') return 'titleHistory';
  if (p === '/api/v2/presence') return 'presence';
  if (p.startsWith('/api/v2/achievements/stats/')) return 'stats';
  if (p.startsWith('/api/v2/achievements/player/')) return 'achievements';
  if (p === '/api/v2/dvr/screenshots') return 'screenshots';
  if (p === '/api/v2/dvr/gameclips') return 'gameclips';
  return 'unknown';
}

export const HOME_IDS = ['750323071', '1022622766', '714681658'];

/**
 * One Microsoft account behind one OpenXBL API key, with its own hourly quota (counted per
 * clock hour, like the app's own counter). Titles: { name, type, devices, lastPlayed (ms|null),
 * minutes: number | 'absent' | 'novalue', achievements: [ms|null], achStatus }.
 */
export class FakeXbl {
  constructor({ key = 'xbl-key-A', xuid = '2533274800000001', limit = 150, includeXuid = true, wrap = true, enrichLatencyMs = 1100 } = {}) {
    this.key = key;
    this.xuid = xuid;
    this.limit = limit;
    this.includeXuid = includeXuid;
    this.wrap = wrap;
    this.enrichLatencyMs = enrichLatencyMs; // virtual time a DVR / achievements request takes
    this.spent = new Map(); // hour -> requests counted against the quota
    this.titles = new Map();
    this.presence = null; // null = offline, else [{ type, titles: [{ id, name, placement, state }] }]
    this.screenshots = [];
    this.gameclips = [];
    this.calls = [];
    this.queued = {};
    this.on = {};
    router.fakes.push(this);
  }

  title(id, fields = {}) {
    id = String(id);
    const t = this.titles.get(id) || { id, name: `Title ${id}`, type: 'Game', devices: ['XboxSeries'], lastPlayed: null, minutes: 0, achievements: [], achStatus: null };
    Object.assign(t, fields);
    this.titles.set(id, t);
    return t;
  }

  /** The platform credits `minutes` (when it has a stat) and stamps last played at `end`. */
  play(id, { end, minutes }) {
    const t = this.title(id);
    if (typeof t.minutes === 'number' && minutes) t.minutes += minutes;
    t.lastPlayed = end;
    return t;
  }

  /** What the console / PC reports right now. Pass [] or null for offline. */
  setPresence(devices) { this.presence = devices && devices.length ? devices : null; }

  hour(t = Date.now()) { return Math.floor(t / HOUR); }
  spentNow() { return this.spent.get(this.hour()) || 0; }
  remaining() { return Math.max(0, this.limit - this.spentNow()); }
  /** Someone else (another app with the same key) used `n` requests this hour. */
  useElsewhere(n) { this.spent.set(this.hour(), this.spentNow() + n); }
  exhaust() { this.spent.set(this.hour(), this.limit); }
  resetAt() { return (this.hour() + 1) * HOUR; }

  /** A 429 exactly like OpenXBL's, and the quota marked as used up (for `on` handlers). */
  tooMany() {
    this.spent.set(this.hour(), this.limit);
    const reset = this.resetAt();
    return json(429, { code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded.', limit: this.limit, spent: this.limit, resetAt: new Date(reset).toISOString(), retryAfter: Math.ceil((reset - Date.now()) / 1000) }, this.quotaHeaders());
  }

  failNext(ep, ...responses) { (this.queued[ep] ||= []).push(...responses); }
  count(ep, pred = () => true) { return this.calls.filter((c) => (!ep || c.ep === ep) && pred(c)).length; }
  callsSince(i) { return this.calls.slice(i); }

  quotaHeaders() {
    return { 'x-ratelimit-limit': String(this.limit), 'x-ratelimit-remaining': String(this.remaining()), 'x-ratelimit-spent': String(Math.min(this.limit, this.spentNow())) };
  }

  body(content) { return this.wrap ? { content, code: 200 } : content; }

  async handle(u) {
    const ep = endpointOf(u.pathname);
    const titleId = ep === 'stats' ? decodeURIComponent(u.pathname.split('/').pop()) : ep === 'achievements' ? decodeURIComponent(u.pathname.split('/').pop()) : null;
    const rec = { ep, path: u.pathname, titleId, at: Date.now(), hour: this.hour() };
    this.calls.push(rec);
    // the quota: once spent, every request is refused until the hour turns
    if (this.spentNow() >= this.limit) {
      rec.status = 429;
      const reset = this.resetAt();
      return json(429, { code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded. Please wait before making more requests.', limit: this.limit, spent: this.limit, resetAt: new Date(reset).toISOString(), retryAfter: Math.ceil((reset - Date.now()) / 1000) }, this.quotaHeaders());
    }
    this.spent.set(this.hour(), this.spentNow() + 1);
    if ((ep === 'screenshots' || ep === 'gameclips' || ep === 'achievements') && this.enrichLatencyMs) clock.advance(this.enrichLatencyMs);
    const q = this.queued[ep];
    if (q?.length) {
      const r = q.shift();
      rec.status = r.status;
      if (r.network) throw Object.assign(new TypeError('fetch failed'), { cause: { code: r.network } });
      if (r.status === 429) {
        // another client spent the rest of the hour at the same moment
        this.spent.set(this.hour(), this.limit);
        const reset = this.resetAt();
        return json(429, { code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded.', limit: this.limit, spent: this.limit, resetAt: new Date(r.resetAt ?? reset).toISOString(), retryAfter: r.retryAfter ?? Math.ceil((reset - Date.now()) / 1000) }, { ...this.quotaHeaders(), ...(r.headers || {}) });
      }
      return json(r.status, r.body ?? { error: 'injected' }, { ...this.quotaHeaders(), ...(r.headers || {}) });
    }
    if (this.on[ep]) { const r = await this.on[ep](u, rec); if (r) { rec.status = r.status; return r; } }
    rec.status = 200;
    const h = this.quotaHeaders();
    switch (ep) {
      case 'titleHistory': {
        const titles = [...this.titles.values()].map((t) => ({
          titleId: t.id, pfn: `${t.name.replace(/\W/g, '')}_8wekyb3d8bbwe`, bingId: null, serviceConfigId: `00000000-0000-0000-0000-0000${t.id.padStart(8, '0')}`, windowsPhoneProductId: null,
          name: t.name, type: t.type, devices: t.devices, displayImage: `https://store-images.s-microsoft.com/image/apps.${t.id}.png`, mediaItemType: t.type === 'App' ? 'Application' : 'Game',
          modernTitleId: t.id, isBundle: false,
          achievement: { currentAchievements: t.achievements.filter(Boolean).length, totalAchievements: t.achievements.length, currentGamerscore: 0, totalGamerscore: 0, progressPercentage: 0, sourceVersion: 2 },
          stats: null, gamePass: null, images: [], titleHistory: t.lastPlayed == null ? null : { lastTimePlayed: xblTime(t.lastPlayed), visible: true, canHide: false },
          detail: null, friendsWhoPlayed: null, alternateTitleIds: null, contentBoards: null, xboxLiveTier: 'Full', isStreamable: false,
        }));
        return json(200, this.body(this.includeXuid ? { xuid: this.xuid, titles } : { titles }), h);
      }
      case 'stats': {
        const t = this.titles.get(String(titleId));
        const base = { xuid: this.xuid, scid: `00000000-0000-0000-0000-0000${String(titleId).padStart(8, '0')}`, titleid: String(titleId) };
        let heroStats = [];
        if (t && typeof t.minutes === 'number') heroStats = [{ groupproperties: { Ordinal: 'Integer', DisplayFormat: 'Integer' }, ...base, name: 'MinutesPlayed', type: 'Integer', value: String(t.minutes), properties: { DisplayName: 'Minutes Played' } }];
        if (t && t.minutes === 'novalue') heroStats = [{ groupproperties: { Ordinal: 'Integer', DisplayFormat: 'Integer' }, ...base, name: 'MinutesPlayed', type: 'Integer', properties: { DisplayName: 'Minutes Played' } }];
        const groups = [{ name: 'Hero', titleid: String(titleId), statlistscollection: heroStats.length ? [{ arrangebyfield: 'xuid', arrangebyfieldid: this.xuid, stats: heroStats }] : [] }];
        return json(200, this.body({ groups, statlistscollection: [{ arrangebyfield: 'xuid', arrangebyfieldid: this.xuid, stats: [] }] }), h);
      }
      case 'presence': {
        const me = this.presence
          ? { xuid: this.xuid, state: 'Online', devices: this.presence.map((d) => ({ type: d.type, titles: d.titles.map((x) => ({ id: String(x.id), name: x.name, placement: x.placement ?? 'Full', state: x.state ?? 'Active', lastModified: xblTime(Date.now()) })) })) }
          : { xuid: this.xuid, state: 'Offline', lastSeen: { deviceType: 'Scarlett', titleId: '750323071', titleName: 'Home', timestamp: xblTime(Date.now() - HOUR) } };
        return json(200, this.body([me]), h);
      }
      case 'achievements': {
        const t = this.titles.get(String(titleId));
        if (!t) return json(404, { error: 'not found' }, h);
        if (t.achStatus) { rec.status = t.achStatus; return json(t.achStatus, { error: 'injected' }, h); }
        const achievements = t.achievements.map((when, i) => ({
          id: String(i + 1), serviceConfigId: 'scid', name: `Achievement ${i + 1}`, titleAssociations: [{ name: t.name, id: Number(t.id) }],
          progressState: when ? 'Achieved' : 'NotStarted', progression: { requirements: [], timeUnlocked: when ? xblTime(when) : LOCKED },
          mediaAssets: [], platforms: ['XboxSeries'], isSecret: false, description: '', lockedDescription: '', productId: '', achievementType: 'Persistent',
          participationType: 'Individual', timeWindow: null, rewards: [{ value: '10', type: 'Gamerscore' }], estimatedTime: '00:00:00', deeplink: '', isRevoked: false,
        }));
        return json(200, this.body({ achievements, pagingInfo: { continuationToken: null, totalRecords: achievements.length } }), h);
      }
      case 'screenshots':
        return json(200, this.body({ screenshots: this.screenshots.map((s, i) => ({ screenshotId: `ss-${i}`, resolutionHeight: 1080, resolutionWidth: 1920, state: 'Published', datePublished: xblTime(s.at + HOUR), dateTaken: xblTime(s.at), titleId: Number(s.titleId), titleName: this.titles.get(String(s.titleId))?.name || '', xuid: this.xuid, deviceType: 'Scarlett' })), pagingInfo: { continuationToken: null } }), h);
      case 'gameclips':
        return json(200, this.body({ gameClips: this.gameclips.map((s, i) => ({ gameClipId: `gc-${i}`, state: 'Published', datePublished: xblTime(s.at + HOUR), dateRecorded: xblTime(s.at), durationInSeconds: 30, titleId: Number(s.titleId), titleName: this.titles.get(String(s.titleId))?.name || '', xuid: this.xuid, deviceType: 'Scarlett' })), pagingInfo: { continuationToken: null } }), h);
      default:
        rec.status = 404;
        return json(404, { error: 'Not Found' }, h);
    }
  }
}

/** A device row for FakeXbl.setPresence. */
export const device = (type, ...titles) => ({ type, titles });

// ---------------------------------------------------------------- app
function client(port) {
  return (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (data != null) {
      h['content-type'] ||= 'application/json';
      h['content-length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: path.startsWith('/api') ? path : `/api/v1${path}`, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

const quietLog = (sink) => ({
  info(m) { sink?.push(['info', String(m)]); }, warn(m) { sink?.push(['warn', String(m)]); },
  error(m) { sink?.push(['error', String(m)]); }, debug() {},
});

/** Start PlayTracker in-process with the virtual clock and the fetch router installed. */
export async function setup({ now = T0, dbFile = ':memory:', scheduler = false } = {}) {
  clock.install(now);
  installFetch();
  const logs = [];
  const instance = createApp({ dbFile, password: '', log: quietLog(logs), scheduler });
  await new Promise((r) => instance.server.listen(0, '127.0.0.1', r));
  const port = instance.server.address().port;
  const raw = client(port);
  const app = instance.app;
  const db = app.db;
  const svc = app.sync;

  const h = {
    app, db, svc, logs, port, instance,
    call: raw,
    get: async (p) => { const r = await raw('GET', p); if (r.status !== 200) throw new Error(`GET ${p} -> ${r.status} ${r.text}`); return r.body; },
    post: (p, b = {}) => raw('POST', p, b),
    patch: (p, b = {}) => raw('PATCH', p, b),

    /** Wait until no sync or background enrichment is in flight. */
    async settle() {
      for (let i = 0; i < 100; i++) {
        const ps = [...svc.running.values(), ...svc.enriching.values()];
        if (!ps.length) { await new Promise((r) => setImmediate(r)); if (!svc.running.size && !svc.enriching.size) return; continue; }
        await Promise.allSettled(ps);
      }
      throw new Error('background work did not settle');
    },

    /** Link an Xbox account without starting the initial import. */
    async link(fake, config = {}, name = 'My Xbox') {
      const r = await raw('POST', '/accounts', { platform: 'xbox', name, config: { api_key: fake.key, ...config }, sync: false });
      if (r.status !== 200) throw new Error(`link failed: ${r.status} ${r.text}`);
      return r.body;
    },

    /** POST /accounts/:id/sync?wait=true, then let background enrichment finish. */
    async sync(id) {
      const r = await raw('POST', `/accounts/${id}/sync?wait=true`, {});
      await h.settle();
      return r;
    },

    /** One presence poll, the way the scheduler does it every 5 minutes. */
    async poll(id) {
      await svc.pollPresence(svc.account(id));
      await h.settle();
    },

    /**
     * Presence sees `titles` from `from` until `to` (polls every 5 minutes), then the player
     * goes offline (one more poll 5 minutes after `to`).
     */
    async presenceSpan(fake, id, devices, from, to) {
      for (let t = from; t <= to; t += 5 * MIN) {
        clock.set(t);
        fake.setPresence(devices);
        await h.poll(id);
      }
      clock.set(to + 5 * MIN);
      fake.setPresence(null);
      await h.poll(id);
    },

    account: async (id) => (await h.get('/accounts')).find((a) => a.id === id),
    entry: (accountId, extId) => db.prepare('SELECT * FROM entries WHERE account_id = ? AND ext_id = ?').get(accountId, String(extId)),
    entries: (accountId) => db.prepare('SELECT * FROM entries WHERE account_id = ? ORDER BY ext_id').all(accountId),
    sessions: (entryId, kind = 'play') => db.prepare(`SELECT * FROM sessions WHERE entry_id = ? ${kind === 'all' ? '' : 'AND kind = ?'} ORDER BY COALESCE(started_at, window_start, window_end), id`).all(...(kind === 'all' ? [entryId] : [entryId, kind])),
    sumKind: (entryId, kind) => db.prepare('SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ? AND kind = ?').get(entryId, kind).m,
    playSessions: (accountId) => db.prepare("SELECT s.*, e.ext_id FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.account_id = ? AND s.kind = 'play' ORDER BY s.sort_time, s.id").all(accountId),
    lastSync: (accountId) => db.prepare('SELECT * FROM syncs WHERE account_id = ? ORDER BY id DESC LIMIT 1').get(accountId),

    async close() {
      try { await h.settle(); } catch { /* closing anyway */ }
      instance.close();
      restoreFetch();
      clock.restore();
    },
  };
  return h;
}

/** Entries whose sessions do not add up to their lifetime total (must always be empty). */
export function unbalanced(db) {
  return db.prepare(`SELECT e.id, e.ext_id, e.title, e.playtime_min, COALESCE(SUM(s.minutes), 0) m FROM entries e
    LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min`).all();
}

/** Play / estimate sessions whose per-day rollup rows don't add up to the session (after a flush). */
export function badRollups(db) {
  return db.prepare(`SELECT s.id, s.kind, s.minutes, COALESCE(SUM(d.minutes), 0) r FROM sessions s LEFT JOIN play_days d ON d.session_id = s.id
    WHERE s.kind IN ('play', 'estimate') GROUP BY s.id HAVING ABS(COALESCE(SUM(d.minutes), 0) - s.minutes) > 0.01`).all();
}

/** Play sessions that end in the future (relative to the virtual now). */
export function futureSessions(db, now = Date.now()) {
  return db.prepare("SELECT id, minutes, started_at, ended_at, window_end FROM sessions WHERE kind = 'play' AND COALESCE(ended_at, window_end) > ?").all(now + MIN);
}
