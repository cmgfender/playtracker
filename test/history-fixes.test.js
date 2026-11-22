// History dating with evidence that contradicts itself, or entries that are not counted:
// each case used to lose dated history (or date it somewhere implausible).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { inferHistory, reinferMany } from '../src/services/inference.js';
import { flushRollups } from '../src/services/rollup.js';

const DAY = 86_400_000;
// noon, local time: whole days on both sides in any timezone
const T = new Date(2025, 5, 20, 12).getTime();
const dated = (res) => res.chunks.reduce((a, c) => a + c.minutes, 0);

function library() {
  const db = openDb(':memory:');
  const entry = (title, minutes, hist, { excluded = 0 } = {}) => {
    const game = Number(db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, 0, 0)').run(title, title.toLowerCase()).lastInsertRowid);
    return Number(db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, baseline_min, first_seen_at, excluded, hist)
      VALUES (NULL, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`).run(game, title, title, minutes, minutes, T, excluded, JSON.stringify({ tracking_start: T, ...hist })).lastInsertRowid);
  };
  const history = (id) => Object.fromEntries(db.prepare("SELECT kind, SUM(minutes) m FROM sessions WHERE entry_id = ? AND source = 'inferred' GROUP BY kind").all(id).map((r) => [r.kind, r.m]));
  return { db, entry, history };
}

test('an excluded entry (a double count) takes no room in the shared day budget from counted games', () => {
  // two games played in the same six days; the first fills its 10 h a day
  const window = { first_played_at: T - 10 * DAY, last_played_at: T - 5 * DAY };
  const run = (excluded) => {
    const { db, entry, history } = library();
    const twin = entry('Twin', 3600, window, { excluded });
    const game = entry('Game', 3000, window);
    reinferMany(db, [twin, game], { settings: {} });
    flushRollups(db);
    const out = { twin: history(twin), game: history(game) };
    db.close();
    return out;
  };
  const alone = (() => {
    const { db, entry, history } = library();
    const game = entry('Game', 3000, window);
    reinferMany(db, [game], { settings: {} });
    const out = history(game);
    db.close();
    return out;
  })();
  assert.deepEqual(alone, { estimate: 3000 }, 'on its own the game fits its window');
  // counted, the twin leaves 2 h a day: most of the game cannot be dated
  assert.ok(run(0).game.baseline > 2000);
  // excluded, the twin is in no chart and no total: the game is dated as if it were not there
  const ex = run(1);
  assert.deepEqual(ex.game, alone);
  assert.deepEqual(ex.twin, { estimate: 3600 }, 'the excluded entry keeps its own dating');
});
