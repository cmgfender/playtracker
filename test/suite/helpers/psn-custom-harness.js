// Harness for test/suite/psn-custom.test.js (own helpers; nothing shared with other test files).
//
//  - clock:    Date.now is replaced by a controllable, frozen clock (tests move time explicitly)
//  - FakePSN:  in-memory Sony endpoints (NPSSO -> code -> tokens, refresh, gamelist v2,
//              basicPresences, trophyTitles / trophies) answering exactly what Vestigo asks
//  - fetch:    127.0.0.1 goes to the real network stack; Sony hosts go to the fake; Discord /
//              Slack webhook hosts are forwarded to a local sink server; anything else fails
//  - startApp: Vestigo in-process on :memory:, called over real HTTP
//  - checks:   invariants that must hold after any sync / report
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { createApp } from '../../../src/server.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Epoch ms of a LOCAL wall-clock time (TZ is pinned by psn-custom-tz.js). */
export const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0).getTime();
export const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- clock
const realDateNow = Date.now.bind(Date);
export const clock = {
  t: realDateNow(),
  now() { return this.t; },
  set(t) { this.t = Math.round(t); return this.t; },
  advance(ms) { return this.set(this.t + ms); },
  install() { Date.now = () => clock.t; },
  restore() { Date.now = realDateNow; },
};

// ---------------------------------------------------------------- fetch router
export const realFetch = globalThis.fetch;
const routes = { psn: null, sink: null };
export const outbound = []; // every non-local request the app made: { host, path, at }

export function installFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(typeof url === 'string' ? url : url.url ?? String(url));
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(url, opts);
    outbound.push({ host: u.host, path: u.pathname, at: Date.now() });
    if ((u.host === 'ca.account.sony.com' || u.host === 'm.np.playstation.com') && routes.psn) return routes.psn.handle(u, opts);
    if ((u.host === 'discord.com' || u.host === 'discordapp.com' || u.host === 'hooks.slack.com') && routes.sink) {
      // chat webhooks are delivered to the local sink, keeping the original host visible
      return realFetch(`${routes.sink.base}${u.pathname}${u.search}`, { ...opts, headers: { ...(opts.headers || {}), 'x-original-host': u.host } });
    }
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  };
}
export function restoreFetch() { globalThis.fetch = realFetch; routes.psn = null; routes.sink = null; }
export function usePsn(fake) { routes.psn = fake; return fake; }
export function useSink(sink) { routes.sink = sink; return sink; }

// ---------------------------------------------------------------- Sony fake
const json = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
});
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** ISO-8601 duration as Sony writes it ("PT228H56M33S"). */
export function isoDuration(minutes, seconds = 0) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `PT${h ? `${h}H` : ''}${m || (!h && !seconds) ? `${m}M` : ''}${seconds ? `${seconds}S` : ''}`;
}

/** A gamelist v2 title object, shaped like Sony's. */
export function psnTitle({ id, name, minutes = 0, duration, first = null, last = null, count = null, category = 'ps5_native_game', concept, conceptName, noName = false } = {}) {
  const t = {
    titleId: id,
    name: noName ? undefined : name,
    localizedName: noName ? undefined : name,
    imageUrl: `https://image.api.playstation.com/title/${id}.png`,
    localizedImageUrl: `https://image.api.playstation.com/title/${id}.png`,
    category,
    service: category === 'ps5_native_game' ? 'none_purchased' : 'other',
    playCount: count ?? undefined,
    concept: concept === null ? undefined : {
      id: concept ?? Number(String(id).replace(/\D/g, '').slice(0, 7) || 1),
      titleIds: [id],
      name: conceptName ?? name,
      media: { audios: [], videos: [], images: [{ url: `https://image.api.playstation.com/concept/${id}-master.png`, format: 'UNKNOWN', type: 'MASTER' }] },
      genres: ['ACTION'],
      localizedName: { defaultLanguage: 'en-US', metadata: { 'en-US': conceptName ?? name } },
      country: 'US', language: 'en',
    },
    media: { audios: [], videos: [], images: [] },
    firstPlayedDateTime: first != null ? new Date(first).toISOString() : undefined,
    lastPlayedDateTime: last != null ? new Date(last).toISOString() : undefined,
    playDuration: duration ?? isoDuration(minutes),
    _min: minutes,
  };
  return t;
}

export const ACCOUNT_ID = '7766554433221100998';
export const NPSSO = 'npssoAbCdEf0123456789ghIJklMNopQRstUVwxYZ0123456789abcdefGHIJKLmn';

/**
 * Minimal PlayStation backend. Tokens expire on the fake clock. Behaviour per endpoint can be
 * overridden (`fake.on.gamelist = (u, ctx) => Response | undefined`) or replaced for the next
 * N calls (`fake.failNext('token', { status: 400, body })`).
 */
export class FakePSN {
  constructor({ npsso = NPSSO, accountId = ACCOUNT_ID, accessTtlS = 3600, refreshTtlS = 5_183_999 } = {}) {
    this.validNpsso = new Set([npsso]);
    this.accountId = accountId;
    this.accessTtlS = accessTtlS;
    this.refreshTtlS = refreshTtlS;
    this.codes = new Map();     // code -> npsso
    this.access = new Map();    // token -> expiresAt
    this.refresh = new Map();   // token -> expiresAt
    this.titles = [];
    this.endStyle = 'omit';     // last page: 'omit' nextOffset | 'null'
    this.playing = [];          // basicPresences gameTitleInfoList
    this.presenceById = true;   // users/{accountId}/basicPresences answers (else 404 -> 'me')
    this.trophyTitles = new Map(); // npTitleId -> [{ npCommunicationId, npServiceName? }]
    this.trophySets = new Map();   // npCommunicationId -> { service, trophies: [...] } | { status }
    this.calls = [];
    this.queued = {};
    this.on = {};
    this.autoAdvanceTrophyMs = 3300; // enrichment spaces calls 3.2 s apart on Date.now: let virtual time pass instead
    this.n = 0;
  }

  add(...titles) { this.titles.push(...titles); return this; }
  title(id) { return this.titles.find((t) => t.titleId === id); }
  remove(id) { this.titles = this.titles.filter((t) => t.titleId !== id); }

  /** A session as Sony records it: duration grows, launch counter increments, last played = end. */
  play(id, { minutes, launches = 1, end = Date.now(), firstAt }) {
    const t = this.title(id);
    t._min += minutes;
    t.playDuration = isoDuration(t._min);
    t.playCount = (t.playCount || 0) + launches;
    t.lastPlayedDateTime = new Date(end).toISOString();
    if (!t.firstPlayedDateTime) t.firstPlayedDateTime = new Date(firstAt ?? end - minutes * MIN).toISOString();
    return t;
  }

  failNext(ep, ...responses) { (this.queued[ep] ||= []).push(...responses); }
  count(ep) { return this.calls.filter((c) => c.ep === ep).length; }
  of(ep) { return this.calls.filter((c) => c.ep === ep); }
  reset() { this.calls = []; }

  issueTokens() {
    const n = ++this.n;
    const now = Date.now();
    const access = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ sub: this.accountId, jti: `a${n}`, scope: 'psn:mobile.v2.core psn:clientapp', exp: Math.floor(now / 1000) + this.accessTtlS })}.c2lnbmF0dXJl${n}`;
    const refresh = `rfr-${n}-${'x'.repeat(24)}`;
    this.access.set(access, now + this.accessTtlS * 1000);
    this.refresh.set(refresh, now + this.refreshTtlS * 1000);
    return { access_token: access, token_type: 'bearer', expires_in: this.accessTtlS, scope: 'psn:mobile.v2.core psn:clientapp', id_token: 'idtok', refresh_token: refresh, refresh_token_expires_in: this.refreshTtlS };
  }

  revokeAll() { this.access.clear(); this.refresh.clear(); }

  bearerOk(headers) {
    const m = /^Bearer (.+)$/.exec(headers.get('authorization') || '');
    const exp = m && this.access.get(m[1]);
    return !!exp && exp > Date.now();
  }

  endpoint(u, method) {
    const p = u.pathname;
    if (u.host === 'ca.account.sony.com') {
      if (p === '/api/authz/v3/oauth/authorize') return 'authorize';
      if (p === '/api/authz/v3/oauth/token' && method === 'POST') return 'token';
    }
    if (u.host === 'm.np.playstation.com') {
      if (p === '/api/gamelist/v2/users/me/titles') return 'gamelist';
      if (/^\/api\/userProfile\/v1\/internal\/users\/[^/]+\/basicPresences$/.test(p)) return 'presence';
      if (p === '/api/trophy/v1/users/me/titles/trophyTitles') return 'trophyTitles';
      if (/^\/api\/trophy\/v1\/users\/me\/npCommunicationIds\/[^/]+\/trophyGroups\/all\/trophies$/.test(p)) return 'trophies';
      if (/^\/api\/trophy\/v1\/npCommunicationIds\/[^/]+\/trophyGroups\/all\/trophies$/.test(p)) return 'trophyList';
    }
    return 'unknown';
  }

  async handle(u, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const headers = new Headers(opts.headers || {});
    const ep = this.endpoint(u, method);
    const body = typeof opts.body === 'string' ? opts.body : '';
    const rec = { ep, method, path: u.pathname, params: Object.fromEntries(u.searchParams), headers: Object.fromEntries(headers), form: Object.fromEntries(new URLSearchParams(body)), redirect: opts.redirect, at: Date.now(), real: performance.now() };
    this.calls.push(rec);
    if ((ep === 'trophyTitles' || ep === 'trophies' || ep === 'trophyList') && this.autoAdvanceTrophyMs) clock.advance(this.autoAdvanceTrophyMs);
    if (this.gate?.[ep]) await this.gate[ep];
    const q = this.queued[ep];
    if (q?.length) {
      const r = q.shift();
      if (r.network) throw Object.assign(new TypeError('fetch failed'), { cause: { code: r.network } });
      if (r.raw) return new Response(r.raw, { status: r.status || 200, headers: r.headers || { 'content-type': 'application/json' } });
      return json(r.status, r.body ?? { error: { code: 0, message: 'injected' } }, r.headers || {});
    }
    if (this.on[ep]) { const r = await this.on[ep](u, rec); if (r) return r; }
    switch (ep) {
      case 'authorize': {
        const npsso = /(?:^|;\s*)npsso=([^;]+)/.exec(headers.get('cookie') || '')?.[1];
        const base = 'com.scee.psxandroid.scecompcall://redirect/';
        if (!npsso || !this.validNpsso.has(npsso) || rec.params.response_type !== 'code' || !rec.params.client_id) {
          return new Response(null, { status: 302, headers: { location: `${base}?error=login_required&error_code=4165&error_description=Missing+or+invalid+NPSSO&no_captcha=false` } });
        }
        const code = `v3.code${++this.n}`;
        this.codes.set(code, npsso);
        return new Response(null, { status: 302, headers: { location: `${base}?code=${code}&cid=0b3c6f6a-0000-4000-8000-000000000000` } });
      }
      case 'token': {
        if (!/^Basic [A-Za-z0-9+/=]+$/.test(headers.get('authorization') || '')) return json(401, { error: 'invalid_client' });
        const f = rec.form;
        if (f.grant_type === 'authorization_code') {
          if (!this.codes.has(f.code) || !f.redirect_uri) return json(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
          this.codes.delete(f.code);
          return json(200, this.issueTokens());
        }
        if (f.grant_type === 'refresh_token') {
          const exp = this.refresh.get(f.refresh_token);
          if (!exp || exp <= Date.now()) return json(400, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
          const t = this.issueTokens();
          this.refresh.delete(t.refresh_token);
          return json(200, { ...t, refresh_token: f.refresh_token, refresh_token_expires_in: Math.floor((exp - Date.now()) / 1000) });
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      case 'gamelist': {
        if (!this.bearerOk(headers)) return json(401, { error: { referenceId: 'x', code: 2241025, message: 'Invalid token' } });
        const limit = Number(rec.params.limit || 100);
        const offset = Number(rec.params.offset || 0);
        const page = this.titles.slice(offset, offset + limit).map((t) => JSON.parse(JSON.stringify(t, (k, v) => (k.startsWith('_') ? undefined : v))));
        const next = offset + limit < this.titles.length ? offset + limit : null;
        const out = { titles: page, totalItemCount: this.titles.length };
        if (offset > 0) out.previousOffset = Math.max(0, offset - limit);
        if (next != null) out.nextOffset = next; else if (this.endStyle === 'null') out.nextOffset = null;
        return json(200, out);
      }
      case 'presence': {
        if (!this.bearerOk(headers)) return json(401, { error: { code: 2241025, message: 'Invalid token' } });
        const id = /users\/([^/]+)\/basicPresences/.exec(u.pathname)[1];
        if (id !== 'me' && (id !== this.accountId || !this.presenceById)) return json(404, { error: { code: 2105356, message: 'User not found' } });
        return json(200, { basicPresence: {
          availability: this.playing.length ? 'availableToPlay' : 'unavailable',
          primaryPlatformInfo: { onlineStatus: this.playing.length ? 'online' : 'offline', platform: 'PS5', lastOnlineDate: new Date(Date.now()).toISOString() },
          ...(this.playing.length ? { gameTitleInfoList: this.playing.map((p) => ({ npTitleId: p.id, titleName: p.title, format: p.format || 'PS5', launchPlatform: p.format || 'PS5', conceptIconUrl: 'https://image.api.playstation.com/x.png' })) } : {}),
        } });
      }
      case 'trophyTitles': {
        if (!this.bearerOk(headers)) return json(401, { error: { code: 2241025, message: 'Invalid token' } });
        const ids = String(rec.params.npTitleIds || '').split(',').filter(Boolean);
        rec.ids = ids;
        if (ids.length > 5) return json(400, { error: { code: 2240526, message: 'Too many npTitleIds' } });
        return json(200, { titles: ids.map((id) => ({ npTitleId: id, trophyTitles: (this.trophyTitles.get(id) || []).map((s) => ({ npServiceName: s.npServiceName, npCommunicationId: s.npCommunicationId, trophyTitleName: `Set ${s.npCommunicationId}`, trophySetVersion: '01.00', trophyTitlePlatform: 'PS5' })) })) });
      }
      case 'trophies': {
        if (!this.bearerOk(headers)) return json(401, { error: { code: 2241025, message: 'Invalid token' } });
        const comm = decodeURIComponent(/npCommunicationIds\/([^/]+)\//.exec(u.pathname)[1]);
        const set = this.trophySets.get(comm);
        if (!set) return json(404, { error: { code: 2240525, message: 'Resource not found' } });
        if (set.status) return json(set.status, { error: { code: 1, message: 'injected' } }, set.headers || {});
        // Sony answers 404 when the service name doesn't match the set (PS5 sets are "trophy2")
        if (rec.params.npServiceName !== set.service) return json(404, { error: { code: 2240525, message: 'Resource not found' } });
        return json(200, { trophySetVersion: '01.00', hasTrophyGroups: false, trophies: set.trophies, totalItemCount: set.trophies.length });
      }
      case 'trophyList': {
        // the set's own list (names, details, icons), the same for every player
        if (!this.bearerOk(headers)) return json(401, { error: { code: 2241025, message: 'Invalid token' } });
        const comm = decodeURIComponent(/npCommunicationIds\/([^/]+)\//.exec(u.pathname)[1]);
        const set = this.trophySets.get(comm);
        if (!set || set.status || rec.params.npServiceName !== set.service) return json(404, { error: { code: 2240525, message: 'Resource not found' } });
        const list = set.trophies.map((t) => ({ trophyId: t.trophyId, trophyHidden: !!t.trophyHidden, trophyType: t.trophyType, trophyName: `Trophy ${t.trophyId}`, trophyDetail: `Detail ${t.trophyId}`,
          trophyIconUrl: `https://image.api.playstation.com/trophy/${comm}/${t.trophyId}.png`, trophyGroupId: t.trophyGroupId || 'default' }));
        return json(200, { trophySetVersion: '01.00', hasTrophyGroups: false, trophies: list, totalItemCount: list.length });
      }
      default:
        return json(404, { error: 'not found' });
    }
  }
}

/** Sony trophy objects. */
export const trophy = (id, earnedAt) => ({ trophyId: id, trophyHidden: false, earned: earnedAt != null, ...(earnedAt != null ? { earnedDateTime: new Date(earnedAt).toISOString() } : {}), trophyType: 'bronze', trophyRare: 3, trophyEarnedRate: '50.0' });

// ---------------------------------------------------------------- webhook sink (local http server)
export async function startSink() {
  const hits = [];
  const waiters = [];
  let status = 204;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      hits.push({ method: req.method, path: req.url, headers: req.headers, text, body, host: req.headers['x-original-host'] || null });
      res.writeHead(status); res.end();
      for (const w of waiters.splice(0)) w();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, hits,
    setStatus(s) { status = s; },
    clear() { hits.length = 0; },
    /** Resolve once `n` deliveries arrived (or fail after `ms`). */
    async waitFor(n = 1, ms = 3000) {
      const until = performance.now() + ms;
      while (hits.length < n) {
        if (performance.now() > until) throw new Error(`expected ${n} webhook deliveries, got ${hits.length}`);
        await Promise.race([new Promise((r) => waiters.push(r)), realSleep(50)]);
      }
      return hits;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------------------------------------------------------------- app
export async function startApp({ password = '' } = {}) {
  const logs = { info: [], warn: [], error: [] };
  const log = {
    info(m) { logs.info.push(String(m)); },
    warn(m) { logs.warn.push(String(m)); },
    error(m) { logs.error.push(String(m)); },
    debug() {},
  };
  const inst = createApp({ dbFile: ':memory:', password, log, scheduler: false });
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${inst.server.address().port}`;
  const api = async (method, path, body, headers = {}) => {
    const url = base + (path.startsWith('/api') || path.startsWith('/metrics') ? path : `/api/v1${path}`);
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!Object.keys(init.headers).some((k) => k.toLowerCase() === 'content-type')) init.headers['content-type'] = 'application/json';
    }
    const res = await realFetch(url, init);
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed, text, headers: res.headers };
  };
  const t = {
    inst, app: inst.app, db: inst.app.db, sync: inst.app.sync, base, api, logs,
    /** Wait for background work the app starts after a sync (trophy enrichment, running syncs). */
    async settle() {
      for (let i = 0; i < 5; i++) {
        const pending = [...t.sync.enriching.values(), ...t.sync.running.values()];
        if (!pending.length) return;
        await Promise.allSettled(pending);
      }
    },
    async syncNow(id) {
      const r = await api('POST', `/accounts/${id}/sync?wait=true`);
      await t.settle();
      return r;
    },
    async report(id, games) {
      const r = await api('POST', `/accounts/${id}/report`, { games });
      await t.settle();
      return r;
    },
    entry(accountId, extId) { return t.db.prepare('SELECT * FROM entries WHERE account_id = ? AND ext_id = ?').get(accountId, String(extId)); },
    sessions(entryId, kind = null) {
      return t.db.prepare(`SELECT * FROM sessions WHERE entry_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY COALESCE(started_at, window_start, window_end, created_at), id`).all(...(kind ? [entryId, kind] : [entryId]));
    },
    sum(rows) { return rows.reduce((a, r) => a + r.minutes, 0); },
    close() { inst.close(); },
  };
  return t;
}

/** Entries whose sessions (tracked + estimated + undated) don't add up to the entry's total. */
export function invariantViolations(db) {
  return db.prepare(`SELECT e.id, e.title, e.playtime_min, COALESCE(SUM(s.minutes), 0) sessions FROM entries e
    LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min`).all();
}

/** Play/estimate sessions whose per-day rollup rows don't add up to the session's minutes. */
export function rollupViolations(db) {
  return db.prepare(`SELECT s.id, s.kind, s.minutes, COALESCE(SUM(d.minutes), 0) rolled FROM sessions s LEFT JOIN play_days d ON d.session_id = s.id
    WHERE s.kind IN ('play', 'estimate') AND s.minutes > 0 GROUP BY s.id HAVING ABS(COALESCE(SUM(d.minutes), 0) - s.minutes) > 0.01`).all();
}

/** Sessions that lie (partly) in the future relative to the clock. */
export function futureSessions(db, now = Date.now()) {
  return db.prepare('SELECT * FROM sessions WHERE COALESCE(ended_at, window_end, 0) > ? OR COALESCE(started_at, window_start, 0) > ?').all(now + 1000, now + 1000);
}
