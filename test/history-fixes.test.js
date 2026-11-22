// History dating with evidence that contradicts itself, or entries that are not counted:
// each case used to lose dated history (or date it somewhere implausible).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { allocate, inferHistory, learnStyleFromDb, reinferMany } from '../src/services/inference.js';
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

test('a date added (or first unlock) after the last played date is no start: no binge before last played', () => {
  const e = { minutes: 3000, trackingStart: T, lastPlayedAt: T - 100 * DAY };
  const plain = inferHistory(e);
  const span = (res) => Math.round((res.window[1] - res.window[0]) / DAY);
  assert.ok(span(plain) > 60, 'last played alone: spread over months');
  // bought 90 days after the last session (played on a shared copy before): not five 10 h days
  for (const late of [{ dateAdded: T - 10 * DAY }, { anchors: [T - 50 * DAY, T - 40 * DAY, T - 30 * DAY] }]) {
    const res = inferHistory({ ...e, ...late });
    assert.equal(dated(res), 3000);
    assert.deepEqual(res.window, plain.window, JSON.stringify(late));
    assert.equal(res.confidence, 'low');
    assert.deepEqual(res.reasons, ['Only the last played date is known']);
  }
  // the earlier of the two hints still counts when the other is too late
  const mixed = inferHistory({ ...e, anchors: [T - 50 * DAY], dateAdded: T - 150 * DAY });
  assert.ok(mixed.window[0] >= new Date(T - 150 * DAY).setHours(0, 0, 0, 0) && mixed.window[1] <= T - 100 * DAY);
  // added later on the last played day itself: that day is the start
  const sameDay = inferHistory({ minutes: 300, trackingStart: T, lastPlayedAt: T - 100 * DAY, dateAdded: T - 100 * DAY + 3_600_000 });
  assert.equal(dated(sameDay), 300);
  assert.equal(sameDay.window[0], new Date(T - 100 * DAY).setHours(0, 0, 0, 0));
  // a date added after tracking began and nothing else: no date at all
  const after = inferHistory({ minutes: 3000, trackingStart: T, dateAdded: T + 5 * DAY });
  assert.equal(after.undated, 3000);
  assert.deepEqual(after.reasons, ['No dates available - kept as undated history (lifetime totals only)']);
});

test('history games known by their unlock times are learned at their own size, not their unlock count', () => {
  const { db, entry } = library();
  // three history games of 10 h, 100 h and 200 h, each with ten unlocks over 90 days
  const anchors = Array.from({ length: 10 }, (_, i) => T - (100 - i * 10) * DAY);
  for (const minutes of [600, 6000, 12000]) entry(`Game ${minutes}`, minutes, { anchors });
  const style = learnStyleFromDb(db, { now: T });
  db.close();
  assert.equal(style.games, 3);
  assert.equal(style.tracked, 0, 'unlock times are not tracked sessions');
  // a new game is dated like the learned games nearest in size: the size must be the game's
  assert.deepEqual(style.samples.map((x) => x.m), [600, 6000, 12000]);
  for (const x of style.samples) assert.ok(Math.abs(x.rel.reduce((a, v) => a + v, 0) - 1) < 0.01);
});

test('a game added before its release date (a pre-order) is dated from the release, not left undated', () => {
  const e = { minutes: 3000, trackingStart: T, dateAdded: T - 400 * DAY };
  const plain = inferHistory(e);
  assert.equal(dated(plain), 3000);
  // bought 100 days before release, no last played date: the burst begins at the release
  const res = inferHistory({ ...e, releaseAt: T - 300 * DAY });
  assert.equal(res.undated, 0);
  assert.ok(res.window[0] < res.window[1], 'the window runs forwards');
  assert.ok(res.window[0] >= new Date(T - 300 * DAY).setHours(0, 0, 0, 0), 'not before the release');
  assert.equal(res.window[1] - res.window[0], plain.window[1] - plain.window[0], 'the same burst, 100 days later');
  assert.ok(res.reasons.includes('Clamped to release date'));
  // a release date that leaves no day before tracking began bounds nothing
  const late = inferHistory({ ...e, releaseAt: T + DAY });
  assert.equal(late.undated, 0);
  assert.deepEqual(late.window, plain.window);
  assert.ok(!late.reasons.includes('Clamped to release date'));
  // history from before the recent-play counter's days, with a release date inside them
  const recent = inferHistory({ minutes: 3000, trackingStart: T, recent: { minutes: 100, days: 14 }, releaseAt: T - 5 * DAY });
  assert.equal(recent.undated, 0);
  assert.ok(recent.chunks.every((c) => c.start < c.end && c.end <= T));
});

test('minutes that make a session of their own go to a free day when the likeliest days are full', () => {
  // the likely first and last day have 20 and 14 min left, the day between is free
  assert.deepEqual(allocate(40, [100, 1, 100], { cap: [20, 600, 14], minDay: 15 }), [20, 20, 0]);
  // a remainder too small for a day of its own is still left out (it stays undated)
  assert.deepEqual(allocate(30, [100, 1, 100], { cap: [20, 600, 14], minDay: 15 }), [20, 0, 0]);
  // a game played over three days whose first and last day are nearly full with other games
  const day = (n) => new Date(T - n * DAY).setHours(0, 0, 0, 0);
  const room = new Map([[day(10), 20], [day(8), 14]]);
  const res = inferHistory({ minutes: 40, trackingStart: T, firstPlayedAt: day(10) + 10 * 3_600_000, lastPlayedAt: day(8) + 20 * 3_600_000 },
    { dayRoom: (t) => room.get(new Date(t).setHours(0, 0, 0, 0)) ?? 720 });
  assert.equal(res.undated, 0, 'the free day between holds what the two busy days cannot');
  assert.deepEqual(res.chunks.map((c) => [new Date(c.start).setHours(0, 0, 0, 0), c.minutes]), [[day(10), 20], [day(9), 20]]);
});
