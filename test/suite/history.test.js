// Pre-tracking history dating, black-box through the HTTP API (fresh suite, own helpers).
//
// Expectations come from README.md ("Smart handling of your existing playtime", "How sessions are
// computed", "Importing history"), docs/PLATFORMS.md ("How pre-tracking history is dated",
// "Learning the player's style"), the API route summaries, and what a correct tracker must do:
// totals add up, nothing is counted twice or lost, history never lands after tracking began, a
// day never holds more play than it has time for, bad input is rejected and changes nothing.
//
// The file runs in America/New_York (helpers/history-tz.js). "Now" is a fixed instant
// (Wed 2026-06-17 15:00 EDT) controlled by the harness clock; Steam scenarios let it tick from
// there because the app spaces store calls with real timers. Steam is mocked at the fetch level.
import './helpers/history-tz.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN, HOUR, DAY, clock, local, dayKey, startOfDay, addDays, iso, sum,
  guardNetwork, restoreNetwork, setPlatform, steamWorld, jsonResponse, startApp,
  historySessions, estimates, estimatedByDay, trackedByDay, entryIdByTitle, trackingStartOf, fingerprint,
  checkTotals, checkCaps, checkInvariants, tightEstimates,
} from './helpers/history-harness.js';

const NOW = local(2026, 6, 17, 15, 0);
before(() => { guardNetwork(); clock.install(NOW); });
after(() => { clock.uninstall(); restoreNetwork(); });

// ---------------------------------------------------------------------------- local helpers
const STEAM_CFG = { api_key: 'test-key', steam_id: '76561198000000001' };
/** Link a Steam account against the mock world and run its initial sync to completion. */
async function steamAccount(h, world, { store429 = false } = {}) {
  const base = steamWorld(world);
  setPlatform(store429 ? (u, i) => (u.pathname.includes('/api/appdetails') ? jsonResponse(429, { error: 'busy' }) : base(u, i)) : base);
  const acc = await h.post('/accounts', { platform: 'steam', name: 'Steam', config: STEAM_CFG, sync: false });
  const result = await h.post(`/accounts/${acc.id}/sync?wait=true`);
  await h.idle();
  return { id: acc.id, result };
}
const minutesOf = (ss) => sum(ss, (s) => s.minutes);
const spanOf = (ss) => [Math.min(...ss.map((s) => s.window_start)), Math.max(...ss.map((s) => s.window_end))];
const historyOf = async (h, title) => (await h.entryOf(title)).entry.history;
const undatedOf = (h, id) => minutesOf(historySessions(h.db, id).filter((s) => s.kind === 'baseline'));
/** Share of an entry's estimated minutes whose midpoint lies in [lo, hi) of the dated span (0..1). */
function shareIn(ss, lo, hi) {
  const [a, b] = spanOf(ss);
  const inRange = ss.filter((s) => { const p = ((s.window_start + s.window_end) / 2 - a) / (b - a); return p >= lo && p < hi; });
  return minutesOf(inRange) / minutesOf(ss);
}
/** Uncertain minutes as documented: undated + low confidence count fully, medium at half weight. */
const uncertainOf = (h, id) => sum(historySessions(h.db, id), (s) => (s.kind === 'baseline' || s.confidence === 'low' ? s.minutes : s.confidence === 'medium' ? s.minutes / 2 : 0));
async function allReviewItems(h, qs = '') {
  const out = []; let offset = 0; let total = 0;
  for (;;) {
    const r = await h.get(`/history/review?limit=200&offset=${offset}${qs}`);
    total = r.total; out.push(...r.items); offset += r.items.length;
    if (!r.items.length || offset >= r.total) break;
  }
  return { items: out, total };
}

// ======================================================================================
describe('first import of a large library (Steam, 603 games)', () => {
  let h; let first; let reported;
  const games = [];
  before(async () => {
    clock.set(NOW, { tick: true });
    let seed = 20260617;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 600; i++) {
      const k = i % 10;
      const minutes = k === 9 ? 0 : Math.round(30 + rnd() * rnd() * 12000); // a tenth never played
      const g = { appid: 1000 + i, name: `Library Game ${i}`, minutes };
      if (minutes && k !== 8) g.lastPlayed = NOW - HOUR - Math.round(rnd() * 400 * DAY); // a tenth has no timestamps
      if (minutes && k < 3) { // played in the last two weeks, some of them earlier today
        g.lastPlayed = NOW - 2 * HOUR - Math.round(rnd() * 13 * DAY);
        g.recent = Math.min(minutes, Math.round(60 + rnd() * 1500));
      }
      games.push(g);
    }
    // night owls: played until the small hours of import day, with a big 2-week counter
    for (let i = 0; i < 3; i++) games.push({ appid: 9000 + i, name: `Night Owl ${i}`, minutes: 1500, recent: 1200, lastPlayed: local(2026, 6, 17, 1, 0) + i * 30 * MIN });
    reported = sum(games, (g) => g.minutes);
    h = await startApp();
    // the store answers 429 so background enrichment stops at once (it is tested separately)
    ({ result: first } = await steamAccount(h, { timecreated: local(2016, 3, 1), games }, { store429: true }));
  });
  after(() => h.close());

  test('the initial sync records no play at all: every reported minute becomes history, nothing lost', async () => {
    assert.equal(first.initial, true);
    assert.equal(first.games_seen, 603);
    assert.equal(first.sessions_created, 0);
    assert.equal(first.minutes_added, 0);
    const life = await h.get('/stats/lifetime');
    assert.equal(life.total_minutes, reported);
    assert.equal(life.tracked_minutes, 0);
    assert.equal(life.sessions, 0);
    assert.equal(life.estimated_minutes + life.baseline_minutes, reported, 'dated + undated history = everything reported');
    assert.equal((await h.get('/sessions?kind=play')).total, 0);
    const rows = (await h.get('/history/summary')).rows;
    assert.equal(sum(rows, (r) => r.minutes), reported);
    checkTotals(h.db, { label: 'big import' });
  });

  test('today, this week, sessions and streaks stay at zero; the 30-day chart shows the history flagged as estimated', async () => {
    const s = await h.get('/summary');
    assert.equal(s.today.total_minutes, 0);
    assert.equal(s.week.total_minutes, 0);
    assert.equal(s.today.sessions, 0);
    assert.equal(s.week.sessions, 0);
    assert.equal(s.week.streaks.current, 0);
    assert.equal(s.month.tracked_minutes, 0);
    assert.ok(s.month.estimated_minutes > 0, 'recent history is charted');
    assert.equal(s.month.total_minutes, s.month.estimated_minutes, 'everything charted in the last 30 days is estimated');
    assert.equal(s.recent_sessions.length, 0);
    const wk = await h.get('/stats?range=7d&estimates=exclude');
    assert.equal(wk.total_minutes, 0);
    assert.equal(wk.days_played, 0);
  });

  test('the import day itself gets at most 12 h of history and no game more than 10 h of it', async () => {
    const heat = await h.get('/stats/heatmap?year=2026&estimates=only');
    const today = heat.days[dayKey(NOW)] || 0;
    assert.ok(today <= 720, `import day holds ${today} estimated minutes`);
    const perGame = h.db.prepare('SELECT entry_id, SUM(minutes) m FROM play_days WHERE estimated = 1 AND day = ? GROUP BY entry_id HAVING SUM(minutes) > 601').all(dayKey(NOW));
    assert.deepEqual(perGame.map((r) => ({ ...r })), []);
    assert.equal((await h.get('/summary')).today.total_minutes, 0, 'and none of it is today\'s play');
  });

  test('no day of the whole library holds more than 12 h of history, no game more than 10 h',
    { todo: 'APP BUG history-2: the shared 12 h/day budget is exceeded (multi-day chunks average away per-day room; also inflated by history-1)' }, async () => {
      checkCaps(h.db, { label: 'big import' });
    });

  test('the widget\'s today/this-week hours count tracked play only',
    { todo: 'APP BUG history-8: GET /api/v1/widget week_hours/today_hours include estimated pre-tracking history' }, async () => {
      const w = await h.get('/widget');
      assert.equal(w.today_hours, 0);
      assert.equal(w.week_hours, 0);
      assert.equal(w.top_game_week, null);
      assert.equal(w.sessions, 0);
      assert.equal(w.lifetime_hours, Math.round(reported / 60));
    });

  test('Improve history ranks the whole library least certain first; the meter accounts for every minute', async () => {
    const { items, total } = await allReviewItems(h);
    assert.equal(items.length, total);
    assert.ok(total > 300, `most of a big library needs answers (${total})`);
    for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].uncertain_minutes >= items[i].uncertain_minutes, `order at ${i}`);
    for (const it of items.slice(0, 40)) assert.ok(Math.abs(it.uncertain_minutes - uncertainOf(h, it.entry_id)) <= 1, `${it.title} uncertain minutes`);
    const r = await h.get('/history/review?limit=1');
    assert.equal(sum(Object.values(r.meter)), reported, 'meter covers all history');
    assert.ok(Math.abs(r.uncertain_minutes - (r.meter.undated + r.meter.low + r.meter.medium / 2)) <= 1);
    const neverPlayed = items.filter((it) => it.minutes === 0);
    assert.equal(neverPlayed.length, 0, 'games without playtime have no history to answer');
  });
});

// ======================================================================================
describe('evidence: what each date tells (custom account, first report)', () => {
  let h; let acc;
  const G = {
    both: { id: 'both', title: 'Both Dates', playtime_minutes: 3000, first_played_at: iso(local(2026, 1, 5, 20)), last_played_at: iso(local(2026, 3, 20, 23, 59)) },
    last: { id: 'last', title: 'Last Only', playtime_minutes: 2400, last_played_at: iso(local(2026, 4, 10, 23, 59)) },
    added: { id: 'added', title: 'Date Added', playtime_minutes: 1800, date_added: iso(local(2025, 12, 1, 12)), last_played_at: iso(local(2026, 2, 14, 23, 59)) },
    launches: { id: 'launch', title: 'Launches', playtime_minutes: 2000, first_played_at: iso(local(2025, 10, 1, 19)), last_played_at: iso(local(2025, 12, 20, 23, 59)), play_count: 25 },
    none: { id: 'none', title: 'No Dates', playtime_minutes: 1500 },
    recent: { id: 'recent', title: 'Recent Fortnight', playtime_minutes: 2500, last_played_at: iso(local(2026, 6, 16, 22)), recent_minutes: 600 },
    week: { id: 'week', title: 'Recent Week', playtime_minutes: 2500, last_played_at: iso(local(2026, 6, 16, 22)), recent_minutes: 600, recent_days: 7 },
    zero: { id: 'zero', title: 'Never Played', playtime_minutes: 0, last_played_at: iso(local(2026, 1, 1, 20)) },
  };
  let res;
  before(async () => {
    clock.set(NOW);
    h = await startApp();
    acc = await h.customAccount('Switch sheet');
    res = await h.report(acc, Object.values(G));
  });
  after(() => h.close());
  const t = (k) => Date.parse(G[k].first_played_at ?? G[k].date_added ?? G[k].last_played_at);

  test('the first report files every minute as history and dates it; nothing is tracked play', async () => {
    assert.equal(res.initial, true);
    assert.equal(res.sessions_created, 0);
    const total = sum(Object.values(G), (g) => g.playtime_minutes);
    assert.equal(res.history_minutes, total);
    assert.equal((await h.get('/stats/lifetime')).tracked_minutes, 0);
    checkInvariants(h.db, { label: 'evidence' });
  });

  test('first + last played bound the window: high confidence, the default shape bursts early and bumps at the end', async () => {
    const id = entryIdByTitle(h.db, 'Both Dates');
    const ss = estimates(h.db, id);
    assert.equal(minutesOf(ss), 3000, 'all of it is dated');
    const [a, b] = spanOf(ss);
    const first = Date.parse(G.both.first_played_at); const last = Date.parse(G.both.last_played_at);
    assert.ok(a >= startOfDay(first), `starts ${iso(a)} on/after first played`);
    assert.ok(b <= last, `ends ${iso(b)} by last played`);
    const hist = await historyOf(h, 'Both Dates');
    assert.equal(hist.confidence, 'high');
    assert.equal(hist.minutes, 3000);
    assert.equal(hist.estimated, 3000);
    assert.equal(hist.undated, 0);
    assert.equal(hist.evidence.first_played_at, first);
    assert.equal(hist.evidence.last_played_at, last);
    assert.ok(hist.window[0] <= a && hist.window[1] >= b && hist.window[0] >= startOfDay(first) && hist.window[1] <= last, 'the reported window describes the estimate');
    assert.ok(hist.reasons.length >= 1);
    // README: "a burst after starting a game, a taper, and a bump near the last session"
    const early = shareIn(ss, 0, 0.1); const middle = shareIn(ss, 0.45, 0.55); const late = shareIn(ss, 0.9, 1.01);
    assert.ok(early > middle, `burst after starting (${early.toFixed(3)} vs ${middle.toFixed(3)})`);
    assert.ok(late > middle, `bump near the last session (${late.toFixed(3)} vs ${middle.toFixed(3)})`);
  });

  test('only last played known: low confidence, the window ends at last played and starts before it', async () => {
    const id = entryIdByTitle(h.db, 'Last Only');
    const ss = estimates(h.db, id);
    assert.equal(minutesOf(ss) + undatedOf(h, id), 2400);
    assert.ok(minutesOf(ss) > 0);
    const [a, b] = spanOf(ss);
    assert.ok(b <= Date.parse(G.last.last_played_at));
    assert.ok(a < startOfDay(b), 'spread over more than the last day');
    assert.equal((await historyOf(h, 'Last Only')).confidence, 'low');
  });

  test('date added + last played: medium confidence, never before the date added', async () => {
    const id = entryIdByTitle(h.db, 'Date Added');
    const ss = estimates(h.db, id);
    assert.equal(minutesOf(ss), 1800);
    const [a, b] = spanOf(ss);
    assert.ok(a >= startOfDay(t('added')), `starts ${iso(a)}`);
    assert.ok(b <= Date.parse(G.added.last_played_at));
    const hist = await historyOf(h, 'Date Added');
    assert.equal(hist.confidence, 'medium');
    assert.equal(hist.evidence.date_added, Date.parse(G.added.date_added));
  });

  test('the launch count is kept as evidence and explained', async () => {
    const hist = await historyOf(h, 'Launches');
    assert.equal(hist.evidence.play_count, 25);
    assert.equal(hist.confidence, 'high');
    assert.ok(hist.reasons.some((r) => /25/.test(r) && /launch/i.test(r)), JSON.stringify(hist.reasons));
    const ss = estimates(h.db, entryIdByTitle(h.db, 'Launches'));
    assert.equal(minutesOf(ss), 2000);
    assert.ok(spanOf(ss)[0] >= startOfDay(t('launches')));
  });

  test('no dates at all: undated history - lifetime totals only, never charted', async () => {
    const { game, entry } = await h.entryOf('No Dates');
    assert.equal(entry.history.confidence, null);
    assert.equal(entry.history.window, null);
    assert.equal(entry.history.undated, 1500);
    assert.equal(entry.history.estimated, 0);
    assert.ok(entry.history.reasons.length >= 1);
    assert.equal(estimates(h.db, entry.id).length, 0);
    assert.equal(undatedOf(h, entry.id), 1500);
    assert.equal(game.minutes, 1500);
    assert.equal(game.summary.baseline_minutes, 1500);
    assert.equal(game.summary.estimated_minutes, 0);
    assert.equal(game.summary.tracked_minutes, 0);
    const st = await h.get(`/stats?range=all&game_id=${game.id}`);
    assert.equal(st.total_minutes, 0, 'nothing of it on any chart');
    assert.equal(Object.keys((await h.get(`/stats/heatmap?year=2026&game_id=${game.id}`)).days).length, 0);
  });

  test('a game reported with no playtime has no history at all', async () => {
    const { game, entry } = await h.entryOf('Never Played');
    assert.equal(game.minutes, 0);
    assert.equal(entry.history, null);
    assert.equal(historySessions(h.db, entry.id).length, 0);
    const r = await h.call('PATCH', `/entries/${entry.id}/history`, { mode: 'undated' });
    assert.equal(r.status, 400, 'nothing to adjust');
  });

  test('recent minutes (custom recent_minutes, default 14 days) land exactly in the last 14 days, the rest before them', async () => {
    const id = entryIdByTitle(h.db, 'Recent Fortnight');
    const ts = trackingStartOf(h.db, id);
    const edge = ts - 14 * DAY;
    const ss = estimates(h.db, id);
    const recent = ss.filter((s) => s.window_end > edge);
    assert.equal(minutesOf(recent), 600);
    for (const s of recent) assert.ok(s.window_start >= startOfDay(edge) && s.window_end <= Date.parse(G.recent.last_played_at), 'inside the recent period, never after last played');
    assert.equal(minutesOf(ss.filter((s) => s.window_end <= edge)), 1900);
    assert.equal((await historyOf(h, 'Recent Fortnight')).evidence.recent_min, 600);
  });

  test('recent_days narrows the recent period: "600 min in the last 7 days" lands in the last 7 days',
    { todo: 'APP BUG history-9: a custom report\'s recent_days is ignored for history; the minutes are spread over the last 14 days' }, async () => {
      const id = entryIdByTitle(h.db, 'Recent Week');
      const ts = trackingStartOf(h.db, id);
      const ss = estimates(h.db, id);
      const recent = ss.filter((s) => s.window_end > ts - 7 * DAY);
      assert.equal(minutesOf(recent), 600);
      for (const s of recent) assert.ok(s.window_start >= startOfDay(ts - 7 * DAY), `${s.minutes} min from ${iso(s.window_start)}`);
    });

  test('game pages: total = tracked + estimated + undated for every game, with the history block filled in', async () => {
    for (const g of Object.values(G)) {
      const { game, entry } = await h.entryOf(g.title);
      assert.equal(game.minutes, g.playtime_minutes, g.title);
      assert.equal(game.summary.total_minutes, game.summary.tracked_minutes + game.summary.estimated_minutes + game.summary.baseline_minutes, g.title);
      if (!g.playtime_minutes) continue;
      assert.equal(entry.history.minutes, g.playtime_minutes);
      assert.equal(entry.history.estimated + entry.history.undated, g.playtime_minutes);
      assert.equal(entry.history.mode, 'auto');
      assert.equal(entry.history.manual, null);
      assert.equal(entry.history.tracking_start, trackingStartOf(h.db, entry.id));
    }
  });

  test('charts include history flagged as estimated (toggleable); sessions, averages and streaks never count it', async () => {
    const inc = await h.get('/stats?range=year:2026&group=month');
    const exc = await h.get('/stats?range=year:2026&group=month&estimates=exclude');
    const only = await h.get('/stats?range=year:2026&group=month&estimates=only');
    assert.ok(inc.estimated_minutes > 0);
    assert.equal(inc.tracked_minutes, 0);
    assert.equal(inc.total_minutes, inc.estimated_minutes);
    assert.equal(exc.total_minutes, 0);
    assert.equal(only.total_minutes, inc.estimated_minutes);
    assert.equal(inc.sessions, 0);
    assert.equal(inc.avg_session_minutes, 0);
    assert.equal(inc.streaks.longest, 0);
    assert.equal(inc.days_played, 0);
    // every chart bar says how much of it is estimated (bars are rounded to whole minutes each)
    assert.ok(Math.abs(sum(inc.series, (x) => x.estimated) - inc.estimated_minutes) <= inc.series.length / 2);
    assert.ok(inc.series.every((x) => x.estimated === x.minutes));
    const yir = await h.get('/stats/year/2025');
    assert.ok(yir.estimated_minutes > 0);
    assert.equal(yir.sessions, 0);
    assert.equal(yir.longest_streak, 0);
    const heat = await h.get('/stats/heatmap?year=2025');
    assert.deepEqual(heat.days, heat.estimated_days, 'every 2025 heatmap day is estimated');
    // the Stats page toggle: estimates off by default
    await h.put('/settings', { stats_estimates: 'exclude' });
    assert.equal((await h.get('/stats?range=year:2026')).total_minutes, 0);
    await h.put('/settings', { stats_estimates: 'include' });
    assert.equal((await h.get('/stats?range=year:2026')).total_minutes, inc.total_minutes);
  });

  test('reporting the same totals again adds nothing: history is never counted twice', async () => {
    const before_ = (await h.get('/stats/lifetime')).total_minutes;
    const fp = fingerprint(h.db, entryIdByTitle(h.db, 'Both Dates'));
    clock.advance(DAY);
    const r = await h.report(acc, Object.values(G));
    assert.equal(r.initial, false);
    assert.equal(r.history_minutes, 0);
    assert.equal(r.sessions_created, 0);
    assert.equal((await h.get('/stats/lifetime')).total_minutes, before_);
    assert.deepEqual(fingerprint(h.db, entryIdByTitle(h.db, 'Both Dates')), fp);
    checkTotals(h.db, { label: 'repeat report' });
    clock.set(NOW);
  });
});

// ======================================================================================
describe('Steam evidence: 2-week counter, release date, account creation, unlock times', () => {
  let h; let acc;
  const world = {
    timecreated: local(2026, 1, 15, 12),
    games: [
      { appid: 10, name: 'Fortnight Counter', minutes: 2000, recent: 300, lastPlayed: NOW - 2 * DAY },
      { appid: 20, name: 'Late Release', minutes: 3000, lastPlayed: local(2026, 5, 30, 23, 59), release: 'May 20, 2026' },
      { appid: 30, name: 'Since Account Creation', minutes: 20000, lastPlayed: local(2026, 5, 30, 23, 59) },
      { appid: 40, name: 'Achievement Hunter', minutes: 3000, lastPlayed: local(2026, 6, 1, 23, 59),
        achievements: [local(2026, 3, 20, 20), local(2026, 3, 25, 20), local(2026, 4, 2, 20), local(2026, 4, 10, 20), local(2026, 7, 1, 20)] },
      { appid: 50, name: 'Legacy No Timestamps', minutes: 900 },
    ],
  };
  before(async () => {
    clock.set(NOW, { tick: true });
    h = await startApp();
    ({ id: acc } = await steamAccount(h, world)); // waits for the background enrichment too
  });
  after(() => h.close());

  test('the 2-week counter puts exactly those minutes into the last 14 days, the rest before them', async () => {
    const id = entryIdByTitle(h.db, 'Fortnight Counter');
    const ts = trackingStartOf(h.db, id);
    const edge = ts - 14 * DAY;
    const ss = estimates(h.db, id);
    const recent = ss.filter((s) => s.window_end > edge);
    assert.equal(minutesOf(recent), 300);
    for (const s of recent) assert.ok(s.window_start >= startOfDay(edge) && s.window_end <= world.games[0].lastPlayed + 1000);
    assert.equal(minutesOf(ss.filter((s) => s.window_end <= edge)), 1700);
    const hist = await historyOf(h, 'Fortnight Counter');
    assert.equal(hist.evidence.recent_min, 300);
    assert.equal((await h.get('/stats/lifetime')).tracked_minutes, 0, 'the counter dates history; it is not tracked play');
  });

  test('history never starts before the game\'s release date (store appdetails), and says so', async () => {
    const id = entryIdByTitle(h.db, 'Late Release');
    const ss = estimates(h.db, id);
    assert.equal(minutesOf(ss) + undatedOf(h, id), 3000);
    const release = local(2026, 5, 20, 0, 0);
    assert.ok(spanOf(ss)[0] >= release, `starts ${iso(spanOf(ss)[0])}`);
    const hist = await historyOf(h, 'Late Release');
    assert.equal(dayKey(hist.evidence.release_at), '2026-05-20');
    assert.ok(hist.reasons.some((r) => /release/i.test(r)), JSON.stringify(hist.reasons));
  });

  test('nor before the Steam account existed (GetPlayerSummaries timecreated)', async () => {
    const id = entryIdByTitle(h.db, 'Since Account Creation');
    const ss = estimates(h.db, id);
    assert.equal(minutesOf(ss) + undatedOf(h, id), 20000);
    assert.ok(minutesOf(ss) > 0);
    assert.ok(spanOf(ss)[0] >= startOfDay(world.timecreated), `starts ${iso(spanOf(ss)[0])}`);
    assert.equal((await h.get('/accounts')).find((a) => a.id === acc).profile.account_created_at, Math.floor(world.timecreated / 1000) * 1000);
  });

  test('achievement unlock times anchor the window (medium confidence); an unlock dated after tracking began cannot pull history past it', async () => {
    const id = entryIdByTitle(h.db, 'Achievement Hunter');
    const ss = estimates(h.db, id);
    assert.equal(minutesOf(ss), 3000);
    const [a, b] = spanOf(ss);
    const firstUnlock = world.games[3].achievements[0];
    assert.ok(a >= startOfDay(firstUnlock) && a <= firstUnlock, `the window starts on the first unlock day (${iso(a)})`);
    assert.ok(b <= world.games[3].lastPlayed);
    const hist = await historyOf(h, 'Achievement Hunter');
    assert.equal(hist.confidence, 'medium');
    assert.ok(hist.evidence.anchors >= 4);
    assert.ok(hist.reasons.some((r) => /achievement|trophy|unlock/i.test(r)), JSON.stringify(hist.reasons));
    assert.ok(b <= trackingStartOf(h.db, id));
    // days with unlocks really saw play
    const byDay = estimatedByDay(h.db, { entryId: id });
    for (const u of world.games[3].achievements.slice(0, 4)) {
      const near = [-1, 0, 1].some((d) => (byDay.get(dayKey(addDays(u, d))) || 0) > 0);
      assert.ok(near, `estimated play around the unlock on ${dayKey(u)}`);
    }
  });

  test('a title with no timestamps stays undated', async () => {
    const id = entryIdByTitle(h.db, 'Legacy No Timestamps');
    assert.equal(estimates(h.db, id).length, 0);
    assert.equal(undatedOf(h, id), 900);
  });

  test('background enrichment finished: nothing pending, every history title enriched, all of it adds up', async () => {
    const s = await h.get('/history/summary');
    assert.equal(s.pending_enrichment, 0);
    const sys = await h.get('/system');
    assert.equal(sys.accounts.find((a) => a.id === acc).enrichment_pending, 0);
    for (const g of world.games) assert.equal((await historyOf(h, g.name)).enriched, true, g.name);
    assert.equal(h.errors.length, 0, h.errors.join('\n'));
    checkInvariants(h.db, { label: 'steam evidence' });
  });
});

// ======================================================================================
describe('new evidence re-dates history automatically', () => {
  let h; let acc;
  const world = { games: [{ appid: 70, name: 'Portal Like', minutes: 2400, lastPlayed: local(2026, 5, 1, 23, 59) }] };
  before(async () => {
    clock.set(NOW, { tick: true });
    h = await startApp();
    ({ id: acc } = await steamAccount(h, world)); // first enrichment: no achievements, no release date
  });
  after(() => h.close());

  test('a low-confidence guess becomes a medium one once unlock times arrive; totals unchanged', async () => {
    const id = entryIdByTitle(h.db, 'Portal Like');
    const before_ = await historyOf(h, 'Portal Like');
    assert.equal(before_.confidence, 'low');
    assert.equal(before_.enriched, true);
    world.games[0].achievements = [local(2026, 2, 1, 20), local(2026, 2, 3, 20), local(2026, 2, 20, 20), local(2026, 3, 15, 20)];
    world.games[0].release = 'Jan 10, 2026';
    const r = await h.post(`/accounts/${acc}/enrich?wait=true`, { reset: true });
    assert.equal(r.updated, 1);
    const after_ = await historyOf(h, 'Portal Like');
    assert.equal(after_.confidence, 'medium');
    assert.equal(after_.evidence.anchors, 4);
    assert.equal(dayKey(after_.evidence.release_at), '2026-01-10');
    const ss = estimates(h.db, id);
    assert.equal(minutesOf(ss), 2400);
    assert.ok(spanOf(ss)[0] >= startOfDay(world.games[0].achievements[0]), 'now starts at the first unlock');
    assert.ok(spanOf(ss)[1] <= world.games[0].lastPlayed);
    checkInvariants(h.db, { label: 're-enriched' });
  });
});

// ======================================================================================
describe('Steam licenses paste: purchase dates bound history', () => {
  let h; let acc;
  const world = {
    games: [
      { appid: 80, name: 'Paste Target', minutes: 6000, lastPlayed: local(2026, 5, 30, 23, 59) },
      { appid: 81, name: 'Untouched', minutes: 1200, lastPlayed: local(2026, 4, 1, 23, 59) },
    ],
  };
  const text = [
    'Date\tItem\tAcquisition Method',
    '3 Feb, 2026\tPaste Target Deluxe Edition\tSteam Store',
    '10 Jan, 2026\tPaste Target\tGift/Guest Pass',
    '1 Dec, 2025\tPaste Target Soundtrack\tSteam Store',
    '15 Mar, 2026\tSome Other Product\tSteam Store',
  ].join('\n');
  let fpTarget; let fpOther;
  before(async () => {
    clock.set(NOW, { tick: true });
    h = await startApp();
    ({ id: acc } = await steamAccount(h, world));
    fpTarget = fingerprint(h.db, entryIdByTitle(h.db, 'Paste Target'));
    fpOther = fingerprint(h.db, entryIdByTitle(h.db, 'Untouched'));
  });
  after(() => h.close());

  test('dry run reports what would match and changes nothing', async () => {
    const r = await h.post(`/accounts/${acc}/licenses?dry_run=true`, { text });
    assert.equal(r.dry_run, true);
    assert.equal(r.matched, 1);
    assert.equal((await historyOf(h, 'Paste Target')).evidence.date_added, null);
    assert.deepEqual(fingerprint(h.db, entryIdByTitle(h.db, 'Paste Target')), fpTarget);
  });

  test('the earliest product date (editions count, soundtracks do not) starts the window; only matched games move', async () => {
    const r = await h.post(`/accounts/${acc}/licenses`, { text });
    assert.equal(r.licenses, 4);
    assert.equal(r.matched, 1);
    assert.equal(r.history_redated, 1);
    assert.equal(r.unmatched, 1);
    const hist = await historyOf(h, 'Paste Target');
    assert.equal(dayKey(hist.evidence.date_added), '2026-01-10', 'the earliest game product, not the soundtrack');
    assert.equal(hist.confidence, 'medium');
    const ss = estimates(h.db, entryIdByTitle(h.db, 'Paste Target'));
    assert.equal(minutesOf(ss) + undatedOf(h, entryIdByTitle(h.db, 'Paste Target')), 6000);
    assert.ok(spanOf(ss)[0] >= local(2026, 1, 10, 0, 0), `starts ${iso(spanOf(ss)[0])}`);
    assert.deepEqual(fingerprint(h.db, entryIdByTitle(h.db, 'Untouched')), fpOther);
    checkInvariants(h.db, { label: 'licenses' });
  });

  test('bad pastes are rejected', async () => {
    assert.equal((await h.call('POST', `/accounts/${acc}/licenses`, {})).status, 400);
    assert.equal((await h.call('POST', `/accounts/${acc}/licenses`, { text: 42 })).status, 400);
    assert.equal((await h.call('POST', '/accounts/999/licenses', { text })).status, 404);
    const junk = await h.post(`/accounts/${acc}/licenses`, { text: 'nothing that looks like a date\nhello' });
    assert.equal(junk.licenses, 0);
    assert.equal(junk.matched, 0);
  });
});

// ======================================================================================
describe('imports date history from their columns', () => {
  let h;
  before(async () => { clock.set(NOW); h = await startApp(); });
  after(() => h.close());
  const csv = [
    'title,platform,playtime_hours,first_played,last_played,date_added,play_count',
    'Hades,switch,42,2025-11-02,2026-01-15,,30',
    'Celeste,switch,12.5,,2026-02-01,2025-12-20,',
    'Zelda,switch,100,,,,',
  ].join('\n');

  test('CSV: first_played/last_played/date_added/play_count date the hours; no dates means undated', async () => {
    const r = await h.post('/import', csv);
    assert.equal(r.tracked_minutes, 0);
    assert.equal(r.baseline_minutes, 2520 + 750 + 6000);
    assert.equal(r.estimated_minutes + r.undated_minutes, r.baseline_minutes);
    const hades = await historyOf(h, 'Hades');
    assert.equal(hades.confidence, 'high');
    assert.equal(hades.evidence.play_count, 30);
    const hs = estimates(h.db, entryIdByTitle(h.db, 'Hades'));
    assert.equal(minutesOf(hs), 2520);
    assert.ok(spanOf(hs)[0] >= local(2025, 11, 2, 0, 0) && spanOf(hs)[1] <= local(2026, 1, 15, 12, 0));
    const celeste = await historyOf(h, 'Celeste');
    assert.equal(celeste.confidence, 'medium');
    assert.ok(spanOf(estimates(h.db, entryIdByTitle(h.db, 'Celeste')))[0] >= local(2025, 12, 20, 0, 0));
    assert.equal(undatedOf(h, entryIdByTitle(h.db, 'Zelda')), 6000);
    checkInvariants(h.db, { label: 'csv' });
  });

  test('re-importing the same file changes nothing (idempotent, never doubled)', async () => {
    const fps = ['Hades', 'Celeste', 'Zelda'].map((t) => fingerprint(h.db, entryIdByTitle(h.db, t)));
    const total = (await h.get('/stats/lifetime')).total_minutes;
    const r = await h.post('/import', csv);
    assert.equal(r.entries_created, 0);
    assert.equal(r.baseline_minutes, 0);
    assert.equal((await h.get('/stats/lifetime')).total_minutes, total);
    assert.deepEqual(['Hades', 'Celeste', 'Zelda'].map((t) => fingerprint(h.db, entryIdByTitle(h.db, t))), fps);
    checkTotals(h.db, { label: 'csv again' });
  });

  test('JSON with some sessions: the sessions are tracked, the rest is history dated before the earliest session', async () => {
    const first = local(2026, 3, 1, 20);
    const r = await h.post('/import', { games: [{ title: 'Totk', platform: 'switch', playtime_minutes: 9000, first_played: '2025-09-01', last_played: '2026-06-01',
      sessions: [{ started_at: iso(first), minutes: 120 }, { started_at: iso(local(2026, 3, 5, 20)), minutes: 60 }] }] });
    assert.equal(r.tracked_minutes, 180);
    assert.equal(r.baseline_minutes, 8820);
    const id = entryIdByTitle(h.db, 'Totk');
    const ss = estimates(h.db, id);
    assert.equal(minutesOf(ss) + undatedOf(h, id), 8820);
    assert.ok(spanOf(ss)[1] <= first, `history ends ${iso(spanOf(ss)[1])}, before the first imported session`);
    assert.ok(spanOf(ss)[0] >= local(2025, 9, 1, 0, 0));
    assert.equal(trackingStartOf(h.db, id), first);
    const { game } = await h.entryOf('Totk');
    assert.equal(game.summary.tracked_minutes, 180);
    assert.equal(game.summary.sessions, 2);
    checkInvariants(h.db, { label: 'json' });
  });
});

// ======================================================================================
describe('history lands before tracking began (boundary times)', () => {
  let h; let acc;
  const MIDNIGHT = local(2026, 6, 17, 0, 0);
  before(async () => {
    clock.set(MIDNIGHT);
    h = await startApp();
    acc = await h.customAccount();
    await h.report(acc, [
      { id: 'mid', title: 'Midnight Start', playtime_minutes: 3000, first_played_at: iso(local(2026, 6, 7, 12)), last_played_at: iso(MIDNIGHT) },
      { id: 'fut', title: 'Future Last Played', playtime_minutes: 3000, first_played_at: iso(local(2026, 6, 7, 12)), last_played_at: iso(local(2026, 7, 17, 0, 0)) },
      { id: 'back', title: 'Contradiction', playtime_minutes: 1000, first_played_at: iso(local(2026, 6, 1, 12)), last_played_at: iso(local(2026, 5, 1, 23, 59)) },
    ]);
  });
  after(() => h.close());

  test('tracking that starts at exactly midnight leaves the tracking day without any history', async () => {
    const id = entryIdByTitle(h.db, 'Midnight Start');
    const ss = estimates(h.db, id);
    assert.equal(minutesOf(ss), 3000);
    assert.ok(spanOf(ss)[1] < MIDNIGHT);
    assert.equal(estimatedByDay(h.db).get(dayKey(MIDNIGHT)) || 0, 0, 'nothing on the import day');
    assert.equal((await h.get('/summary')).today.total_minutes, 0);
  });

  test('a last-played time in the future (reporter clock skew) cannot move history past tracking start', async () => {
    const id = entryIdByTitle(h.db, 'Future Last Played');
    const ss = estimates(h.db, id);
    assert.equal(minutesOf(ss) + undatedOf(h, id), 3000);
    assert.ok(spanOf(ss)[1] <= MIDNIGHT);
  });

  test('last played before first played (contradictory report): still before both last played and tracking, nothing lost', async () => {
    const id = entryIdByTitle(h.db, 'Contradiction');
    const ss = estimates(h.db, id);
    assert.equal(minutesOf(ss) + undatedOf(h, id), 1000);
    assert.ok(spanOf(ss)[1] <= local(2026, 5, 1, 23, 59));
    checkInvariants(h.db, { label: 'boundaries' });
  });

  test('a game first seen in a later sync but last played before the previous one is history; one played since is a session', async () => {
    const prev = MIDNIGHT;
    clock.set(local(2026, 6, 18, 0, 0));
    const r = await h.report(acc, [
      { id: 'late', title: 'Late Arrival', playtime_minutes: 2400, last_played_at: iso(local(2026, 5, 1, 21)) },
      { id: 'fresh', title: 'Fresh Game', playtime_minutes: 90, last_played_at: iso(local(2026, 6, 17, 22)) },
    ]);
    assert.equal(r.initial, false);
    assert.equal(r.history_minutes, 2400);
    assert.equal(r.minutes_added, 90);
    const late = entryIdByTitle(h.db, 'Late Arrival');
    const ts = trackingStartOf(h.db, late);
    assert.ok(ts > prev);
    assert.equal(minutesOf(estimates(h.db, late)) + undatedOf(h, late), 2400);
    assert.ok(spanOf(estimates(h.db, late))[1] <= local(2026, 5, 1, 21));
    const fresh = (await h.entryOf('Fresh Game')).game.summary;
    assert.equal(fresh.tracked_minutes, 90);
    assert.equal(fresh.estimated_minutes + fresh.baseline_minutes, 0);
    checkInvariants(h.db, { label: 'late arrival' });
    clock.set(NOW);
  });
});

describe('the last day of a history window', () => {
  test('a game last played at 00:30 gets at most 30 min that day and no day above the 10 h cap',
    { todo: 'APP BUG history-1: the final day chunk is cut at last played but keeps its full minutes (891 min/day on the two days before, an 1800-min estimate squeezed into 48.5 h)' }, async () => {
      clock.set(NOW);
      const h = await startApp();
      try {
        const acc = await h.customAccount();
        const last = local(2026, 5, 10, 0, 30);
        await h.report(acc, [{ id: 'c', title: 'Early Last Play', playtime_minutes: 6000, first_played_at: iso(local(2026, 5, 1, 20)), last_played_at: iso(last) }]);
        const id = entryIdByTitle(h.db, 'Early Last Play');
        checkTotals(h.db);
        assert.ok((estimatedByDay(h.db, { entryId: id }).get('2026-05-10') || 0) <= 31, 'only 30 minutes exist before last played on that day');
        checkCaps(h.db, { label: 'early last play' });
      } finally { await h.close(); }
    });

  test('import day: a game played until 01:00 today gets at most the hour before that on import day',
    { todo: 'APP BUG history-1: the 2-week-counter minutes of the last day are cut at last played (01:00) but keep the day\'s share: 260 min placed between 00:00 and 01:00 on import day' }, async () => {
      clock.set(NOW);
      const h = await startApp();
      try {
        const acc = await h.customAccount();
        await h.report(acc, [ // yesterday is already full (12 h) of other history, so today's share stands alone
          { id: 'a', title: 'Marathon A', playtime_minutes: 600, first_played_at: iso(local(2026, 6, 16, 8)), last_played_at: iso(local(2026, 6, 16, 23, 59)) },
          { id: 'b', title: 'Marathon B', playtime_minutes: 120, first_played_at: iso(local(2026, 6, 16, 8)), last_played_at: iso(local(2026, 6, 16, 23, 59)) },
          { id: 'n', title: 'Night Owl', playtime_minutes: 1500, recent_minutes: 1200, last_played_at: iso(local(2026, 6, 17, 1, 0)) },
        ]);
        checkTotals(h.db);
        const today = estimatedByDay(h.db, { entryId: entryIdByTitle(h.db, 'Night Owl') }).get(dayKey(NOW)) || 0;
        assert.ok(today <= 61, `${today.toFixed(0)} min of history between midnight and 01:00 on import day`);
        assert.deepEqual(tightEstimates(h.db), []);
      } finally { await h.close(); }
    });

  test('an exact window ending in the evening (game page) keeps the 10 h/day cap on its days',
    { todo: 'APP BUG history-1: a 2-day window ending 20:00 holds 1200 min in 44 h, so its first day gets 654 min' }, async () => {
      clock.set(NOW);
      const h = await startApp();
      try {
        const acc = await h.customAccount();
        await h.report(acc, [{ id: 't', title: 'Evening End', playtime_minutes: 2400, last_played_at: iso(local(2026, 3, 17, 23, 59)) }]);
        const id = entryIdByTitle(h.db, 'Evening End');
        await h.patch(`/entries/${id}/history`, { first_played_at: iso(local(2026, 2, 10, 12)), last_played_at: iso(local(2026, 2, 11, 20)) });
        checkTotals(h.db);
        for (const [d, m] of estimatedByDay(h.db, { entryId: id })) assert.ok(m <= 601, `${d}: ${m.toFixed(1)}`);
        assert.deepEqual(tightEstimates(h.db), []);
      } finally { await h.close(); }
    });

  test('the 25-hour DST fall-back day (2025-11-02) still holds at most 10 h of one game',
    { todo: 'APP BUG history-3: a multi-day estimate is spread by elapsed time, so the 25-hour fall-back day gets 25/24 of a capped day (621 min)' }, async () => {
      clock.set(NOW);
      const h = await startApp();
      try {
        const acc = await h.customAccount();
        await h.report(acc, [{ id: 'd', title: 'Autumn Binge', playtime_minutes: 13 * 600, first_played_at: iso(local(2025, 10, 27, 12)), last_played_at: iso(local(2025, 11, 8, 23, 59)) }]);
        checkTotals(h.db);
        const day = estimatedByDay(h.db, { entryId: entryIdByTitle(h.db, 'Autumn Binge') }).get('2025-11-02') || 0;
        assert.ok(day <= 601, `2025-11-02 holds ${day.toFixed(1)} min`);
      } finally { await h.close(); }
    });
});

// ======================================================================================
describe('per-day caps: 10 h per game, 12 h per day across the library', () => {
  let h; let acc;
  before(async () => {
    clock.set(NOW);
    h = await startApp();
    const g = await h.post('/games', { title: 'Marathon' }); // tracked play inside the history period
    for (let d = 0; d < 10; d++) await h.post('/sessions', { game_id: g.id, minutes: 660, started_at: iso(local(2026, 5, 1 + d, 9)) });
    acc = await h.customAccount();
    await h.report(acc, [
      { id: 'cram', title: 'Crammed', playtime_minutes: 6000, first_played_at: iso(local(2026, 6, 1, 12)), last_played_at: iso(local(2026, 6, 5, 23, 59)) },
      { id: 'whale', title: 'Whale', playtime_minutes: 30000, last_played_at: iso(local(2026, 6, 10, 23, 59)) },
      { id: 'other', title: 'Shares The Days', playtime_minutes: 3000, first_played_at: iso(local(2026, 4, 28, 12)), last_played_at: iso(local(2026, 5, 12, 23, 59)) },
    ]);
  });
  after(() => h.close());

  test('more hours than the window can hold at 10 h/day: never above the cap, the rest widened back or undated, nothing lost', async () => {
    const id = entryIdByTitle(h.db, 'Crammed');
    const byDay = estimatedByDay(h.db, { entryId: id });
    for (const [d, m] of byDay) assert.ok(m <= 601, `${d}: ${m}`);
    const dated = minutesOf(estimates(h.db, id));
    assert.equal(dated + undatedOf(h, id), 6000);
    assert.ok(dated >= 3000, 'at least the five capped days are used');
    assert.ok(spanOf(estimates(h.db, id))[1] <= local(2026, 6, 5, 23, 59));
  });

  test('a huge game with only last played is spread over many days instead of piling up', async () => {
    const id = entryIdByTitle(h.db, 'Whale');
    const ss = estimates(h.db, id);
    assert.equal(minutesOf(ss) + undatedOf(h, id), 30000);
    assert.ok(minutesOf(ss) > 0);
    const byDay = estimatedByDay(h.db, { entryId: id });
    assert.ok(byDay.size >= 50, `${byDay.size} days`);
    for (const [d, m] of byDay) assert.ok(m <= 601, `${d}: ${m}`);
  });

  test('tracked play uses the same daily budget: history fills only what is left of 12 h', async () => {
    const est = estimatedByDay(h.db); const tr = trackedByDay(h.db);
    for (let d = 1; d <= 10; d++) {
      const k = dayKey(local(2026, 5, d, 12));
      assert.equal(Math.round(tr.get(k)), 660);
      assert.ok((est.get(k) || 0) <= 60 + 1, `${k}: ${est.get(k)} estimated next to 660 tracked`);
    }
    checkInvariants(h.db, { label: 'caps' });
  });

  test('the caps are settings: lowering them re-dates everything within the new limits; restoring them restores the dating', async () => {
    const ids = ['Crammed', 'Whale', 'Shares The Days'].map((t) => entryIdByTitle(h.db, t));
    const fps = ids.map((id) => fingerprint(h.db, id));
    await h.put('/settings', { history_max_game_day_minutes: 120, history_max_day_minutes: 300 });
    const s = await h.get('/settings');
    assert.equal(s.history_max_game_day_minutes, 120);
    assert.equal(s.history_max_day_minutes, 300);
    checkTotals(h.db, { label: 'lower caps' });
    for (const id of ids) for (const [d, m] of estimatedByDay(h.db, { entryId: id })) assert.ok(m <= 121, `entry ${id} ${d}: ${m}`);
    for (const [d, m] of estimatedByDay(h.db)) assert.ok(m <= 301, `${d}: ${m} across the library`);
    await h.put('/settings', { history_max_game_day_minutes: 600, history_max_day_minutes: 720 });
    assert.deepEqual(ids.map((id) => fingerprint(h.db, id)), fps);
  });

  test('a non-numeric cap is rejected and changes nothing', async () => {
    const fp = fingerprint(h.db, entryIdByTitle(h.db, 'Whale'));
    assert.equal((await h.call('PUT', '/settings', { history_max_day_minutes: 'lots' })).status, 400);
    assert.equal((await h.get('/settings')).history_max_day_minutes, 720);
    assert.deepEqual(fingerprint(h.db, entryIdByTitle(h.db, 'Whale')), fp);
  });

  test('a negative or zero cap is rejected instead of silently un-dating all history', async () => {
      const charted = (await h.get('/stats/lifetime')).estimated_minutes;
      const r1 = await h.call('PUT', '/settings', { history_max_day_minutes: -100 });
      const r2 = await h.call('PUT', '/settings', { history_max_game_day_minutes: 0 });
      const lifeAfter = (await h.get('/stats/lifetime')).estimated_minutes;
      await h.put('/settings', { history_max_day_minutes: 720, history_max_game_day_minutes: 600 }); // leave a sane state
      assert.equal(r1.status, 400);
      assert.equal(r2.status, 400);
      assert.equal(lifeAfter, charted);
    });
});

describe('a library competing for the same weeks', () => {
  test('60 games with first/last played in the same weeks never stack more than 12 h on a day',
    { todo: 'APP BUG history-2: per-day allocation respects the shared room, but consecutive days are merged into averaged multi-day estimates, pushing busy days to ~773 min' }, async () => {
      clock.set(NOW);
      const h = await startApp();
      try {
        const acc = await h.customAccount();
        const games = [];
        for (let i = 0; i < 60; i++) {
          const lp = local(2026, 6, 16 - (i % 10), 23, 59);
          games.push({ id: `g${i}`, title: `Busy ${i}`, playtime_minutes: 900 + (i % 7) * 100, last_played_at: iso(lp), first_played_at: iso(addDays(lp, -20 - (i % 5))) });
        }
        await h.report(acc, games);
        checkTotals(h.db, { label: 'competing' });
        assert.equal(sum(games, (g) => g.playtime_minutes), (await h.get('/stats/lifetime')).total_minutes);
        checkCaps(h.db, { label: 'competing' });
      } finally { await h.close(); }
    });
});

// ======================================================================================
describe('Improve history: review list and meter', () => {
  let h;
  before(async () => {
    clock.set(NOW);
    h = await startApp();
    const acc = await h.customAccount('Handheld');
    await h.report(acc, [
      { id: 'u', title: 'Undated One', playtime_minutes: 1000 },
      { id: 'l', title: 'Low One', playtime_minutes: 800, last_played_at: iso(local(2026, 4, 1, 23, 59)) },
      { id: 'm', title: 'Medium One', playtime_minutes: 1200, date_added: iso(local(2026, 1, 1, 12)), last_played_at: iso(local(2026, 3, 1, 23, 59)) },
      { id: 'h', title: 'High One', playtime_minutes: 5000, first_played_at: iso(local(2025, 6, 1, 12)), last_played_at: iso(local(2025, 12, 1, 23, 59)) },
    ]);
    await h.post('/import', 'title,platform,playtime_minutes,last_played\nSwitch Low,switch,900,2026-02-01\n');
  });
  after(() => h.close());
  const titles = (r) => r.items.map((i) => i.title);

  test('least certain first: undated and low count fully, medium at half weight, solid history is not listed', async () => {
    const r = await h.get('/history/review');
    assert.deepEqual(titles(r), ['Undated One', 'Switch Low', 'Low One', 'Medium One']);
    assert.deepEqual(r.items.map((i) => i.uncertain_minutes), [1000, 900, 800, 600]);
    assert.equal(r.total, 4);
    assert.equal(r.uncertain_minutes, 3300);
  });

  test('each item explains itself: minutes, confidence, window, undated part, reasons, evidence', async () => {
    const r = await h.get('/history/review');
    const u = r.items.find((i) => i.title === 'Undated One');
    assert.equal(u.minutes, 1000); assert.equal(u.undated, 1000); assert.equal(u.window, null); assert.equal(u.confidence, null);
    assert.ok(u.reasons.length);
    const m = r.items.find((i) => i.title === 'Medium One');
    assert.equal(m.confidence, 'medium'); assert.equal(m.platform, 'custom'); assert.equal(m.account_name, 'Handheld');
    assert.equal(m.evidence.date_added, local(2026, 1, 1, 12));
    assert.equal(m.evidence.last_played_at, local(2026, 3, 1, 23, 59));
    assert.ok(m.window[0] >= startOfDay(local(2026, 1, 1)) && m.window[1] <= local(2026, 3, 1, 23, 59));
    assert.ok(m.evidence.tracking_start >= NOW - 1000);
    for (const it of r.items) {
      assert.ok(Number.isInteger(it.entry_id) && Number.isInteger(it.game_id));
      assert.equal((await h.get(`/games/${it.game_id}`)).entries.some((e) => e.id === it.entry_id), true);
    }
  });

  test('platform filter', async () => {
    assert.deepEqual(titles(await h.get('/history/review?platform=switch')), ['Switch Low']);
    assert.deepEqual(titles(await h.get('/history/review?platform=custom')), ['Undated One', 'Low One', 'Medium One']);
    const none = await h.get('/history/review?platform=xbox');
    assert.equal(none.total, 0); assert.deepEqual(none.items, []);
  });

  test('the meter splits every minute of history by confidence and matches the summary rows', async () => {
    const r = await h.get('/history/review');
    assert.deepEqual(r.meter, { high: 5000, medium: 1200, low: 1700, undated: 1000, manual: 0 });
    const s = await h.get('/history/summary');
    const by = (k, c) => sum(s.rows.filter((x) => x.kind === k && (c === undefined || x.confidence === c)), (x) => x.minutes);
    assert.equal(by('estimate', 'high'), 5000);
    assert.equal(by('estimate', 'medium'), 1200);
    assert.equal(by('estimate', 'low'), 1700);
    assert.equal(by('baseline'), 1000);
    assert.equal(s.rows.find((x) => x.kind === 'estimate' && x.confidence === 'low').entries, 2);
    assert.equal(typeof s.version, 'number');
    assert.equal(s.style, null);
  });

  test('excluding an entry (double counting) removes it from the list, the meter and the summary; including it restores them', async () => {
    const id = entryIdByTitle(h.db, 'Switch Low');
    await h.patch(`/entries/${id}`, { excluded: true });
    let r = await h.get('/history/review');
    assert.ok(!titles(r).includes('Switch Low'));
    assert.equal(r.meter.low, 800);
    assert.equal(sum((await h.get('/history/summary')).rows, (x) => x.minutes), 8000);
    await h.patch(`/entries/${id}`, { excluded: false });
    r = await h.get('/history/review');
    assert.ok(titles(r).includes('Switch Low'));
    assert.equal(r.meter.low, 1700);
  });

  test('answered games leave the list; a set window counts as "set by you", "don\'t chart" as undated', async () => {
    const low = entryIdByTitle(h.db, 'Low One');
    const und = entryIdByTitle(h.db, 'Undated One');
    await h.patch(`/entries/${low}/history`, { first_played_at: new Date(2025, 0, 1, 12).toISOString(), last_played_at: new Date(2025, 2, 31, 20).toISOString(), mode: 'auto' });
    await h.patch(`/entries/${und}/history`, { mode: 'undated' });
    const r = await h.get('/history/review');
    assert.deepEqual(titles(r), ['Switch Low', 'Medium One']);
    assert.equal(r.meter.manual, 800);
    assert.equal(r.meter.undated, 1000);
    assert.equal(sum(Object.values(r.meter)), 8900);
    checkInvariants(h.db, { label: 'review' });
  });

  test('pending enrichment counts only titles that can still be enriched (custom accounts and imports never are)',
    { todo: 'APP BUG history-7: /history/summary pending_enrichment counts custom-account titles that are never enriched, disagreeing with /system' }, async () => {
      const s = await h.get('/history/summary');
      const sys = await h.get('/system');
      assert.equal(s.pending_enrichment, sum(sys.accounts, (a) => a.enrichment_pending));
      assert.equal(s.pending_enrichment, 0);
    });
});

describe('Improve history: paging a long list', () => {
  let h;
  before(async () => {
    clock.set(NOW);
    h = await startApp();
    const acc = await h.customAccount();
    await h.report(acc, Array.from({ length: 210 }, (_, i) => ({ id: `n${i}`, title: `Mystery ${String(i).padStart(3, '0')}`, playtime_minutes: 100 + i })));
  });
  after(() => h.close());

  test('pages are disjoint, ordered and complete; limit is capped at 200; bad values fall back to defaults', async () => {
    const p1 = await h.get('/history/review?limit=100');
    const p2 = await h.get('/history/review?limit=100&offset=100');
    const p3 = await h.get('/history/review?limit=100&offset=200');
    assert.equal(p1.total, 210);
    assert.deepEqual([p1.items.length, p2.items.length, p3.items.length], [100, 100, 10]);
    const all = [...p1.items, ...p2.items, ...p3.items];
    assert.equal(new Set(all.map((i) => i.entry_id)).size, 210);
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].uncertain_minutes >= all[i].uncertain_minutes);
    assert.equal(all[0].minutes, 309, 'the biggest unknown first');
    assert.equal((await h.get('/history/review?limit=1000')).items.length, 200, 'limit is capped at 200');
    const def = (await h.get('/history/review')).items;
    assert.ok(def.length >= 1 && def.length <= 200);
    assert.deepEqual(def.map((i) => i.entry_id), all.slice(0, def.length).map((i) => i.entry_id), 'the default page is the head of the list');
    assert.deepEqual((await h.get('/history/review?limit=abc')).items.map((i) => i.entry_id), def.map((i) => i.entry_id), 'a non-numeric limit falls back to the default');
    assert.equal((await h.get('/history/review?offset=5000')).items.length, 0);
    const neg = await h.call('GET', '/history/review?limit=-5&offset=-3');
    assert.equal(neg.status, 200);
    assert.ok(neg.body.items.length >= 1 && neg.body.items.length <= 200);
  });
});

// ======================================================================================
describe('answering a window, "looks right", "don\'t chart" and reset (PATCH /entries/:id/history)', () => {
  let h;
  const names = ['Quick Answer', 'Exact Dates', 'End Only', 'Tiny Window', 'After Tracking', 'Clear Me', 'Bad Input', 'Toggle Undated', 'Reset Me', 'Confirm Me', 'Confirm Redate', 'Garbage Dates'];
  const fp0 = {}; const id = {};
  before(async () => {
    clock.set(NOW);
    h = await startApp();
    const acc = await h.customAccount();
    await h.report(acc, [
      ...names.map((title, i) => ({ id: `w${i}`, title, playtime_minutes: 2400, last_played_at: iso(addDays(local(2026, 5, 31, 23, 59), -i * 25)) })),
      { id: 'nd', title: 'No Dates Here', playtime_minutes: 700 },
    ]);
    for (const t of [...names, 'No Dates Here']) { id[t] = entryIdByTitle(h.db, t); fp0[t] = fingerprint(h.db, id[t]); }
    const g = await h.post('/games', { title: 'Tracked Only' });
    await h.post('/sessions', { game_id: g.id, minutes: 60, started_at: iso(local(2026, 6, 10, 20)) });
    id['Tracked Only'] = entryIdByTitle(h.db, 'Tracked Only');
  });
  after(() => h.close());
  const patch = (t, body) => h.patch(`/entries/${id[t]}/history`, body);

  test('quick answer "mostly played in 2025, Apr - Jun" (as the Improve history page sends it) moves all of it there', async () => {
    const start = new Date(2025, 3, 1, 12); const end = new Date(2025, 5, 30, 20);
    const game = await patch('Quick Answer', { first_played_at: start.toISOString(), last_played_at: end.toISOString(), mode: 'auto' });
    const e = game.entries.find((x) => x.id === id['Quick Answer']);
    assert.equal(e.history.confidence, 'high');
    assert.deepEqual(e.history.manual, { start: start.getTime(), end: end.getTime() });
    const ss = estimates(h.db, id['Quick Answer']);
    assert.equal(minutesOf(ss), 2400);
    assert.ok(spanOf(ss)[0] >= local(2025, 4, 1, 0, 0) && spanOf(ss)[1] <= end.getTime(), `${iso(spanOf(ss)[0])}..${iso(spanOf(ss)[1])}`);
    assert.ok(!(await h.get('/history/review?limit=200')).items.some((i) => i.entry_id === id['Quick Answer']));
    checkInvariants(h.db, { label: 'quick answer' });
  });

  test('exact dates from the game page (local date-time strings) bound it the same way', async () => {
    await patch('Exact Dates', { first_played_at: '2025-08-10T12:00:00', last_played_at: '2025-09-20T20:00:00', mode: 'auto' });
    const ss = estimates(h.db, id['Exact Dates']);
    assert.equal(minutesOf(ss), 2400);
    assert.ok(spanOf(ss)[0] >= local(2025, 8, 10, 0, 0) && spanOf(ss)[1] <= local(2025, 9, 20, 20, 0));
  });

  test('only an end date: history ends there and keeps its size', async () => {
    const end = local(2026, 1, 10, 20);
    await patch('End Only', { last_played_at: iso(end) });
    const ss = estimates(h.db, id['End Only']);
    assert.equal(minutesOf(ss) + undatedOf(h, id['End Only']), 2400);
    assert.ok(spanOf(ss)[1] <= end);
    assert.ok(spanOf(ss)[0] < startOfDay(end));
  });

  test('a window too short for the hours keeps the 10 h/day cap; what does not fit stays undated', async () => {
    // inside the platform's history (this game was last played 2026-03-17); ends late in the evening
    // (an evening end time is covered under "the last day of a history window")
    await patch('Tiny Window', { first_played_at: iso(local(2026, 2, 10, 12)), last_played_at: iso(local(2026, 2, 11, 23, 59)) });
    const ss = estimates(h.db, id['Tiny Window']);
    for (const [d, m] of estimatedByDay(h.db, { entryId: id['Tiny Window'] })) assert.ok(m <= 601, `${d}: ${m}`);
    assert.ok(spanOf(ss)[0] >= local(2026, 2, 10, 0, 0) && spanOf(ss)[1] <= local(2026, 2, 11, 23, 59), `${iso(spanOf(ss)[0])}..${iso(spanOf(ss)[1])}`);
    assert.ok(minutesOf(ss) <= 1200);
    assert.equal(minutesOf(ss) + undatedOf(h, id['Tiny Window']), 2400);
    checkInvariants(h.db, { label: 'tiny window' });
  });

  test('a window after tracking began cannot move history past tracking start', async () => {
    await patch('After Tracking', { first_played_at: iso(local(2026, 7, 1, 12)), last_played_at: iso(local(2026, 7, 20, 20)) });
    const ss = estimates(h.db, id['After Tracking']);
    assert.equal(minutesOf(ss) + undatedOf(h, id['After Tracking']), 2400);
    if (ss.length) assert.ok(spanOf(ss)[1] <= trackingStartOf(h.db, id['After Tracking']));
    checkTotals(h.db, { label: 'after tracking' });
  });

  test('clearing the window (nulls) returns to the automatic dating', async () => {
    await patch('Clear Me', { first_played_at: iso(local(2025, 3, 1, 12)), last_played_at: iso(local(2025, 4, 1, 20)) });
    assert.notDeepEqual(fingerprint(h.db, id['Clear Me']), fp0['Clear Me']);
    const g = await patch('Clear Me', { first_played_at: null, last_played_at: null });
    assert.equal(g.entries.find((x) => x.id === id['Clear Me']).history.manual, null);
    assert.deepEqual(fingerprint(h.db, id['Clear Me']), fp0['Clear Me']);
  });

  test('invalid answers are rejected and change nothing', async () => {
    const p = (t, body) => h.call('PATCH', `/entries/${id[t] ?? t}/history`, body);
    const r1 = await p('Bad Input', { first_played_at: iso(local(2025, 6, 1)), last_played_at: iso(local(2025, 5, 1)) });
    assert.equal(r1.status, 400); assert.match(r1.body.error, /after/);
    assert.equal((await p('Bad Input', { mode: 'sometimes' })).status, 400);
    assert.equal((await p('Bad Input', { mode: null })).status, 400);
    assert.deepEqual(fingerprint(h.db, id['Bad Input']), fp0['Bad Input']);
    assert.equal((await h.call('PATCH', '/entries/999999/history', { mode: 'undated' })).status, 404);
    assert.equal((await h.call('PATCH', '/entries/abc/history', { mode: 'undated' })).status, 404);
    const tracked = await p('Tracked Only', { first_played_at: iso(local(2025, 1, 1)) });
    assert.equal(tracked.status, 400, 'tracked-only game has no pre-tracking history');
    assert.equal((await h.get(`/games/${(await h.entryOf('Tracked Only')).game.id}`)).summary.tracked_minutes, 60);
    checkTotals(h.db, { label: 'invalid' });
  });

  test('unparseable dates are rejected instead of silently clearing the window',
    { todo: 'APP BUG history-5: first_played_at/last_played_at that are not dates are accepted (200) and clear the manual window' }, async () => {
      await patch('Garbage Dates', { first_played_at: iso(local(2025, 2, 1, 12)), last_played_at: iso(local(2025, 3, 1, 20)) });
      const set = fingerprint(h.db, id['Garbage Dates']);
      const r1 = await h.call('PATCH', `/entries/${id['Garbage Dates']}/history`, { first_played_at: 'next tuesday' });
      const r2 = await h.call('PATCH', `/entries/${id['Garbage Dates']}/history`, { last_played_at: 'soon' });
      assert.equal(r1.status, 400);
      assert.equal(r2.status, 400);
      assert.deepEqual(fingerprint(h.db, id['Garbage Dates']), set, 'the answered window is kept');
    });

  test('"don\'t chart" keeps it out of every chart but in the lifetime total; charting it again restores the dating', async () => {
    const t = 'Toggle Undated';
    const life = (await h.get('/stats/lifetime')).total_minutes;
    const g = await patch(t, { mode: 'undated' });
    const e = g.entries.find((x) => x.id === id[t]);
    assert.equal(e.history.mode, 'undated');
    assert.equal(e.history.estimated, 0);
    assert.equal(e.history.undated, 2400);
    assert.equal(estimates(h.db, id[t]).length, 0);
    assert.equal(g.summary.baseline_minutes, 2400);
    assert.equal((await h.get(`/stats?range=all&game_id=${g.id}`)).total_minutes, 0);
    assert.equal((await h.get('/stats/lifetime')).total_minutes, life);
    assert.ok(!(await h.get('/history/review?limit=200')).items.some((i) => i.entry_id === id[t]), 'answered');
    await patch(t, { mode: 'auto' });
    assert.deepEqual(fingerprint(h.db, id[t]), fp0[t]);
    checkInvariants(h.db, { label: 'undated toggle' });
  });

  test('reset returns to automatic dating from any answer', async () => {
    const t = 'Reset Me';
    await patch(t, { first_played_at: iso(local(2025, 1, 1, 12)), last_played_at: iso(local(2025, 2, 1, 20)) });
    await patch(t, { mode: 'undated' });
    const g = await patch(t, { reset: true });
    const e = g.entries.find((x) => x.id === id[t]);
    assert.equal(e.history.mode, 'auto');
    assert.equal(e.history.manual, null);
    assert.equal(e.history.confidence, 'low');
    assert.deepEqual(fingerprint(h.db, id[t]), fp0[t]);
    assert.ok((await h.get('/history/review?limit=200')).items.some((i) => i.entry_id === id[t]), 'back on the list');
  });

  test('"looks right" keeps the current estimate exactly, marks it high confidence and takes it off the list', async () => {
    const t = 'Confirm Me';
    const g = await patch(t, { confirm: true });
    const e = g.entries.find((x) => x.id === id[t]);
    assert.equal(e.history.confidence, 'high');
    assert.match(e.history.reasons[0], /confirm/i, 'the first reason says you confirmed it');
    assert.equal(e.history.mode, 'auto');
    assert.deepEqual(fingerprint(h.db, id[t]), fp0[t], 'nothing moved');
    assert.ok(estimates(h.db, id[t]).every((s) => s.confidence === 'high'));
    assert.ok(!(await h.get('/history/review?limit=200')).items.some((i) => i.entry_id === id[t]));
    assert.equal((await h.call('PATCH', `/entries/${id['No Dates Here']}/history`, { confirm: true })).status, 400, 'nothing to confirm when nothing is dated');
    assert.deepEqual(fingerprint(h.db, id['No Dates Here']), fp0['No Dates Here']);
  });

  test('a confirmed estimate survives re-dating (re-date all, new cap settings) exactly',
    { todo: 'APP BUG history-4: confirm pins only the window; re-dating re-shapes the minutes inside it (a low-confidence guess changes on the next re-date)' }, async () => {
      const t = 'Confirm Redate';
      await patch(t, { confirm: true });
      const kept = fingerprint(h.db, id[t]);
      assert.deepEqual(kept, fp0[t]);
      await h.post('/history/reinfer');
      assert.deepEqual(fingerprint(h.db, id[t]), kept, 'after re-date all');
      await h.put('/settings', { history_max_game_day_minutes: 500 });
      await h.put('/settings', { history_max_game_day_minutes: 600 });
      assert.deepEqual(fingerprint(h.db, id[t]), kept, 'after cap changes');
    });

  test('all of the answering keeps every total intact', async () => {
    assert.equal((await h.get('/stats/lifetime')).total_minutes, 12 * 2400 + 700 + 60);
    checkTotals(h.db, { label: 'answers' });
  });
});

// ======================================================================================
describe('re-date all (POST /history/reinfer)', () => {
  let h;
  before(async () => {
    clock.set(NOW);
    h = await startApp();
    const acc = await h.customAccount();
    await h.report(acc, [
      { id: 'a', title: 'Auto Low', playtime_minutes: 2000, last_played_at: iso(local(2026, 4, 20, 23, 59)) },
      { id: 'b', title: 'Auto High', playtime_minutes: 4000, first_played_at: iso(local(2025, 7, 1, 12)), last_played_at: iso(local(2025, 10, 1, 23, 59)) },
      { id: 'c', title: 'Answered', playtime_minutes: 1500, last_played_at: iso(local(2026, 2, 20, 23, 59)) },
      { id: 'd', title: 'Not Charted', playtime_minutes: 900, last_played_at: iso(local(2026, 2, 20, 23, 59)) },
      { id: 'e', title: 'Undatable', playtime_minutes: 800 },
    ]);
    await h.post('/import', 'title,platform,playtime_minutes,first_played,last_played\nSheet Game,switch,1100,2025-03-01,2025-05-01\n');
    await h.patch(`/entries/${entryIdByTitle(h.db, 'Answered')}/history`, { first_played_at: iso(local(2024, 9, 1, 12)), last_played_at: iso(local(2024, 11, 30, 20)) });
    await h.patch(`/entries/${entryIdByTitle(h.db, 'Not Charted')}/history`, { mode: 'undated' });
  });
  after(() => h.close());
  const all = () => ['Auto Low', 'Auto High', 'Answered', 'Not Charted', 'Undatable', 'Sheet Game'].map((t) => fingerprint(h.db, entryIdByTitle(h.db, t)));

  test('re-dates every title with history, loses nothing and is idempotent', async () => {
    const life = await h.get('/stats/lifetime');
    const before_ = all();
    const r = await h.post('/history/reinfer');
    assert.equal(r.ok, true);
    assert.equal(r.entries, 6);
    assert.deepEqual(await h.get('/stats/lifetime'), life);
    assert.deepEqual(all(), before_, 'same evidence, same algorithm: same dating');
    assert.equal((await h.post('/history/reinfer')).entries, 6);
    assert.deepEqual(all(), before_);
    assert.equal(h.errors.length, 0, h.errors.join('\n'));
    checkInvariants(h.db, { label: 'reinfer' });
  });

  test('your answers survive it: the answered window and "don\'t chart" are kept', async () => {
    await h.post('/history/reinfer');
    const ans = estimates(h.db, entryIdByTitle(h.db, 'Answered'));
    assert.equal(minutesOf(ans), 1500);
    assert.ok(spanOf(ans)[0] >= local(2024, 9, 1, 0, 0) && spanOf(ans)[1] <= local(2024, 11, 30, 20));
    const nc = entryIdByTitle(h.db, 'Not Charted');
    assert.equal(estimates(h.db, nc).length, 0);
    assert.equal(undatedOf(h, nc), 900);
    assert.equal((await historyOf(h, 'Not Charted')).mode, 'undated');
  });

  test('works on an empty library', async () => {
    const e = await startApp();
    try {
      assert.deepEqual(await e.post('/history/reinfer'), { ok: true, entries: 0 });
      const s = await e.get('/history/summary');
      assert.deepEqual(s.rows, []);
      const r = await e.get('/history/review');
      assert.equal(r.total, 0);
      assert.deepEqual(r.meter, { high: 0, medium: 0, low: 0, undated: 0, manual: 0 });
    } finally { await e.close(); }
  });
});

// ======================================================================================
describe('learned play style (history_learn)', () => {
  let h; let acc; let S; let L; let fpS0; let fpL0; let fpS1; let lateShare0;
  const quietEnd = (i, daysAgo) => addDays(local(2026, 6, 17, 20), -daysAgo - i);
  /** A game tracked start to finish over 100 days: two early sittings, then a 10-day binge at the end. */
  const lateBinger = (i, { daysAgo = 40, untracked = 0, title = `Binger ${i}` } = {}) => {
    const start = addDays(quietEnd(i, daysAgo), -99);
    const sessions = [{ started_at: iso(start), minutes: 30 }, { started_at: iso(addDays(start, 10)), minutes: 30 }];
    for (let d = 90; d < 100; d++) sessions.push({ started_at: iso(addDays(start, d)), minutes: 120 + (i % 3) * 10 });
    return { title, platform: 'pc', playtime_minutes: sum(sessions, (s) => s.minutes) + untracked, sessions };
  };
  const style = async () => (await h.get('/history/summary')).style;
  before(async () => {
    clock.set(NOW);
    h = await startApp();
    acc = await h.customAccount();
    await h.report(acc, [
      { id: 's', title: 'Subject', playtime_minutes: 3000, first_played_at: iso(local(2025, 9, 1, 20)), last_played_at: iso(local(2025, 12, 9, 23, 59)) },
      { id: 'l', title: 'Start Unknown', playtime_minutes: 3000, last_played_at: iso(local(2026, 2, 1, 23, 59)) },
    ]);
    S = entryIdByTitle(h.db, 'Subject'); L = entryIdByTitle(h.db, 'Start Unknown');
    fpS0 = fingerprint(h.db, S); fpL0 = fingerprint(h.db, L);
    lateShare0 = shareIn(estimates(h.db, S), 0.8, 1.01);
  });
  after(() => h.close());

  test('nothing learned yet: learning is on by default, the default shape is used', async () => {
    assert.equal((await h.get('/settings')).history_learn, true);
    assert.equal(await style(), null);
    assert.equal((await h.get('/history/review')).style, null);
  });

  test('games not tracked from first session to last teach nothing: untracked (pre-tracking) hours, or still being played', async () => {
    const r1 = await h.post('/import', { games: Array.from({ length: 5 }, (_, i) => lateBinger(i, { untracked: 600, title: `Partly Tracked ${i}` })) });
    const r2 = await h.post('/import', { games: Array.from({ length: 5 }, (_, i) => lateBinger(i, { daysAgo: 2, title: `Still Playing ${i}` })) });
    assert.equal(r1.baseline_minutes, 3000, 'the untracked hours are history');
    assert.deepEqual([r1.style_relearned, r2.style_relearned], [false, false]);
    assert.equal(await style(), null);
    assert.deepEqual(fingerprint(h.db, S), fpS0);
    assert.deepEqual(fingerprint(h.db, L), fpL0);
    checkTotals(h.db, { label: 'non-teachers' });
  });

  test('ten finished, fully tracked games teach the style and history is re-dated like them', async () => {
    const r = await h.post('/import', { games: Array.from({ length: 10 }, (_, i) => lateBinger(i)) });
    assert.equal(r.style_relearned, true);
    const st = await style();
    assert.equal(st.games, 10);
    assert.equal(typeof st.learned_at, 'number');
    assert.equal((await h.get('/history/review')).style.games, 10);
    fpS1 = fingerprint(h.db, S);
    assert.notDeepEqual(fpS1, fpS0, 'Subject re-dated');
    const ss = estimates(h.db, S);
    assert.equal(minutesOf(ss), 3000);
    const [a, b] = spanOf(ss);
    assert.ok(a >= local(2025, 9, 1, 0, 0) && b <= local(2025, 12, 9, 23, 59), 'still inside first..last played');
    // the default shape front-loads; these players binge at the end of a game's life
    const lateShare = shareIn(ss, 0.8, 1.01);
    assert.ok(lateShare > lateShare0 + 0.15, `late share ${lateShare0.toFixed(2)} -> ${lateShare.toFixed(2)}`);
    assert.ok(lateShare > 0.4, `most of Subject now sits in the last fifth of its window (${lateShare.toFixed(2)})`);
    assert.deepEqual(fingerprint(h.db, L), fpL0, 'with fewer than 20 games a start-less game keeps the default dating (PLATFORMS.md footnote 1)');
    checkInvariants(h.db, { label: 'learned' });
  });

  test('a small change (< 20% more games) keeps the learned style; 20%+ re-learns it', async () => {
    const r1 = await h.post('/import', { games: [lateBinger(10)] });
    assert.equal(r1.style_relearned, false);
    assert.equal((await style()).games, 10);
    const r2 = await h.post('/import', { games: [lateBinger(11), lateBinger(12)] });
    assert.equal(r2.style_relearned, true);
    assert.equal((await style()).games, 13);
    fpS1 = fingerprint(h.db, S);
  });

  test('turning learning off re-dates with the default shape exactly; turning it on brings the style back', async () => {
    await h.put('/settings', { history_learn: false });
    assert.equal((await h.get('/settings')).history_learn, false);
    assert.equal(await style(), null);
    assert.equal((await h.get('/history/review')).style, null);
    assert.deepEqual(fingerprint(h.db, S), fpS0);
    // while off, new teachers change nothing
    const r = await h.post('/import', { games: Array.from({ length: 4 }, (_, i) => lateBinger(13 + i)) });
    assert.equal(r.style_relearned, false);
    assert.deepEqual(fingerprint(h.db, S), fpS0);
    await h.put('/settings', { history_learn: true });
    assert.equal((await style()).games, 17);
    assert.notDeepEqual(fingerprint(h.db, S), fpS0);
    checkTotals(h.db, { label: 'learn toggled' });
  });

  test('with 20+ games behind it the style also dates games whose start is unknown', async () => {
    await h.post('/import', { games: Array.from({ length: 8 }, (_, i) => lateBinger(17 + i)) });
    assert.ok((await style()).games >= 20);
    assert.notDeepEqual(fingerprint(h.db, L), fpL0);
    const ss = estimates(h.db, L);
    assert.equal(minutesOf(ss) + undatedOf(h, L), 3000);
    assert.ok(spanOf(ss)[1] <= local(2026, 2, 1, 23, 59));
    checkInvariants(h.db, { label: '20+ teachers' });
  });
});

describe('learned play style: manual sessions and games that go quiet', () => {
  let h; let acc;
  const style = async () => (await h.get('/history/summary')).style;
  before(async () => {
    clock.set(NOW);
    h = await startApp();
    acc = await h.customAccount();
    await h.report(acc, [{ id: 's', title: 'Subject', playtime_minutes: 3000, first_played_at: iso(local(2025, 9, 1, 20)), last_played_at: iso(local(2025, 12, 9, 23, 59)) }]);
  });
  after(() => h.close());
  const again = () => h.report(acc, [{ id: 's', title: 'Subject', playtime_minutes: 3000 }]);

  test('logged sessions teach too; the style is relearned after a sync, at most every 10 minutes', async () => {
    for (let i = 0; i < 4; i++) {
      const g = await h.post('/games', { title: `Logged ${i}` });
      for (let d = 0; d < 6; d++) await h.post('/sessions', { game_id: g.id, minutes: 90, started_at: iso(addDays(local(2026, 3, 1, 20), d * 3 + i)) });
    }
    clock.advance(2 * MIN);
    await again();
    assert.equal(await style(), null, 'a sync 2 minutes after the last learning does not relearn');
    clock.advance(9 * MIN);
    await again();
    assert.equal((await style())?.games, 4);
    checkTotals(h.db, { label: 'logged teachers' });
  });

  test('games still being played start teaching once they have been quiet for 30 days', async () => {
    const recentStart = addDays(NOW, -20);
    const games = Array.from({ length: 5 }, (_, i) => ({
      title: `Fresh ${i}`, platform: 'pc', playtime_minutes: 6 * 100,
      sessions: Array.from({ length: 6 }, (_, d) => ({ started_at: iso(addDays(recentStart, d * 3 + i)), minutes: 100 })),
    }));
    await h.post('/import', { games });
    assert.equal((await style()).games, 4, 'not yet: played within the last 30 days');
    clock.advance(40 * DAY);
    await again();
    assert.equal((await style()).games, 9);
    checkInvariants(h.db, { label: 'quiet teachers' });
    clock.set(NOW);
  });
});

// ======================================================================================
describe('unlinking an account', () => {
  test('removes its history with it and leaves other history alone', async () => {
    clock.set(NOW);
    const h = await startApp();
    try {
      const a = await h.customAccount('First');
      const b = await h.customAccount('Second');
      await h.report(a, [{ id: 'x', title: 'Gone Soon', playtime_minutes: 1200, last_played_at: iso(local(2026, 3, 1, 23, 59)) }]);
      await h.report(b, [{ id: 'y', title: 'Stays', playtime_minutes: 800, last_played_at: iso(local(2026, 2, 1, 23, 59)) }]);
      const fp = fingerprint(h.db, entryIdByTitle(h.db, 'Stays'));
      await h.del(`/accounts/${a}`);
      assert.equal((await h.get('/stats/lifetime')).total_minutes, 800);
      assert.equal(sum((await h.get('/history/summary')).rows, (r) => r.minutes), 800);
      assert.deepEqual((await h.get('/history/review')).items.map((i) => i.title), ['Stays']);
      assert.deepEqual(fingerprint(h.db, entryIdByTitle(h.db, 'Stays')), fp);
      assert.equal(estimatedByDay(h.db).size > 0, true);
      checkInvariants(h.db, { label: 'unlinked' });
    } finally { await h.close(); }
  });
});
