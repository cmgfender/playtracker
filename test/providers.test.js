import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { providers } from '../src/providers/index.js';

// Mock the platform APIs at the fetch level and drive real syncs through the app.
const realFetch = globalThis.fetch;
const DAY = 86_400_000;
const NOW = Date.now();
const state = {
  steamPlaytime: { 10: 3000, 20: 0 },
  steamGameId: null,
  psnTitles: [],
  xboxMinutes: { 111: 900 },
  calls: [],
};

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function mockFetch(url, opts = {}) {
  const u = new URL(url);
  state.calls.push(u.host + u.pathname);
  if (u.host === '127.0.0.1') return realFetch(url, opts);
  // ---- Steam ----
  if (u.pathname.includes('GetOwnedGames')) {
    return json({ response: { game_count: 2, games: [
      { appid: 10, name: 'Counter-Strike', playtime_forever: state.steamPlaytime[10], playtime_2weeks: 240, rtime_last_played: Math.floor((NOW - DAY) / 1000), playtime_windows_forever: state.steamPlaytime[10] - 100, playtime_deck_forever: 100, playtime_disconnected: 0, has_community_visible_stats: true },
      { appid: 20, name: 'Team Fortress Classic', playtime_forever: state.steamPlaytime[20], rtime_last_played: 0 },
    ] } });
  }
  if (u.pathname.includes('GetPlayerSummaries')) {
    return json({ response: { players: [{ steamid: '76561197960287930', personaname: 'Tester', communityvisibilitystate: 3, timecreated: Math.floor((NOW - 3000 * DAY) / 1000), ...(state.steamGameId ? { gameid: state.steamGameId, gameextrainfo: 'Counter-Strike' } : {}) }] } });
  }
  if (u.pathname.includes('GetPlayerAchievements')) {
    return json({ playerstats: { success: true, achievements: [
      { apiname: 'a', achieved: 1, unlocktime: Math.floor((NOW - 400 * DAY) / 1000) },
      { apiname: 'b', achieved: 1, unlocktime: Math.floor((NOW - 398 * DAY) / 1000) },
      { apiname: 'c', achieved: 1, unlocktime: Math.floor((NOW - 380 * DAY) / 1000) },
      { apiname: 'd', achieved: 0, unlocktime: 0 },
    ] } });
  }
  if (u.pathname.includes('IStoreBrowseService/GetItems')) {
    const ids = JSON.parse(u.searchParams.get('input_json')).ids.map((x) => x.appid);
    return json({ response: { store_items: ids.map((appid) => ({ appid, id: appid, success: 1, assets: appid === 20
      ? { asset_url_format: `steam/apps/${appid}/\${FILENAME}?t=1`, library_capsule: 'abc123/library_600x900.jpg', header: 'abc123/header.jpg' }
      : { asset_url_format: `steam/apps/${appid}/\${FILENAME}?t=1`, library_capsule: 'library_600x900.jpg' } })) } });
  }
  if (u.host === 'store.steampowered.com') return json({ 10: { success: true, data: { release_date: { coming_soon: false, date: '1 Nov, 2000' } } } });
  // ---- PSN ----
  if (u.pathname.endsWith('/oauth/authorize')) return new Response(null, { status: 302, headers: { Location: 'com.scee.psxandroid.scecompcall://redirect/?code=v3.abc' } });
  if (u.pathname.endsWith('/oauth/token')) {
    const claims = Buffer.from(JSON.stringify({ sub: '1234567890' })).toString('base64url');
    return json({ access_token: `x.${claims}.y`, expires_in: 3600, refresh_token: 'r', refresh_token_expires_in: 5184000 });
  }
  if (u.pathname.includes('/gamelist/v2/users/me/titles')) return json({ titles: state.psnTitles, nextOffset: null, totalItemCount: state.psnTitles.length });
  if (u.pathname.endsWith('/trophy/v1/users/me/titles/trophyTitles')) {
    return json({ titles: u.searchParams.get('npTitleIds').split(',').map((id) => ({ npTitleId: id, trophyTitles: [{ npCommunicationId: 'NPWR1_00', npServiceName: 'trophy2' }] })) });
  }
  if (u.pathname.includes('/npCommunicationIds/NPWR1_00/trophyGroups/all/trophies')) {
    state.calls.push(`svc=${u.searchParams.get('npServiceName')}`);
    return json({ trophies: [{ earned: true, earnedDateTime: new Date(NOW - 150 * DAY).toISOString() }, { earned: true, earnedDateTime: new Date(NOW - 100 * DAY).toISOString() }, { earned: false }] });
  }
  if (u.pathname.includes('basicPresences')) return json({ basicPresence: { availability: 'availableToPlay', gameTitleInfoList: [] } });
  // ---- Xbox (OpenXBL) ----
  if (u.pathname === '/api/v2/player/titleHistory') return json({ xuid: '2533', titles: [{ titleId: '111', name: 'Forza Horizon 5', titleHistory: { lastTimePlayed: new Date(NOW - 3 * DAY).toISOString() }, devices: ['XboxSeries'] }, { titleId: '750323071', name: 'Home' }] });
  if (u.pathname.startsWith('/api/v2/achievements/stats/')) {
    const id = u.pathname.split('/').pop();
    return json({ statlistscollection: [{ stats: [{ name: 'MinutesPlayed', value: String(state.xboxMinutes[id] ?? 0) }] }] });
  }
  if (u.pathname.startsWith('/api/v2/achievements/player/')) return json({ achievements: [{ progressState: 'Achieved', progression: { timeUnlocked: new Date(NOW - 50 * DAY).toISOString() } }, { progressState: 'NotStarted', progression: { timeUnlocked: '0001-01-01T00:00:00.0000000Z' } }] });
  if (u.pathname === '/api/v2/dvr/screenshots') return json({ values: [{ titleId: 111, captureDate: new Date(NOW - 40 * DAY).toISOString() }, { titleId: 999, captureDate: new Date(NOW - 10 * DAY).toISOString() }] });
  if (u.pathname === '/api/v2/dvr/gameclips') return json({ values: [] });
  if (u.pathname === '/api/v2/presence') return json([{ xuid: '2533', state: 'Online', devices: [{ type: 'Scarlett', titles: [{ id: '750323071', name: 'Home', placement: 'Background', state: 'Active' }, { id: '111', name: 'Forza Horizon 5', placement: 'Full', state: 'Active' }] }] }]);
  return json({ error: `unmocked ${url}` }, 404);
}

let app; let base;
const quiet = { info() {}, warn() {}, error() {} };
before(async () => {
  globalThis.fetch = mockFetch;
  app = createApp({ dbFile: ':memory:', password: '', log: quiet, scheduler: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
});
after(() => { app.close(); globalThis.fetch = realFetch; });

const call = async (path, { method = 'GET', body } = {}) => {
  const res = await realFetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};

test('steam: initial import dates history, enrichment adds achievement anchors, presence pins next session', async () => {
  const acc = await call('/accounts', { method: 'POST', body: { platform: 'steam', name: 'S', config: { api_key: 'k', steam_id: '76561197960287930' }, sync: false } });
  const r = await call(`/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
  assert.equal(r.initial, true);
  assert.equal(r.sessions_created, 0);
  assert.equal(r.history_minutes, 3000);
  assert.equal(r.estimated_minutes, 3000);
  const s = app.app.sync;
  // enrichment: achievements + release date
  await s.enrich(acc.id); // joins the background run started by the sync
  const g = (await call('/games?q=Counter')).items[0];
  const detail = await call(`/games/${g.id}`);
  const hist = detail.entries[0].history;
  assert.equal(hist.evidence.anchors, 3);
  assert.ok(hist.evidence.release_at > 0);
  assert.ok(['medium', 'high'].includes(hist.confidence), `confidence ${hist.confidence}`);
  const account = s.account(acc.id);
  assert.ok(account.state.account_created_at > 0, 'account creation date stored');

  // presence: playing now -> span; stop -> span closes and a sync is scheduled
  state.steamGameId = '10';
  await s.pollPresence(s.account(acc.id));
  assert.equal(s.nowPlaying().length, 1);
  // simulate an hour of play
  app.app.db.prepare('UPDATE presence SET started_at = started_at - 3600000').run();
  state.steamGameId = null;
  s.presenceState.get(acc.id).lastPoll = 0;
  await s.pollPresence(s.account(acc.id));
  assert.equal(s.nowPlaying().length, 0);
  assert.ok(s.soon.get(acc.id) > Date.now(), 'sync scheduled after the session ended');

  // the next sync sees +55 min -> exact session from the presence span, on the Steam Deck
  state.steamPlaytime[10] = 3055;
  app.app.db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(Date.now() - 3 * 3600_000, acc.id);
  app.app.db.prepare('UPDATE entries SET last_synced_at = ? WHERE account_id = ?').run(Date.now() - 3 * 3600_000, acc.id);
  const r2 = await call(`/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
  assert.equal(r2.sessions_created, 1);
  assert.equal(r2.exact_sessions, 1);
  const sess = (await call('/sessions?limit=5')).items[0];
  assert.equal(sess.confidence, 'exact');
  assert.equal(sess.minutes, 55);
  assert.ok(sess.precise);
  const usage = (await call('/system')).accounts.find((a) => a.id === acc.id).api_usage_24h;
  assert.ok(usage.calls >= 5);
});

test('steam: covers stored under hashed store paths are found, classic ones left alone', async () => {
  const acc = (await call('/accounts')).find((a) => a.platform === 'steam');
  // runs in the background after each sync; run it directly too (no-op if already done)
  await app.app.sync.resolveCovers(acc.id);
  const tfc = (await call('/games?q=Team%20Fortress')).items[0];
  assert.equal(tfc.cover_url, 'https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/20/abc123/library_600x900.jpg?t=1');
  const cs = (await call('/games?q=Counter')).items[0];
  assert.match(cs.cover_url, /\/steam\/apps\/10\/library_600x900\.jpg$/);
  // checked once; later syncs keep the resolved cover
  assert.deepEqual((await app.app.sync.resolveCovers(acc.id)), { updated: 0 });
  await call(`/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
  assert.match((await call('/games?q=Team%20Fortress')).items[0].cover_url, /abc123/);
});

test('psn: first/last played + play count give high-confidence history; play count splits deltas', async () => {
  state.psnTitles = [{ titleId: 'PPSA01411_00', name: "Marvel's Spider-Man 2", playDuration: 'PT40H', firstPlayedDateTime: new Date(NOW - 200 * DAY).toISOString(), lastPlayedDateTime: new Date(NOW - 20 * DAY).toISOString(), playCount: 30, category: 'ps5_native_game', concept: { id: 1 } }];
  const acc = await call('/accounts', { method: 'POST', body: { platform: 'psn', name: 'P', config: { npsso: 'abc' }, sync: false } });
  const r = await call(`/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
  assert.equal(r.history_minutes, 2400);
  const g = (await call('/games?q=Spider')).items[0];
  const h = (await call(`/games/${g.id}`)).entries[0].history;
  assert.equal(h.confidence, 'high');
  assert.ok(h.window[0] >= NOW - 201 * DAY && h.window[1] <= NOW - 19 * DAY, 'inside first..last played');
  // later: +3 launches, +3h -> 3 sessions, last one pinned
  state.psnTitles[0] = { ...state.psnTitles[0], playDuration: 'PT43H', playCount: 33, lastPlayedDateTime: new Date().toISOString() };
  app.app.db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(NOW - 2 * DAY, acc.id);
  app.app.db.prepare('UPDATE entries SET last_synced_at = ? WHERE account_id = ?').run(NOW - 2 * DAY, acc.id);
  const r2 = await call(`/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
  assert.equal(r2.sessions_created, 3);
  assert.equal(r2.minutes_added, 180);
  const acct = (await call('/accounts')).find((a) => a.id === acc.id);
  assert.equal(app.app.sync.account(acc.id).state.account_id, '1234567890');
  assert.ok(acct.presence?.enabled);
  // trophy earned times become anchors (PS5 set read as trophy2)
  const en = await app.app.sync.enrich(acc.id);
  assert.equal(en.anchored, 1);
  assert.ok(state.calls.includes('svc=trophy2'));
  assert.equal((await call(`/games/${g.id}`)).entries[0].history.evidence.anchors, 2);
});

test('xbox: home title skipped, minutes from stats, presence parsed, achievements anchor history', async () => {
  const acc = await call('/accounts', { method: 'POST', body: { platform: 'xbox', name: 'X', config: { api_key: 'k' }, sync: false } });
  const r = await call(`/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
  assert.equal(r.games_seen, 1);
  assert.equal(r.history_minutes, 900);
  const s = app.app.sync;
  await s.pollPresence(s.account(acc.id));
  assert.ok(s.nowPlaying().some((p) => p.ext_id === '111'));
  await s.enrich(acc.id);
  const g = (await call('/games?q=Forza')).items[0];
  // one achievement + one screenshot of this title (the other capture is another game)
  assert.equal((await call(`/games/${g.id}`)).entries[0].history.evidence.anchors, 2);
});

test('xbox: testing credentials only samples; deferred titles are back-filled hourly', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ titleId: String(5000 + i), name: `Game ${i}`, type: 'Game', titleHistory: { lastTimePlayed: new Date(NOW - (i + 1) * DAY).toISOString() } }));
  const prev = globalThis.fetch;
  globalThis.fetch = (url, o) => (new URL(url).pathname === '/api/v2/player/titleHistory' ? Promise.resolve(json({ xuid: '2533', titles: many })) : mockFetch(url, o));
  try {
    const before_ = state.calls.length;
    const t = await call('/accounts/test', { method: 'POST', body: { platform: 'xbox', config: { api_key: 'k' } } });
    const stats = state.calls.slice(before_).filter((c) => c.includes('/achievements/stats/')).length;
    assert.ok(stats <= 3, `test spent ${stats} stat calls`);
    assert.match(t.warning, /Sampled a few of 40 titles/);
    // a real sync with a tiny hourly limit defers most titles and schedules a back-fill within the hour
    const acc = await call('/accounts', { method: 'POST', body: { platform: 'xbox', name: 'X2', config: { api_key: 'k', hourly_limit: '20' }, sync: false } });
    await call(`/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
    const a = app.app.sync.account(acc.id);
    assert.ok(a.state.deferred_titles.length > 20, `${a.state.deferred_titles.length} deferred`);
    const next = app.app.sync.computeNext(a);
    assert.ok(next - a.last_sync_at <= 65 * 60_000, 'back-fill within the hour, not at the daily sync');
  } finally { globalThis.fetch = prev; }
});

test('xbox: quota headers cap the budget; a 429 pauses the account until the reset instead of retrying', async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 1800;
  let statCalls = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    const u = new URL(url);
    const h = { 'X-RateLimit-Limit': '150', 'X-RateLimit-Reset': String(resetAt) };
    if (u.pathname === '/api/v2/player/titleHistory') {
      return json({ xuid: '2533', titles: Array.from({ length: 30 }, (_, i) => ({ titleId: String(7000 + i), name: `Q ${i}`, type: 'Game', titleHistory: { lastTimePlayed: new Date(NOW - DAY).toISOString() } })) }, 200, { ...h, 'X-RateLimit-Remaining': '30' });
    }
    if (u.pathname.startsWith('/api/v2/achievements/stats/')) {
      statCalls++;
      if (statCalls > 2) return json({ error: 'limit' }, 429, { ...h, 'X-RateLimit-Remaining': '0' });
      return json({ statlistscollection: [{ stats: [{ name: 'MinutesPlayed', value: '60' }] }] }, 200, { ...h, 'X-RateLimit-Remaining': String(30 - statCalls) });
    }
    return mockFetch(url, o);
  };
  try {
    const acc = await call('/accounts', { method: 'POST', body: { platform: 'xbox', name: 'Q', config: { api_key: 'k2' }, sync: false } });
    await call(`/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
    // the API said 30 left (not our own 150): 30 minus the 15% reserve = 7 at most; the 429 on
    // the third call stops it without retrying
    assert.equal(statCalls, 3);
    const s = app.app.sync;
    assert.ok(Math.abs(s.blockedUntil(acc.id) - resetAt * 1000) < 10_000, 'paused until the reported reset');
    assert.ok(s.computeNext(s.account(acc.id)) >= resetAt * 1000 - 1000, 'next sync waits for the reset');
    const sys = (await call('/accounts')).find((a) => a.id === acc.id);
    assert.equal(sys.api_quota.remaining, 0);
  } finally { globalThis.fetch = prev; }
});

test('xbox: OpenXBL-style 429 (reset in the body, no reset header) pauses until that reset', async () => {
  const resetAt = new Date(Date.now() + 786_000);
  resetAt.setMilliseconds(0);
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.host === 'xbl.io') {
      return json({ code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded.', limit: 150, spent: 150, resetAt: resetAt.toISOString(), retryAfter: 786 }, 429,
        { 'x-ratelimit-limit': '150', 'x-ratelimit-remaining': '0', 'x-ratelimit-spent': '150' });
    }
    return mockFetch(url, o);
  };
  try {
    const acc = await call('/accounts', { method: 'POST', body: { platform: 'xbox', name: 'Q2', config: { api_key: 'k3' }, sync: false } });
    const r = await realFetch(`${base}/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
    assert.equal(r.status, 429, await r.clone().text());
    const s = app.app.sync;
    const until = s.blockedUntil(acc.id);
    assert.ok(Math.abs(until - resetAt.getTime()) < 10_000, `paused until ${new Date(until).toISOString()}, reset ${resetAt.toISOString()}`);
    const a = s.account(acc.id);
    assert.equal(a.last_status, 'warning');
    assert.ok(s.computeNext(a) >= resetAt.getTime());
  } finally { globalThis.fetch = prev; }
});

test('xbox PC titles without a playtime stat: sessions from presence, safe fallbacks, no double counting', async () => {
  const xs = { last: NOW - 30 * DAY, minutes: null };
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    const u = new URL(url);
    if (u.pathname === '/api/v2/player/titleHistory') return json({ xuid: '2533', titles: [{ titleId: '8001', name: 'PC Game', type: 'Game', titleHistory: { lastTimePlayed: new Date(xs.last).toISOString() } }] });
    if (u.pathname === '/api/v2/achievements/stats/8001') return json({ groups: [], statlistscollection: [{ stats: xs.minutes == null ? [] : [{ name: 'MinutesPlayed', value: String(xs.minutes) }] }] });
    return mockFetch(url, o);
  };
  const db = app.app.db;
  const s = app.app.sync;
  const sum = (id) => db.prepare('SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ?').get(id).m;
  try {
    const acc = await call('/accounts', { method: 'POST', body: { platform: 'xbox', name: 'PC', config: { api_key: 'k4', presence: 'off' }, sync: false } });
    await call(`/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
    assert.equal(s.account(acc.id).state.unmetered['8001'], 1, 'marked as reporting no playtime');
    const entry = () => db.prepare("SELECT * FROM entries WHERE account_id = ? AND ext_id = '8001'").get(acc.id);

    // 1) presence sees a 40-minute session -> one exact session, total follows
    const t0 = Date.now() - 2 * 3600_000;
    s.applyPresence(s.account(acc.id), [{ extId: '8001', title: 'PC Game' }], { intervalSec: 300, now: t0 });
    s.applyPresence(s.account(acc.id), [{ extId: '8001', title: 'PC Game' }], { intervalSec: 300, now: t0 + 40 * 60_000 });
    s.applyPresence(s.account(acc.id), [], { intervalSec: 300, now: t0 + 45 * 60_000 });
    const live = db.prepare("SELECT * FROM sessions WHERE entry_id = ? AND kind = 'play'").all(entry().id);
    assert.equal(live.length, 1);
    assert.equal(live[0].confidence, 'exact');
    assert.ok(live[0].minutes >= 40 && live[0].minutes <= 45, `${live[0].minutes} min`);
    assert.equal(entry().playtime_min, live[0].minutes);

    // 2) the next sync reports no playtime again: the total is kept, nothing added
    xs.last = t0 + 44 * 60_000;
    await call(`/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
    assert.equal(entry().playtime_min, live[0].minutes);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE entry_id = ? AND kind = 'play'").get(entry().id).n, 1, 'covered by presence: no fallback');

    // 3) played while presence was down: one fallback session ending at the new last-played time
    xs.last = Date.now() - 10 * 60_000;
    await call(`/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
    const fb = db.prepare("SELECT * FROM sessions WHERE entry_id = ? AND kind = 'play' AND confidence = 'pinned'").all(entry().id);
    assert.equal(fb.length, 1);
    assert.equal(fb[0].ended_at, xs.last);
    assert.match(fb[0].note, /Length estimated/);
    assert.equal(sum(entry().id), entry().playtime_min);
    // the same last-played time again never adds another one
    await call(`/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE entry_id = ? AND kind = 'play'").get(entry().id).n, 2);

    // 4) the platform starts reporting a real total (weekly recheck): what presence recorded is
    //    part of it, the rest is history - nothing counted twice, no fake session today
    const tracked = entry().playtime_min;
    xs.minutes = 600;
    db.prepare('UPDATE accounts SET state = json_set(state, \'$.zero_checked\', json(\'{}\')) WHERE id = ?').run(acc.id);
    xs.last = Date.now() - 60_000;
    await call(`/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
    assert.equal(entry().playtime_min, 600);
    assert.equal(sum(entry().id), 600);
    assert.equal(db.prepare("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ? AND kind = 'play'").get(entry().id).m, tracked, 'tracked play unchanged');
    assert.equal(s.account(acc.id).state.unmetered['8001'], undefined);
  } finally { globalThis.fetch = prev; }
});

test('test endpoint reports data quality without saving', async () => {
  const r = await call('/accounts/test', { method: 'POST', body: { platform: 'steam', config: { api_key: 'k', steam_id: '76561197960287930' } } });
  assert.equal(r.ok, true);
  assert.equal(r.games, 2);
  assert.equal(r.with_dates, 1);
  assert.match(r.presence, /^ok/);
  assert.ok(r.account_created_at > 0);
});

test('provider failures are recorded with context', async () => {
  const acc = await call('/accounts', { method: 'POST', body: { platform: 'steam', name: 'Broken', config: { api_key: 'k', steam_id: 'not-a-real-vanity' }, sync: false } });
  globalThis.fetch = (url, o) => (String(url).includes('ResolveVanityURL') ? Promise.resolve(json({ response: { success: 42 } })) : mockFetch(url, o));
  const r = await realFetch(`${base}/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
  globalThis.fetch = mockFetch;
  assert.equal(r.status, 502);
  const syncs = await call(`/syncs?account_id=${acc.id}`);
  assert.equal(syncs[0].status, 'error');
  assert.match(syncs[0].error, /vanity/);
  const a = (await call('/accounts')).find((x) => x.id === acc.id);
  assert.equal(a.last_status, 'error');
});

test('presence: Xbox app shells are not games; Steam reports its persona state', async () => {
  const xbox = providers.xbox;
  const reply = { content: { xuid: '2533', state: 'Online', devices: [{ type: 'WindowsOneCore', titles: [
    { id: '1810111157', name: 'Gears of War: E-Day', placement: 'Full', state: 'Active' },
    { id: '704208617', name: 'Online', placement: 'Full', state: 'Active' }, // the Xbox app on Windows
    { id: '999', name: 'Online', placement: 'Full', state: 'Active' }, // another shell by its presence word
  ] }] }, code: 200 };
  const library = new Set(['1810111157']);
  const r = await xbox.presence({ config: { api_key: 'k' }, state: { xuid: '2533' } }, { http: async () => reply, remainingBudget: () => 100, getEntry: (id) => library.has(id) || null });
  assert.deepEqual(r.playing.map((p) => p.extId), ['1810111157']);
  assert.deepEqual(r.seen.filter((x) => x.skipped).map((x) => x.id), ['704208617', '999']);
  // a game in the library keeps its name, whatever it is
  library.add('999');
  assert.ok((await xbox.presence({ config: { api_key: 'k' }, state: { xuid: '2533' } }, { http: async () => reply, remainingBudget: () => 100, getEntry: (id) => library.has(id) || null })).playing.some((p) => p.extId === '999'));

  const steam = providers.steam;
  const summary = (p) => ({ async summary() { return { communityvisibilitystate: 3, ...p }; } });
  const away = await steam.presence.call({ ...steam, ...summary({ personastate: 3 }) }, { state: { steamid64: '1' } }, {});
  assert.equal(away.online, 'Away');
  assert.deepEqual(away.playing, []);
  const playing = await steam.presence.call({ ...steam, ...summary({ personastate: 1, gameid: '620', gameextrainfo: 'Portal 2' }) }, { state: { steamid64: '1' } }, {});
  assert.equal(playing.online, 'Online');
  assert.deepEqual(playing.seen, [{ id: '620', name: 'Portal 2' }]);
});

test('the sync after a session waits while a game is still being played, then runs once it ends', async () => {
  const s = app.app.sync;
  const acc = await call('/accounts', { method: 'POST', body: { platform: 'xbox', name: 'Waits', config: { api_key: 'k5', presence: 'off' }, sync: false } });
  const a = () => s.account(acc.id);
  app.app.db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(Date.now(), acc.id); // next scheduled run: tomorrow
  const MIN = 60_000; const t0 = Date.now() - 50 * MIN;
  const play = (now, on) => s.applyPresence(a(), on ? [{ extId: '1810111157', title: 'Gears of War: E-Day' }] : [], { intervalSec: 300, now });
  // played, dropped out of presence for 10 minutes, then picked up again
  play(t0, true); play(t0 + 20 * MIN, true); play(t0 + 25 * MIN, false);
  const armed = s.soon.get(acc.id);
  assert.ok(armed > t0 + 25 * MIN, 'a sync is armed when the game drops out');
  play(t0 + 35 * MIN, true); play(Date.now(), true);
  assert.equal(s.soonFor(a()), null, 'it waits while the game is played again');
  assert.ok(s.computeNext(a()) > Date.now() + 60 * MIN, 'the next sync is the scheduled one');
  play(Date.now() + 1, false);
  assert.ok(s.soonFor(a()) > Date.now(), 'armed again when the game ends');
  assert.equal(s.computeNext(a()), s.soonFor(a()));
  // a game presence no longer sees (polling stopped) never holds the sync back
  s.soon.set(acc.id, Date.now() - 1000);
  app.app.db.prepare('UPDATE presence SET ended_at = NULL, last_seen_at = ? WHERE account_id = ?').run(Date.now() - 60 * MIN, acc.id);
  assert.ok(s.soonFor(a()) <= Date.now());
  await call(`/accounts/${acc.id}`, { method: 'DELETE' });
});

test('a game played on Steam that also shows up in Xbox presence is counted once', async () => {
  const db = app.app.db; const s = app.app.sync;
  const M = 60_000; const t0 = Date.now() - 6 * 3600_000;
  const steam = await call('/accounts', { method: 'POST', body: { platform: 'steam', name: 'S2', config: { api_key: 'k7', steam_id: '76561190000000077', presence: 'off' }, sync: false } });
  const xbox = await call('/accounts', { method: 'POST', body: { platform: 'xbox', name: 'X2', config: { api_key: 'k8', presence: 'off' }, sync: false } });
  const game = await call('/games', { method: 'POST', body: { title: 'Tape to Tape', merge: false } });
  const entry = (acc, ext) => Number(db.prepare('INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at) VALUES (?, ?, ?, ?, ?, 0, ?)').run(acc.id, game.id, acc.id === steam.id ? 'steam' : 'xbox', ext, 'Tape to Tape', t0 - 86400_000).lastInsertRowid);
  const se = entry(steam, '2286390'); const xe = entry(xbox, '1619912274');
  db.prepare('UPDATE accounts SET state = ? WHERE id = ?').run(JSON.stringify({ unmetered: { 1619912274: 1 } }), xbox.id);
  const steamPlay = (start, minutes) => {
    db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, confidence, created_at) VALUES (?, 'sync', 'play', ?, ?, ?, ?, ?, 'exact', ?)").run(se, minutes, start, start + minutes * M, start, start + minutes * M, Date.now());
    db.prepare('UPDATE entries SET playtime_min = playtime_min + ? WHERE id = ?').run(minutes, se);
  };
  const xboxSpan = (start, minutes) => db.prepare('INSERT INTO presence(account_id, ext_id, title, started_at, last_seen_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)').run(xbox.id, '1619912274', 'Tape to Tape', start, start + minutes * M, start + minutes * M);
  const xboxMinutes = () => db.prepare('SELECT playtime_min m FROM entries WHERE id = ?').get(xe).m;

  // Steam recorded the session first: Xbox presence of the same play adds nothing
  steamPlay(t0, 14); xboxSpan(t0 + M, 13);
  s.presenceSessions(xbox.id, { now: Date.now() });
  assert.equal(xboxMinutes(), 0);
  // Xbox presence first (an older version recorded it): the repair removes it once Steam counts it
  xboxSpan(t0 + 2 * 3600_000, 14);
  s.presenceSessions(xbox.id, { now: Date.now() });
  assert.equal(xboxMinutes(), 14, 'no Steam session yet: presence is all we know');
  steamPlay(t0 + 2 * 3600_000, 14);
  assert.equal((await import('../src/services/sync.js')).dropDoubledPresence(db), 1);
  assert.equal(xboxMinutes(), 0);
  // a different time is different play: kept
  xboxSpan(t0 + 4 * 3600_000, 20);
  s.presenceSessions(xbox.id, { now: Date.now() });
  assert.equal(xboxMinutes(), 20);
  const bad = db.prepare('SELECT e.id FROM entries e LEFT JOIN sessions x ON x.entry_id = e.id WHERE e.id IN (?, ?) GROUP BY e.id HAVING COALESCE(SUM(x.minutes), 0) != e.playtime_min').all(se, xe);
  assert.deepEqual(bad, []);
  for (const a of [steam, xbox]) await call(`/accounts/${a.id}`, { method: 'DELETE' });
});
