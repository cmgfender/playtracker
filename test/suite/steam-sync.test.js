// Steam sync, end to end, against a mocked Steam Web API (test/suite/helpers/steam-sync-harness.js).
//
// Expectations come from README.md, docs/PLATFORMS.md and the API route summaries - not from the
// implementation. Everything runs in America/New_York so daily buckets and 04:00 schedule slots
// cross a real daylight-saving change (Sun Nov 1 2026, 02:00 EDT -> 01:00 EST).
import './helpers/steam-sync-tz.js';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  clock, installFetch, restoreFetch, useExternal, FakeSteam, SteamWorld, generateSessions, startApp, expect200,
  local, startOfDay, dayKey, unix, realSleep, MIN, HOUR, DAY, KEY, STEAMID, VANITY,
  violations, impossibleSessions, mulberry32, minutesByDay,
} from './helpers/steam-sync-harness.js';

const T0 = local(2026, 10, 24, 15, 0); // Saturday, 3 pm EDT: the account gets linked
const CREATED = local(2012, 5, 1, 12); // Steam account creation (GetPlayerSummaries.timecreated)
const HADES = 1145360; const ELDEN = 1245620; const CELESTE = 504230; const PORTAL2 = 620; const PORTAL = 400;
const LIBRARY_TOTAL = 6000 + 12000 + 750 + 0 + 300;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const steamDate = (t) => { const d = new Date(t); return `${d.getDate()} ${MON[d.getMonth()]}, ${d.getFullYear()}`; };

before(() => { clock.install(); installFetch(); });
after(() => { restoreFetch(); clock.restore(); });

/** A typical library: big totals, a 2-week counter, an old game, an unplayed game, a legacy game without timestamps. */
function standardLibrary(fake, at = T0) {
  fake.game(HADES, { name: 'Hades', playtime_forever: 6000, rtime_last_played: unix(at - 20 * DAY), playtime_windows_forever: 6000 });
  fake.game(ELDEN, { name: 'ELDEN RING', playtime_forever: 12000, playtime_2weeks: 400, rtime_last_played: unix(at - 2 * DAY), playtime_windows_forever: 12000 });
  fake.game(CELESTE, { name: 'Celeste', playtime_forever: 750, rtime_last_played: unix(at - 400 * DAY), playtime_linux_forever: 750 });
  fake.game(PORTAL2, { name: 'Portal 2', playtime_forever: 0, rtime_last_played: 0 });
  fake.game(PORTAL, { name: 'Portal', playtime_forever: 300, rtime_last_played: 0, playtime_windows_forever: 300 });
}

/** Fresh app + fake Steam (+ linked account unless link: false); always torn down. */
async function scenario(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  clock.freeze();
  clock.set(opts.at ?? T0);
  const fake = new FakeSteam(opts.fake);
  (opts.library ?? standardLibrary)(fake, opts.at ?? T0);
  useExternal(fake);
  const h = await startApp(opts);
  try {
    const acc = opts.link === false ? null : await h.link(opts.config, opts.extra);
    return await fn({ h, fake, api: h.api, acc, id: acc?.id });
  } finally {
    await h.close();
    useExternal(null);
    clock.freeze();
  }
}

async function syncAt(h, id, t) {
  if (t != null) clock.set(t);
  const r = await h.syncNow(id);
  assert.equal(r.status, 200, `sync failed: ${r.text}`);
  assert.deepEqual(violations(h.db), [], 'invariants after sync');
  return r.body;
}
const nextSync = async (h, id) => (await h.account(id)).next_sync_at;
const plays = (h, id, appid) => h.sessionsOf(h.entry(id, appid).id, 'play');
const kindSum = (h, entryId, kind) => h.sum('SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ? AND kind = ?', entryId, kind);
const gameOf = async (h, id, appid) => expect200(await h.api.get(`/games/${h.entry(id, appid).game_id}`), 'game');
const earliestEstimate = (h, entryId) => h.db.prepare("SELECT MIN(window_start) t FROM sessions WHERE entry_id = ? AND kind = 'estimate'").get(entryId).t;
async function waitFor(fn, ms = 5000, what = 'condition') {
  const t0 = performance.now();
  for (;;) {
    if (await fn()) return;
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await realSleep(20);
  }
}

// =====================================================================================
describe('linking a Steam account', () => {
  test('incomplete, unknown or malformed account definitions are rejected with 400 and nothing is created', () => scenario({ link: false }, async ({ api, fake }) => {
    let r = await api.post('/accounts', { platform: 'steam', config: {} });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /API key/i);
    assert.match(r.body.error, /SteamID64/i);
    r = await api.post('/accounts', { platform: 'steam', config: { api_key: '   ', steam_id: VANITY } });
    assert.equal(r.status, 400, 'a blank key is not a key');
    assert.match(r.body.error, /API key/i);
    r = await api.post('/accounts', { platform: 'steam', config: { api_key: KEY, steam_id: '' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /SteamID64/i);
    r = await api.post('/accounts', { platform: 'stean', config: { api_key: KEY, steam_id: VANITY } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Unknown platform/i);
    r = await api.post('/accounts', { platform: 'steam', config: { api_key: KEY, steam_id: VANITY }, schedule: { schedule_mode: 'sometimes' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /schedule_mode/);
    r = await api.post('/accounts', { platform: 'steam', config: { api_key: KEY, steam_id: VANITY }, schedule: { schedule_mode: 'daily', schedule_time: '25:00' } });
    assert.equal(r.status, 400);
    r = await api.raw('POST', '/api/v1/accounts', '{"platform": "steam", ', { 'content-type': 'application/json' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /JSON/i);
    assert.deepEqual(expect200(await api.get('/accounts')), []);
    assert.equal(fake.calls.length, 0, 'nothing was sent to Steam');
  }));

  test('linking by vanity name resolves the SteamID once, runs the initial import and shows the profile', () => scenario(async ({ h, fake, id }) => {
    const a = await h.account(id);
    assert.equal(a.last_status, 'ok', a.last_error);
    assert.equal(a.last_sync_at, T0);
    assert.equal(a.games, 5);
    assert.equal(a.minutes, LIBRARY_TOTAL);
    assert.equal(a.profile.name, 'Play Tester');
    assert.equal(a.profile.account_created_at, unix(CREATED) * 1000);
    const resolves = fake.calls.filter((c) => c.ep === 'resolve');
    assert.equal(resolves.length, 1);
    assert.equal(resolves[0].params.vanityurl, VANITY);
    assert.ok(fake.calls.filter((c) => c.ep === 'owned').every((c) => c.params.steamid === STEAMID), 'owned games are read for the resolved SteamID64');
    const syncs = expect200(await h.api.get(`/syncs?account_id=${id}`));
    assert.equal(syncs.length, 1);
    assert.equal(syncs[0].trigger, 'initial');
    assert.equal(syncs[0].initial, 1);
    assert.equal(syncs[0].status, 'ok');
    assert.equal(syncs[0].games_seen, 5);
    await syncAt(h, id, T0 + HOUR);
    await syncAt(h, id, T0 + 2 * HOUR);
    assert.equal(fake.count('resolve'), 1, 'the vanity name is not resolved again on later syncs');
    const metrics = await h.api.get('/metrics');
    assert.equal(metrics.status, 200);
    assert.match(metrics.text, new RegExp(`playtracker_account_last_sync_seconds\\{id="${id}",platform="steam",status="ok"\\} ${Math.floor((T0 + 2 * HOUR) / 1000)}`));
    assert.match(metrics.text, new RegExp(`playtracker_playtime_minutes\\{platform="steam"\\} ${LIBRARY_TOTAL}`));
    clock.set(T0 + 3 * HOUR);
    assert.equal(expect200(await h.api.post('/sync')).started, 1, '"sync all" starts the Steam account');
    await h.settle();
    assert.equal(expect200(await h.api.get(`/syncs?account_id=${id}`)).length, 4);
  }));

  test('a pasted profile URL works in both forms, and a bare SteamID64 needs no lookup', () => scenario({ link: false }, async ({ api, fake }) => {
    let r = await api.post('/accounts/test', { platform: 'steam', config: { api_key: KEY, steam_id: `https://steamcommunity.com/profiles/${STEAMID}/` } });
    assert.equal(expect200(r).games, 5);
    assert.equal(fake.count('resolve'), 0);
    r = await api.post('/accounts/test', { platform: 'steam', config: { api_key: KEY, steam_id: STEAMID } });
    assert.equal(expect200(r).games, 5);
    assert.equal(fake.count('resolve'), 0);
    r = await api.post('/accounts/test', { platform: 'steam', config: { api_key: KEY, steam_id: `https://steamcommunity.com/id/${VANITY}/?l=english` } });
    assert.equal(expect200(r).games, 5);
    assert.equal(fake.count('resolve'), 1);
    assert.equal(fake.calls.find((c) => c.ep === 'resolve').params.vanityurl, VANITY);
  }));

  test('testing credentials reports what would be imported (and live presence) without saving anything', () => scenario({ link: false }, async ({ api, fake }) => {
    fake.setPlaying(HADES, 'Hades');
    const r = expect200(await api.post('/accounts/test', { platform: 'steam', config: { api_key: KEY, steam_id: VANITY } }));
    assert.equal(r.ok, true);
    assert.equal(r.games, 5);
    assert.equal(r.played, 4);
    assert.equal(r.minutes, LIBRARY_TOTAL);
    assert.match(String(r.presence), /Hades/);
    assert.ok(r.sample.includes('Hades'));
    assert.equal(r.account_created_at, unix(CREATED) * 1000);
    const bad = await api.post('/accounts/test', { platform: 'steam', config: { api_key: 'WRONG-KEY', steam_id: VANITY } });
    assert.ok(bad.status >= 400, 'a rejected key is an error');
    assert.match(bad.body.error, /credentials|403/i);
    assert.deepEqual(expect200(await api.get('/accounts')), []);
    assert.equal(expect200(await api.get('/games')).total, 0);
    assert.equal(expect200(await api.get('/stats/lifetime')).total_minutes, 0);
  }));

  test('an unknown vanity name fails clearly and leaves no partial data', () => scenario({ config: { steam_id: 'nobody-here' } }, async ({ h, api, id }) => {
    const a = await h.account(id);
    assert.equal(a.last_status, 'error');
    assert.match(a.last_error, /Could not resolve/i);
    assert.match(a.last_error, /nobody-here/);
    assert.equal(a.last_sync_at, null, 'a failed attempt is not a sync');
    const syncs = expect200(await api.get(`/syncs?account_id=${id}`));
    assert.equal(syncs[0].status, 'error');
    assert.equal(expect200(await api.get('/games')).total, 0);
    const r = await h.syncNow(id);
    assert.equal(r.status, 502);
    assert.match(r.body.error, /Could not resolve/);
  }));

  test('a rejected API key is reported as a credentials problem; after fixing it the library is imported as history, not new play', () => scenario({ config: { api_key: 'WRONG-KEY' } }, async ({ h, api, id }) => {
    let a = await h.account(id);
    assert.equal(a.last_status, 'error');
    assert.match(a.last_error, /credentials/i);
    assert.equal(expect200(await api.get('/games')).total, 0);
    clock.advance(HOUR);
    const p = expect200(await api.patch(`/accounts/${id}`, { config: { api_key: KEY } }));
    assert.notEqual(p.config.api_key, KEY);
    const res = await syncAt(h, id);
    assert.equal(res.initial, true, 'the first successful sync is the initial import');
    assert.equal(res.sessions_created, 0);
    const life = expect200(await api.get('/stats/lifetime'));
    assert.equal(life.total_minutes, LIBRARY_TOTAL);
    assert.equal(life.tracked_minutes, 0);
    a = await h.account(id);
    assert.equal(a.last_status, 'ok');
  }));

  test('the API key is never exposed: masked in every response, absent from logs, and a masked value sent back keeps the real key', () => scenario(async ({ h, api, id, fake }) => {
    fake.play(HADES, { start: T0 + 3 * HOUR, minutes: 30 });
    await syncAt(h, id, T0 + 5 * HOUR);
    fake.failNext('owned', { status: 500, body: { error: 'boom' } }, { status: 500 }, { status: 500 });
    clock.advance(HOUR);
    await h.syncNow(id); // a failure, so error paths are in the logs too
    for (const path of ['/accounts', '/system', `/syncs?account_id=${id}`, '/summary', '/export', '/export?format=csv', '/logs', '/settings', '/platforms']) {
      const r = await api.get(path);
      assert.equal(r.status, 200, path);
      assert.ok(!r.text.includes(KEY), `${path} leaks the API key`);
    }
    assert.ok(!JSON.stringify(h.logs).includes(KEY), 'the console log leaks the API key');
    const masked = (await h.account(id)).config.api_key;
    assert.notEqual(masked, KEY);
    expect200(await api.patch(`/accounts/${id}`, { name: 'Renamed', config: { api_key: masked, steam_id: VANITY } }));
    clock.advance(HOUR);
    const r = await h.syncNow(id);
    assert.equal(r.status, 200, 'the stored key still works after the form was saved with its masked value');
  }));
});

// =====================================================================================
describe('initial import: existing playtime becomes dated history', () => {
  test('no play sessions, nothing counted for today or this week, totals exact', () => scenario(async ({ h, api, id }) => {
    const sync = expect200(await api.get(`/syncs?account_id=${id}`))[0];
    assert.equal(sync.sessions_created, 0);
    assert.equal(sync.minutes_added, 0);
    const sess = expect200(await api.get(`/sessions?account_id=${id}`));
    assert.equal(sess.total, 0, 'no tracked play is invented on import');
    const life = expect200(await api.get('/stats/lifetime'));
    assert.equal(life.total_minutes, LIBRARY_TOTAL);
    assert.equal(life.tracked_minutes, 0);
    assert.equal(life.sessions, 0);
    assert.equal(life.estimated_minutes + life.baseline_minutes, LIBRARY_TOTAL);
    const sum = expect200(await api.get('/summary'));
    assert.equal(sum.today.total_minutes, 0);
    assert.equal(sum.week.total_minutes, 0);
    assert.equal(sum.week.streaks.current, 0, 'history never makes a streak');
    const today = expect200(await api.get('/stats?range=1d&estimates=include'));
    assert.equal(today.total_minutes, 0, 'import day holds no history (every game was last played earlier)');
    for (const appid of [HADES, ELDEN, CELESTE, PORTAL]) {
      const g = await gameOf(h, id, appid);
      const total = { [HADES]: 6000, [ELDEN]: 12000, [CELESTE]: 750, [PORTAL]: 300 }[appid];
      assert.equal(g.minutes, total);
      assert.equal(g.summary.tracked_minutes, 0);
      assert.equal(g.summary.estimated_minutes + g.summary.baseline_minutes, total);
      assert.equal(g.entries[0].history.minutes, total);
    }
    assert.deepEqual(violations(h.db), []);
  }));

  test('dated history follows the evidence: never after last played or tracking start, never before the account existed, at most 12 h a day and 10 h per game', () => scenario(async ({ h, api, id }) => {
    const rows = h.db.prepare(`SELECT e.ext_id, e.last_played_at, MIN(s.window_start) first, MAX(s.window_end) last FROM sessions s JOIN entries e ON e.id = s.entry_id
      WHERE e.account_id = ? AND s.kind = 'estimate' GROUP BY e.id`).all(id);
    assert.ok(rows.length >= 3, 'Hades, ELDEN RING and Celeste get dated history');
    for (const r of rows) {
      assert.ok(r.last <= r.last_played_at, `${r.ext_id}: history runs past last played`);
      assert.ok(r.last <= T0, `${r.ext_id}: history runs past the start of tracking`);
      assert.ok(r.first >= startOfDay(CREATED), `${r.ext_id}: history starts before the Steam account existed`);
    }
    const gids = [HADES, ELDEN, CELESTE].map((a) => h.entry(id, a).game_id);
    for (let y = 2012; y <= 2026; y++) {
      const all = expect200(await api.get(`/stats/heatmap?year=${y}&estimates=only`));
      for (const [day, m] of Object.entries(all.days)) assert.ok(m <= 721, `${day}: ${m} min of history on one day`);
      for (const gid of gids) {
        const one = expect200(await api.get(`/stats/heatmap?year=${y}&game_id=${gid}&estimates=only`));
        for (const [day, m] of Object.entries(one.days)) assert.ok(m <= 601, `${day}: ${m} min of one game's history on one day`);
      }
    }
  }));

  test('time that cannot be dated stays undated history; unplayed games are listed with nothing', () => scenario(async ({ h, api, id }) => {
    const portal = await gameOf(h, id, PORTAL);
    assert.equal(portal.summary.baseline_minutes, 300, 'a legacy title with no timestamps is undated');
    assert.equal(portal.summary.estimated_minutes, 0);
    const heat = expect200(await api.get(`/stats/heatmap?year=2026&game_id=${portal.id}`));
    assert.deepEqual(heat.days, {}, 'undated history is never charted');
    const unplayed = expect200(await api.get('/games?played=false'));
    assert.deepEqual(unplayed.items.map((g) => g.title), ['Portal 2']);
    assert.equal(unplayed.items[0].minutes, 0);
    assert.equal(h.sessionsOf(h.entry(id, PORTAL2).id).length, 0);
  }));

  test("Steam's 2-week counter puts exactly that many minutes into the last 14 days, and nothing lands after last played", () => scenario(async ({ h, api, id }) => {
    const elden = h.entry(id, ELDEN).game_id;
    const in14 = expect200(await api.get(`/stats?range=14d&game_id=${elden}&estimates=only`)).estimated_minutes;
    const in15 = expect200(await api.get(`/stats?range=15d&game_id=${elden}&estimates=only`)).estimated_minutes;
    assert.ok(in14 <= 401, `${in14} min of ELDEN RING history in the last 14 days, counter says 400`);
    assert.ok(in15 >= 399, `only ${in15} min of ELDEN RING history in the last 14 days (+ boundary day), counter says 400`);
    const hades = h.entry(id, HADES).game_id;
    assert.equal(expect200(await api.get(`/stats?range=19d&game_id=${hades}&estimates=only`)).estimated_minutes, 0, 'Hades was last played 20 days ago');
  }));

  const bigLibrary = (fake) => {
    for (let i = 0; i < 40; i++) fake.game(3000000 + i, { name: `Big Game ${i}`, playtime_forever: 3000, playtime_2weeks: 60, rtime_last_played: unix(T0 - DAY + 5 * HOUR + i * MIN) });
  };
  test('a 40-game library is spread out instead of stacked: at most 10 h per game per day, none on import day, totals exact', () => scenario({ library: bigLibrary }, async ({ h, api }) => {
    const life = expect200(await api.get('/stats/lifetime'));
    assert.equal(life.total_minutes, 40 * 3000);
    assert.equal(life.tracked_minutes, 0);
    const perGame = h.db.prepare('SELECT game_id, day, SUM(minutes) m FROM play_days WHERE estimated = 1 GROUP BY game_id, day HAVING m > 601').all();
    assert.deepEqual(perGame, [], 'no game gets more than 10 h of history on one day');
    assert.equal(expect200(await api.get('/stats?range=1d')).total_minutes, 0);
    const recent = expect200(await api.get('/stats?range=15d&estimates=only')).estimated_minutes;
    assert.ok(recent >= 40 * 60 - 1, `the 2-week counters (${40 * 60} min) belong to the last 14 days, got ${recent}`);
    assert.deepEqual(violations(h.db), []);
  }));

  test('…and all games together never get more than 12 h of history on one day',
    { todo: 'APP BUG steam-sync-6: multi-day history chunks are evened out after the shared daily budget was applied, pushing days past 720 min' },
    () => scenario({ library: bigLibrary }, async ({ api }) => {
      const over = [];
      for (const y of [2023, 2024, 2025, 2026]) {
        const heat = expect200(await api.get(`/stats/heatmap?year=${y}&estimates=only`));
        for (const [day, m] of Object.entries(heat.days)) if (m > 721) over.push(`${day}: ${m}`);
      }
      assert.deepEqual(over, [], 'days with more than 12 h of estimated history');
    }));

  test('odd values from Steam are handled without losing or inventing minutes', () => scenario({
    library: (fake) => {
      const g = fake.game(9001, { playtime_forever: 120, rtime_last_played: unix(T0 - 5 * DAY) });
      delete g.name; // include_appinfo without a name
      fake.game(9002, { name: 'ドラゴンクエストXI　過ぎ去りし時を求めて S', playtime_forever: 300, rtime_last_played: unix(T0 - 3 * DAY) });
      fake.game(9003, { name: 'Negative', playtime_forever: -50, rtime_last_played: unix(T0 - 3 * DAY) });
      fake.game(9004, { name: 'Stringy', playtime_forever: '125', rtime_last_played: unix(T0 - 4 * DAY) });
      fake.game(9005, { name: 'Clock Skew', playtime_forever: 500, rtime_last_played: unix(T0 + 2 * DAY) });
      fake.game(9006, { name: 'Forever Game', playtime_forever: 10_000_000, playtime_2weeks: 900, rtime_last_played: unix(T0 - 3 * DAY) });
      fake.game(9007, { name: 'Nullish', playtime_forever: null, rtime_last_played: null });
    },
  }, async ({ h, api, id }) => {
    assert.equal((await h.account(id)).last_status, 'ok');
    assert.ok(h.entry(id, 9001).title.trim().length > 0, 'a game without a name still gets a title');
    assert.equal(h.entry(id, 9002).title, 'ドラゴンクエストXI　過ぎ去りし時を求めて S');
    assert.equal(h.entry(id, 9003).playtime_min, 0);
    assert.equal(h.sessionsOf(h.entry(id, 9003).id).length, 0);
    assert.equal(h.entry(id, 9004).playtime_min, 125);
    assert.equal(h.entry(id, 9006).playtime_min, 10_000_000);
    assert.equal(h.entry(id, 9007).playtime_min, 0);
    assert.equal(expect200(await api.get('/stats/lifetime')).total_minutes, 120 + 300 + 125 + 500 + 10_000_000);
    const skew = h.db.prepare("SELECT MAX(window_end) t FROM sessions WHERE entry_id = ? AND kind = 'estimate'").get(h.entry(id, 9005).id).t;
    assert.ok(skew == null || skew <= T0, 'a last-played time in the future never puts history after now');
    const huge = h.db.prepare('SELECT day, SUM(minutes) m FROM play_days WHERE estimated = 1 GROUP BY day HAVING m > 721').all();
    assert.deepEqual(huge, [], 'even 19 years of playtime is never stacked beyond 12 h a day');
    assert.deepEqual(violations(h.db), []);
  }));

  test('right after the import, history is never dated before the Steam account existed',
    () => scenario({
      library: (fake) => {
        fake.game(9010, { name: 'Long Ago', playtime_forever: 200_000, rtime_last_played: unix(local(2013, 1, 10, 12)) });
        fake.game(9006, { name: 'Forever Game', playtime_forever: 10_000_000, playtime_2weeks: 900, rtime_last_played: unix(T0 - 3 * DAY) });
      },
    }, async ({ h, id }) => {
      assert.equal((await h.account(id)).profile.account_created_at, unix(CREATED) * 1000, 'the creation date is known');
      for (const appid of [9010, 9006]) {
        const first = earliestEstimate(h, h.entry(id, appid).id);
        assert.ok(first >= startOfDay(CREATED), `${appid}: history starts ${new Date(first).toISOString()}, account created ${new Date(CREATED).toISOString()}`);
      }
    }));
});

// =====================================================================================
describe('later syncs: deltas become sessions', () => {
  test('a delta between two daily syncs is one session pinned to the launch time and tagged with the device', () => scenario(async ({ h, api, id, fake }) => {
    const L = local(2026, 10, 24, 20, 0);
    fake.play(HADES, { start: L, minutes: 90, device: 'deck' });
    const next = await nextSync(h, id);
    assert.equal(next, local(2026, 10, 25, 4, 0), 'default schedule: daily at 04:00');
    const res = await syncAt(h, id, next);
    assert.equal(res.initial, false);
    assert.equal(res.sessions_created, 1);
    assert.equal(res.minutes_added, 90);
    const [s] = plays(h, id, HADES);
    assert.equal(s.minutes, 90);
    assert.equal(s.started_at, L, "Steam's last-played time is the launch");
    assert.equal(s.ended_at, L + 90 * MIN);
    assert.equal(s.device, 'deck');
    assert.equal(s.source, 'sync');
    const list = expect200(await api.get(`/sessions?account_id=${id}`));
    assert.equal(list.total, 1);
    assert.equal(list.total_minutes, 90);
    assert.equal(list.items[0].precise, true);
    const heat = expect200(await api.get('/stats/heatmap?year=2026&estimates=exclude'));
    assert.deepEqual(heat.days, { '2026-10-24': 90 });
    const g = await gameOf(h, id, HADES);
    assert.equal(g.minutes, 6090);
    assert.equal(g.summary.tracked_minutes, 90);
    assert.equal(g.summary.sessions, 1);
    const snaps = expect200(await api.get(`/entries/${h.entry(id, HADES).id}/snapshots`));
    assert.equal(snaps[0].playtime_min, 6090);
    assert.equal(plays(h, id, ELDEN).length, 0, 'unchanged games get nothing');
    const sum = expect200(await api.get('/summary'));
    assert.equal(sum.recent_sessions[0].title, 'Hades');
  }));

  test('unchanged totals create nothing; deltas below the minimum session build up until they count', () => scenario(async ({ h, id, fake }) => {
    let res = await syncAt(h, id, local(2026, 10, 25, 4, 0));
    assert.equal(res.sessions_created, 0);
    assert.equal(res.minutes_added, 0);
    fake.play(HADES, { start: local(2026, 10, 25, 12, 0), minutes: 1 });
    res = await syncAt(h, id, local(2026, 10, 26, 4, 0));
    assert.equal(res.sessions_created, 0, 'a 1-minute delta is held back (minimum session is 2 min)');
    assert.equal(plays(h, id, HADES).length, 0);
    fake.play(HADES, { start: local(2026, 10, 26, 12, 0), minutes: 1 });
    res = await syncAt(h, id, local(2026, 10, 27, 4, 0));
    assert.equal(res.sessions_created, 1);
    const s = plays(h, id, HADES);
    assert.equal(s.length, 1);
    assert.equal(s[0].minutes, 2, 'the held-back minute is not lost');
    assert.equal(h.entry(id, HADES).playtime_min, 6002);
  }));

  test('a game bought and played between syncs is all new play; a bought-but-unplayed game appears with nothing', () => scenario(async ({ h, id, fake }) => {
    const L = local(2026, 10, 24, 21, 0);
    fake.game(2379780, { name: 'Balatro', playtime_forever: 0 });
    fake.play(2379780, { start: L, minutes: 150, device: 'deck' });
    fake.game(1086940, { name: "Baldur's Gate 3", playtime_forever: 0 });
    const res = await syncAt(h, id, local(2026, 10, 25, 4, 0));
    assert.equal(res.games_new, 2);
    const g = await gameOf(h, id, 2379780);
    assert.equal(g.summary.tracked_minutes, 150);
    assert.equal(g.summary.estimated_minutes, 0);
    assert.equal(g.summary.baseline_minutes, 0);
    assert.equal(plays(h, id, 2379780)[0].started_at, L);
    const bg3 = await gameOf(h, id, 1086940);
    assert.equal(bg3.minutes, 0);
    assert.equal(h.sessionsOf(h.entry(id, 1086940).id).length, 0);
  }));

  test("the first session of a newly bought game is tagged with the device it was played on",
    () => scenario(async ({ h, id, fake }) => {
      fake.game(2379780, { name: 'Balatro', playtime_forever: 0 });
      fake.play(2379780, { start: local(2026, 10, 24, 21, 0), minutes: 150, device: 'deck' });
      await syncAt(h, id, local(2026, 10, 25, 4, 0));
      assert.deepEqual(plays(h, id, 2379780).map((s) => s.device), ['deck']);
    }));

  test('a game that newly shows up but was last played before the previous sync is history, not new play', () => scenario(async ({ h, id, fake }) => {
    fake.game(105600, { name: 'Terraria', playtime_forever: 900, rtime_last_played: unix(T0 - 30 * DAY) });
    await syncAt(h, id, local(2026, 10, 25, 4, 0));
    const g = await gameOf(h, id, 105600);
    assert.equal(g.summary.tracked_minutes, 0);
    assert.equal(g.summary.estimated_minutes + g.summary.baseline_minutes, 900);
    const last = h.db.prepare("SELECT MAX(window_end) t FROM sessions WHERE entry_id = ? AND kind = 'estimate'").get(h.entry(id, 105600).id).t;
    assert.ok(last == null || last <= T0 - 30 * DAY + DAY, 'its history ends at its last-played day');
  }));

  test('a new game with more playtime than the window can hold: the 2-week counter decides what is new, the rest is history', () => scenario(async ({ h, id, fake }) => {
    fake.game(292030, { name: 'The Witcher 3', playtime_forever: 5000, playtime_2weeks: 200, rtime_last_played: unix(local(2026, 10, 24, 21, 0)) });
    await syncAt(h, id, local(2026, 10, 25, 4, 0));
    const g = await gameOf(h, id, 292030);
    assert.equal(g.minutes, 5000);
    assert.equal(g.summary.tracked_minutes, 200);
    assert.equal(g.summary.estimated_minutes + g.summary.baseline_minutes, 4800);
  }));

  test('a long session that began before the previous sync is placed where it ran, not squeezed into a short window',
    () => scenario({ extra: { schedule: { schedule_mode: 'hourly' } } }, async ({ h, id, fake }) => {
      const L = T0 + HOUR; // launched at 16:00, plays 11 h while hourly syncs see nothing (Steam writes on exit)
      fake.game(ELDEN, { rtime_last_played: unix(L) });
      for (let t = T0 + HOUR; t <= L + 11 * HOUR; t += HOUR) {
        if (t === L + 11 * HOUR) fake.play(ELDEN, { start: L, minutes: 660 });
        const res = await syncAt(h, id, t + MIN);
        if (t < L + 11 * HOUR) assert.equal(res.sessions_created, 0);
      }
      const s = plays(h, id, ELDEN);
      assert.equal(s.reduce((a, x) => a + x.minutes, 0), 660, 'all of it is tracked play');
      assert.deepEqual(impossibleSessions(h.db), [], 'no session holds more minutes than the time it is placed in');
      for (const x of s) assert.ok((x.started_at ?? x.window_start) >= L - MIN, 'nothing before the launch');
    }));

  test('a delta beyond elapsed time plus one maximum-length session is capped; the excess is undated history, never charted', () => scenario({ extra: { schedule: { schedule_mode: 'hourly' } } }, async ({ h, api, id, fake }) => {
    const Ts = T0 + HOUR;
    await syncAt(h, id, Ts);
    const g = fake.game(ELDEN);
    g.playtime_forever += 1000; g.playtime_windows_forever += 1000; g.playtime_2weeks += 1000; g.rtime_last_played = unix(Ts + 10 * MIN);
    await syncAt(h, id, Ts + HOUR);
    const e = h.entry(id, ELDEN);
    const tracked = kindSum(h, e.id, 'play');
    const undated = h.sum("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ? AND kind = 'baseline' AND source = 'sync'", e.id);
    assert.equal(e.playtime_min, 13000, 'the platform total stands');
    assert.equal(tracked + undated, 1000, 'nothing lost');
    assert.ok(tracked >= 60, 'at least the elapsed hour is play');
    assert.ok(tracked <= 60 + 12 * 60 + 15, `${tracked} min tracked in a 1-hour window`);
    assert.ok(undated > 0, 'the impossible part is filed as undated history');
    const stats = expect200(await api.get('/stats?range=all&estimates=include'));
    assert.equal(stats.tracked_minutes, tracked, 'undated minutes are never charted');
  }));

  test('offline play uploaded late (beyond the 2-week counter) becomes undated history; the session is flagged as including offline play', () => scenario(async ({ h, api, id, fake }) => {
    const L = local(2026, 10, 24, 19, 0);
    const g = fake.play(HADES, { start: L, minutes: 60, device: 'deck' }); // 60 min online this evening
    g.playtime_forever += 300; g.playtime_disconnected += 300; g.playtime_deck_forever += 300; // + 300 min played offline 25 days ago
    await syncAt(h, id, local(2026, 10, 25, 4, 0));
    const s = plays(h, id, HADES);
    assert.equal(s.reduce((a, x) => a + x.minutes, 0), 60, 'only the minutes inside the 2-week counter are dated into this window');
    assert.ok(s.every((x) => /offline/i.test(x.note || '')), 'the session is tagged "includes offline play"');
    const late = expect200(await api.get(`/sessions?kind=baseline&account_id=${id}&source=sync`));
    assert.equal(late.total_minutes, 300, 'the late upload is undated history');
    assert.equal(h.entry(id, HADES).playtime_min, 6360);
    assert.equal(expect200(await api.get('/stats?range=all&estimates=exclude')).tracked_minutes, 60);
  }));

  test('a monthly window is narrowed by the 2-week counter, large deltas are spread over the days (across DST), and old play stays before the counter', () => scenario({ extra: { schedule: { schedule_mode: 'monthly' } } }, async ({ h, id, fake }) => {
    const T1 = T0 + 30 * DAY;
    const hades = fake.game(HADES);
    hades.playtime_forever += 500; hades.playtime_windows_forever += 500; hades.playtime_2weeks = 500; hades.rtime_last_played = unix(T1 - 3 * DAY);
    const elden = fake.game(ELDEN);
    elden.playtime_forever += 500; elden.playtime_windows_forever += 500; delete elden.playtime_2weeks; elden.rtime_last_played = unix(T1 - 20 * DAY);
    await syncAt(h, id, T1);
    const hs = plays(h, id, HADES);
    assert.equal(hs.reduce((a, x) => a + x.minutes, 0), 500);
    assert.ok(hs.length > 1, '500 min over a month is spread, not one session');
    for (const x of hs) assert.ok((x.started_at ?? x.window_start) >= T1 - 14 * DAY - MIN, 'counter minutes are within the last 14 days');
    const es = plays(h, id, ELDEN);
    assert.equal(es.reduce((a, x) => a + x.minutes, 0), 500);
    for (const x of es) assert.ok((x.ended_at ?? x.window_end) <= T1 - 14 * DAY, 'with a zero counter none of it is in the last 14 days');
    const byDay = new Map();
    for (const x of es) minutesByDay(x.started_at ?? x.window_start, x.ended_at ?? x.window_end, x.minutes, byDay);
    const busiest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(busiest, dayKey(T1 - 20 * DAY), 'the spread is weighted toward the last activity');
  }));

  test('refunded or removed games are marked as no longer in the library without losing recorded play; a re-purchase is not counted twice', () => scenario(async ({ h, api, id, fake }) => {
    fake.game(999001, { name: 'Refund Me', playtime_forever: 0 });
    fake.play(999001, { start: local(2026, 10, 24, 20, 0), minutes: 40 });
    await syncAt(h, id, local(2026, 10, 25, 4, 0));
    const before = expect200(await api.get('/stats/lifetime')).total_minutes;
    fake.remove(999001);
    await syncAt(h, id, local(2026, 10, 26, 4, 0));
    let g = await gameOf(h, id, 999001);
    assert.equal(g.entries[0].missing_since, local(2026, 10, 26, 4, 0), 'marked "no longer in library"');
    assert.equal(g.summary.tracked_minutes, 40, 'the play that happened stays');
    assert.equal(expect200(await api.get('/stats/lifetime')).total_minutes, before);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM entries WHERE account_id = ? AND missing_since IS NOT NULL').get(id).n, 1, 'only the removed title is marked');
    fake.game(999001, { name: 'Refund Me', playtime_forever: 40, playtime_2weeks: 40, rtime_last_played: unix(local(2026, 10, 24, 20, 0)) });
    await syncAt(h, id, local(2026, 10, 27, 4, 0));
    g = await gameOf(h, id, 999001);
    assert.equal(g.entries[0].missing_since, null);
    assert.equal(g.summary.tracked_minutes, 40, 'coming back is not new play');
    fake.play(999001, { start: local(2026, 10, 27, 19, 0), minutes: 30 });
    await syncAt(h, id, local(2026, 10, 28, 4, 0));
    g = await gameOf(h, id, 999001);
    assert.equal(g.minutes, 70);
    assert.equal(g.summary.tracked_minutes, 70);
  }));

  test('a lower total from Steam creates no session and nothing negative', () => scenario(async ({ h, id, fake }) => {
    fake.game(HADES, { playtime_forever: 5900 });
    const res = await syncAt(h, id, local(2026, 10, 25, 4, 0));
    assert.equal(res.sessions_created, 0);
    assert.equal(plays(h, id, HADES).length, 0);
    fake.game(HADES, { playtime_forever: 6000 });
    await syncAt(h, id, local(2026, 10, 26, 4, 0));
    assert.equal(plays(h, id, HADES).length, 0, 'the same minutes coming back are not play');
  }));

  test('a lower platform total is ignored: the lifetime total keeps its high-water mark (README rule 6)',
    () => scenario(async ({ h, id, fake }) => {
      fake.game(HADES, { playtime_forever: 5900 });
      await syncAt(h, id, local(2026, 10, 25, 4, 0));
      assert.equal(h.entry(id, HADES).playtime_min, 6000);
      assert.equal(plays(h, id, HADES).length, 0);
    }));

  test('a game still running at sync time is counted once Steam writes it on exit, as one session at its launch time', () => scenario(async ({ h, id, fake }) => {
    const S = local(2026, 10, 25, 4, 0);
    const L = S - 40 * MIN;
    fake.game(HADES, { rtime_last_played: unix(L) }); // launched, still running: total not written yet
    let res = await syncAt(h, id, S);
    assert.equal(res.sessions_created, 0);
    fake.play(HADES, { start: L, minutes: 150 });
    res = await syncAt(h, id, local(2026, 10, 26, 4, 0));
    const s = plays(h, id, HADES);
    assert.equal(s.length, 1);
    assert.equal(s[0].minutes, 150);
    assert.equal(s[0].started_at, L);
  }));

  test('self-repair: a launch time used for an earlier delta is given to the session that really started then', () => scenario(async ({ h, id, fake }) => {
    // 22:00-23:00 played (60 min); at 01:00 launched again and still running at the 04:00 sync
    fake.play(HADES, { start: local(2026, 10, 24, 22, 0), minutes: 60 });
    const L = local(2026, 10, 25, 1, 0);
    fake.game(HADES, { rtime_last_played: unix(L) });
    await syncAt(h, id, local(2026, 10, 25, 4, 0));
    fake.play(HADES, { start: L, minutes: 240 }); // that session ends at 05:00
    await syncAt(h, id, local(2026, 10, 26, 4, 0));
    const s = plays(h, id, HADES);
    assert.equal(s.reduce((a, x) => a + x.minutes, 0), 300);
    const atLaunch = s.filter((x) => x.started_at === L);
    assert.equal(atLaunch.length, 1);
    assert.equal(atLaunch[0].minutes, 240, 'the launch belongs to the 240-minute session');
    const other = s.filter((x) => x !== atLaunch[0]);
    assert.ok(other.every((x) => (x.ended_at ?? x.window_end) <= L), 'the earlier delta is moved before the launch');
  }));

  test('one game at a time: a later launch of another game caps the earlier session', () => scenario(async ({ h, id, fake }) => {
    fake.play(HADES, { start: local(2026, 10, 25, 12, 0), minutes: 120 });
    fake.play(HADES, { start: local(2026, 10, 25, 18, 0), minutes: 60 });
    fake.play(ELDEN, { start: local(2026, 10, 25, 19, 0), minutes: 90 });
    await syncAt(h, id, local(2026, 10, 26, 4, 0));
    const e = plays(h, id, ELDEN);
    assert.equal(e.length, 1);
    assert.equal(e[0].started_at, local(2026, 10, 25, 19, 0));
    assert.equal(e[0].minutes, 90);
    const hs = plays(h, id, HADES);
    assert.equal(hs.reduce((a, x) => a + x.minutes, 0), 180);
    const at18 = hs.find((x) => x.started_at === local(2026, 10, 25, 18, 0));
    assert.ok(at18, 'a Hades session starts at its last launch');
    assert.ok(at18.ended_at <= local(2026, 10, 25, 19, 0), 'it ends before ELDEN RING was launched');
  }));

  test('pushing a new total for one Steam title through the API counts its delta once and never marks the rest of the library as removed', () => scenario(async ({ h, api, id, fake }) => {
    const e = h.entry(id, HADES);
    for (const bad of [{}, { playtime_minutes: -5 }, { playtime_minutes: 'lots' }]) assert.equal((await api.post(`/entries/${e.id}/playtime`, bad)).status, 400, JSON.stringify(bad));
    assert.equal((await api.post('/entries/999999/playtime', { playtime_minutes: 10 })).status, 404);
    const L = local(2026, 10, 24, 18, 0);
    clock.set(local(2026, 10, 24, 20, 0));
    const r = expect200(await api.post(`/entries/${e.id}/playtime`, { playtime_minutes: 6090, last_played_at: new Date(L).toISOString() }));
    assert.equal(r.minutes_added, 90);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM entries WHERE account_id = ? AND missing_since IS NOT NULL').get(id).n, 0, 'a partial report removes nothing');
    assert.deepEqual(violations(h.db), []);
    fake.play(HADES, { start: L, minutes: 90 }); // Steam reports the same play at the next sync
    await syncAt(h, id, local(2026, 10, 25, 4, 0));
    assert.equal(kindSum(h, e.id, 'play'), 90, 'not counted again by the sync');
    assert.equal(h.entry(id, HADES).playtime_min, 6090);
  }));

  test('a synced session can be dropped from stats (it becomes history) but its minutes cannot be edited, and the next sync does not bring it back', () => scenario(async ({ h, api, id, fake }) => {
    fake.play(HADES, { start: local(2026, 10, 24, 20, 0), minutes: 90 });
    await syncAt(h, id, local(2026, 10, 25, 4, 0));
    const [s] = plays(h, id, HADES);
    const edit = await api.patch(`/sessions/${s.id}`, { minutes: 30 });
    assert.equal(edit.status, 400, 'minutes of synced sessions come from the platform');
    assert.equal(expect200(await api.del(`/sessions/${s.id}`)).result, 'baseline');
    assert.equal(expect200(await api.get('/stats?range=7d&estimates=exclude')).tracked_minutes, 0);
    assert.equal(expect200(await api.get('/stats/lifetime')).total_minutes, LIBRARY_TOTAL + 90, 'the lifetime total still comes from Steam');
    await syncAt(h, id, local(2026, 10, 26, 4, 0));
    assert.equal(plays(h, id, HADES).length, 0, 'the next sync does not re-create it');
    expect200(await api.patch(`/sessions/${s.id}`, { kind: 'play' }));
    assert.equal(expect200(await api.get('/stats?range=7d&estimates=exclude')).tracked_minutes, 90, 'and it can be put back');
    assert.deepEqual(violations(h.db), []);
  }));

  test('concurrent sync requests for one account never count a delta twice', () => scenario(async ({ h, api, id, fake }) => {
    fake.play(HADES, { start: local(2026, 10, 24, 20, 0), minutes: 90 });
    clock.set(local(2026, 10, 25, 4, 0));
    const rs = await Promise.all([1, 2, 3].map(() => api.post(`/accounts/${id}/sync?wait=true`)));
    await h.settle();
    for (const r of rs) assert.ok(r.status === 200 || r.status === 409, `unexpected ${r.status}`);
    assert.equal(plays(h, id, HADES).reduce((a, x) => a + x.minutes, 0), 90);
    assert.equal(h.entry(id, HADES).playtime_min, 6090);
    assert.deepEqual(violations(h.db), []);
  }));

  test("sessions never land in the future, even when Steam's last-played time is ahead of the server clock", () => scenario(async ({ h, id, fake }) => {
    const S = local(2026, 10, 25, 4, 0);
    const g = fake.play(HADES, { start: S - 3 * HOUR, minutes: 45 });
    g.rtime_last_played = unix(S + 2 * HOUR);
    await syncAt(h, id, S); // violations() checks for future sessions
    assert.equal(plays(h, id, HADES).reduce((a, x) => a + x.minutes, 0), 45);
  }));
});

// =====================================================================================
/** Run every sync that the scheduler would have started before time t (in order). */
async function runDue(h, id, t) {
  for (let n = await nextSync(h, id), guard = 0; n != null && n <= t; n = await nextSync(h, id), guard++) {
    assert.ok(guard < 50, 'scheduler loop');
    await syncAt(h, id, n);
  }
}

/**
 * Poll presence the way the scheduler does (every 2 min) while `appid` runs from start to end,
 * running the syncs that fall due in between; stops at the first poll that sees it stopped.
 */
async function presenceRun(h, fake, id, appid, title, start, end, { offset = 37_000, due = true } = {}) {
  const polls = [];
  const first = Math.floor((start - 6 * MIN - T0) / (2 * MIN)) * 2 * MIN + T0 + offset;
  for (let t = first; ; t += 2 * MIN) { polls.push(t); if (t >= end) break; }
  for (const t of polls) {
    if (due) await runDue(h, id, t);
    clock.set(t);
    fake.setPlaying(t >= start && t < end ? appid : null, title);
    await h.poll(id);
  }
  fake.setPlaying(null);
  const seen = polls.filter((t) => t >= start && t < end);
  return { before: polls.filter((t) => t < start).at(-1), firstSeen: seen[0], lastSeen: seen.at(-1), after: polls.find((t) => t >= end), lastPoll: polls.at(-1) };
}

describe('live presence', () => {
  test('presence pins a session to exact start and end, shows it as playing now, and a sync follows 90 s after it ends', () => scenario(async ({ h, api, id, fake }) => {
    const start = local(2026, 10, 24, 18, 1); const end = local(2026, 10, 24, 19, 31);
    clock.set(local(2026, 10, 24, 18, 0)); fake.setPlaying(null); await h.poll(id);
    let lastPoll = null;
    for (let t = local(2026, 10, 24, 18, 2); t <= local(2026, 10, 24, 19, 30); t += 2 * MIN) {
      clock.set(t); fake.setPlaying(HADES, 'Hades'); await h.poll(id); lastPoll = t;
      if (t === local(2026, 10, 24, 18, 30)) {
        const np = expect200(await api.get('/now-playing'));
        assert.equal(np.length, 1);
        assert.equal(np[0].ext_id, String(HADES));
        assert.equal(np[0].title, 'Hades');
        assert.ok(np[0].minutes >= 27 && np[0].minutes <= 30, `playing for ${np[0].minutes} min`);
        assert.equal(expect200(await api.get('/summary')).playing_now.length, 1);
      }
    }
    assert.equal(lastPoll, local(2026, 10, 24, 19, 30));
    clock.set(local(2026, 10, 24, 19, 32)); fake.setPlaying(null); await h.poll(id);
    assert.deepEqual(expect200(await api.get('/now-playing')), []);
    const next = await nextSync(h, id);
    assert.equal(next, local(2026, 10, 24, 19, 32) + 90_000, 'a sync runs 90 seconds after you stop playing');
    fake.play(HADES, { start, minutes: 90 });
    await syncAt(h, id, next);
    const [s, ...rest] = plays(h, id, HADES);
    assert.equal(rest.length, 0);
    assert.equal(s.confidence, 'exact');
    assert.equal(s.minutes, 90);
    assert.ok(s.started_at >= local(2026, 10, 24, 18, 0) && s.started_at <= local(2026, 10, 24, 18, 2), 'start between the last idle and first playing poll');
    assert.ok(s.ended_at >= local(2026, 10, 24, 19, 30) && s.ended_at <= local(2026, 10, 24, 19, 32), 'end between the last playing and first idle poll');
    assert.equal(await nextSync(h, id), local(2026, 10, 25, 4, 0), 'then back to the regular schedule');
  }));

  test('two sessions of one game between two syncs stay two exact sessions', () => scenario(async ({ h, id, fake }) => {
    // the server was busy: neither the 04:00 sync nor the session-end syncs ran in between
    const a = await presenceRun(h, fake, id, HADES, 'Hades', local(2026, 10, 25, 14, 0), local(2026, 10, 25, 15, 0), { due: false });
    const b = await presenceRun(h, fake, id, HADES, 'Hades', local(2026, 10, 25, 20, 0), local(2026, 10, 25, 20, 45), { due: false });
    fake.play(HADES, { start: local(2026, 10, 25, 14, 0), minutes: 60 });
    fake.play(HADES, { start: local(2026, 10, 25, 20, 0), minutes: 45 });
    await syncAt(h, id, local(2026, 10, 26, 4, 0));
    const s = plays(h, id, HADES);
    assert.equal(s.length, 2);
    assert.ok(s.every((x) => x.confidence === 'exact'));
    assert.equal(s[0].minutes + s[1].minutes, 105);
    assert.ok(Math.abs(s[0].minutes - 60) <= 2 && Math.abs(s[1].minutes - 45) <= 2, `split ${s[0].minutes}/${s[1].minutes}`);
    for (const [x, p] of [[s[0], a], [s[1], b]]) {
      assert.ok(x.started_at >= p.before && x.started_at <= p.firstSeen);
      assert.ok(x.ended_at >= p.lastSeen && x.ended_at <= p.after);
    }
  }));

  test('a session still running at sync time is left alone until it ends, then recorded exactly once', () => scenario(async ({ h, id, fake }) => {
    const start = local(2026, 10, 25, 3, 30); const end = local(2026, 10, 25, 5, 0);
    for (let t = local(2026, 10, 25, 3, 26); t < local(2026, 10, 25, 4, 0); t += 2 * MIN) { clock.set(t); fake.setPlaying(t >= start ? HADES : null, 'Hades'); await h.poll(id); }
    fake.game(HADES, { rtime_last_played: unix(start) });
    let res = await syncAt(h, id, local(2026, 10, 25, 4, 0)); // still playing
    assert.equal(res.sessions_created, 0);
    for (let t = local(2026, 10, 25, 4, 0); t <= local(2026, 10, 25, 5, 2); t += 2 * MIN) { clock.set(t); fake.setPlaying(t < end ? HADES : null, 'Hades'); await h.poll(id); }
    fake.play(HADES, { start, minutes: 90 });
    const next = await nextSync(h, id);
    assert.equal(next, local(2026, 10, 25, 5, 0) + 90_000, 'the poll at 05:00 sees it stopped');
    res = await syncAt(h, id, next);
    let s = plays(h, id, HADES);
    assert.equal(s.length, 1);
    assert.equal(s[0].confidence, 'exact');
    assert.equal(s[0].minutes, 90);
    assert.ok(Math.abs(s[0].started_at - start) <= 2 * MIN && Math.abs(s[0].ended_at - end) <= 2 * MIN);
    await syncAt(h, id, local(2026, 10, 25, 9, 0));
    s = plays(h, id, HADES);
    assert.equal(s.length, 1, 'the span is never used twice');
  }));

  test('a game bought and started since the last sync shows as playing now under its Steam name, and its first session is exact', () => scenario(async ({ h, api, id, fake }) => {
    const BAL = 2379780;
    const start = local(2026, 10, 24, 18, 5); const end = local(2026, 10, 24, 19, 40);
    let checked = false;
    const origPoll = h.poll;
    h.poll = async (accId) => {
      await origPoll(accId);
      if (!checked && fake.player.gameid === String(BAL) && Date.now() > start + 20 * MIN) {
        checked = true;
        const np = expect200(await api.get('/now-playing'));
        assert.equal(np.length, 1);
        assert.equal(np[0].title, 'Balatro', "Steam's in-game title is shown before the game is in the library");
      }
    };
    const p = await presenceRun(h, fake, id, BAL, 'Balatro', start, end);
    assert.ok(checked);
    fake.game(BAL, { name: 'Balatro', playtime_forever: 0 });
    fake.play(BAL, { start, minutes: 95 });
    await syncAt(h, id, await nextSync(h, id));
    const s = plays(h, id, BAL);
    assert.equal(s.length, 1);
    assert.equal(s[0].confidence, 'exact');
    assert.equal(s[0].minutes, 95);
    assert.ok(s[0].started_at >= p.before && s[0].started_at <= p.firstSeen);
    assert.ok(s[0].ended_at >= p.lastSeen && s[0].ended_at <= p.after);
    assert.equal(h.entry(id, BAL).baseline_min, 0, 'no history for a game bought during tracking');
  }));

  test('a failing presence check is reported on the account and clears when the next check works', () => scenario(async ({ h, api, id, fake }) => {
    fake.failNext('summaries', { status: 400, body: { error: 'bad request' } });
    clock.set(T0 + HOUR); await h.poll(id);
    let p = (await h.account(id)).presence;
    assert.equal(p.failures, 1);
    assert.match(String(p.error), /400/);
    clock.set(T0 + HOUR + 2 * MIN); fake.setPlaying(HADES, 'Hades'); await h.poll(id);
    p = (await h.account(id)).presence;
    assert.equal(p.failures, 0);
    assert.equal(p.error, null);
    assert.equal(p.last_poll, T0 + HOUR + 2 * MIN);
    assert.equal(expect200(await api.get('/now-playing')).length, 1);
  }));

  test('presence on a private profile says presence is unavailable and records nothing', () => scenario(async ({ h, api, id, fake }) => {
    fake.player.communityvisibilitystate = 1;
    fake.setPlaying(HADES, 'Hades');
    clock.set(T0 + HOUR); await h.poll(id);
    clock.set(T0 + HOUR + 2 * MIN); await h.poll(id);
    const a = await h.account(id);
    assert.match(String(a.presence.error), /private/i);
    assert.deepEqual(expect200(await api.get('/now-playing')), []);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM presence').get().n, 0);
  }));

  test('presence can be switched off per account', () => scenario({ config: { presence: 'off' } }, async ({ h, api, id }) => {
    assert.equal((await h.account(id)).presence.enabled, false);
    expect200(await api.patch(`/accounts/${id}`, { config: { presence: 'on' } }));
    assert.equal((await h.account(id)).presence.enabled, true);
    expect200(await api.patch(`/accounts/${id}`, { enabled: false }));
    assert.equal((await h.account(id)).presence.enabled, false, 'a disabled account is not watched');
  }));

  test("after three sessions seen by presence the account learns what Steam's last-played time marks (the launch)", () => scenario(async ({ h, id, fake }) => {
    const sessions = [[local(2026, 10, 24, 19, 0), 50], [local(2026, 10, 25, 20, 0), 70], [local(2026, 10, 26, 21, 0), 40]];
    for (const [start, minutes] of sessions) {
      await presenceRun(h, fake, id, HADES, 'Hades', start, start + minutes * MIN);
      fake.play(HADES, { start, minutes });
      await syncAt(h, id, await nextSync(h, id));
    }
    const s = plays(h, id, HADES);
    assert.equal(s.length, 3);
    assert.ok(s.every((x) => x.confidence === 'exact'));
    const model = (await h.account(id)).history_model;
    assert.match(model.last_played, /start|launch/i);
    assert.match(model.last_played, /calibrated/i, model.last_played);
  }));

  test('switching presence off and on keeps what the account has learned',
    () => scenario(async ({ h, api, id, fake }) => {
      for (const [start, minutes] of [[local(2026, 10, 24, 19, 0), 50], [local(2026, 10, 25, 20, 0), 70], [local(2026, 10, 26, 21, 0), 40]]) {
        await presenceRun(h, fake, id, HADES, 'Hades', start, start + minutes * MIN);
        fake.play(HADES, { start, minutes });
        await syncAt(h, id, await nextSync(h, id));
      }
      assert.match((await h.account(id)).history_model.last_played, /calibrated/i);
      expect200(await api.patch(`/accounts/${id}`, { config: { presence: 'off' } }));
      expect200(await api.patch(`/accounts/${id}`, { config: { presence: 'on' } }));
      assert.match((await h.account(id)).history_model.last_played, /calibrated/i, 'calibration survives a presence toggle');
    }));
});

// =====================================================================================
describe('history enrichment from achievements and store release dates', () => {
  const STARDEW = 413150; const PRIV = 555000;
  const unlocks = [300, 297, 295, 290, 285].map((d) => startOfDay(T0 - d * DAY) + 21 * HOUR);
  const release = startOfDay(T0 - 60 * DAY) + 12 * HOUR;
  let h; let fake; let id;
  const snap = {};
  before(async () => {
    clock.freeze(); clock.set(T0);
    fake = new FakeSteam();
    useExternal(fake);
    fake.game(HADES, { name: 'Hades', playtime_forever: 3000, rtime_last_played: unix(T0 - 10 * DAY) });
    fake.game(STARDEW, { name: 'Stardew Valley', playtime_forever: 6000, rtime_last_played: unix(T0 - 30 * DAY) });
    fake.game(PRIV, { name: 'Private Stats Game', playtime_forever: 1000, rtime_last_played: unix(T0 - 5 * DAY) });
    fake.achievements.set(HADES, [
      ...unlocks.map((t, i) => ({ apiname: `ACH_${i}`, achieved: 1, unlocktime: unix(t) })),
      { apiname: 'LOCKED_1', achieved: 0, unlocktime: 0 }, { apiname: 'LOCKED_2', achieved: 0, unlocktime: 0 }, { apiname: 'BROKEN', achieved: 1, unlocktime: 0 },
    ]);
    fake.achievements.set(PRIV, { status: 403 }); // Stardew has no stats -> 400 (fake default)
    fake.appdetails.set(STARDEW, { release_date: { coming_soon: false, date: steamDate(release) } });
    fake.appdetails.set(HADES, { release_date: { coming_soon: false, date: '17 Sep, 2020' } });
    fake.appdetails.set(PRIV, { release_date: { coming_soon: true, date: 'Coming soon' } });
    h = await startApp({ backgroundEnrichment: true });
    clock.flow(); // the store is called at most every 1.6 s of real time
    const acc = expect200(await h.api.post('/accounts', { platform: 'steam', config: { api_key: KEY, steam_id: VANITY } }));
    id = acc.id;
    await h.sync.running.get(id)?.catch(() => {});
    for (const appid of [HADES, STARDEW]) snap[appid] = earliestEstimate(h, h.entry(id, appid).id);
    await waitFor(async () => expect200(await h.api.get('/history/summary')).pending_enrichment === 0, 20_000, 'enrichment');
    await h.settle();
    clock.freeze();
  });
  after(async () => { await h.close(); useExternal(null); });

  test('runs in the background after the first import until every title is done, without warnings for games without (public) stats', async () => {
    const sys = expect200(await h.api.get('/system'));
    assert.equal(sys.accounts[0].enrichment_pending, 0);
    for (const appid of [HADES, STARDEW, PRIV]) assert.equal((await gameOf(h, id, appid)).entries[0].history.enriched, true);
    assert.deepEqual(h.logs.filter((l) => l.level !== 'info'), [], 'a 400/403 for achievements is not an error');
  });

  test('titles with the most pre-tracking time are looked up first', () => {
    assert.deepEqual(fake.calls.filter((c) => c.ep === 'achievements').map((c) => Number(c.params.appid)), [STARDEW, HADES, PRIV]);
  });

  test('store lookups are spaced to respect the store limit (about 1.6 s apart)', () => {
    const t = fake.calls.filter((c) => c.ep === 'appdetails').map((c) => c.real);
    assert.equal(t.length, 3);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 1500, `store calls ${Math.round(t[i] - t[i - 1])} ms apart`);
  });

  test('achievement unlock times anchor the history window; locked and zero-time achievements are ignored', async () => {
    const g = await gameOf(h, id, HADES);
    assert.equal(g.entries[0].history.evidence.anchors, 5);
    const first = earliestEstimate(h, h.entry(id, HADES).id);
    assert.ok(snap[HADES] > unlocks[0] + 30 * DAY, 'before enrichment the start was a guess');
    assert.ok(first >= startOfDay(unlocks[0]) && first <= unlocks[0] + DAY, `history now starts at the first unlock (${new Date(first).toISOString()})`);
    const nearUnlocks = h.sum("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ? AND kind = 'estimate' AND window_start <= ? AND window_end >= ?",
      h.entry(id, HADES).id, unlocks.at(-1) + 2 * DAY, unlocks[0] - 2 * DAY);
    assert.ok(nearUnlocks > 0, 'the unlock period holds history');
    assert.equal(g.minutes, 3000);
    assert.deepEqual(violations(h.db), []);
  });

  test('the store release date is a lower bound for history', async () => {
    const g = await gameOf(h, id, STARDEW);
    assert.ok(Math.abs(g.entries[0].history.evidence.release_at - release) <= DAY, 'release date stored');
    assert.ok(snap[STARDEW] < startOfDay(release), 'before enrichment the guess started before release');
    assert.ok(earliestEstimate(h, h.entry(id, STARDEW).id) >= startOfDay(release), 'history cannot start before release');
    assert.equal(g.minutes, 6000);
    assert.equal((await gameOf(h, id, PRIV)).entries[0].history.evidence.release_at, null, 'a "coming soon" date is not a release date');
  });

  test('enrichment calls are counted in the account’s API usage', async () => {
    const a = await h.account(id);
    assert.equal(a.api_usage_hour.calls, fake.calls.length, 'achievement and store lookups are counted too');
    assert.ok(fake.count('achievements') === 3 && fake.count('appdetails') === 3);
  });
});

describe("Steam licenses page pasted to date history", () => {
  const paste = [
    'Date\tItem\tAcquisition Method',
    '12 Jan, 2025\tHades\tSteam Store',
    '12 Jan, 2025\tHades Original Soundtrack\tSteam Store',
    '3 Mar, 2026\tELDEN RING Deluxe Edition\tSteam Store',
    '9 Sep, 2019\tA Game You Do Not Own Anymore\tComplimentary',
  ].join('\n');

  test('purchase dates start each game\'s history window (editions matched, soundtracks skipped); a dry run changes nothing', () => scenario(async ({ h, api, id }) => {
    const hades = h.entry(id, HADES).id; const elden = h.entry(id, ELDEN).id;
    const before = { hades: earliestEstimate(h, hades), elden: earliestEstimate(h, elden) };
    assert.ok(before.hades > local(2025, 1, 12, 12) + 30 * DAY, 'without a start date the window is a guess');
    assert.equal((await api.post(`/accounts/${id}/licenses`, {})).status, 400);
    assert.equal((await api.post('/accounts/99999/licenses', { text: paste })).status, 404);
    const dry = expect200(await api.post(`/accounts/${id}/licenses?dry_run=true`, { text: paste }));
    assert.equal(dry.dry_run, true);
    assert.equal(dry.matched, 2);
    assert.equal(earliestEstimate(h, hades), before.hades, 'a preview changes nothing');
    const r = expect200(await api.post(`/accounts/${id}/licenses`, { text: paste }));
    assert.equal(r.matched, 2, 'Hades and ELDEN RING (Deluxe Edition)');
    assert.equal(r.unmatched, 1, 'the game no longer owned');
    const h1 = earliestEstimate(h, hades);
    assert.ok(h1 >= startOfDay(local(2025, 1, 12, 12)) && h1 <= local(2025, 1, 12, 12) + DAY, `Hades history starts on its purchase day (${new Date(h1).toISOString()})`);
    assert.ok(earliestEstimate(h, elden) >= startOfDay(local(2026, 3, 3, 12)), 'ELDEN RING history starts no earlier than its purchase');
    assert.equal(h.entry(id, HADES).playtime_min, 6000);
    assert.deepEqual(violations(h.db), []);
  }));
});

// =====================================================================================
describe('cover art', () => {
  const art = (fake) => {
    fake.game(10, { name: 'Counter-Strike', playtime_forever: 100, rtime_last_played: unix(T0 - 20 * DAY) });
    fake.game(2000001, { name: 'New Art', playtime_forever: 100, rtime_last_played: unix(T0 - 20 * DAY) });
    fake.game(2000002, { name: 'Header Only', playtime_forever: 100, rtime_last_played: unix(T0 - 20 * DAY) });
    fake.game(2000004, { name: 'Custom Cover Game', playtime_forever: 100, rtime_last_played: unix(T0 - 20 * DAY) });
    fake.storeAssets.set(10, { asset_url_format: 'steam/apps/10/${FILENAME}?t=1700000000', library_capsule: 'library_600x900.jpg', header: 'header.jpg' });
    fake.storeAssets.set(2000001, { asset_url_format: 'steam/apps/2000001/0123abcd/${FILENAME}', library_capsule: 'library_600x900_2x.jpg', header: 'header.jpg' });
    fake.storeAssets.set(2000002, { asset_url_format: 'steam/apps/2000002/feed/${FILENAME}', header: 'header.jpg' });
    fake.storeAssets.set(2000004, { asset_url_format: 'steam/apps/2000004/beef/${FILENAME}', library_capsule: 'library_600x900_2x.jpg' });
  };
  const STORE = 'https://shared.cloudflare.steamstatic.com/store_item_assets/';
  const coverOf = async (h, appid) => (await gameOf(h, h.db.prepare('SELECT account_id FROM entries WHERE ext_id = ?').get(String(appid)).account_id, appid)).cover_url;

  test('hashed store paths replace the classic path, classic apps keep it, a cover you set is kept, and checked apps are not asked again', () => scenario({ library: art, link: false }, async ({ h, api, fake }) => {
    expect200(await api.post('/games', { title: 'Custom Cover Game', cover_url: 'https://example.com/mine.png' }));
    const acc = await h.link();
    await waitFor(async () => (await coverOf(h, 2000001)).startsWith(STORE), 3000, 'cover lookup');
    assert.equal(await coverOf(h, 10), 'https://cdn.cloudflare.steamstatic.com/steam/apps/10/library_600x900.jpg');
    assert.equal(await coverOf(h, 2000001), `${STORE}steam/apps/2000001/0123abcd/library_600x900_2x.jpg`);
    assert.equal(await coverOf(h, 2000002), `${STORE}steam/apps/2000002/feed/header.jpg`, 'no portrait capsule: the header is used');
    assert.equal(await coverOf(h, 2000004), 'https://example.com/mine.png', 'your own cover is never replaced');
    assert.equal((await gameOf(h, acc.id, 2000001)).entries[0].cover_url, `${STORE}steam/apps/2000001/0123abcd/library_600x900_2x.jpg`);
    const items = fake.calls.filter((c) => c.ep === 'items');
    assert.equal(items.length, 1, 'one request covers up to 100 apps');
    assert.deepEqual([...items[0].appids].sort((a, b) => a - b), [10, 2000001, 2000002, 2000004]);
    await syncAt(h, acc.id, T0 + DAY);
    await realSleep(30);
    assert.equal(fake.count('items'), 1, 'checked apps are not looked up again');
    assert.equal(await coverOf(h, 2000001), `${STORE}steam/apps/2000001/0123abcd/library_600x900_2x.jpg`, 'a later sync keeps the resolved cover');
    fake.game(2000005, { name: 'Bought Later', playtime_forever: 0 });
    await syncAt(h, acc.id, T0 + 2 * DAY);
    await waitFor(() => fake.count('items') === 2, 3000, 'second cover lookup');
    assert.deepEqual(fake.calls.filter((c) => c.ep === 'items')[1].appids, [2000005]);
  }));

  test('art stored under a hashed path is used even when its file has the classic name',
    () => scenario({
      library: (fake) => {
        fake.game(2000003, { name: 'Hashed Classic Name', playtime_forever: 100, rtime_last_played: unix(T0 - 20 * DAY) });
        fake.storeAssets.set(2000003, { asset_url_format: 'steam/apps/2000003/77aa/${FILENAME}', library_capsule: 'library_600x900.jpg', header: 'header.jpg' });
      },
    }, async ({ h, fake }) => {
      await waitFor(() => fake.count('items') === 1, 3000, 'cover lookup');
      await realSleep(30);
      assert.equal(await coverOf(h, 2000003), `${STORE}steam/apps/2000003/77aa/library_600x900.jpg`);
    }));

  test('a failing cover lookup never fails the sync', () => scenario({ library: art, link: false }, async ({ h, fake }) => {
    fake.failNext('items', { status: 400, body: { error: 'bad' } });
    const acc = await h.link();
    await waitFor(() => fake.count('items') === 1, 3000, 'cover lookup');
    await realSleep(30);
    const a = await h.account(acc.id);
    assert.equal(a.last_status, 'ok');
    assert.equal(await coverOf(h, 2000001), 'https://cdn.cloudflare.steamstatic.com/steam/apps/2000001/library_600x900.jpg');
    assert.deepEqual(violations(h.db), []);
  }));
});

// =====================================================================================
describe('API usage accounting and failures', () => {
  test('every Steam call is counted per account; a follow-up sync costs one call; the profile is refreshed weekly', () => scenario(async ({ h, api, id, fake }) => {
    await realSleep(20); // the cover lookup that follows the import
    const first = expect200(await api.get(`/syncs?account_id=${id}`))[0];
    assert.equal(first.details.api.calls, 3, 'vanity + profile + owned games');
    assert.equal(first.details.api.hosts['api.steampowered.com'], 3);
    let a = await h.account(id);
    assert.equal(a.api_usage_hour.calls, fake.calls.length, 'everything sent to Steam this hour is counted');
    assert.equal(a.api_usage_hour.errors, 0);
    const before = fake.calls.length;
    let res = await syncAt(h, id, T0 + DAY);
    assert.equal(res.api_calls, 1, 'a follow-up sync is one GetOwnedGames call');
    assert.equal(fake.calls.length - before, 1);
    res = await syncAt(h, id, T0 + 8 * DAY);
    assert.equal(res.api_calls, 2, 'the profile is refreshed after a week');
    assert.deepEqual(fake.calls.slice(-2).map((c) => c.ep), ['summaries', 'owned']);
    a = await h.account(id);
    assert.equal(a.api_usage_hour.calls, 2);
    const sys = expect200(await api.get('/system'));
    assert.equal(sys.accounts[0].api_usage_24h.calls, 2);
    const syncs = expect200(await api.get(`/syncs?account_id=${id}`));
    assert.deepEqual(syncs.map((s) => s.details.api.calls), [2, 1, 3]);
  }));

  test('a 5xx answer is retried (honouring Retry-After) and counted as a failed call; the sync still succeeds and counts the delta once', () => scenario(async ({ h, id, fake }) => {
    fake.play(HADES, { start: local(2026, 10, 24, 20, 0), minutes: 90 });
    fake.failNext('owned', { status: 503, headers: { 'retry-after': '1' }, body: { error: 'busy' } });
    const before = fake.count('owned');
    const t0 = performance.now();
    const res = await syncAt(h, id, local(2026, 10, 25, 4, 0));
    assert.ok(performance.now() - t0 >= 900, 'waited for Retry-After');
    assert.equal(fake.count('owned') - before, 2);
    assert.equal(res.api_calls, 2);
    const a = await h.account(id);
    assert.equal(a.api_usage_hour.errors, 1);
    assert.equal(plays(h, id, HADES).reduce((x, s) => x + s.minutes, 0), 90);
  }));

  test('a 429 without Retry-After pauses the account instead of hammering the API, and the next sync catches up', () => scenario(async ({ h, id, fake }) => {
    fake.play(HADES, { start: local(2026, 10, 24, 20, 0), minutes: 90 });
    fake.failNext('owned', { status: 429, body: { error: 'Too Many Requests' } });
    const S = local(2026, 10, 25, 4, 0);
    clock.set(S);
    const before = fake.count('owned');
    const r = await h.syncNow(id);
    assert.equal(r.status, 429);
    assert.equal(fake.count('owned') - before, 1, 'no retry burns more of a used-up quota');
    let a = await h.account(id);
    assert.equal(a.last_status, 'warning');
    assert.match(a.last_error, /paused/i);
    assert.equal(a.api_usage_hour.rate_limited, 1);
    assert.ok(a.next_sync_at >= S + MIN, 'the next attempt waits for the quota');
    assert.equal(plays(h, id, HADES).length, 0);
    assert.deepEqual(violations(h.db), []);
    await syncAt(h, id, S + 2 * HOUR);
    a = await h.account(id);
    assert.equal(a.last_status, 'ok');
    assert.equal(plays(h, id, HADES).reduce((x, s) => x + s.minutes, 0), 90);
  }));

  test('network failures fail the sync readably without touching data; the next good sync catches up exactly', () => scenario(async ({ h, api, id, fake }) => {
    fake.play(HADES, { start: local(2026, 10, 24, 20, 0), minutes: 120 });
    fake.failNext('owned', { network: 'ECONNRESET' }, { network: 'ECONNRESET' }, { network: 'ECONNRESET' });
    clock.set(local(2026, 10, 25, 4, 0));
    const r = await h.syncNow(id);
    assert.equal(r.status, 502);
    assert.match(r.body.error, /network error/i);
    const a = await h.account(id);
    assert.equal(a.last_status, 'error');
    assert.equal(a.last_sync_at, T0, 'a failed sync is not a sync');
    assert.equal(h.entry(id, HADES).playtime_min, 6000);
    fake.play(HADES, { start: local(2026, 10, 25, 20, 0), minutes: 80 });
    await syncAt(h, id, local(2026, 10, 26, 4, 0));
    const s = plays(h, id, HADES);
    assert.equal(s.reduce((x, y) => x + y.minutes, 0), 200);
    for (const x of s) assert.ok((x.started_at ?? x.window_start) >= T0 - MIN, 'within the window since the last good sync');
    assert.equal(expect200(await api.get('/system')).accounts[0].failed_syncs_7d, 1);
  }));

  test('a private profile fails with a clear message, never marks the library as removed, and syncing resumes when public again', () => scenario(async ({ h, api, id, fake }) => {
    fake.gameDetailsPrivate = true;
    clock.set(local(2026, 10, 25, 4, 0));
    const r = await h.syncNow(id);
    assert.equal(r.status, 502);
    assert.match(r.body.error, /Public/);
    const a = await h.account(id);
    assert.equal(a.last_status, 'error');
    assert.match(a.last_error, /Game details|Public/);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM entries WHERE missing_since IS NOT NULL').get().n, 0);
    assert.equal(expect200(await api.get('/stats/lifetime')).total_minutes, LIBRARY_TOTAL);
    fake.gameDetailsPrivate = false;
    fake.play(HADES, { start: local(2026, 10, 25, 20, 0), minutes: 90 });
    await syncAt(h, id, local(2026, 10, 26, 4, 0));
    assert.equal(plays(h, id, HADES).reduce((x, s) => x + s.minutes, 0), 90);
  }));

  test('linking a private profile fails clearly and imports nothing', () => scenario({ fake: { visibility: 1 } }, async ({ h, api, id }) => {
    const a = await h.account(id);
    assert.equal(a.last_status, 'error');
    assert.match(a.last_error, /Public/);
    assert.equal(expect200(await api.get('/games')).total, 0);
  }));

  test('the private-profile message points at the privacy setting, not at the credentials',
    () => scenario({ fake: { visibility: 1 } }, async ({ h, id }) => {
      const a = await h.account(id);
      assert.doesNotMatch(a.last_error, /credentials/i, a.last_error);
    }));
});

// =====================================================================================
describe('sync schedule', () => {
  test('the default daily schedule runs at 04:00 local time, across both daylight-saving changes', () => scenario({ at: local(2026, 10, 31, 15, 0) }, async ({ h, id }) => {
    let next = await nextSync(h, id);
    assert.equal(next, local(2026, 11, 1, 4, 0));
    assert.equal(new Date(next).getHours(), 4);
    assert.equal(new Date(next).toISOString(), '2026-11-01T09:00:00.000Z', '04:00 EST after the clocks went back');
    assert.equal(next - local(2026, 10, 31, 15, 0), 14 * HOUR, 'the night has an extra hour');
    await syncAt(h, id, next);
    next = await nextSync(h, id);
    assert.equal(next, local(2026, 11, 2, 4, 0));
    await syncAt(h, id, local(2027, 3, 13, 15, 0));
    next = await nextSync(h, id);
    assert.equal(next, local(2027, 3, 14, 4, 0));
    assert.equal(new Date(next).getHours(), 4, 'still 04:00 after the clocks went forward');
    assert.equal(next - local(2027, 3, 13, 15, 0), 12 * HOUR);
  }));

  test('the running scheduler starts a due sync on its own and polls presence', () => scenario({ scheduler: true }, async ({ h, api, id, fake }) => {
    fake.play(HADES, { start: local(2026, 10, 24, 20, 0), minutes: 90 });
    const due = await nextSync(h, id);
    clock.set(due + 30_000); // the scheduler's first tick comes ~5 s (real time) after start
    const summaries = fake.count('summaries');
    await waitFor(async () => expect200(await api.get(`/syncs?account_id=${id}`)).length === 2, 15_000, 'the scheduled sync');
    await h.settle();
    const [last] = expect200(await api.get(`/syncs?account_id=${id}`));
    assert.equal(last.trigger, 'schedule');
    assert.equal(last.status, 'ok');
    assert.equal(plays(h, id, HADES).reduce((a, s) => a + s.minutes, 0), 90);
    await waitFor(() => fake.count('summaries') > summaries, 3000, 'a presence poll');
    assert.equal((await h.account(id)).next_sync_at, local(2026, 10, 26, 4, 0));
  }));

  test('per-account overrides, the global schedule, "off", invalid schedules and disabled accounts', () => scenario(async ({ h, api, id, fake }) => {
    const set = async (schedule) => expect200(await api.patch(`/accounts/${id}`, { schedule }));
    let a = await set({ schedule_mode: 'hourly' });
    assert.equal(a.next_sync_at, T0 + HOUR);
    assert.equal(a.schedule_label, 'Every hour');
    a = await set({ schedule_mode: 'hours', schedule_every: 6 });
    assert.equal(a.next_sync_at, T0 + 6 * HOUR);
    a = await set({ schedule_mode: 'weekly', schedule_weekday: 3, schedule_time: '21:30' });
    assert.equal(a.next_sync_at, local(2026, 10, 28, 21, 30));
    assert.equal(a.schedule_label, 'Weekly on Wednesday at 21:30');
    a = await set({ schedule_mode: 'off' });
    assert.equal(a.next_sync_at, null);
    assert.equal(a.schedule_label, 'Manual only');
    for (const bad of [{ schedule_mode: 'weekly', schedule_weekday: 9 }, { schedule_mode: 'hours', schedule_every: 0 }, { schedule_mode: 'daily', schedule_time: 'noon' }, { schedule_mode: 'fortnightly' }]) {
      const r = await api.patch(`/accounts/${id}`, { schedule: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await h.account(id)).schedule_label, 'Manual only', 'a rejected schedule changes nothing');
    a = await set(null);
    assert.equal(a.next_sync_at, local(2026, 10, 25, 4, 0), 'back to the global daily schedule');
    expect200(await api.put('/settings', { schedule_mode: 'days', schedule_every: 3, schedule_time: '06:15' }));
    assert.equal(await nextSync(h, id), local(2026, 10, 27, 6, 15));
    expect200(await api.patch(`/accounts/${id}`, { enabled: false }));
    assert.equal(await nextSync(h, id), null, 'a disabled account is never scheduled');
    const before = fake.calls.length;
    assert.equal(expect200(await api.post('/sync')).started, 0, '"sync all" skips disabled accounts');
    await h.settle();
    assert.equal(fake.calls.length, before);
    const r = await api.post('/accounts/99999/sync?wait=true');
    assert.equal(r.status, 404);
  }));
});

// =====================================================================================
describe('account lifecycle and joining existing data', () => {
  test('unlinking an account deletes its games and sessions but keeps your own games and sessions', () => scenario({ link: false }, async ({ h, api, fake }) => {
    const g = expect200(await api.post('/games', { title: 'Hades' }));
    expect200(await api.post('/sessions', { game_id: g.id, minutes: 45, started_at: local(2026, 10, 20, 20, 0) }));
    const acc = await h.link();
    assert.equal(h.entry(acc.id, HADES).game_id, g.id, 'the synced Hades joins your Hades');
    fake.play(HADES, { start: local(2026, 10, 24, 20, 0), minutes: 90 });
    await syncAt(h, acc.id, local(2026, 10, 25, 4, 0));
    assert.equal(expect200(await api.get(`/games/${g.id}`)).minutes, 6090 + 45);
    expect200(await api.del(`/accounts/${acc.id}`));
    const games = expect200(await api.get('/games?hidden=all'));
    assert.deepEqual(games.items.map((x) => x.title), ['Hades']);
    assert.equal(games.items[0].minutes, 45);
    const sess = expect200(await api.get('/sessions'));
    assert.equal(sess.total, 1);
    assert.equal(sess.items[0].minutes, 45);
    assert.equal(expect200(await api.get('/stats/lifetime')).total_minutes, 45);
    assert.equal((await api.del(`/accounts/${acc.id}`)).status, 404);
    assert.equal((await api.post(`/accounts/${acc.id}/sync?wait=true`)).status, 404);
    assert.deepEqual(violations(h.db), []);
  }));

  test('linking Steam joins games you imported before instead of counting them twice, and keeps your details (assist, not replace)', () => scenario({ link: false }, async ({ h, api }) => {
    const imp = expect200(await api.post('/import', { games: [{
      title: 'Hades', platform: 'steam', playtime_minutes: 5400, last_played: '2026-09-01', status: 'completed', rating: 9, notes: 'Heat 16 run',
      sessions: [{ date: '2026-08-01', minutes: 120 }],
    }] }));
    assert.equal(imp.games, 1);
    await h.link();
    const found = expect200(await api.get('/games?q=Hades'));
    assert.equal(found.total, 1, 'one Hades, not two');
    const g = expect200(await api.get(`/games/${found.items[0].id}`));
    assert.equal(g.minutes, 6000, "Steam's total stands; the imported hours are part of it");
    assert.equal(g.status, 'completed');
    assert.equal(g.rating, 9);
    assert.equal(g.notes, 'Heat 16 run');
    assert.equal(g.summary.tracked_minutes, 120, 'the imported real session is still tracked play');
    assert.ok(g.sessions.some((s) => s.minutes === 120 && s.started_at === local(2026, 8, 1, 12, 0)));
    assert.equal(expect200(await api.get('/stats/lifetime')).total_minutes, LIBRARY_TOTAL);
    assert.deepEqual(violations(h.db), []);
  }));
});

describe('importing after linking', () => {
  test("an import adds dates and exact past sessions to a synced game without changing Steam's total; re-imports and later syncs never double count", () => scenario(async ({ h, api, id, fake }) => {
    const file = { games: [{ title: 'Hades', platform: 'steam', playtime_minutes: 5400, status: 'beaten', rating: 8, sessions: [{ date: '2026-08-01', minutes: 120 }] }] };
    expect200(await api.post('/import', file));
    const e = h.entry(id, HADES);
    assert.equal(e.playtime_min, 6000, "Steam's total stands");
    assert.equal(kindSum(h, e.id, 'play'), 120, 'the exact past session is tracked play');
    assert.equal(h.sum("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ? AND source = 'inferred'", e.id), 5880, 'and that much less is estimated');
    const g = await gameOf(h, id, HADES);
    assert.equal(g.status, 'beaten');
    assert.equal(g.rating, 8);
    assert.equal(expect200(await api.get('/games?q=Hades')).total, 1);
    expect200(await api.post('/import', file));
    assert.equal(kindSum(h, e.id, 'play'), 120, 're-importing the same file is idempotent');
    fake.play(HADES, { start: local(2026, 10, 24, 20, 0), minutes: 90 });
    await syncAt(h, id, local(2026, 10, 25, 4, 0));
    assert.equal(kindSum(h, e.id, 'play'), 210);
    assert.equal(h.entry(id, HADES).playtime_min, 6090);
    assert.equal(expect200(await api.get('/stats/lifetime')).total_minutes, LIBRARY_TOTAL + 90);
    assert.deepEqual(violations(h.db), []);
  }));
});

// =====================================================================================
describe('many syncs over simulated days keep totals exact', () => {
  /** Run the scheduler the way the app would: due syncs, then the event (a presence poll). */
  async function run(h, id, polls, until, onSync) {
    const nextAt = () => h.db.prepare('SELECT next_sync_at n FROM accounts WHERE id = ?').get(id).n;
    let syncs = 0;
    const due = async (t) => {
      for (let n = nextAt(), guard = 0; n != null && n <= t; n = nextAt(), guard++) {
        assert.ok(guard < 500, 'scheduler loop');
        clock.set(n);
        const r = await h.syncNow(id);
        assert.equal(r.status, 200, r.text);
        syncs++;
        await onSync(r.body, n);
      }
    };
    for (const t of polls) {
      await due(t);
      clock.set(t);
      await h.poll(id);
    }
    await due(until);
    clock.set(until);
    return syncs;
  }

  test('three weeks across the DST change with presence on most days: totals exact, nothing twice, nothing lost, presence sessions exact', (t) => scenario({ link: false, library: () => {} }, async ({ h, api, fake }) => {
    const rng = mulberry32(20261024);
    const world = new SteamWorld(fake);
    const BAL = 2379780; const REF = 999001;
    world.addGame(HADES, { name: 'Hades', initial: 6000, initialLast: T0 - 20 * DAY });
    world.addGame(ELDEN, { name: 'ELDEN RING', initial: 12000, initialLast: T0 - 2 * DAY, initialRecent: { minutes: 400, at: T0 - 2 * DAY } });
    world.addGame(PORTAL2, { name: 'Portal 2', initial: 0 });
    world.addGame(CELESTE, { name: 'Celeste', initial: 750, initialLast: T0 - 400 * DAY, device: 'linux' });
    world.addGame(BAL, { name: 'Balatro', ownedFrom: local(2026, 10, 29, 9, 0) });
    world.addGame(REF, { name: 'Refund Me', ownedFrom: local(2026, 11, 3, 9, 0), removedAt: local(2026, 11, 4, 12, 0) });
    const firstDay = local(2026, 10, 25, 0, 0);
    const truth = generateSessions(rng, {
      firstDay, days: 21,
      pick: (r, start) => {
        const owned = [HADES, ELDEN, ...(start > local(2026, 10, 31, 0, 0) ? [PORTAL2] : []), ...(world.owned(BAL, start) ? [BAL, BAL] : [])];
        return { appid: owned[Math.floor(r() * owned.length)], device: r() < 0.3 ? 'deck' : 'windows' };
      },
    });
    truth.push({ appid: REF, start: local(2026, 11, 3, 9, 30), minutes: 40, device: 'windows', dayIndex: 9 });
    truth.sort((a, b) => a.start - b.start);
    for (const s of truth) world.addSession(s.appid, s.start, s.minutes, s.device);
    world.addUpload(CELESTE, local(2026, 11, 12, 12, 0), 120); // played offline on the Deck before tracking began
    const presenceDay = (s) => s.dayIndex % 3 !== 2;
    // the scheduler polls every 2 minutes; only the polls around sessions matter
    const polls = new Set();
    for (const s of truth.filter(presenceDay)) {
      const first = Math.floor((s.start - 6 * MIN - T0) / (2 * MIN)) * 2 * MIN + T0 + 37_000;
      for (let t = first; t <= s.start + (s.minutes + 4) * MIN; t += 2 * MIN) polls.add(t);
    }
    const pollList = [...polls].sort((a, b) => a - b);
    clock.set(T0);
    world.apply(T0);
    const acc = await h.link();
    const id = acc.id;
    const end = local(2026, 11, 16, 6, 0);
    const syncs = await run(h, id, pollList, end, async (_, at) => {
      assert.deepEqual(violations(h.db, { accountId: id }), [], `invariants after the sync at ${new Date(at).toString()}`);
      for (const e of h.db.prepare('SELECT * FROM entries WHERE account_id = ? AND missing_since IS NULL').all(id)) {
        assert.equal(e.playtime_min, world.totalAt(Number(e.ext_id), at), `${e.title} total at ${new Date(at).toString()}`);
      }
    });
    assert.ok(syncs >= 21 + truth.filter(presenceDay).length - 2, `${syncs} syncs`);

    // tracked play equals what really happened after the import, per game and in total
    const trackedTruth = truth.reduce((a, s) => a + s.minutes, 0);
    for (const appid of [HADES, ELDEN, PORTAL2, BAL, REF, CELESTE]) {
      const want = truth.filter((s) => s.appid === appid).reduce((a, s) => a + s.minutes, 0);
      assert.equal(kindSum(h, h.entry(id, appid).id, 'play'), want, `tracked minutes of ${appid}`);
    }
    const life = expect200(await api.get('/stats/lifetime'));
    assert.equal(life.tracked_minutes, trackedTruth);
    const finalTotals = [HADES, ELDEN, PORTAL2, CELESTE, BAL, REF].reduce((a, appid) => a + world.totalAt(appid, end), 0);
    assert.equal(life.total_minutes, finalTotals);
    assert.equal(expect200(await api.get('/stats?range=all&estimates=exclude')).tracked_minutes, trackedTruth);
    // history equals what Steam reported at the import; the late offline upload is identified as late
    for (const [appid, initial] of [[HADES, 6000], [ELDEN, 12000], [CELESTE, 750]]) {
      const e = h.entry(id, appid);
      assert.equal(h.sum("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ? AND source = 'inferred'", e.id), initial, `history of ${appid}`);
    }
    assert.equal(h.sum("SELECT COALESCE(SUM(s.minutes), 0) m FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.account_id = ? AND s.source = 'sync' AND s.kind = 'baseline'", id), 120, 'late upload');
    // nothing before tracking began, nothing in the future
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.account_id = ? AND s.kind = 'play' AND COALESCE(s.started_at, s.window_start) < ?").get(id, T0 - 2 * MIN).n, 0);
    assert.deepEqual(violations(h.db, { accountId: id }), []);
    // presence days: 1:1 with real sessions, exact times, right device
    const exact = h.db.prepare(`SELECT s.*, e.ext_id FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.account_id = ? AND s.kind = 'play' AND s.confidence = 'exact'`).all(id);
    // (the very first session of a title bought during tracking has no device: steam-sync-8, tested on its own)
    const firstOfNew = new Set([BAL, REF].map((appid) => truth.find((s) => s.appid === appid)));
    for (const s of truth.filter(presenceDay)) {
      const m = exact.filter((x) => Number(x.ext_id) === s.appid && Math.abs(x.started_at - s.start) <= 90_000 && Math.abs(x.ended_at - (s.start + s.minutes * MIN)) <= 90_000);
      assert.equal(m.length, 1, `presence session ${new Date(s.start).toString()} (${s.minutes} min) recorded exactly once`);
      assert.equal(m[0].minutes, s.minutes);
      if (!firstOfNew.has(s)) assert.equal(m[0].device, s.device, `device of ${new Date(s.start).toString()}`);
    }
    assert.equal(exact.length, truth.filter(presenceDay).length, 'no extra exact sessions');
    // day placement: presence days exact, the rest within the documented no-presence accuracy
    const want = new Map();
    for (const s of truth) minutesByDay(s.start, s.start + s.minutes * MIN, s.minutes, want);
    const heat = expect200(await api.get('/stats/heatmap?year=2026&estimates=exclude')).days;
    let wrong = 0;
    for (const d of new Set([...want.keys(), ...Object.keys(heat)])) wrong += Math.abs((want.get(d) || 0) - (heat[d] || 0));
    t.diagnostic(`${syncs} syncs, ${pollList.length} presence polls, ${truth.length} sessions; ${(wrong / 2 / trackedTruth * 100).toFixed(2)}% of ${trackedTruth} tracked minutes on the wrong day`);
    assert.ok(wrong / 2 <= 0.1 * trackedTruth, `${Math.round(wrong / 2)} of ${trackedTruth} tracked minutes on the wrong day`);
    // purchases, refunds, calibration
    assert.ok(h.entry(id, REF).missing_since, 'the refunded game is marked as no longer in the library');
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM entries WHERE account_id = ? AND missing_since IS NOT NULL').get(id).n, 1);
    assert.equal(h.entry(id, BAL).baseline_min, 0, 'a game bought during tracking has no history');
    const model = (await h.account(id)).history_model;
    assert.match(model.last_played, /calibrated/i);
    assert.match(model.last_played, /start|launch/i);
  }));

  test('four weekly syncs without presence: tracked minutes stay exact', () => scenario({ link: false, library: () => {} }, async ({ h, fake }) => {
    const rng = mulberry32(7);
    const world = new SteamWorld(fake);
    world.addGame(HADES, { name: 'Hades', initial: 6000, initialLast: T0 - 20 * DAY });
    world.addGame(ELDEN, { name: 'ELDEN RING', initial: 12000, initialLast: T0 - 2 * DAY, initialRecent: { minutes: 400, at: T0 - 2 * DAY } });
    world.addGame(CELESTE, { name: 'Celeste', initial: 750, initialLast: T0 - 400 * DAY });
    const truth = generateSessions(rng, { firstDay: local(2026, 10, 25, 0, 0), days: 28, pick: (r) => ({ appid: [HADES, ELDEN, CELESTE][Math.floor(r() * 3)], device: 'windows' }) });
    for (const s of truth) world.addSession(s.appid, s.start, s.minutes, s.device);
    clock.set(T0);
    world.apply(T0);
    const acc = await h.link({ presence: 'off' }, { schedule: { schedule_mode: 'weekly', schedule_weekday: 1, schedule_time: '04:00' } });
    const end = local(2026, 11, 23, 4, 30);
    const syncs = await run(h, acc.id, [], end, async () => { assert.deepEqual(violations(h.db), []); });
    assert.equal(syncs, 5, 'Mondays Oct 26, Nov 2, 9, 16, 23');
    const total = truth.reduce((a, s) => a + s.minutes, 0);
    assert.equal(h.sum("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE kind = 'play'"), total, 'tracked = real play');
    assert.equal(h.sum("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE kind = 'baseline' AND source = 'sync'"), 0, 'nothing was mistaken for a late upload');
    for (const appid of [HADES, ELDEN, CELESTE]) assert.equal(h.entry(acc.id, appid).playtime_min, world.totalAt(appid, end));
  }));

  test('a week of hourly syncs without presence: exact totals, every session fits where it is placed, near-exact days', (t) => scenario({ link: false, library: () => {} }, async ({ h, api, fake }) => {
    const rng = mulberry32(99);
    const world = new SteamWorld(fake);
    world.addGame(HADES, { name: 'Hades', initial: 6000, initialLast: T0 - 20 * DAY });
    world.addGame(ELDEN, { name: 'ELDEN RING', initial: 12000, initialLast: T0 - 2 * DAY, initialRecent: { minutes: 400, at: T0 - 2 * DAY } });
    const truth = generateSessions(rng, { firstDay: local(2026, 10, 25, 0, 0), days: 7, maxMinutes: 280, pick: (r) => ({ appid: r() < 0.5 ? HADES : ELDEN, device: 'windows' }) });
    for (const s of truth) world.addSession(s.appid, s.start, s.minutes, s.device);
    clock.set(T0);
    world.apply(T0);
    const acc = await h.link({ presence: 'off' }, { schedule: { schedule_mode: 'hourly' } });
    const end = local(2026, 11, 1, 12, 0);
    const syncs = await run(h, acc.id, [], end, async () => { assert.deepEqual(violations(h.db), []); });
    assert.ok(syncs >= 7 * 24, `${syncs} hourly syncs`);
    const total = truth.reduce((a, s) => a + s.minutes, 0);
    assert.equal(expect200(await api.get('/stats/lifetime')).tracked_minutes, total);
    assert.deepEqual(impossibleSessions(h.db), []);
    const want = new Map();
    for (const s of truth) minutesByDay(s.start, s.start + s.minutes * MIN, s.minutes, want);
    const heat = expect200(await api.get('/stats/heatmap?year=2026&estimates=exclude')).days;
    let wrong = 0;
    for (const d of new Set([...want.keys(), ...Object.keys(heat)])) wrong += Math.abs((want.get(d) || 0) - (heat[d] || 0));
    t.diagnostic(`${syncs} syncs, ${truth.length} sessions; ${(wrong / 2 / total * 100).toFixed(2)}% of ${total} minutes on the wrong day`);
    assert.ok(wrong / 2 <= 0.02 * total, `${Math.round(wrong / 2)} of ${total} minutes on the wrong day with hourly syncs`);
  }));
});
