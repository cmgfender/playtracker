// Stats, the weekly summary, backups and history re-dating: answers that must stay the same while
// they got cheaper, and the edge cases fixed along the way. Times are local wall-clock times, so
// the file passes in any timezone.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { flushRollups } from '../src/services/rollup.js';
import { computeStats, dayKey } from '../src/services/stats.js';

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
