// Harness for test/suite/import-export.test.js (own helpers; nothing shared with other suites).
// - startApp(): an in-process Vestigo on 127.0.0.1 with an in-memory database
// - installFetchMock(): replaces globalThis.fetch for every non-127.0.0.1 host (no real network)
// - SteamMock: a fake Steam Web API / store for one API key
// - buildZip(): a small ZIP writer (deflate or stored) for GameTrack exports
// - csv helpers, local-day helpers, database invariants and content snapshots
import zlib from 'node:zlib';
import { createApp } from '../../../src/server.js';

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------- fetch mock
const realFetch = globalThis.fetch;
const handlers = new Set();
export const externalCalls = [];

/** Route every non-local request to the registered mocks; unknown hosts fail like a dead network. */
export function installFetchMock() {
  globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    externalCalls.push(url.href);
    for (const h of handlers) {
      const r = await h(url, init);
      if (r) return r;
    }
    throw new TypeError(`fetch failed (no mock for ${url.host})`);
  };
  return () => { globalThis.fetch = realFetch; };
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

let mockSeq = 0;
/**
 * A fake Steam account. games: [{ appid, name, minutes, lastPlayed (ms), recent? }].
 * achievements: { appid: [ms, ...] }. Only answers requests carrying its own API key.
 */
export class SteamMock {
  constructor({ games = [], achievements = {}, timecreated = null, steamid = '76561198000000001' } = {}) {
    this.key = `steam-key-${++mockSeq}-${Math.random().toString(36).slice(2, 10)}`;
    this.steamid = steamid;
    this.games = new Map(games.map((g) => [String(g.appid), { ...g }]));
    this.achievements = achievements;
    this.timecreated = timecreated;
    this.calls = [];
    this.handler = (url) => this.handle(url);
    handlers.add(this.handler);
  }

  set(appid, patch) { this.games.set(String(appid), { ...(this.games.get(String(appid)) || { appid }), ...patch }); }
  dispose() { handlers.delete(this.handler); }

  handle(url) {
    const key = url.searchParams.get('key');
    if (url.host === 'api.steampowered.com') {
      // the store-browse cover lookup carries no key; answer it for every mock (no special covers)
      if (url.pathname.startsWith('/IStoreBrowseService/GetItems')) return json({ response: { store_items: [] } });
      if (key !== this.key) return null;
      this.calls.push(url.pathname);
      if (url.pathname.startsWith('/ISteamUser/GetPlayerSummaries')) {
        return json({ response: { players: [{ steamid: this.steamid, personaname: 'Tester', communityvisibilitystate: 3, ...(this.timecreated ? { timecreated: Math.floor(this.timecreated / 1000) } : {}) }] } });
      }
      if (url.pathname.startsWith('/IPlayerService/GetOwnedGames')) {
        const games = [...this.games.values()].map((g) => ({
          appid: Number(g.appid), name: g.name, playtime_forever: g.minutes, playtime_2weeks: g.recent || 0,
          rtime_last_played: g.lastPlayed ? Math.floor(g.lastPlayed / 1000) : 0,
          playtime_windows_forever: g.minutes, playtime_mac_forever: 0, playtime_linux_forever: 0, playtime_deck_forever: 0, playtime_disconnected: 0,
          img_icon_url: '', has_community_visible_stats: !!this.achievements[g.appid],
        }));
        return json({ response: { game_count: games.length, games } });
      }
      if (url.pathname.startsWith('/ISteamUserStats/GetPlayerAchievements')) {
        const appid = url.searchParams.get('appid');
        const list = this.achievements[appid];
        if (!list) return json({ playerstats: { error: 'Requested app has no stats', success: false } }, 400);
        return json({ playerstats: { success: true, achievements: list.map((t, i) => ({ apiname: `a${i}`, achieved: 1, unlocktime: Math.floor(t / 1000) })) } });
      }
      if (url.pathname.startsWith('/ISteamUser/ResolveVanityURL')) return json({ response: { success: 1, steamid: this.steamid } });
      return json({}, 404);
    }
    if (url.host === 'store.steampowered.com' && url.pathname.startsWith('/api/appdetails')) {
      // release dates are not part of these scenarios: an empty, successful reply
      return json({ [url.searchParams.get('appids')]: { success: false } });
    }
    return null;
  }
}

// ---------------------------------------------------------------- app
export async function startApp({ password = '' } = {}) {
  const inst = createApp({ dbFile: ':memory:', password, log: quiet, scheduler: false });
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  const port = inst.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const base = `${origin}/api/v1`;
  const db = inst.app.db;
  const sync = inst.app.sync;
  let defaultHeaders = {};

  /** Low-level request. body: object -> JSON, string -> as is (with `type`), Buffer -> binary. */
  async function call(path, { method = 'GET', body, type, headers = {}, query } = {}) {
    const url = new URL(path.startsWith('http') ? path : path.startsWith('/api') ? origin + path : base + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const h = { ...defaultHeaders, ...headers };
    let payload;
    if (body !== undefined) {
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) { payload = body; h['Content-Type'] ||= type || 'application/zip'; }
      else if (typeof body === 'string') { payload = body; h['Content-Type'] ||= type || 'text/csv'; }
      else { payload = JSON.stringify(body); h['Content-Type'] ||= 'application/json'; }
    }
    const res = await fetch(url, { method, headers: h, body: payload });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let data = null;
    if (/json/.test(res.headers.get('content-type') || '')) { try { data = JSON.parse(text); } catch { data = null; } }
    return { status: res.status, headers: res.headers, data, text, buf };
  }
  const ok = async (p) => {
    const r = await p;
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 300)}`);
    return r.data;
  };

  const t = {
    inst, db, sync, base, origin, call,
    setHeaders(h) { defaultHeaders = { ...h }; },
    get: (p, query) => call(p, { query }),
    post: (p, body, opts = {}) => call(p, { method: 'POST', body, ...opts }),
    patch: (p, body) => call(p, { method: 'PATCH', body }),
    del: (p) => call(p, { method: 'DELETE' }),
    ok,
    /** POST /import with a CSV (text/csv) or JSON body; returns the full response. */
    importCsv: (text, query) => call('/import', { method: 'POST', body: text, type: 'text/csv', query }),
    importJson: (obj, query) => call('/import', { method: 'POST', body: obj, query }),
    importZip: (buf, query) => call('/import/gametrack', { method: 'POST', body: buf, type: 'application/zip', query }),

    /** Link a Steam account backed by `mock`, run the initial sync and wait for background enrichment. */
    async linkSteam(mock, { name = 'Steam' } = {}) {
      const acc = await ok(t.post('/accounts', { platform: 'steam', name, config: { api_key: mock.key, steam_id: mock.steamid, presence: 'off' }, sync: false }));
      const res = await ok(t.post(`/accounts/${acc.id}/sync`, {}, { query: { wait: 'true' } }));
      await t.settle();
      return { account: acc, sync: res };
    },
    async syncSteam(accountId) {
      const res = await ok(t.post(`/accounts/${accountId}/sync`, {}, { query: { wait: 'true' } }));
      await t.settle();
      return res;
    },
    async linkCustom(name = 'Custom') {
      return ok(t.post('/accounts', { platform: 'custom', name, config: {} }));
    },
    /** Wait for every in-flight sync / enrichment / cover lookup of this instance. */
    async settle() {
      for (let i = 0; i < 5; i++) {
        const p = [...sync.running.values(), ...sync.enriching.values()];
        if (!p.length) break;
        await Promise.allSettled(p);
      }
      await new Promise((r) => setTimeout(r, 30));
    },

    // ---------- reads ----------
    async gamesAll() { return (await ok(t.get('/games', { limit: '5000', hidden: 'true', sort: 'title' }))).items; },
    async gameByTitle(title) {
      const all = await t.gamesAll();
      const hits = all.filter((g) => g.title === title);
      if (hits.length > 1) throw new Error(`"${title}" is in the library ${hits.length} times`);
      return hits[0] ? ok(t.get(`/games/${hits[0].id}`)) : null;
    },
    gamesTitled(title, all) { return all.filter((g) => g.title === title); },
    lifetime: () => ok(t.get('/stats/lifetime')),
    entriesOf(title) {
      return db.prepare('SELECT e.* FROM entries e JOIN games g ON g.id = e.game_id WHERE g.title = ? ORDER BY e.id').all(title);
    },
    sessionsOf(entryId, kind) {
      return db.prepare(`SELECT * FROM sessions WHERE entry_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY COALESCE(started_at, window_start, window_end), id`).all(...[entryId, kind].filter((x) => x != null));
    },
    playOfGame(title) {
      return db.prepare(`SELECT s.* FROM sessions s JOIN entries e ON e.id = s.entry_id JOIN games g ON g.id = e.game_id
        WHERE g.title = ? AND s.kind = 'play' ORDER BY COALESCE(s.started_at, s.window_start, s.window_end), s.minutes`).all(title);
    },

    // ---------- invariants ----------
    /** Entries whose sessions (play + estimated + undated history) do not add up to their total. */
    sumViolations() {
      return db.prepare(`SELECT e.id, e.title, e.playtime_min, COALESCE(SUM(s.minutes), 0) sessions FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id
        GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min`).all();
    },
    /** Rows that can never be right: negative totals, non-positive sessions, future sessions, empty games. */
    oddities(now = Date.now()) {
      return {
        negative_totals: db.prepare('SELECT COUNT(*) n FROM entries WHERE playtime_min < 0 OR baseline_min < 0').get().n,
        nonpositive_sessions: db.prepare('SELECT COUNT(*) n FROM sessions WHERE minutes <= 0').get().n,
        // tracked play cannot end in the future; history cannot start after today
        future_play: db.prepare("SELECT COUNT(*) n FROM sessions WHERE kind = 'play' AND COALESCE(ended_at, window_end, started_at, 0) > ?").get(now + 5 * MIN).n,
        future_history: db.prepare("SELECT COUNT(*) n FROM sessions WHERE kind = 'estimate' AND COALESCE(window_start, started_at, 0) > ?").get(now + 5 * MIN).n,
        empty_games: db.prepare('SELECT COUNT(*) n FROM games WHERE id NOT IN (SELECT game_id FROM entries)').get().n,
        rollup_mismatch: db.prepare(`SELECT COUNT(*) n FROM (SELECT s.id, s.minutes, (SELECT COALESCE(SUM(p.minutes), 0) FROM play_days p WHERE p.session_id = s.id) d
          FROM sessions s WHERE s.kind IN ('play', 'estimate')) WHERE ABS(minutes - d) > 0.01`).get().n,
      };
    },
    /** Everything a user can see, without row ids / creation stamps (re-dating may renumber rows). */
    snapshot() {
      const q = (sql) => db.prepare(sql).all();
      const strip = (h) => { const o = JSON.parse(h || '{}'); if (o.inference) delete o.inference.at; return o; };
      return {
        games: q('SELECT title, norm_title, cover_url, status, rating, notes, favorite, hidden, merge_locked FROM games ORDER BY norm_title, id'),
        entries: q(`SELECT e.account_id, g.title game, e.platform, e.ext_id, e.title, e.playtime_min, e.last_played_at, e.excluded, e.baseline_min, e.hist
          FROM entries e JOIN games g ON g.id = e.game_id ORDER BY e.platform, e.ext_id`).map((e) => ({ ...e, hist: strip(e.hist) })),
        sessions: q(`SELECT e.platform, e.ext_id, s.source, s.kind, s.minutes, s.window_start, s.window_end, s.started_at, s.ended_at, s.confidence, s.note
          FROM sessions s JOIN entries e ON e.id = s.entry_id ORDER BY e.platform, e.ext_id, s.kind, s.source, COALESCE(s.started_at, s.window_start, s.window_end), s.minutes, s.note`),
        days: q('SELECT p.day, g.norm_title, p.estimated, ROUND(SUM(p.minutes), 3) m FROM play_days p JOIN games g ON g.id = p.game_id GROUP BY p.day, g.norm_title, p.estimated ORDER BY p.day, g.norm_title, p.estimated'),
      };
    },

    async close() {
      await t.settle();
      inst.close();
    },
  };
  return t;
}

// ---------------------------------------------------------------- CSV
/** Build a delimited file; fields are quoted only when they must be (RFC 4180 style). */
export function toCsv(rows, { sep = ',', eol = '\n', quoteAll = false } = {}) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return quoteAll || s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(sep)).join(eol) + eol;
}

/** A strict RFC 4180 reader (comma only) used to check what the export wrote. */
export function readCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x !== ''));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// ---------------------------------------------------------------- dates (local time zone)
export const pad = (n) => String(n).padStart(2, '0');
export const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const endOfDay = (t) => { const d = new Date(t); d.setHours(23, 59, 59, 999); return d.getTime(); };
export const iso = (t) => new Date(t).toISOString();

// ---------------------------------------------------------------- ZIP
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: { 'path/name.csv': string | Buffer }. method 8 = deflate (default), 0 = stored. */
export function buildZip(files, { store = false, corrupt } = {}) {
  const locals = []; const central = []; let offset = 0; let count = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    let data = store ? raw : zlib.deflateRawSync(raw);
    if (corrupt === name) data = Buffer.from(data.map((b, i) => (i > 2 ? b ^ 0x5a : b)));
    const method = store ? 0 : 8;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data); central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length; count++;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
