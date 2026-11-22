// Facts and forecasts at their edges: a game that was played before tracking began, a title that
// also occurs in the sentence around it, a span under a week, a backlog of one game.
//
// Sessions are logged at local wall-clock times, so the file passes in any timezone.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clock, local, startApp, guardNetwork, restoreNetwork, addGame, logSession, report } from './suite/helpers/sessions-stats-harness.js';

// Wednesday 2026-03-18 15:00 local
const NOW = local(2026, 3, 18, 15);

describe('facts: a game with hours from before tracking began', () => {
  let h; let g;
  before(async () => {
    guardNetwork();
    // a push account linked on January 2, 2025 with two games already played for a long time
    clock.install(local(2025, 1, 2, 12));
    h = await startApp();
    const acc = await h.post('/accounts', { platform: 'custom', name: 'push', config: {} });
    const push = async (when, id, total, played) => { clock.set(when); await report(h, acc.id, [{ id, title: id, playtime_minutes: total, last_played_at: played }]); };
    await push(local(2025, 1, 2, 12), 'Old Favourite', 30000);
    await push(local(2025, 1, 2, 12), 'Veteran', 6000);
    await push(local(2025, 1, 2, 12), 'Barely Tracked', 5000);
    // Old Favourite: its first tracked day is a year before today
    await push(local(2025, 3, 18, 22), 'Old Favourite', 30150, local(2025, 3, 18, 21));
    await push(local(2025, 4, 18, 22), 'Old Favourite', 30500, local(2025, 4, 18, 21));
    // Veteran: its last tracked day is
    await push(local(2025, 2, 1, 22), 'Veteran', 6200, local(2025, 2, 1, 21));
    await push(local(2025, 3, 18, 23), 'Veteran', 6400, local(2025, 3, 18, 22));
    await push(local(2025, 5, 1, 22), 'Barely Tracked', 5030, local(2025, 5, 1, 21));
    clock.set(NOW);
    g = Object.fromEntries(h.db.prepare('SELECT id, title FROM games').all().map((x) => [x.title, x.id]));
    // a game with no earlier history, started the same day, and three that were only tried
    g.Fresh = await addGame(h, 'Fresh');
    await logSession(h, g.Fresh, local(2025, 3, 18, 10), 200);
    await logSession(h, g.Fresh, local(2025, 6, 18, 10), 200);
    for (const t of ['Tried A', 'Tried B', 'Tried C']) await logSession(h, await addGame(h, t), local(2025, 7, 1, 10), 20);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('its first tracked day is not the day it was started; a game without earlier hours still has its anniversary', async () => {
    const r = await h.get('/stats/facts?limit=20');
    assert.equal(r.day, '2026-03-18');
    const started = r.on_this_day.filter((f) => f.event === 'started');
    assert.deepEqual(started.map((f) => [f.game_id, f.text]), [[g.Fresh, 'A year ago today you started Fresh: you played it for 3 months, 6h 40m in all.']]);
    assert.ok(!r.facts.some((f) => f.game_id === g['Old Favourite'] && /started/.test(f.text)), '500 hours came before the first tracked day');
  });

  test('"in all" is the lifetime total, not only what was tracked', async () => {
    const r = await h.get('/stats/facts?limit=20');
    const last = r.on_this_day.find((f) => f.game_id === g.Veteran);
    // 6000 minutes before tracking and 400 tracked
    assert.deepEqual([last.event, last.text, last.minutes], ['last_played', 'A year ago today was the last time you played Veteran (106h 40m in all).', 6400]);
  });

  test('a game with 83 hours and half an hour of them tracked is not one that "got less than an hour"', async () => {
    // one standing fact a day, taken in turn: within as many days as there are standing facts, each is said once
    const tried = [];
    try {
      for (let d = 18; d < 30; d++) {
        clock.install(local(2026, 3, d, 15));
        const s = (await h.get('/stats/facts?limit=20')).facts.find((f) => f.kind === 'standing' && f.event === 'tried');
        if (s) tried.push([s.games, s.of, s.text]);
      }
    } finally { clock.install(NOW); }
    assert.ok(tried.length >= 1, 'the fact came up');
    for (const t of tried) assert.deepEqual(t, [3, 7, '3 of the 7 games you have played got less than an hour.']);
  });
});

describe('facts: where the title is in the sentence', () => {
  let h; let g;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    g = {};
    // titles that are words of the sentences around them, or markup, or a replacement pattern
    for (const t of ['You', 'A', 'Your', '$& <b>$1</b>']) g[t] = await addGame(h, t);
    await logSession(h, g.You, local(2025, 6, 1, 19), 60); // back after nine months
    await logSession(h, g.You, local(2026, 3, 17, 19), 60);
    await logSession(h, g.A, local(2025, 3, 18, 19), 200); // started a year ago today
    await logSession(h, g.A, local(2025, 5, 1, 19), 200);
    for (let d = 10; d <= 27; d++) await logSession(h, g['$& <b>$1</b>'], local(2026, 1, d, 9), 330); // 99 hours, then past 100
    await logSession(h, g['$& <b>$1</b>'], local(2026, 3, 16, 19), 120);
    await logSession(h, g.Your, local(2026, 3, 15, 8), 540); // the longest session yet
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('title_at says where the game\'s title starts, also when the same words come earlier', async () => {
    const r = await h.get('/stats/facts?limit=20');
    const by = (id) => r.facts.find((f) => f.game_id === id);
    assert.deepEqual([by(g.You).text, by(g.You).title_at], ['You came back to You after 10 months away.', 17]);
    assert.deepEqual([by(g.A).text, by(g.A).title_at], ['A year ago today you started A: you played it for 6 weeks, 6h 40m in all.', 29]);
    assert.deepEqual([by(g.Your).text, by(g.Your).title_at], ['Your longest session yet: 9h of Your on March 15, 2026.', 32]);
    assert.equal(by(g['$& <b>$1</b>']).text, 'You passed 100 hours in $& <b>$1</b> this week: the first game you have taken that far.');
    for (const f of r.facts) {
      assert.ok(!f.text.includes('\u0001'), 'no marker is left in the text');
      if (f.title) assert.equal(f.text.slice(f.title_at, f.title_at + f.title.length), f.title, `${f.kind}: the title is at title_at`);
      else assert.equal(f.title_at, undefined);
    }
    // the summary's lines carry the same text
    assert.ok(!(await h.get('/summary/week')).text.includes('\u0001'));
  });
});

describe('patterns of a game put down long ago', () => {
  let h; let game;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    game = await addGame(h, 'Shelved');
    // two years ago: Monday to Wednesday 80 minutes each, then a weekend of 90 a day
    for (const d of [4, 5, 6]) await logSession(h, game, local(2024, 3, d, 19), 80);
    for (const d of [9, 10]) await logSession(h, game, local(2024, 3, d, 14), 90);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('play on both kinds of day is never "all on weekends", however thin it is spread over the years since', async () => {
    const r = await h.get(`/stats/records?range=all&game_id=${game}`);
    const w = r.patterns.find((x) => x.id === 'weekend');
    // 240 minutes on weekdays, 180 on weekend days: under a minute a day of either by now
    assert.equal(w.lean, 'weekend');
    assert.ok(w.value > 1.25 && w.value < 3, `a ratio, not null: ${w.value}`);
    assert.equal(w.text, `A weekend day gets ${w.value} times the play of a weekday.`);
    assert.deepEqual([w.weekday_minutes, w.weekend_minutes], [0, 1]);
  });
});

describe('facts: the standing fact of a day', () => {
  const zone = process.env.TZ;
  after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; clock.uninstall(); restoreNetwork(); });

  test('is picked by the calendar date: the same fact in every timezone, another the next day', async () => {
    guardNetwork();
    const picked = {};
    for (const tz of ['UTC', 'America/New_York', 'Europe/London', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      clock.install(local(2026, 3, 18, 15));
      const h = await startApp();
      try {
        // six games over a quiet year: nothing happened this week, so only standing facts are left
        for (let i = 0; i < 6; i++) {
          const id = await addGame(h, `Game ${i}`);
          for (let d = 1; d <= 3; d++) await logSession(h, id, local(2025, 2 + i, 4 * d + i, 19), 60 + 30 * i);
        }
        picked[tz] = [];
        for (const d of [18, 19, 28, 29, 30]) { // (clocks in London go forward on the 29th)
          clock.install(local(2026, 3, d, 15));
          const r = await h.get('/stats/facts?limit=20');
          assert.equal(r.day, `2026-03-${d}`);
          picked[tz].push(r.facts.find((f) => f.kind === 'standing')?.event ?? null);
        }
      } finally { await h.close(); }
    }
    for (const tz of Object.keys(picked)) assert.deepEqual(picked[tz], picked.UTC, `${tz} says what UTC says`);
    assert.ok(picked.UTC.every((e, i) => e && (!i || e !== picked.UTC[i - 1])), `another fact each day: ${picked.UTC}`);
  });
});

describe('forecast and backlog in words', () => {
  let h; let nearly;
  const meta = (id, main) => h.db.prepare("INSERT INTO game_meta(game_id, matched_by, ttb_main, fetched_at) VALUES (?, 'title', ?, ?)").run(id, main, NOW);
  before(async () => {
    guardNetwork();
    // a library five months old ...
    clock.install(local(2025, 10, 10, 12));
    h = await startApp();
    await logSession(h, await addGame(h, 'First'), local(2025, 10, 10, 10), 60);
    // ... with three games added in the last three months: one nearly finished, one waiting
    clock.install(local(2026, 2, 20, 12));
    nearly = await addGame(h, 'Nearly'); meta(nearly, 600);
    const waiting = await addGame(h, 'Waiting'); meta(waiting, 600);
    await h.patch(`/games/${waiting}`, { status: 'backlog' });
    await addGame(h, 'Third');
    clock.install(NOW);
    // 9h 20m of a typical 10 hours, all in the last four weeks
    for (const d of [2, 6, 10, 14]) await logSession(h, nearly, local(2026, 3, d, 19), 140);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('a game days from its end: the sentence starts with a capital', async () => {
    const f = await h.get(`/games/${nearly}/forecast`);
    assert.deepEqual([f.state, f.weeks, f.remaining_minutes], ['playing', 0.3, 40]);
    assert.equal(f.text, 'Under a week to finish: 40m left of 10h typical, at 2h 20m a week.');
  });

  test('a backlog of one game "holds", and one game a month is not "1 games"', async () => {
    const b = await h.get('/stats/backlog');
    assert.deepEqual([b.games, b.remaining_minutes, b.added_per_month, b.finished_per_month], [1, 600, 1, 0]);
    assert.equal(b.text, '1 game in the backlog holds about 10h of play: about 3 months if all your play went to it (47m a week). You add 1 game a month and finish 0.');
  });
});
