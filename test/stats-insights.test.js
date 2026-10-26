// Insight endpoints (punchcard, session lengths, platform / device stacks, timeline, a game's
// curve, library overview, year over year, records): exact numbers on a small hand-built
// library, response shapes and OpenAPI docs, and a time budget on a generated large library.
//
// The fixture is written straight into the database (games, entries, sessions of every kind,
// achievements) so every number below can be worked out by hand. Times are local wall-clock
// times, so the file passes in any timezone; the DST block checks the numbers of both an
// hour-shifting zone (TZ=America/New_York) and one without DST.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clock, local, startApp, guardNetwork, restoreNetwork, MIN, DAY } from './suite/helpers/sessions-stats-harness.js';
import { flushRollups } from '../src/services/rollup.js';
import { segmentEras, ERA_RULES } from '../src/services/insights.js';

// Wednesday 2026-03-18 15:00 local
const NOW = local(2026, 3, 18, 15);

/** A tiny library writer: games, entries, sessions, achievements (entries' totals kept equal to their sessions). */
function writer(db) {
  const game = (title, { status = 'unset', hidden = 0 } = {}) => Number(db.prepare('INSERT INTO games(title, norm_title, status, hidden, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title, title.toLowerCase(), status, hidden, local(2025, 1, 1), local(2025, 1, 1)).lastInsertRowid);
  const entry = (gameId, platform, { excluded = 0, hist = {}, lastPlayed = null, firstPlayed = null } = {}) => Number(db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, excluded, hist, last_played_at, first_played_at)
    VALUES (NULL, ?, ?, ?, 'x', 0, ?, ?, ?, ?, ?)`).run(gameId, platform, `ext-${gameId}-${platform}`, local(2025, 1, 1), excluded, JSON.stringify(hist), lastPlayed, firstPlayed).lastInsertRowid);
  const ins = db.prepare('INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const bump = db.prepare('UPDATE entries SET playtime_min = playtime_min + ? WHERE id = ?');
  const add = (e, kind, minutes, ws, we, st, en, device = null) => { const id = Number(ins.run(e, kind === 'play' ? 'manual' : 'inferred', kind, minutes, ws, we, st, en, we ?? 0, device).lastInsertRowid); bump.run(minutes, e); return id; };
  return {
    game, entry,
    /** exact tracked session */
    play: (e, start, end, device) => add(e, 'play', Math.round((end - start) / MIN), start, end, start, end, device),
    /** tracked session known only by its sync window */
    window: (e, from, to, minutes) => add(e, 'play', minutes, from, to, null, null),
    estimate: (e, from, to, minutes) => add(e, 'estimate', minutes, from, to, null, null),
    baseline: (e, minutes) => add(e, 'baseline', minutes, null, null, null, null),
    achievements: (e, list) => {
      const a = db.prepare('INSERT INTO achievements(entry_id, ach_id, unlocked, unlocked_at, first_seen_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)');
      list.forEach(([unlocked, at], i) => a.run(e, `a${i}`, unlocked ? 1 : 0, at ?? null));
    },
  };
}

describe('insights on a hand-built library', () => {
  let h; let ids;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    const w = writer(h.db);
    const g = {
      alpha: w.game('Alpha', { status: 'playing' }), beta: w.game('Beta', { status: 'backlog' }), gamma: w.game('Gamma', { status: 'completed' }),
      delta: w.game('Delta'), epsilon: w.game('Epsilon', { status: 'wishlist' }), old: w.game('Old', { status: 'paused' }), zeta: w.game('Zeta', { hidden: 1 }),
    };
    const e = {
      alpha: w.entry(g.alpha, 'steam'),
      beta: w.entry(g.beta, 'xbox', { hist: { date_added: local(2023, 5, 1) } }),
      gamma: w.entry(g.gamma, 'psn'),
      delta: w.entry(g.delta, 'steam', { excluded: 1 }), // a double count: never counts anywhere
      epsilon: w.entry(g.epsilon, 'psn'),
      old: w.entry(g.old, 'steam', { hist: { date_added: local(2022, 1, 10) }, lastPlayed: local(2024, 6, 3, 12), firstPlayed: local(2024, 5, 20, 12) }),
      zeta: w.entry(g.zeta, 'steam'),
    };
    const s = {
      s1: w.play(e.alpha, local(2026, 3, 16, 20), local(2026, 3, 16, 22), 'Steam Deck'), // Mon 120
      s2: w.play(e.alpha, local(2026, 3, 14, 23), local(2026, 3, 15, 1), 'PC'), // Sat 23:00 -> Sun 01:00: 60 + 60
      s3: w.play(e.beta, local(2026, 3, 17, 10), local(2026, 3, 17, 10, 20)), // Tue 20
      s4: w.window(e.beta, local(2026, 3, 10), local(2026, 3, 11), 300), // a day's sync window: Tue 300, no time of day
      s5: w.play(e.gamma, local(2026, 2, 2, 18), local(2026, 2, 2, 21, 30)), // Mon 210
      s6: w.play(e.gamma, local(2025, 3, 18, 12), local(2025, 3, 18, 12, 45)), // Tue 45, a year ago
      s7: w.play(e.delta, local(2026, 3, 16, 8), local(2026, 3, 16, 14), 'Excluded Box'), // excluded: 360
      s8: w.play(e.gamma, local(2026, 1, 20, 19), local(2026, 1, 20, 20)), // Tue 60
    };
    w.estimate(e.alpha, local(2026, 1, 1), local(2026, 1, 11), 600); // history: 60 a day, Jan 1-10
    w.estimate(e.old, local(2024, 6, 1), local(2024, 6, 3), 240); // history: 120 a day, Jun 1-2 2024
    w.baseline(e.old, 500); // undated history: totals only
    w.achievements(e.gamma, [[1, local(2026, 2, 2, 19)], [1, local(2026, 2, 2, 19, 30)], [1, local(2025, 3, 18, 12, 30)], [0]]);
    w.achievements(e.alpha, [[1, null], [0]]);
    w.achievements(e.delta, [[1, local(2026, 3, 16, 9)], [1, local(2026, 3, 16, 10)]]);
    flushRollups(h.db);
    ids = { g, e, s };
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('punchcard: weekday x hour of exact tracked play; window sessions, estimates and excluded entries left out', async () => {
    const p = await h.get('/stats/punchcard?range=30d');
    assert.equal(p.estimates, 'exclude');
    assert.equal(p.week_starts_on, 1);
    assert.equal(p.range.label, 'Last 30 days');
    assert.equal(p.range.from, local(2026, 2, 17));
    assert.equal(p.minutes.length, 7);
    assert.ok(p.minutes.every((row) => row.length === 24));
    const cells = [];
    p.minutes.forEach((row, wd) => row.forEach((m, hr) => { if (m) cells.push([wd, hr, m]); }));
    // Sun 00h and Sat 23h: the session across midnight split by local day
    assert.deepEqual(cells, [[0, 0, 60], [1, 20, 60], [1, 21, 60], [2, 10, 20], [6, 23, 60]]);
    assert.deepEqual(p.weekday, [60, 120, 20, 0, 0, 0, 60]);
    assert.equal(p.hours[0], 60); assert.equal(p.hours[10], 20); assert.equal(p.hours[23], 60);
    assert.equal(p.total_minutes, 260);
    assert.equal(p.tracked_minutes, 560, 'tracked play in range, window session included');
    assert.equal(p.untimed_minutes, 300);
    assert.deepEqual(p.days, [4, 4, 5, 5, 4, 4, 4], 'Feb 17 (Tue) .. Mar 18 (Wed)');
    assert.deepEqual(p.busiest, { weekday: 1, hour: 20, minutes: 60 }, 'ties: the first in week order (Monday first)');
    assert.deepEqual(p.busiest_weekday, { weekday: 1, minutes: 120 });
    assert.deepEqual(p.busiest_hour, { hour: 0, minutes: 60 });
    // filters
    const steam = await h.get('/stats/punchcard?range=30d&platform=steam');
    assert.equal(steam.total_minutes, 240, 'Alpha only - the excluded Steam entry never counts');
    const beta = await h.get(`/stats/punchcard?range=30d&game_id=${ids.g.beta}`);
    assert.deepEqual([beta.total_minutes, beta.tracked_minutes, beta.untimed_minutes], [20, 320, 300]);
    const all = await h.get('/stats/punchcard?range=all');
    assert.equal(all.total_minutes, 575);
    assert.equal(all.range.from, local(2025, 3, 18), 'all starts on the first day of tracked play');
    const empty = await h.get('/stats/punchcard?range=year:2020');
    assert.equal(empty.total_minutes, 0);
    assert.equal(empty.busiest, null);
    assert.equal((await h.call('GET', '/stats/punchcard?range=year:20x')).status, 400);
  });

  test('session lengths: histogram, median, p90, longest; exact-only', async () => {
    const l = await h.get('/stats/session-lengths?range=30d');
    assert.equal(l.estimates, 'exclude');
    assert.deepEqual([l.sessions, l.exact_sessions, l.total_minutes, l.mean_minutes, l.median_minutes, l.p90_minutes], [4, 3, 560, 140, 120, 300]);
    assert.deepEqual(l.buckets.map((b) => [b.label, b.count, b.minutes]), [['<15m', 0, 0], ['15-30m', 1, 20], ['30-60m', 0, 0], ['1-2h', 0, 0], ['2-3h', 2, 240], ['3-5h', 0, 0], ['5h+', 1, 300]]);
    assert.deepEqual(l.buckets.map((b) => [b.min, b.max]), [[0, 15], [15, 30], [30, 60], [60, 120], [120, 180], [180, 300], [300, null]]);
    assert.deepEqual(l.longest, { session_id: ids.s.s4, minutes: 300, game_id: ids.g.beta, title: 'Beta', cover_url: null, platform: 'xbox', started_at: null, ended_at: local(2026, 3, 11), day: '2026-03-10', precise: false });
    const x = await h.get('/stats/session-lengths?range=30d&exact=true');
    assert.deepEqual([x.exact_only, x.sessions, x.median_minutes, x.p90_minutes], [true, 3, 120, 120]);
    assert.equal(x.longest.session_id, ids.s.s2, 'a tie goes to the first to reach that length');
    assert.equal(x.longest.started_at, local(2026, 3, 14, 23));
    const all = await h.get('/stats/session-lengths?range=all');
    assert.deepEqual([all.sessions, all.total_minutes, all.mean_minutes, all.median_minutes, all.p90_minutes], [7, 875, 125, 120, 300], 'the excluded 6h session is not here');
    const g = await h.get(`/stats/session-lengths?range=all&game_id=${ids.g.gamma}`);
    assert.deepEqual([g.sessions, g.median_minutes, g.p90_minutes, g.longest.minutes], [3, 60, 210, 210]);
    const none = await h.get('/stats/session-lengths?range=year:2020');
    assert.deepEqual([none.sessions, none.median_minutes, none.p90_minutes, none.longest], [0, null, null, null]);
  });

  test('platforms over time: stacks per week (week start setting), tracked and estimated apart, estimates= as on /stats', async () => {
    const wk = await h.get('/stats/platforms?range=month:2026-03&group=week');
    assert.deepEqual(wk.range.group, 'week');
    assert.deepEqual(wk.keys, ['2026-02-23', '2026-03-02', '2026-03-09', '2026-03-16']);
    assert.deepEqual(wk.series.map((s) => [s.name, s.minutes, s.tracked]), [['xbox', 320, [0, 0, 300, 20]], ['steam', 240, [0, 0, 120, 120]]]);
    assert.deepEqual(wk.totals, { tracked: [0, 0, 420, 140], estimated: [0, 0, 0, 0] });
    try {
      await h.put('/settings', { week_starts_on: 0 });
      const sun = await h.get('/stats/platforms?range=month:2026-03&group=week');
      assert.deepEqual(sun.keys, ['2026-03-01', '2026-03-08', '2026-03-15']);
      assert.deepEqual(sun.series.find((s) => s.name === 'steam').tracked, [0, 60, 180], 'Sunday 03-15 opens a week now');
    } finally { await h.put('/settings', { week_starts_on: 1 }); }

    const y = await h.get('/stats/platforms?range=year:2026&group=month');
    assert.deepEqual(y.keys, ['2026-01', '2026-02', '2026-03']);
    const by = Object.fromEntries(y.series.map((s) => [s.name, s]));
    assert.deepEqual(by.steam, { name: 'steam', minutes: 840, tracked_minutes: 240, estimated_minutes: 600, tracked: [0, 0, 240], estimated: [600, 0, 0] });
    assert.deepEqual(by.psn, { name: 'psn', minutes: 270, tracked_minutes: 270, estimated_minutes: 0, tracked: [60, 210, 0], estimated: [0, 0, 0] });
    assert.equal(y.estimates, 'include');
    const ex = await h.get('/stats/platforms?range=year:2026&group=month&estimates=exclude');
    assert.deepEqual(ex.series.find((s) => s.name === 'steam').estimated, [0, 0, 0]);
    assert.equal(ex.series.find((s) => s.name === 'steam').minutes, 240);
    const only = await h.get('/stats/platforms?range=year:2026&group=month&estimates=only');
    assert.deepEqual(only.series.map((s) => [s.name, s.minutes, s.tracked, s.estimated]), [['steam', 600, [0, 0, 0], [600, 0, 0]]]);
    // the stats_estimates setting is the default
    try {
      await h.put('/settings', { stats_estimates: 'exclude' });
      const d = await h.get('/stats/platforms?range=year:2026&group=month');
      assert.equal(d.estimates, 'exclude');
      assert.equal(d.totals.estimated[0], 0);
    } finally { await h.put('/settings', { stats_estimates: 'include' }); }

    const dev = await h.get('/stats/platforms?range=month:2026-03&group=month&by=device');
    assert.equal(dev.by, 'device');
    assert.deepEqual(dev.series.map((s) => [s.name, s.minutes]), [[null, 320], ['PC', 120], ['Steam Deck', 120]], 'the excluded entry\'s device is not here');
    const devY = await h.get('/stats/platforms?range=year:2026&group=month&by=device');
    assert.deepEqual(devY.series.find((s) => s.name === null).estimated, [600, 0, 0], 'history has no device');
    assert.equal((await h.call('GET', '/stats/platforms?by=os')).status, 400);
    assert.equal((await h.call('GET', '/stats/platforms?group=hour')).status, 400);
  });

  test('timeline: swimlanes of the top games, others, monthly leaders and eras', async () => {
    const t = await h.get('/stats/timeline?range=year:2026&group=month');
    assert.deepEqual(t.keys, ['2026-01', '2026-02', '2026-03']);
    assert.equal(t.games_played, 3);
    assert.deepEqual(t.games.map((x) => [x.title, x.minutes, x.estimated_minutes, x.tracked, x.estimated, x.first_day, x.last_day]), [
      ['Alpha', 840, 600, [0, 0, 240], [600, 0, 0], '2026-01-01', '2026-03-16'],
      ['Beta', 320, 0, [0, 0, 320], [0, 0, 0], '2026-03-10', '2026-03-17'],
      ['Gamma', 270, 0, [60, 210, 0], [0, 0, 0], '2026-01-20', '2026-02-02'],
    ]);
    assert.deepEqual(t.others, { tracked: [0, 0, 0], estimated: [0, 0, 0] });
    assert.deepEqual(t.months.map((m) => [m.month, m.title, m.minutes, m.estimated_minutes, m.month_minutes, m.share]), [
      ['2026-01', 'Alpha', 600, 600, 660, 0.909], ['2026-02', 'Gamma', 210, 0, 210, 1], ['2026-03', 'Beta', 320, 0, 560, 0.571],
    ]);
    const two = await h.get('/stats/timeline?range=year:2026&group=month&limit=2');
    assert.deepEqual(two.games.map((x) => x.title), ['Alpha', 'Beta']);
    assert.deepEqual(two.others, { tracked: [60, 210, 0], estimated: [0, 0, 0] }, 'Gamma goes to others');
    // tracked only: Gamma leads January and February - one era
    const ex = await h.get('/stats/timeline?range=all&estimates=exclude');
    assert.equal(ex.range.group, 'month');
    assert.deepEqual(ex.eras.map((x) => [x.kind, x.title, x.from, x.to, x.months, x.minutes, x.ordinal, x.color_index]), [
      ['game', 'Gamma', '2025-03', '2025-03', 1, 45, 1, 0], ['break', null, '2025-04', '2025-12', 9, 0, null, null],
      ['game', 'Gamma', '2026-01', '2026-02', 2, 270, 2, 0], ['game', 'Beta', '2026-03', '2026-03', 1, 320, 1, 1]]);
    assert.deepEqual(ex.era_range, { from: '2025-03', to: '2026-03', months: 13 });
    // every era: the old fields, then what it is, its share of all play in it and what came alongside
    assert.deepEqual(ex.eras[3], {
      game_id: ids.g.beta, title: 'Beta', cover_url: null, from: '2026-03', to: '2026-03', months: 1, minutes: 320, estimated_minutes: 0,
      kind: 'game', share: 0.571, total_minutes: 560, alongside: [{ game_id: ids.g.alpha, title: 'Alpha', cover_url: null, minutes: 240, estimated_minutes: 0, share: 0.429 }], games: [], ordinal: 1, color_index: 1,
    });
    assert.deepEqual(ex.eras[1], { game_id: null, title: null, cover_url: null, from: '2025-04', to: '2025-12', months: 9, minutes: 0, estimated_minutes: 0, kind: 'break', share: null, total_minutes: 0, alongside: [], games: [], ordinal: null, color_index: null });
    const inc = await h.get('/stats/timeline?range=all');
    assert.deepEqual(inc.eras.map((x) => [x.kind, x.title, x.from, x.to]), [['game', 'Old', '2024-06', '2024-06'], ['break', null, '2024-07', '2025-02'], ['game', 'Gamma', '2025-03', '2025-03'], ['break', null, '2025-04', '2025-12'],
      ['game', 'Alpha', '2026-01', '2026-01'], ['game', 'Gamma', '2026-02', '2026-02'], ['game', 'Beta', '2026-03', '2026-03']]);
    assert.equal(inc.eras[0].estimated_minutes, 240, 'an era of history is marked as such');
    assert.deepEqual(inc.eras.map((x) => x.color_index), [0, null, 1, null, 2, 1, 3], 'one colour per game, in order of first appearance');
    const yr = await h.get('/stats/timeline?range=year:2026');
    assert.deepEqual(yr.era_range, { from: '2026-01', to: '2026-03', months: 3 }, 'the year so far');
    const weekly = await h.get('/stats/timeline?range=30d');
    assert.equal(weekly.range.group, 'week', 'short ranges default to weeks');
    assert.equal(weekly.keys[0], '2026-02-16');
  });

  test('a game\'s curve: cumulative tracked / estimated, sessions and unlocks per month, first / last played', async () => {
    const c = await h.get(`/games/${ids.g.gamma}/stats`);
    assert.equal(c.group, 'month');
    assert.equal(c.series.length, 13, '2025-03 .. 2026-03');
    const k = Object.fromEntries(c.series.map((s) => [s.key, s]));
    assert.deepEqual(k['2025-03'], { key: '2025-03', minutes: 45, tracked: 45, estimated: 0, sessions: 1, unlocked: 1, cumulative_tracked: 45, cumulative_estimated: 0, cumulative_unlocked: 1 });
    assert.deepEqual(k['2026-02'], { key: '2026-02', minutes: 210, tracked: 210, estimated: 0, sessions: 1, unlocked: 2, cumulative_tracked: 315, cumulative_estimated: 0, cumulative_unlocked: 3 });
    assert.deepEqual([k['2025-12'].cumulative_tracked, k['2026-01'].cumulative_tracked, k['2026-03'].cumulative_tracked], [45, 105, 315]);
    assert.deepEqual(c.totals, { minutes: 315, tracked_minutes: 315, estimated_minutes: 0, baseline_minutes: 0, sessions: 3 });
    assert.deepEqual(c.achievements, { total: 4, unlocked: 3, undated: 0, percent: 75 });
    assert.deepEqual([c.first_day, c.last_day, c.first_session_at, c.last_session_at], ['2025-03-18', '2026-02-02', local(2025, 3, 18, 12), local(2026, 2, 2, 21, 30)]);

    const a = await h.get(`/games/${ids.g.alpha}/stats`);
    assert.deepEqual(a.series.map((s) => [s.key, s.tracked, s.estimated, s.sessions, s.cumulative_tracked, s.cumulative_estimated]), [['2026-01', 0, 600, 0, 0, 600], ['2026-02', 0, 0, 0, 0, 600], ['2026-03', 240, 0, 2, 240, 600]]);
    assert.deepEqual(a.achievements, { total: 2, unlocked: 1, undated: 1, percent: 50 });
    const ax = await h.get(`/games/${ids.g.alpha}/stats?estimates=exclude`);
    assert.deepEqual(ax.series.map((s) => [s.key, s.tracked, s.estimated]), [['2026-03', 240, 0]]);
    assert.equal(ax.totals.estimated_minutes, 600, 'totals always tell every kind apart');
    const ad = await h.get(`/games/${ids.g.alpha}/stats?group=day`);
    assert.deepEqual(ad.series.filter((s) => s.tracked).map((s) => [s.key, s.tracked]), [['2026-03-14', 60], ['2026-03-15', 60], ['2026-03-16', 120]]);
    assert.equal(ad.series.find((s) => s.key === '2026-03-15').sessions, 1, 'counted on the day it ended');

    const o = await h.get(`/games/${ids.g.old}/stats`);
    assert.deepEqual(o.totals, { minutes: 740, tracked_minutes: 0, estimated_minutes: 240, baseline_minutes: 500, sessions: 0 });
    assert.equal(o.series[0].key, '2024-06');
    assert.equal(o.series[0].estimated, 240);
    assert.equal(o.platform_first_played_at, local(2024, 5, 20, 12));
    assert.equal(o.platform_last_played_at, local(2024, 6, 3, 12));
    const d = await h.get(`/games/${ids.g.delta}/stats`);
    assert.deepEqual([d.series, d.totals.minutes, d.achievements.total], [[], 0, 0], 'an excluded entry adds nothing');
    assert.equal((await h.call('GET', '/games/99999/stats')).status, 404);
  });

  test('library overview: status, platform, years, played, dusty, backlog age, hours, completion', async () => {
    const l = await h.get('/stats/library');
    assert.deepEqual([l.hidden_included, l.games, l.played, l.never_played, l.minutes, l.tracked_minutes, l.history_minutes], [false, 6, 4, 2, 2215, 875, 1340]);
    const st = Object.fromEntries(l.by_status.map((s) => [s.status, s]));
    assert.deepEqual(l.by_status.map((s) => s.status), ['unset', 'backlog', 'playing', 'paused', 'completed', 'beaten', 'dropped', 'wishlist']);
    assert.deepEqual(st.playing, { status: 'playing', games: 1, played: 1, minutes: 840, tracked_minutes: 240, history_minutes: 600 });
    assert.deepEqual(st.paused, { status: 'paused', games: 1, played: 1, minutes: 740, tracked_minutes: 0, history_minutes: 740 });
    assert.deepEqual(st.unset, { status: 'unset', games: 1, played: 0, minutes: 0, tracked_minutes: 0, history_minutes: 0 }, 'Delta: its only entry is excluded');
    assert.deepEqual(st.beaten.games, 0);
    assert.deepEqual(l.by_platform, [
      { platform: 'steam', games: 3, played: 2, minutes: 1580, tracked_minutes: 240, history_minutes: 1340 },
      { platform: 'xbox', games: 1, played: 1, minutes: 320, tracked_minutes: 320, history_minutes: 0 },
      { platform: 'psn', games: 2, played: 1, minutes: 315, tracked_minutes: 315, history_minutes: 0 },
    ]);
    assert.deepEqual(l.by_first_played_year, [{ year: 2024, games: 1, minutes: 740, from_history: 1 }, { year: 2025, games: 1, minutes: 315, from_history: 0 }, { year: 2026, games: 2, minutes: 1160, from_history: 1 }]);
    assert.equal(l.first_played_unknown, 0);
    assert.deepEqual(l.by_year_added, [{ year: 2022, games: 1, minutes: 740 }, { year: 2023, games: 1, minutes: 320 }]);
    assert.equal(l.added_unknown, 4);
    assert.deepEqual(l.hours.map((b) => [b.label, b.games, b.minutes]), [['Never', 2, 0], ['<1h', 0, 0], ['1-5h', 0, 0], ['5-10h', 2, 635], ['10-25h', 2, 1580], ['25-50h', 0, 0], ['50-100h', 0, 0], ['100h+', 0, 0]]);
    assert.deepEqual(l.dusty, { count: 1, minutes: 740, items: [{ game_id: ids.g.old, title: 'Old', cover_url: null, status: 'paused', minutes: 740, last_played_at: local(2024, 6, 3, 12), days_since: 653 }] });
    assert.deepEqual([l.backlog.count, l.backlog.minutes, l.backlog.median_days], [1, 320, 1052]);
    assert.deepEqual(l.backlog.buckets.map((b) => b.games), [0, 0, 0, 0, 1]);
    assert.deepEqual(l.backlog.oldest, [{ game_id: ids.g.beta, title: 'Beta', cover_url: null, since: local(2023, 5, 1), days: 1052, minutes: 320 }]);
    assert.deepEqual(l.completion, { games: 2, truncated: false, points: [
      { game_id: ids.g.alpha, title: 'Alpha', minutes: 840, percent: 50, unlocked: 1, total: 2, status: 'playing' },
      { game_id: ids.g.gamma, title: 'Gamma', minutes: 315, percent: 75, unlocked: 3, total: 4, status: 'completed' },
    ] }, 'the excluded entry\'s achievements are not here');
    const capped = await h.get('/stats/library?points=1&dusty_limit=0');
    assert.deepEqual([capped.completion.points.length, capped.completion.truncated, capped.dusty.items.length, capped.dusty.count], [1, true, 0, 1]);
    const hid = await h.get('/stats/library?hidden=true');
    assert.deepEqual([hid.games, hid.never_played], [7, 3]);
  });

  test('year over year: months tracked / estimated, the same date in each year, top game, new games', async () => {
    const y = await h.get('/stats/year-over-year');
    assert.deepEqual(y.years.map((x) => x.year), [2025, 2026]);
    const [a, b] = y.years;
    assert.deepEqual([a.partial, a.total_minutes, a.tracked_minutes, a.estimated_minutes, a.sessions, a.games_played, a.days_played, a.new_games], [false, 45, 45, 0, 1, 1, 1, 1]);
    assert.deepEqual(a.to_date, { through: '03-18', minutes: 45, tracked_minutes: 45, estimated_minutes: 0 });
    assert.deepEqual(a.top_game, { game_id: ids.g.gamma, title: 'Gamma', cover_url: null, minutes: 45, estimated_minutes: 0 });
    assert.deepEqual(a.months[2], { month: 3, key: '2025-03', minutes: 45, tracked: 45, estimated: 0, sessions: 1 });
    assert.equal(a.months.length, 12);
    assert.deepEqual([b.partial, b.total_minutes, b.tracked_minutes, b.estimated_minutes, b.sessions, b.games_played, b.days_played, b.new_games], [true, 1430, 830, 600, 6, 3, 7, 2]);
    assert.deepEqual(b.months.slice(0, 4).map((m) => [m.minutes, m.tracked, m.estimated, m.sessions]), [[660, 60, 600, 1], [210, 210, 0, 1], [560, 560, 0, 4], [0, 0, 0, 0]]);
    assert.deepEqual(b.to_date, { through: '03-18', minutes: 1430, tracked_minutes: 830, estimated_minutes: 600 });
    assert.deepEqual([b.top_game.title, b.top_game.minutes, b.top_game.estimated_minutes], ['Alpha', 840, 600]);
    const ex = await h.get('/stats/year-over-year?years=2024,2026&estimates=exclude');
    assert.deepEqual(ex.years.map((x) => [x.year, x.total_minutes, x.estimated_minutes, x.new_games, x.top_game?.title ?? null]), [[2024, 0, 0, 0, null], [2026, 830, 0, 2, 'Beta']]);
    const old = await h.get('/stats/year-over-year?years=2024');
    assert.deepEqual([old.years[0].estimated_minutes, old.years[0].new_games, old.years[0].months[5].estimated, old.years[0].days_played], [240, 1, 240, 0], 'history never makes a tracked day');
    const steam = await h.get('/stats/year-over-year?platform=steam');
    assert.equal(steam.years[1].total_minutes, 840);
    for (const bad of ['26', '2025,abc', Array.from({ length: 11 }, (_, i) => 2000 + i).join(',')]) assert.equal((await h.call('GET', `/stats/year-over-year?years=${bad}`)).status, 400, bad);
  });

  test('records and highlights', async () => {
    const r = await h.get('/stats/records');
    assert.equal(r.range.label, 'All time');
    assert.deepEqual([r.tracked_minutes, r.estimated_minutes, r.sessions, r.days_played, r.games_played], [875, 840, 7, 8, 4]);
    assert.deepEqual([r.longest_session.session_id, r.longest_session.minutes, r.longest_session.day], [ids.s.s4, 300, '2026-03-10']);
    assert.deepEqual([r.first_session.session_id, r.first_session.title, r.first_session.day], [ids.s.s6, 'Gamma', '2025-03-18']);
    assert.deepEqual(r.biggest_day, { day: '2026-03-10', minutes: 300 });
    assert.deepEqual(r.best_week, { key: '2026-03-09', from: '2026-03-09', to: '2026-03-15', minutes: 420 });
    assert.deepEqual(r.best_month, { key: '2026-03', minutes: 560 });
    assert.deepEqual(r.longest_streak, { days: 4, from: '2026-03-14', to: '2026-03-17' });
    assert.equal(r.current_streak, 4, 'through yesterday');
    assert.deepEqual(r.most_played, { game_id: ids.g.alpha, title: 'Alpha', cover_url: null, minutes: 840, estimated_minutes: 600, share: 0.49 });
    assert.equal(r.most_played_by.group, 'year');
    assert.deepEqual(r.most_played_by.items.map((x) => [x.key, x.title, x.minutes, x.share]), [['2024', 'Old', 240, 1], ['2025', 'Gamma', 45, 1], ['2026', 'Alpha', 840, 0.587]]);
    assert.deepEqual(r.weekday, [60, 330, 425, 0, 0, 0, 60]);
    assert.equal(r.hours.reduce((a, b) => a + b, 0), 575);
    assert.deepEqual(r.highlights.map((x) => x.text), [
      'Longest session: 5h of Beta on 2026-03-10.',
      'Biggest day: 5h on 2026-03-10.',
      'Best week: 7h in the week of 2026-03-09.',
      'Longest streak: 4 days in a row (2026-03-14 to 2026-03-17).',
      'Alpha was 49% of your play time (14h).',
      'You play most on Tuesdays (49% of tracked play).',
      'Most of your timed play is in the evening (18:00-24:00): 78%.',
      'First tracked session: Gamma on 2025-03-18.',
    ]);
    assert.deepEqual(r.highlights[0], { id: 'longest_session', text: r.highlights[0].text, value: 300, unit: 'minutes', game_id: ids.g.beta, day: '2026-03-10', session_id: ids.s.s4 });
    assert.deepEqual(r.highlights.map((x) => [x.id, x.value, x.unit]).slice(3, 7), [['longest_streak', 4, 'days'], ['most_played', 49, 'percent'], ['favorite_weekday', 49, 'percent'], ['time_of_day', 78, 'percent']]);

    const ex = await h.get('/stats/records?estimates=exclude&group=month');
    assert.deepEqual([ex.most_played.title, ex.most_played.minutes, ex.estimated_minutes, ex.biggest_day.minutes], ['Beta', 320, 0, 300]);
    assert.deepEqual(ex.most_played_by.items.map((x) => [x.key, x.title]), [['2025-03', 'Gamma'], ['2026-01', 'Gamma'], ['2026-02', 'Gamma'], ['2026-03', 'Beta']]);
    const month = await h.get('/stats/records?range=month:2026-02');
    assert.deepEqual([month.sessions, month.biggest_day.day, month.longest_streak.days, month.first_session.session_id], [1, '2026-02-02', 1, ids.s.s5]);
    assert.equal(month.highlights.find((x) => x.id === 'longest_streak'), undefined, 'a one-day streak is no highlight');
    try {
      await h.put('/settings', { week_starts_on: 0 });
      assert.deepEqual((await h.get('/stats/records')).best_week, { key: '2026-03-08', from: '2026-03-08', to: '2026-03-14', minutes: 360 });
    } finally { await h.put('/settings', { week_starts_on: 1 }); }
    const none = await h.get('/stats/records?range=year:2020');
    assert.deepEqual([none.longest_session, none.biggest_day, none.best_week, none.longest_streak, none.most_played, none.highlights], [null, null, null, null, null, []]);
    assert.equal((await h.call('GET', '/stats/records?group=week')).status, 400);
  });

  test('a write shows up at once (cached answers are dropped on any change)', async () => {
    const before = await h.get('/stats/punchcard?range=30d');
    const lib = await h.get('/stats/library');
    await h.post('/sessions', { game_id: ids.g.epsilon, minutes: 30, started_at: local(2026, 3, 18, 9) });
    const after = await h.get('/stats/punchcard?range=30d');
    assert.equal(after.minutes[3][9], 30, 'Wednesday 09h');
    assert.equal(after.total_minutes, before.total_minutes + 30);
    const lib2 = await h.get('/stats/library');
    assert.deepEqual([lib2.played, lib2.minutes], [lib.played + 1, lib.minutes + 30]);
    assert.equal((await h.get('/stats/records')).current_streak, 5);
  });

  test('every insight route is in the OpenAPI document with a summary, query docs and a response description', async () => {
    const doc = await h.get('/api/openapi.json');
    const want = { '/api/v1/stats/punchcard': ['range'], '/api/v1/stats/session-lengths': ['range', 'exact'], '/api/v1/stats/platforms': ['range', 'group', 'by', 'estimates'],
      '/api/v1/stats/timeline': ['range', 'group', 'limit', 'estimates'], '/api/v1/games/{id}/stats': ['group', 'estimates'], '/api/v1/stats/library': ['hidden', 'points', 'dusty_limit'],
      '/api/v1/stats/year-over-year': ['years', 'estimates'], '/api/v1/stats/records': ['range', 'group', 'estimates'] };
    for (const [p, params] of Object.entries(want)) {
      const op = doc.paths[p]?.get;
      assert.ok(op, `${p} documented`);
      assert.ok(op.summary.length > 20, `${p} summary`);
      assert.equal(op.tags[0], 'stats');
      for (const q of params) assert.ok(op.parameters.some((x) => x.name === q && x.in === 'query' && x.description), `${p} ?${q}`);
      assert.ok(op.responses[200].description.length > 80, `${p} returns`);
    }
    assert.match(doc.paths['/api/v1/stats/punchcard'].get.responses[200].description, /estimated history .* no reliable time of day/);
    const tl = doc.paths['/api/v1/stats/timeline'].get.responses[200].description;
    for (const f of ['kind: game | variety | break', 'share', 'total_minutes', 'alongside', 'ordinal', 'color_index', 'era_range']) assert.ok(tl.includes(f), `timeline documents ${f}`);
  });
});

// =====================================================================================
// era segmentation, on hand-built months (shares of all play in a month)
// =====================================================================================
describe('eras: segmentation of months into game, variety and break eras', () => {
  const A = 1; const B = 2; const C = 3; const D = 4; const E = 5;
  let n = 0;
  /** A month of play: { game: minutes }, optionally { game: estimated minutes } of those. */
  const month = (games = {}, est = {}) => {
    const k = n++;
    return { month: `${2025 + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`, games: Object.entries(games).map(([id, m]) => ({ game_id: Number(id), m, e: est[id] || 0 })) };
  };
  const seg = (...months) => { n = 0; return segmentEras(months.map((f) => f())); };
  const brief = (eras) => eras.map((e) => [e.kind, e.game_id, e.from, e.months]);

  test('a narrow one-month win by another game does not split an era; a clear takeover does', () => {
    // B tops February with 55%, but A kept 45%: still A's era
    let eras = seg(() => month({ [A]: 600, [B]: 100 }), () => month({ [A]: 450, [B]: 550 }), () => month({ [A]: 500 }));
    assert.deepEqual(brief(eras), [['game', A, '2025-01', 3]]);
    assert.equal(eras[0].minutes, 1550);
    assert.equal(eras[0].total_minutes, 2200);
    assert.equal(eras[0].share, 0.705);
    // B tops with 45% (not dominant) and A still played 15%: absorbed too
    eras = seg(() => month({ [A]: 600 }), () => month({ [B]: 450, [A]: 150, [C]: 200, [D]: 200 }), () => month({ [A]: 600 }));
    assert.deepEqual(brief(eras), [['game', A, '2025-01', 3]]);
    // a month of variety in the middle, A still at 25%: absorbed
    eras = seg(() => month({ [A]: 600 }), () => month({ [A]: 250, [B]: 250, [C]: 250, [D]: 250 }), () => month({ [A]: 600 }));
    assert.deepEqual(brief(eras), [['game', A, '2025-01', 3]]);
    // B takes 80% and A is down to 20%: a takeover, and A's return is its second era
    eras = seg(() => month({ [A]: 600 }), () => month({ [A]: 200, [B]: 800 }), () => month({ [A]: 600 }));
    assert.deepEqual(brief(eras), [['game', A, '2025-01', 1], ['game', B, '2025-02', 1], ['game', A, '2025-03', 1]]);
    assert.deepEqual(eras.map((e) => e.ordinal), [1, 1, 2]);
    // B tops with 45%, but A barely played (5%): A was not there, the era splits
    eras = seg(() => month({ [A]: 600 }), () => month({ [B]: 450, [A]: 50, [C]: 250, [D]: 250 }), () => month({ [A]: 600 }));
    assert.equal(eras.length, 3);
    // two months of B: not a one-month interruption
    eras = seg(() => month({ [A]: 600 }), () => month({ [A]: 400, [B]: 600 }), () => month({ [A]: 400, [B]: 600 }), () => month({ [A]: 600 }));
    assert.deepEqual(brief(eras), [['game', A, '2025-01', 1], ['game', B, '2025-02', 2], ['game', A, '2025-04', 1]]);
    // interruptions that keep coming back (A B A B A, all narrow) are one era
    eras = seg(() => month({ [A]: 500, [B]: 400 }), () => month({ [A]: 400, [B]: 500 }), () => month({ [A]: 500, [B]: 400 }), () => month({ [A]: 400, [B]: 500 }), () => month({ [A]: 500, [B]: 400 }));
    assert.deepEqual(brief(eras), [['game', A, '2025-01', 5]]);
    // at the edge of the range there is nothing to come back to: the last month stays B's
    eras = seg(() => month({ [A]: 600 }), () => month({ [A]: 450, [B]: 550 }));
    assert.deepEqual(brief(eras), [['game', A, '2025-01', 1], ['game', B, '2025-02', 1]]);
  });

  test('months without a clear lead are variety, listing their top three games; consecutive ones are one era', () => {
    const eras = seg(
      () => month({ [A]: 900, [B]: 100 }),
      () => month({ [B]: 260, [C]: 250, [D]: 250, [E]: 240 }), // top 26%
      () => month({ [C]: 300, [D]: 280, [E]: 260, [A]: 160 }), // top 30%: a lead, however close the runner-up
      () => month({ [A]: 210, [B]: 200, [C]: 200, [D]: 200, [E]: 190 }), // 21%, ties: no lead
      () => month({ [D]: 280, [B]: 260, [C]: 240, [E]: 220 }), // 28%
    );
    assert.deepEqual(brief(eras), [['game', A, '2025-01', 1], ['variety', null, '2025-02', 1], ['game', C, '2025-03', 1], ['variety', null, '2025-04', 2]]);
    const v = eras[3];
    assert.equal(v.minutes, 2000, 'a variety era counts all its play');
    assert.equal(v.total_minutes, 2000);
    assert.equal(v.share, null);
    assert.equal(v.ordinal, null);
    assert.equal(v.color_index, null);
    assert.deepEqual(v.games.map((g) => [g.game_id, g.minutes, g.share]), [[D, 480, 0.24], [B, 460, 0.23], [C, 440, 0.22]]);
    assert.deepEqual(v.alongside, []);
  });

  test('a clear lead: 30% of the month, or 20% and 1.5x the runner-up, or a narrow lead held two months running', () => {
    // 25% against 10%s: clear
    let eras = seg(() => month({ [A]: 250, [B]: 100, [C]: 100, [D]: 100, [E]: 100, 6: 100, 7: 100, 8: 150 }));
    assert.deepEqual(brief(eras), [['game', A, '2025-01', 1]]);
    // 22% against 20%: one month of it is variety...
    eras = seg(() => month({ [A]: 220, [B]: 200, [C]: 200, [D]: 190, [E]: 190 }));
    assert.equal(eras[0].kind, 'variety');
    // ...two months running is A's era
    eras = seg(() => month({ [A]: 220, [B]: 200, [C]: 200, [D]: 190, [E]: 190 }), () => month({ [A]: 230, [C]: 200, [B]: 200, [D]: 190, [E]: 180 }));
    assert.deepEqual(brief(eras), [['game', A, '2025-01', 2]]);
    // but 18% two months running is still variety
    eras = seg(() => month({ [A]: 180, [B]: 170, [C]: 170, [D]: 170, [E]: 160, 6: 150 }), () => month({ [A]: 180, [B]: 170, [C]: 170, [D]: 170, [E]: 160, 6: 150 }));
    assert.deepEqual(brief(eras), [['variety', null, '2025-01', 2]]);
  });

  test('months without play are breaks (merged), none before the first or after the last month played', () => {
    const eras = seg(() => month(), () => month({ [A]: 300 }), () => month(), () => month(), () => month({ [A]: 200 }), () => month({ [B]: 100 }), () => month(), () => month({ [B]: 0.2 }));
    assert.deepEqual(brief(eras), [['game', A, '2025-02', 1], ['break', null, '2025-03', 2], ['game', A, '2025-05', 1], ['game', B, '2025-06', 1]]);
    assert.deepEqual(eras[1], { game_id: null, from: '2025-03', to: '2025-04', months: 2, minutes: 0, estimated_minutes: 0, kind: 'break', share: null, total_minutes: 0, alongside: [], games: [], ordinal: null, color_index: null });
    assert.deepEqual(eras.map((e) => e.ordinal), [1, null, 2, 1], 'a break does not join two eras of a game: the return is its second');
    assert.deepEqual(seg(), []);
    assert.deepEqual(seg(() => month(), () => month()), [], 'a range without play has no eras');
    assert.deepEqual(brief(seg(() => month({ [A]: 5 }))), [['game', A, '2025-01', 1]], 'a single month');
  });

  test('alongside: the other games with at least 5% of the era, top three; estimated minutes kept apart', () => {
    const [e] = seg(() => month({ [A]: 600, [B]: 100, [C]: 60, [D]: 50, [E]: 30 }, { [A]: 400, [B]: 100 }), () => month({ [A]: 400, [B]: 20, [C]: 40, [D]: 10, [E]: 10 }));
    // total 1320: B 120 (9.1%), C 100 (7.6%), D 60 (4.5% - left out), E 40
    assert.deepEqual(e.alongside, [{ game_id: B, minutes: 120, estimated_minutes: 100, share: 0.091 }, { game_id: C, minutes: 100, estimated_minutes: 0, share: 0.076 }]);
    assert.equal(e.minutes, 1000);
    assert.equal(e.estimated_minutes, 400);
    assert.equal(e.share, 0.758);
    assert.ok(ERA_RULES.alongside === 0.05);
  });

  test('color_index: one per game in order of first appearance, the same for its returns', () => {
    const eras = seg(() => month({ [C]: 500 }), () => month({ [A]: 500 }), () => month(), () => month({ [B]: 500, [A]: 50 }), () => month({ [A]: 500 }), () => month({ [D]: 100, [E]: 100, [B]: 100, [C]: 100 }), () => month({ [C]: 500 }));
    assert.deepEqual(eras.map((e) => [e.kind, e.game_id, e.color_index, e.ordinal]), [
      ['game', C, 0, 1], ['game', A, 1, 1], ['break', null, null, null], ['game', B, 2, 1], ['game', A, 1, 2], ['variety', null, null, null], ['game', C, 0, 2]]);
    // the same months give the same colours
    assert.deepEqual(seg(() => month({ [C]: 500 }), () => month({ [A]: 500 })).map((e) => e.color_index), [0, 1]);
  });
});

// =====================================================================================
// DST: hours that repeat or never happen (and a session across midnight on a DST night)
// =====================================================================================
describe('punchcard and days on DST change days', () => {
  let h; let g;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    const w = writer(h.db);
    g = w.game('Clock');
    const e = w.entry(g, 'steam');
    w.play(e, local(2025, 11, 2, 0, 30), local(2025, 11, 2, 3, 30)); // fall back: 01:00-02:00 happens twice in New York
    w.play(e, local(2025, 3, 9, 1, 30), local(2025, 3, 9, 3, 30)); // spring forward: 02:00-03:00 never happens
    w.play(e, local(2025, 10, 31, 23), local(2025, 11, 1, 2)); // Fri 23:00 -> Sat 02:00 across midnight
    flushRollups(h.db);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  const dst = () => local(2025, 11, 2, 3, 30) - local(2025, 11, 2, 0, 30) === 4 * 3600_000;

  test('fall back: the repeated hour holds both real hours; the day has 25 hours of play room', async () => {
    const p = await h.get('/stats/punchcard?range=month:2025-11');
    const sun = p.minutes[0];
    if (dst()) assert.deepEqual(sun.slice(0, 4), [30, 120, 60, 30]);
    else assert.deepEqual(sun.slice(0, 4), [30, 60, 60, 30]);
    assert.equal(p.weekday[6], 120, 'Sat 00:00-02:00 of the session across midnight');
    const heat = await h.get('/stats/heatmap?year=2025');
    assert.equal(heat.days['2025-11-02'], dst() ? 240 : 180);
    const l = await h.get('/stats/session-lengths?range=month:2025-11');
    assert.deepEqual(l.buckets.map((b) => b.count), [0, 0, 0, 0, 0, 2, 0], 'two 3-5h sessions (4h of real time in New York)');
  });

  test('spring forward: the missing hour has nothing; a session across midnight is split by local day', async () => {
    const p = await h.get('/stats/punchcard?range=month:2025-03');
    if (dst()) assert.deepEqual(p.minutes[0].slice(1, 4), [30, 0, 30]);
    else assert.deepEqual(p.minutes[0].slice(1, 4), [30, 60, 30]);
    const oct = await h.get('/stats/punchcard?range=month:2025-10');
    assert.deepEqual([oct.weekday[5], oct.minutes[5][23], oct.total_minutes], [60, 60, 60], 'only Friday 23:00-24:00 is in October');
    const r = await h.get('/stats/records?range=year:2025');
    assert.deepEqual(r.biggest_day, { day: '2025-11-02', minutes: dst() ? 240 : 180 });
    assert.deepEqual(r.longest_streak, { days: 3, from: '2025-10-31', to: '2025-11-02' });
  });
});

// =====================================================================================
// a generated large library: every insight endpoint within a time budget
// =====================================================================================
describe('performance on a large library (1,500 games, 50,000 sessions)', () => {
  const GAMES = 1500;
  const SESSIONS = 50_000;
  const BUDGET = Number(process.env.INSIGHTS_BUDGET_MS || 2500); // per cold (uncached) request
  let h; let seeded = 0;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    const db = h.db;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    db.exec('BEGIN');
    const plats = ['steam', 'xbox', 'psn'];
    const statuses = ['unset', 'backlog', 'playing', 'paused', 'completed', 'beaten', 'dropped', 'wishlist'];
    const gIns = db.prepare('INSERT INTO games(title, norm_title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    const eIns = db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, hist) VALUES (NULL, ?, ?, ?, 'x', 0, ?, ?)");
    const sIns = db.prepare('INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const aIns = db.prepare('INSERT INTO achievements(entry_id, ach_id, unlocked, unlocked_at, first_seen_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)');
    const entries = [];
    for (let i = 0; i < GAMES; i++) {
      const gid = Number(gIns.run(`Game ${i}`, `game ${i}`, statuses[i % 8], NOW - 4 * 365 * DAY, NOW).lastInsertRowid);
      const hist = i % 4 === 0 ? JSON.stringify({ date_added: NOW - Math.floor(rnd() * 3000) * DAY }) : '{}';
      const eid = Number(eIns.run(gid, plats[i % 3], `g${i}`, NOW - 3 * 365 * DAY, hist).lastInsertRowid);
      entries.push(eid);
      if (i % 2 === 0) for (let a = 0; a < 20; a++) aIns.run(eid, `a${a}`, rnd() < 0.5 ? 1 : 0, NOW - Math.floor(rnd() * 1000) * DAY);
    }
    for (let i = 0; i < SESSIONS; i++) {
      const e = entries[Math.floor(rnd() ** 2 * entries.length)];
      const end = NOW - Math.floor(rnd() * 3 * 365 * DAY);
      const m = 5 + Math.floor(rnd() * 240);
      if (i % 10 === 0) sIns.run(e, 'inferred', 'estimate', m * 3, end - 30 * DAY, end, null, null, end, null);
      else if (i % 3 === 0) sIns.run(e, 'sync', 'play', m, end - DAY, end, null, null, end, null);
      else sIns.run(e, 'sync', 'play', m, end - m * MIN, end, end - m * MIN, end, end, i % 2 ? 'PS5' : 'Steam Deck');
    }
    db.exec('UPDATE entries SET playtime_min = (SELECT COALESCE(SUM(minutes), 0) FROM sessions s WHERE s.entry_id = entries.id)');
    db.exec('COMMIT');
    seeded = flushRollups(db);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('each endpoint answers within the budget, and cached answers are instant', async () => {
    assert.equal(seeded, SESSIONS);
    const y = new Date(NOW).getFullYear();
    const paths = ['/stats/punchcard?range=all', '/stats/punchcard?range=365d', '/stats/session-lengths?range=all', '/stats/session-lengths?range=30d',
      '/stats/platforms?range=all', '/stats/platforms?range=365d&group=week', '/stats/platforms?range=all&by=device', '/stats/timeline', '/stats/timeline?range=all&limit=50',
      '/games/1/stats', '/games/1/stats?group=day', '/stats/library', '/stats/library?points=2000', `/stats/year-over-year?years=${y - 2},${y - 1},${y}`, '/stats/records', '/stats/records?range=365d'];
    const timings = [];
    for (const p of paths) {
      let t = performance.now();
      const body = await h.get(p);
      const cold = performance.now() - t;
      t = performance.now();
      assert.deepEqual(await h.get(p), body, `${p}: the cached answer is the same`);
      const warm = performance.now() - t;
      timings.push([p, Math.round(cold), Math.round(warm)]);
      assert.ok(cold < BUDGET, `${p} took ${Math.round(cold)}ms (budget ${BUDGET}ms)`);
      assert.ok(warm < 250, `${p} cached took ${Math.round(warm)}ms`);
    }
    if (process.env.INSIGHTS_TIMINGS) for (const [p, c, w] of timings) console.log(`[timing] ${p.padEnd(48)} cold ${String(c).padStart(5)}ms  warm ${String(w).padStart(3)}ms`);
  });

  test('the numbers agree with each other and with /stats at scale', async () => {
    const st = await h.get('/stats?range=all');
    const punch = await h.get('/stats/punchcard?range=all');
    const lengths = await h.get('/stats/session-lengths?range=all');
    const plats = await h.get('/stats/platforms?range=all');
    const rec = await h.get('/stats/records');
    const lib = await h.get('/stats/library?points=2000');
    const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
    near(punch.tracked_minutes, st.tracked_minutes, 1, 'punchcard tracked = /stats tracked');
    near(punch.total_minutes + punch.untimed_minutes, punch.tracked_minutes, 1, 'grid + untimed = tracked');
    assert.equal(lengths.sessions, st.sessions);
    assert.equal(lengths.buckets.reduce((a, b) => a + b.count, 0), lengths.sessions);
    near(plats.series.reduce((a, s) => a + s.minutes, 0), st.total_minutes, plats.series.length, 'platform stacks = /stats total');
    near(plats.series.reduce((a, s) => a + s.estimated_minutes, 0), st.estimated_minutes, plats.series.length, 'estimated apart');
    assert.equal(rec.sessions, st.sessions);
    assert.deepEqual(rec.biggest_day, st.busiest_day);
    assert.equal(rec.longest_session.minutes, st.longest_session.minutes);
    assert.equal(rec.longest_streak?.days ?? 0, st.streaks.longest);
    assert.equal(lib.games, GAMES);
    assert.equal(lib.by_status.reduce((a, s) => a + s.games, 0), GAMES);
    assert.equal(lib.hours.reduce((a, b) => a + b.games, 0), GAMES);
    assert.equal(lib.completion.games, GAMES / 2);
    assert.ok(lib.completion.points.length <= 2000);
    for (let i = 1; i < lib.completion.points.length; i++) assert.ok(lib.completion.points[i - 1].minutes >= lib.completion.points[i].minutes);
  });
});
