// Facts for today (GET /stats/facts), the finish forecast of a game (GET /games/:id/forecast), how
// long the backlog would take (GET /stats/backlog), and the weekly summary carrying facts.
//
// Sessions are logged through the API at local wall-clock times, so the file passes in any timezone.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clock, local, startApp, guardNetwork, restoreNetwork, addGame, logSession } from './suite/helpers/sessions-stats-harness.js';
import { spanText } from '../src/services/forecast.js';

// Wednesday 2026-03-18 15:00 local
const NOW = local(2026, 3, 18, 15);
const meta = (h, id, main, extra = null) => h.db.prepare("INSERT INTO game_meta(game_id, matched_by, ttb_main, ttb_extra, fetched_at) VALUES (?, 'title', ?, ?, ?)").run(id, main, extra, NOW);

describe('facts for today', () => {
  let h; let g;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    g = {};
    for (const t of ['Anniversary', 'Played', 'Century', 'Returner', 'Today']) g[t] = await addGame(h, t);
    // started two years ago today; played again later
    await logSession(h, g.Anniversary, local(2024, 3, 18, 20), 90);
    await logSession(h, g.Anniversary, local(2024, 4, 2, 20), 60);
    // played a year ago today, started earlier that year
    await logSession(h, g.Played, local(2025, 1, 5, 19), 45);
    await logSession(h, g.Played, local(2025, 3, 18, 19), 120);
    // 99 hours in January, 2 more this week: past 100
    for (let d = 20; d <= 28; d++) await logSession(h, g.Century, local(2026, 1, d, 9), 660);
    await logSession(h, g.Century, local(2026, 3, 16, 19), 120);
    // back after more than six months
    await logSession(h, g.Returner, local(2025, 9, 1, 19), 60);
    await logSession(h, g.Returner, local(2026, 3, 17, 19), 60);
    await logSession(h, g.Today, local(2026, 3, 18, 10), 30);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('the most notable first: on this day, a round number passed, a return, a streak', async () => {
    const r = await h.get('/stats/facts');
    assert.equal(r.day, '2026-03-18');
    assert.deepEqual(r.facts.map((f) => [f.kind, f.text]), [
      ['on_this_day', '2 years ago today you started Anniversary: 2h 30m tracked since.'],
      ['on_this_day', 'A year ago today you played Played for 2h.'],
      ['milestone', 'You passed 100 hours in Century this week.'],
      ['comeback', 'You came back to Returner after 6 months away.'],
      ['streak', '3 days in a row, 6 days short of your record.'],
    ]); // no trend: three days of play in the last 30 are too few to compare (see the patterns)
    const [started, played, milestone] = r.facts;
    assert.deepEqual([started.game_id, started.event, started.years_ago, started.day, started.minutes, started.bold], [g.Anniversary, 'started', 2, '2024-03-18', 150, '2 years ago today']);
    assert.deepEqual([played.game_id, played.event, played.years_ago, played.day, played.minutes], [g.Played, 'played', 1, '2025-03-18', 120]);
    assert.deepEqual([milestone.game_id, milestone.hours, milestone.minutes, milestone.bold], [g.Century, 100, 6060, '100 hours']);
    for (const f of r.facts) assert.ok(f.text.includes(f.bold), `${f.kind}: the bold part is part of the text`);
    assert.deepEqual(r.on_this_day.map((f) => f.game_id), [g.Anniversary, g.Played]);
    assert.ok(r.facts.every((f, i) => !i || r.facts[i - 1].score >= f.score), 'by score');
  });

  test('one fact per game; limit cuts the list but on_this_day keeps every anniversary', async () => {
    const r = await h.get('/stats/facts?limit=20');
    const ids = r.facts.map((f) => f.game_id).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, 'Century passed 100 hours and climbed the ranks: one fact');
    const one = await h.get('/stats/facts?limit=1');
    assert.equal(one.facts.length, 1);
    assert.equal(one.on_this_day.length, 2);
    assert.equal((await h.call('GET', '/stats/facts?limit=0')).status, 200, 'a limit out of range is clamped');
  });

  test('the weekly summary carries today\'s anniversary and one more fact, in the numbers and in the text', async () => {
    const s = await h.get('/summary/week');
    assert.deepEqual(s.facts.map((f) => f.kind), ['on_this_day', 'milestone']);
    const lines = s.text.split('\n');
    assert.deepEqual(lines.slice(-2), ['On this day: 2 years ago today you started Anniversary: 2h 30m tracked since.', 'Did you know: You passed 100 hours in Century this week.']);
    const thisWeek = await h.get('/summary/week?weeks_ago=0');
    assert.equal(thisWeek.facts, undefined, 'only last week\'s summary, the one that is sent');
    assert.doesNotMatch(thisWeek.text, /On this day/);
  });

  test('the next day has other facts: nothing happened on March 19', async () => {
    clock.install(local(2026, 3, 19, 9));
    try {
      const r = await h.get('/stats/facts');
      assert.equal(r.day, '2026-03-19');
      assert.deepEqual(r.on_this_day, []);
      assert.ok(r.facts.some((f) => f.kind === 'milestone'), 'still this week');
    } finally { clock.install(NOW); }
  });
});

describe('facts: a new or empty library says nothing rather than something trivial', () => {
  let h;
  before(async () => { guardNetwork(); clock.install(NOW); h = await startApp(); });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('no games: no facts, and the summary is as it was', async () => {
    assert.deepEqual(await h.get('/stats/facts'), { day: '2026-03-18', facts: [], on_this_day: [] });
    const s = await h.get('/summary/week');
    assert.deepEqual(s.facts, []);
    assert.doesNotMatch(s.text, /On this day|Did you know/);
  });

  test('a first week of play sets no "records" and no trend', async () => {
    const a = await addGame(h, 'First');
    await logSession(h, a, local(2026, 3, 17, 19), 240);
    await logSession(h, a, local(2026, 3, 18, 10), 60);
    const r = await h.get('/stats/facts');
    assert.deepEqual(r.facts.map((f) => f.kind), [], JSON.stringify(r.facts));
  });
});

describe('finish forecast and backlog', () => {
  let h; let rpg; let idle; let over; let bare; let done;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    rpg = await addGame(h, 'Long RPG'); meta(h, rpg, 1800);
    idle = await addGame(h, 'Shelved'); meta(h, idle, 600);
    over = await addGame(h, 'Overrun'); meta(h, over, 120);
    bare = await addGame(h, 'No Data');
    done = await addGame(h, 'Finished'); meta(h, done, 600);
    // Long RPG: 2 hours a week over the last four weeks
    for (const d of [18, 11, 4]) await logSession(h, rpg, local(2026, 3, d, 9), 120);
    await logSession(h, rpg, local(2026, 2, 25, 9), 120);
    await logSession(h, idle, local(2025, 11, 2, 19), 90);
    await logSession(h, over, local(2026, 3, 10, 19), 200);
    await logSession(h, done, local(2026, 3, 1, 19), 300);
    await h.patch(`/games/${done}`, { status: 'completed' });
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('a game being played: what is left of the typical length, in weeks at its own pace', async () => {
    const f = await h.get(`/games/${rpg}/forecast`);
    assert.deepEqual({ ...f, text: null }, {
      available: true, game_id: rpg, typical_minutes: 1800, basis: 'main', pace_ratio: 1, personal_pace: false,
      expected_minutes: 1800, played_minutes: 480, remaining_minutes: 1320, percent: 27,
      weekly_minutes: 120, weeks: 11, finish_day: '2026-06-03', state: 'playing', text: null,
    });
    assert.equal(f.text, 'About 3 months to finish: 22h left of 30h typical, at 2h a week.');
  });

  test('not played lately: what is left, without a date; past the typical length: said so', async () => {
    const i = await h.get(`/games/${idle}/forecast`);
    assert.deepEqual([i.state, i.remaining_minutes, i.weekly_minutes, i.weeks, i.finish_day], ['idle', 510, 0, null, null]);
    assert.equal(i.text, 'About 8h 30m left of 10h typical. Not played in the last four weeks.');
    const o = await h.get(`/games/${over}/forecast`);
    assert.deepEqual([o.state, o.remaining_minutes, o.percent, o.weeks], ['past', 0, 100, null]);
    assert.equal(o.text, 'Past the 2h typical: 3h 20m played.');
  });

  test('nothing to forecast: no typical time, finished, dropped, an unknown game', async () => {
    assert.deepEqual(await h.get(`/games/${bare}/forecast`), { available: false, reason: 'no_typical_time', game_id: bare });
    assert.deepEqual(await h.get(`/games/${done}/forecast`), { available: false, reason: 'finished', game_id: done });
    await h.patch(`/games/${idle}`, { status: 'dropped' });
    assert.deepEqual(await h.get(`/games/${idle}/forecast`), { available: false, reason: 'dropped', game_id: idle });
    await h.patch(`/games/${idle}`, { status: 'unset' });
    assert.equal((await h.call('GET', '/games/999999/forecast')).status, 404);
  });

  test('with three finished games the length is scaled by how long this player takes', async () => {
    // each finished in one and a half times the typical time
    for (const [title, typical] of [['Done A', 200], ['Done B', 400]]) {
      const id = await addGame(h, title); meta(h, id, typical);
      await logSession(h, id, local(2025, 6, 1, 9), typical * 1.5);
      await h.patch(`/games/${id}`, { status: 'beaten' });
    }
    // Finished: 300 of 600 is a ratio of 0.5; the median of 0.5, 1.5, 1.5 is 1.5
    const f = await h.get(`/games/${rpg}/forecast`);
    assert.deepEqual([f.pace_ratio, f.personal_pace, f.expected_minutes, f.remaining_minutes, f.weeks], [1.5, true, 2700, 2220, 18.5]);
    assert.equal(f.text, 'About 4 months to finish: 37h left of 45h at your pace, at 2h a week.');
  });

  test('the backlog: what is left of every game marked Backlog, against tracked hours a week', async () => {
    const empty = await h.get('/stats/backlog');
    assert.deepEqual([empty.games, empty.remaining_minutes, empty.weeks, empty.text], [0, 0, null, null]);
    for (const [title, typical] of [['B1', 600], ['B2', 1200], ['B3', 1800], ['B4', null]]) {
      const id = await addGame(h, title);
      if (typical) meta(h, id, typical);
      await h.patch(`/games/${id}`, { status: 'backlog' });
    }
    await h.patch(`/games/${rpg}`, { status: 'backlog' }); // 2700 expected, 480 played
    const b = await h.get('/stats/backlog');
    // at 1.5 times typical: 900 + 1800 + 2700 + 2220 = 7620, and B4 at the median of those (2010)
    assert.deepEqual([b.games, b.with_typical_time, b.assumed, b.remaining_minutes, b.pace_ratio], [5, 4, 1, 9630, 1.5]);
    // tracked in the last 84 days (Dec 25 – Mar 18): 480 + 200 + 300 = 980 minutes over 12 weeks
    assert.equal(b.weekly_minutes, 82);
    assert.equal(b.weeks, 117.9);
    assert.equal(b.years, 2.3);
    assert.deepEqual([b.added_per_month, b.finished_per_month], [null, null], 'a library younger than four months has no rates yet');
    assert.equal(b.text, '5 games in the backlog hold about 160h 30m of play: about 2.3 years at your 1h 22m a week.');
    const fact = (await h.get('/stats/facts?limit=20')).facts.find((f) => f.kind === 'backlog');
    assert.equal(fact.text, 'At your pace the backlog is about 2.3 years of play (5 games, 160h 30m).');
  });
});

describe('spans in words', () => {
  test('weeks, then months, then years', () => {
    assert.deepEqual([0.4, 1, 3.4, 8.9, 9, 30, 77, 78, 117.9, 520].map(spanText),
      ['under a week', 'about 1 week', 'about 3 weeks', 'about 9 weeks', 'about 2 months', 'about 7 months', 'about 18 months', 'about 1.5 years', 'about 2.3 years', 'about 10 years']);
  });
});
