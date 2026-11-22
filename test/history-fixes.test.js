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

test('unlock times from before the first played date do not end the history before it began', () => {
  const e = { minutes: 600, trackingStart: T, firstPlayedAt: T - 100 * DAY };
  const plain = inferHistory(e);
  assert.equal(dated(plain), 600, 'a first played date alone dates the history after it');
  // one stray unlock 100 days before first played: no evidence about the end, so nothing changes
  const stray = inferHistory({ ...e, anchors: [T - 200 * DAY] });
  assert.equal(stray.undated, 0);
  assert.deepEqual(stray.chunks.map((c) => [c.start, c.end, c.minutes]), plain.chunks.map((c) => [c.start, c.end, c.minutes]));
  // the same with a start you set
  assert.equal(inferHistory({ minutes: 600, trackingStart: T, manual: { start: T - 100 * DAY }, anchors: [T - 200 * DAY] }).undated, 0);
  // an unlock after first played still ends the window
  const later = inferHistory({ ...e, anchors: [T - 200 * DAY, T - 50 * DAY] });
  assert.equal(dated(later), 600);
  assert.ok(later.window[0] >= T - 100 * DAY && later.window[1] <= T - 50 * DAY);
});

test('a last played time just after tracking began (clock skew) dates history up to tracking start', () => {
  const at = (lastPlayedAt, more = {}) => inferHistory({ minutes: 3000, trackingStart: T, lastPlayedAt, ...more });
  const onTime = at(T);
  assert.equal(dated(onTime), 3000);
  // the platform's clock 30 s ahead of ours: the same history, not "no dates available"
  const skewed = at(T + 30_000);
  assert.equal(skewed.undated, 0);
  assert.deepEqual(skewed.chunks.map((c) => [c.start, c.end, c.minutes]), onTime.chunks.map((c) => [c.start, c.end, c.minutes]));
  assert.deepEqual(skewed.reasons, onTime.reasons);
  assert.ok(skewed.chunks.every((c) => c.end <= T), 'never past tracking start');
  // with a date added too it still bounds the end: the window reaches tracking start
  const added = { dateAdded: T - 400 * DAY };
  assert.deepEqual(at(T + 30_000, added).window, at(T, added).window);
  assert.equal(at(T + 30_000, added).confidence, 'medium');
});

test('a game last played before its release date (early access, a re-release) is still dated', () => {
  const e = { minutes: 3000, trackingStart: T, lastPlayedAt: T - 100 * DAY };
  const plain = inferHistory(e);
  // the store's release date is 50 days after the last session: it cannot bound that play
  for (const wrong of [{ releaseAt: T - 50 * DAY }, { accountCreatedAt: T - 50 * DAY }]) {
    const res = inferHistory({ ...e, ...wrong });
    assert.equal(res.undated, 0, JSON.stringify(wrong));
    assert.deepEqual(res.chunks.map((c) => [c.start, c.end, c.minutes]), plain.chunks.map((c) => [c.start, c.end, c.minutes]));
    assert.ok(res.window[0] < res.window[1], 'the window runs forwards');
    assert.ok(!res.reasons.includes('Clamped to release date'));
  }
  // the same when the end is one you set
  assert.equal(inferHistory({ minutes: 3000, trackingStart: T, manual: { end: T - 100 * DAY }, releaseAt: T - 50 * DAY }).undated, 0);
  // a release date before last played still bounds the start
  const bounded = inferHistory({ ...e, releaseAt: T - 110 * DAY });
  assert.equal(dated(bounded) + bounded.undated, 3000);
  assert.ok(bounded.window[0] >= new Date(T - 110 * DAY).setHours(0, 0, 0, 0));
  assert.ok(bounded.reasons.includes('Clamped to release date'));
});
