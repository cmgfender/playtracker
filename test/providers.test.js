import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

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
  app = createApp({ dbFile: ':memory:', log: quiet, scheduler: false });
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
