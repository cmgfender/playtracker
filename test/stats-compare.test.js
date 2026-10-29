// Stats page extras: the previous period (like for like) and a range's highlights (new games,
// achievements, the most varied day). Local wall-clock times, so it passes in any timezone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { previousPeriod, comparePeriod, periodHighlights, resolveRange, dayKey } from '../src/services/stats.js';
import { flushRollups } from '../src/services/rollup.js';

const MIN = 60_000;
const DAY = 86_400_000;
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const NOW = local(2026, 3, 18, 15); // Wednesday

function fixture() {
  const { app, close, server } = createApp({ dbFile: ':memory:', password: '', scheduler: false, log: quiet });
  const db = app.db;
  const game = (title) => Number(db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, 0, 0)').run(title, title.toLowerCase()).lastInsertRowid);
  const entry = (g, platform = 'steam') => Number(db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at) VALUES (NULL, ?, ?, ?, 'x', 0, 0)").run(g, platform, `x${g}${platform}`).lastInsertRowid);
  const ins = db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at) VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?)");
  const play = (e, start, minutes, kind = 'play') => { ins.run(e, kind, minutes, start, start + minutes * MIN, start, start + minutes * MIN, start + minutes * MIN); db.prepare('UPDATE entries SET playtime_min = playtime_min + ? WHERE id = ?').run(minutes, e); };
  const a = entry(game('Alpha'));
  const b = entry(game('Beta'), 'xbox');
  const c = entry(game('Gamma'));
  play(a, local(2026, 1, 10, 20), 100); // long before both windows
  play(a, local(2026, 2, 10, 20), 60); // previous 30 days
  play(b, local(2026, 2, 12, 20), 30, 'estimate'); // Beta's estimated history: played before, so not new later
  play(a, local(2026, 3, 1, 20), 50);
  play(b, local(2026, 3, 2, 20), 40);
  play(c, local(2026, 3, 2, 21), 20); // Gamma: first ever play, in range
  play(a, local(2026, 3, 17, 20), 30);
  const ach = db.prepare('INSERT INTO achievements(entry_id, ach_id, name, unlocked, unlocked_at, rarity, points, first_seen_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, 0, 0)');
  ach.run(b, 'b1', 'Rare one', local(2026, 3, 2, 20, 30), 2.5, 50);
  ach.run(a, 'a1', 'Common', local(2026, 3, 1, 20, 30), 60, null);
  ach.run(a, 'a0', 'Old', local(2026, 2, 10, 20, 30), 1, null); // previous window
  flushRollups(db);
  return { app, close, server, db };
}

test('previousPeriod: the span just before, ending at the same point', () => {
  const p = (r) => { const x = previousPeriod(r, NOW); return x && [x.range, new Date(x.now).toDateString()]; };
  assert.deepEqual(p('30d'), ['30d', new Date(NOW - 30 * DAY).toDateString()]);
  assert.deepEqual(p('7d'), ['7d', new Date(NOW - 7 * DAY).toDateString()]);
  assert.deepEqual(p('week'), ['week', new Date(local(2026, 3, 11, 15)).toDateString()]);
  assert.deepEqual(p('month'), ['month', new Date(local(2026, 2, 18, 15)).toDateString()]);
  assert.deepEqual(p('year:2026'), ['year:2025', new Date(local(2025, 3, 18, 15)).toDateString()]);
  assert.deepEqual(p('month:2026-01'), ['month:2025-12', new Date(local(2026, 2, 18, 15)).toDateString()]);
  assert.equal(previousPeriod('all', NOW), null);
  // the 31st of a month compares with the last day of a shorter one
  assert.equal(new Date(previousPeriod('month', local(2026, 3, 31, 12)).now).getDate(), 28);
});

test('comparePeriod and periodHighlights on a small library', () => {
  const { db, close } = fixture();
  try {
    const prev = comparePeriod(db, { range: '30d', now: NOW, estimates: 'exclude' });
    assert.equal(prev.tracked_minutes, 60);
    assert.equal(prev.sessions, 1);
    assert.equal(prev.games_played, 1);
    assert.equal(comparePeriod(db, { range: 'all', now: NOW }), null);

    const h = periodHighlights(db, { range: '30d', now: NOW });
    assert.deepEqual(h.new_games.items.map((g) => g.title), ['Gamma']);
    assert.equal(h.new_games.items[0].first_day, '2026-03-02');
    assert.equal(h.achievements.unlocked, 2);
    assert.equal(h.achievements.points, 50);
    assert.equal(h.achievements.games, 2);
    assert.equal(h.achievements.rarest.name, 'Rare one');
    assert.deepEqual(h.most_varied_day, { day: '2026-03-02', games: 2 });

    const xbox = periodHighlights(db, { range: '30d', platform: 'xbox', now: NOW });
    assert.equal(xbox.achievements.unlocked, 1);
    assert.equal(xbox.new_games.count, 0, 'Beta was played before (estimated history)');
    assert.equal(xbox.most_varied_day, null);
  } finally { close(); }
});

test('GET /stats?compare=true&highlights=true adds previous and highlights; without them the reply is unchanged', async () => {
  const { server, close } = fixture();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = async (q) => (await fetch(`http://127.0.0.1:${server.address().port}/api/v1/stats?${q}`)).json();
  try {
    const plain = await get('range=30d');
    assert.equal(plain.previous, undefined);
    assert.equal(plain.highlights, undefined);
    const s = await get('range=30d&compare=true&highlights=true');
    assert.ok(s.previous && 'total_minutes' in s.previous && s.previous.range.label === 'Last 30 days');
    assert.ok(s.highlights.new_games && s.highlights.achievements);
    assert.equal((await get('range=all&compare=true')).previous, null);
  } finally { close(); }
});

test('playStyle: focus per week, what became of the games started, staying power, comebacks', async () => {
  const { playStyle } = await import('../src/services/insights.js');
  const { app, close } = createApp({ dbFile: ':memory:', password: '', scheduler: false, log: quiet });
  const db = app.db;
  try {
    const game = (title, status = 'unset') => Number(db.prepare('INSERT INTO games(title, norm_title, status, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run(title, title.toLowerCase(), status).lastInsertRowid);
    const entry = (g) => Number(db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at) VALUES (NULL, ?, 'steam', ?, 'x', 0, 0)").run(g, `x${g}`).lastInsertRowid);
    const ins = db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at) VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?)");
    const play = (e, start, minutes, kind = 'play') => { ins.run(e, kind, minutes, start, start + minutes * MIN, start, start + minutes * MIN, start + minutes * MIN); db.prepare('UPDATE entries SET playtime_min = playtime_min + ? WHERE id = ?').run(minutes, e); };
    const ids = {};
    const g = (title, status) => { ids[title] = game(title, status); return entry(ids[title]); };
    const going = g('Going'); const tried = g('Tried'); const invested = g('Invested'); const done = g('Done', 'completed'); const back = g('Back'); const old = g('Old');
    // a busy first week, then a little more: 600 of 700 minutes in the first 7 days
    play(going, local(2026, 3, 1, 12), 300); play(going, local(2026, 3, 3, 12), 300); play(going, local(2026, 3, 17, 12), 100);
    play(tried, local(2026, 3, 2, 21), 20);
    play(invested, local(2026, 2, 20, 12), 400); play(invested, local(2026, 3, 1, 12), 250);
    play(done, local(2026, 2, 22, 20), 120);
    play(back, local(2025, 11, 1, 20), 60); play(back, local(2026, 3, 5, 20), 90); // 124 days apart
    play(old, local(2026, 1, 1, 20), 50, 'estimate'); play(old, local(2026, 3, 4, 20), 60); // estimated before: not a start
    flushRollups(db);

    const s = playStyle(db, { range: '30d', now: NOW });
    const by = Object.fromEntries(s.starts.items.map((x) => [x.title, x]));
    assert.deepEqual(Object.keys(by).sort(), ['Done', 'Going', 'Invested', 'Tried']);
    assert.equal(by.Going.outcome, 'playing');
    assert.equal(by.Tried.outcome, 'tried');
    assert.equal(by.Invested.outcome, 'invested');
    assert.equal(by.Done.outcome, 'finished');
    assert.deepEqual(s.starts.outcomes, { finished: 1, playing: 1, invested: 1, faded: 0, tried: 1, dropped: 0 });
    assert.equal(by.Going.early_share, 0.857);
    assert.equal(by.Going.days, 3);
    assert.equal(by.Going.span_days, 17);
    assert.equal(s.starts.items[0].title, 'Tried', 'the latest start first');
    // staying power: games started 30+ days ago with at least the "tried" minutes - none yet in 30 days
    assert.equal(s.staying_power, null);
    const year = playStyle(db, { range: '365d', now: local(2026, 5, 1, 12) });
    assert.ok(year.staying_power.games >= 3);
    assert.deepEqual(s.comebacks.items.map((c) => [c.title, c.returned_on, c.gap_days, c.minutes_since]), [['Back', '2026-03-05', 124, 90]]);
    assert.ok(s.focus.weeks >= 3);
    assert.ok(['focused', 'balanced', 'varied'].includes(s.focus.style));
    assert.ok(s.focus.series.every((w) => w.games >= 1 && w.top_share > 0 && w.top_share <= 1));
  } finally { close(); }
});

test('day-count ranges and the previous period step by calendar days across DST changes', () => {
  // US changes: Mar 8 and Nov 1 2026 (run with TZ=America/New_York to exercise them)
  for (const now of [local(2026, 3, 9, 0, 30), local(2026, 11, 5, 23, 30), local(2026, 11, 1, 23, 30), local(2026, 3, 29, 1, 30)]) {
    const r = resolveRange('7d', now);
    assert.equal(dayKey(r.from), dayKey(new Date(new Date(now).setDate(new Date(now).getDate() - 6))), `7d from ${new Date(now)}`);
    assert.equal(new Date(r.from).getHours(), 0);
  }
  const w = previousPeriod('week', local(2026, 3, 9, 0, 30));
  assert.equal(new Date(w.now).toString(), new Date(local(2026, 3, 2, 0, 30)).toString());
  const d1 = previousPeriod('1d', local(2026, 3, 9, 0, 30));
  assert.equal(dayKey(d1.now), '2026-03-08');
});
