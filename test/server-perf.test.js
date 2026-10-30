// Stats, the weekly summary, backups and history re-dating: answers that must stay the same while
// they got cheaper, and the edge cases fixed along the way. Times are local wall-clock times, so
// the file passes in any timezone.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { Settings } from '../src/services/settings.js';
import { flushRollups } from '../src/services/rollup.js';
import { computeStats, periodHighlights, firstPlayedIn, dayKey } from '../src/services/stats.js';
import { weeklySummary, WeeklySummary } from '../src/services/digest.js';

const MIN = 60_000;
const DAY = 86_400_000;
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** A small library written straight into the database; every entry's total is the sum of its sessions. */
function writer(db) {
  const game = (title) => Number(db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, 0, 0)').run(title, title.toLowerCase()).lastInsertRowid);
  const entry = (g, platform, { excluded = 0, ext = `${platform}-${g}` } = {}) => Number(db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, excluded) VALUES (NULL, ?, ?, ?, 'x', 0, 0, ?)")
    .run(g, platform, ext, excluded).lastInsertRowid);
  const ins = db.prepare('INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const bump = db.prepare('UPDATE entries SET playtime_min = playtime_min + ? WHERE id = ?');
  const play = (e, start, minutes, kind = 'play') => {
    ins.run(e, kind === 'play' ? 'manual' : 'inferred', kind, minutes, start, start + minutes * MIN, kind === 'play' ? start : null, kind === 'play' ? start + minutes * MIN : null, start + minutes * MIN);
    bump.run(minutes, e);
  };
  return { game, entry, play };
}

/** Every entry's sessions (play + estimate + baseline) add up to its playtime, and the rollups to the sessions. */
export function assertTotals(db, msg = '') {
  assert.deepEqual(db.prepare(`SELECT e.id, e.playtime_min, COALESCE(SUM(s.minutes), 0) m FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id
    GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min`).all().map((r) => ({ ...r })), [], `entry totals ${msg}`);
  assert.deepEqual(db.prepare(`SELECT s.id FROM sessions s WHERE s.kind IN ('play', 'estimate') AND s.minutes > 0
    AND ABS(COALESCE((SELECT SUM(p.minutes) FROM play_days p WHERE p.session_id = s.id), 0) - s.minutes) > 0.001`).all().map((r) => ({ ...r })), [], `rollups ${msg}`);
}

describe('all time starts with the first play the filter counts', () => {
  test('a platform or a game starts on its own first day, never on an excluded entry', async () => {
    const { app, server, close } = createApp({ dbFile: ':memory:', password: '', scheduler: false, log: quiet });
    try {
      const db = app.db;
      const w = writer(db);
      const now = Date.now();
      const steam = w.entry(w.game('Old Steam Game'), 'steam');
      w.play(steam, local(2016, 3, 10, 20), 120);
      const psnGame = w.game('PSN Game');
      const psn = w.entry(psnGame, 'psn');
      for (let d = 30; d >= 1; d--) w.play(psn, now - d * DAY, 60);
      const mirror = w.entry(psnGame, 'steam', { excluded: 1 }); // a double-count copy played in 2018
      w.play(mirror, local(2018, 6, 1, 20), 300);
      flushRollups(db);
      assertTotals(db);

      const s = computeStats(db, { range: 'all', platform: 'psn' });
      assert.equal(dayKey(s.range.from), dayKey(now - 30 * DAY), 'starts with the first PSN day');
      assert.equal(s.range.group, 'day');
      assert.equal(s.tracked_minutes, 1800);
      assert.ok(s.avg_per_day_minutes >= 55, `daily average ${s.avg_per_day_minutes}`);
      const g = computeStats(db, { range: 'all', gameId: psnGame });
      assert.equal(dayKey(g.range.from), dayKey(now - 30 * DAY), 'the excluded 2018 copy does not start the game');
      assert.ok(g.avg_per_day_minutes >= 55);
      const all = computeStats(db, { range: 'all' });
      assert.equal(dayKey(all.range.from), '2016-03-10');
      assert.equal(all.range.group, 'year');

      // years with play: 2018 had only the excluded copy's play
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const years = await (await fetch(`http://127.0.0.1:${server.address().port}/api/v1/stats/years`)).json();
      assert.ok(years.includes(2016));
      assert.ok(!years.includes(2018), `years: ${years}`);
    } finally { close(); }
  });
});

describe('weekly summary', () => {
  const settingsFor = (db, extra = {}) => {
    const settings = new Settings(db);
    settings.set({ webhook_url: 'https://example.invalid/hook', weekly_summary: true, weekly_summary_time: '09:00', week_starts_on: 1, ...extra });
    return settings;
  };

  test('a summary sent more than a day late does not cost the next week its summary', async () => {
    for (const lateHours of [20, 25, 30, 60]) {
      const db = openDb(':memory:');
      const settings = settingsFor(db, { weekly_summary_sent: '2026-08-24', weekly_summary_sent_at: local(2026, 8, 31, 9) });
      const failUntil = local(2026, 9, 7, 9) + lateHours * 3600_000; // the webhook is down from the Monday slot on
      const sent = [];
      let now = local(2026, 9, 7, 0);
      const w = new WeeklySummary({ db, settings, log: null, send: async (url, s) => { if (now < failUntil) throw new Error('webhook down'); sent.push(s.week.start_day); } });
      // ticks once a minute around each Monday, every 10 minutes otherwise (the back-off needs minutes)
      for (const end = local(2026, 10, 6); now < end; now += 10 * MIN) await w.tick(now);
      assert.deepEqual(sent, ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'], `webhook down for ${lateHours} h`);
      db.close();
    }
  });

  test('still one a week when the week start moves', async () => {
    const db = openDb(':memory:');
    const settings = settingsFor(db, { weekly_summary_sent: '2026-03-02', weekly_summary_sent_at: local(2026, 3, 9, 9) });
    const sent = [];
    const w = new WeeklySummary({ db, settings, log: null, send: async (url, s) => { sent.push(s.week.start_day); } });
    assert.equal(await w.tick(local(2026, 3, 16, 9, 1)), true);
    // weeks now start on Tuesday: Tuesday's week (Mar 10-16) mostly overlaps the one just sent
    settings.set({ week_starts_on: 2 });
    assert.equal(await w.tick(local(2026, 3, 17, 9, 1)), false);
    assert.equal(settings.get('weekly_summary_sent'), '2026-03-10');
    assert.equal(await w.tick(local(2026, 3, 24, 9, 1)), true);
    assert.deepEqual(sent, ['2026-03-09', '2026-03-17']);
    db.close();
  });

  test('kept until the next write; new games found from the week, the same as from every game', () => {
    const db = openDb(':memory:');
    const w = writer(db);
    const NOW = local(2026, 3, 18, 15); // weeks start on Monday: last week is Mar 9 - 15
    const a = w.entry(w.game('Alpha'), 'steam');
    const b = w.entry(w.game('Beta'), 'xbox');
    const c = w.entry(w.game('Gamma'), 'psn');
    w.play(a, local(2026, 1, 5, 20), 60); // Alpha was played long before: never new last week
    w.play(a, local(2026, 3, 10, 20), 30);
    w.play(b, local(2026, 3, 11, 19), 120);
    w.play(c, local(2026, 3, 11, 21), 45); // Beta and Gamma both start on the 11th: id order
    w.play(c, local(2026, 3, 8, 20), 200, 'estimate'); // ...but Gamma's history is older
    flushRollups(db);
    assertTotals(db);
    const s = weeklySummary(db, { now: NOW });
    assert.deepEqual(s.new_games.map((g) => g.title), ['Beta']);
    assert.equal(weeklySummary(db, { now: NOW }), s, 'the same answer object until a write');
    w.play(w.entry(w.game('Delta'), 'steam'), local(2026, 3, 12, 20), 10);
    flushRollups(db);
    const s2 = weeklySummary(db, { now: NOW });
    assert.notEqual(s2, s);
    assert.deepEqual(s2.new_games.map((g) => g.title), ['Beta', 'Delta']);
    // this week so far ends now: never answered from a minute ago
    const t0 = weeklySummary(db, { weeksAgo: 0, now: NOW });
    const t1 = weeklySummary(db, { weeksAgo: 0, now: NOW + MIN });
    assert.equal(t1.week.to, NOW + MIN);
    assert.notEqual(t0, t1);
    // highlights: newest first, ties by id
    const h = periodHighlights(db, { range: 'week', now: local(2026, 3, 15, 23) });
    assert.deepEqual(h.new_games.items.map((g) => [g.title, g.first_day]), [['Delta', '2026-03-12'], ['Beta', '2026-03-11']]);
    db.close();
  });

  test('firstPlayedIn gives what the first day of every game gives, for any range and platform', () => {
    const db = openDb(':memory:');
    const w = writer(db);
    let seed = 7;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    const platforms = ['steam', 'xbox', 'psn'];
    for (let i = 0; i < 60; i++) {
      const g = w.game(`Game ${i}`);
      for (const p of platforms) {
        if (rnd() < 0.4) continue;
        const e = w.entry(g, p, { excluded: rnd() < 0.15 ? 1 : 0 });
        for (let k = 0; k < 4; k++) w.play(e, local(2025, 1, 1, 20) + Math.floor(rnd() * 600) * DAY, 10 + Math.floor(rnd() * 100), rnd() < 0.3 ? 'estimate' : 'play');
      }
    }
    flushRollups(db);
    assertTotals(db);
    const naive = (fromDay, toDay, platform) => db.prepare(`SELECT p.game_id, MIN(p.day) first FROM play_days p WHERE p.excluded = 0 ${platform ? 'AND p.platform = ?' : ''}
      GROUP BY p.game_id HAVING first >= ? AND first <= ? ORDER BY first, p.game_id`).all(...(platform ? [platform] : []), fromDay, toDay).map((r) => [r.game_id, r.first]);
    let checked = 0;
    for (const [fromDay, toDay] of [['2025-01-01', '2025-01-31'], ['2025-03-01', '2025-03-07'], ['2025-06-01', '2026-06-01'], ['1969-12-31', '2030-01-01'], ['2026-08-01', '2026-08-02']]) {
      for (const platform of [null, ...platforms]) {
        const got = firstPlayedIn(db, { fromDay, toDay, platform }).map((r) => [r.game_id, r.first]);
        assert.deepEqual(got, naive(fromDay, toDay, platform), `${fromDay}..${toDay} ${platform}`);
        checked += got.length;
      }
    }
    assert.ok(checked > 100, 'the ranges hold new games');
    db.close();
  });
});
