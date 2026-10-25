// Test harness for test/suite/library.test.js (own helpers; no imports from other tests).
// Starts Vestigo in-process on an in-memory database and talks to it over HTTP.
import { createApp } from '../../../src/server.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// the real fetch, captured before any test replaces globalThis.fetch with a platform mock
const realFetch = globalThis.fetch;

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start a fresh app (own in-memory DB) and return a small client around it. */
export async function startApp({ password = '' } = {}) {
  const inst = createApp({ dbFile: ':memory:', password, log: quietLog, scheduler: false });
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${inst.server.address().port}/api/v1`;
  const db = inst.app.db;

  async function call(path, { method = 'GET', body, raw = false, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    if (body !== undefined && raw && !h['Content-Type']) h['Content-Type'] = 'application/json';
    const res = await realFetch(base + path, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { status: res.status, data };
  }
  const get = (p) => call(p);
  const post = (p, body = {}) => call(p, { method: 'POST', body });
  const patch = (p, body = {}) => call(p, { method: 'PATCH', body });
  const put = (p, body = {}) => call(p, { method: 'PUT', body });
  const del = (p) => call(p, { method: 'DELETE' });

  /** POST /games and assert success; returns the game detail. */
  async function createGame(title, extra = {}) {
    const r = await post('/games', { title, ...extra });
    if (r.status !== 200) throw new Error(`createGame(${title}) -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
  /** Log a manual (exact) session for a game. */
  async function logSession(gameId, minutes, startedAt, extra = {}) {
    const r = await post('/sessions', { game_id: gameId, minutes, started_at: startedAt, ...extra });
    if (r.status !== 200) throw new Error(`logSession -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
  async function customAccount(name) {
    const r = await post('/accounts', { platform: 'custom', name });
    if (r.status !== 200) throw new Error(`customAccount -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
  async function report(accountId, games) {
    const r = await post(`/accounts/${accountId}/report`, { games });
    if (r.status !== 200) throw new Error(`report -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
  async function importGames(games) {
    const r = await post('/import', { games });
    if (r.status !== 200) throw new Error(`import -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
  const game = async (id) => (await get(`/games/${id}`)).data;
  const lifetime = async () => (await get('/stats/lifetime')).data;
  const list = async (qs = '') => (await get(`/games${qs ? `?${qs}` : ''}`)).data;
  const titles = async (qs = '') => (await list(qs)).items.map((g) => g.title);
  const dupes = async (qs = '') => (await get(`/duplicates${qs ? `?${qs}` : ''}`)).data;

  /** Universal invariant: every entry's sessions add up to its lifetime playtime. */
  const sessionSumViolations = () => db.prepare(`SELECT e.id, e.title, e.playtime_min, COALESCE(SUM(s.minutes), 0) session_minutes
    FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min`).all().map((r) => ({ ...r }));
  /** Referential sanity: no entries without a game, no sessions without an entry, no empty games. */
  const orphans = () => ({
    entries: db.prepare('SELECT COUNT(*) n FROM entries WHERE game_id NOT IN (SELECT id FROM games)').get().n,
    sessions: db.prepare('SELECT COUNT(*) n FROM sessions WHERE entry_id NOT IN (SELECT id FROM entries)').get().n,
    play_days: db.prepare('SELECT COUNT(*) n FROM play_days WHERE session_id NOT IN (SELECT id FROM sessions)').get().n,
    empty_games: db.prepare('SELECT COUNT(*) n FROM games WHERE id NOT IN (SELECT game_id FROM entries)').get().n,
  });
  /** Sum of counted (non-excluded) entries' playtime, straight from the DB. */
  const countedMinutes = () => db.prepare('SELECT COALESCE(SUM(playtime_min), 0) m FROM entries WHERE excluded = 0').get().m;

  return {
    inst, db, base, call, get, post, patch, put, del,
    createGame, logSession, customAccount, report, importGames, game, lifetime, list, titles, dupes,
    sessionSumViolations, orphans, countedMinutes,
    close: () => inst.close(),
  };
}

/**
 * Replace globalThis.fetch for every host except 127.0.0.1/localhost (those go to the real
 * fetch). `handler(url: URL, opts)` returns a Response. Returns a restore function.
 */
export function installFetchMock(handler) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (input, opts) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, opts);
    return handler(url, opts);
  };
  return () => { globalThis.fetch = prev; };
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

/**
 * A minimal fake of the Steam Web API: `libraries[steamid64]` is a function returning the
 * GetOwnedGames list for that user at the time of the call. Achievements are "private" (403),
 * store lookups return nothing, so background enrichment finishes quickly with no data.
 */
export function steamApiMock(libraries, { created = Date.now() - 3000 * DAY } = {}) {
  const hits = [];
  const handler = async (url) => {
    hits.push(`${url.hostname}${url.pathname}`);
    if (url.hostname !== 'api.steampowered.com' && url.hostname !== 'store.steampowered.com') return json({ error: 'unexpected host' }, 404);
    if (url.pathname.includes('GetPlayerSummaries')) {
      return json({ response: { players: [{ steamid: url.searchParams.get('steamids'), personaname: 'tester', communityvisibilitystate: 3, timecreated: Math.floor(created / 1000) }] } });
    }
    if (url.pathname.includes('GetOwnedGames')) {
      const lib = libraries[url.searchParams.get('steamid')];
      if (!lib) return json({ response: {} });
      const games = lib();
      return json({ response: { game_count: games.length, games } });
    }
    if (url.pathname.includes('GetPlayerAchievements')) return json({ playerstats: { success: false, error: 'Profile is not public' } }, 403);
    if (url.pathname.includes('appdetails')) return json({});
    if (url.pathname.includes('GetItems')) return json({ response: { store_items: [] } });
    return json({ error: 'not mocked' }, 404);
  };
  return { handler, hits };
}
