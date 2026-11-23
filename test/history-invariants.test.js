// What must hold for every piece of pre-tracking history, whatever the evidence: checked on
// seeded pseudo-random games and libraries (the same seeds, so the same cases, on every run and
// in every timezone - all dates are built from local wall-clock time), plus the edges that
// random input rarely hits.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { allocate, inferHistory, learnStyle, learnStyleFromDb, reinferMany, reinferPending, relearnStyle, styleOf } from '../src/services/inference.js';
import { flushRollups } from '../src/services/rollup.js';
import { spreadByDay } from '../src/services/stats.js';

const MIN = 60_000;
const DAY = 86_400_000;
const EARLIEST = Date.UTC(1995, 0, 1);
const local = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const startOfDay = (t) => new Date(t).setHours(0, 0, 0, 0);
const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + f(x), 0);
const shape = (res) => res.chunks.map((c) => [c.start, c.end, c.minutes, c.why, c.confidence, c.basis]);

/** Seeded generator (mulberry32): the cases never depend on Math.random or the clock. */
function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (xs) => xs[next.int(xs.length)];
  return next;
}

/** Estimated minutes per local day, spread as the chart rollups spread them. */
function byDay(chunks) {
  const days = new Map();
  for (const c of chunks) {
    for (const [, m, d] of spreadByDay({ minutes: c.minutes, window_start: c.start, window_end: c.end })) days.set(d, (days.get(d) || 0) + m);
  }
  return days;
}

// ---------------------------------------------------------------------------- one game
/** Random evidence around tracking start T: every kind of date, sometimes contradictory. */
function randomEvidence(r) {
  const T = r.pick([
    local(2015 + r.int(11), 1 + r.int(12), 1 + r.int(28), r.int(24), r.int(60)),
    local(2019 + r.int(7), 1 + r.int(12), 1 + r.int(28), 0, 0), // tracking began at midnight
    local(2025, 11, 2, 12), local(2025, 3, 9, 12), local(2025, 3, 30, 12), local(2025, 10, 26, 12), // DST changes (US, EU)
    local(2024, 2, 29, 8), local(2024, 3, 1, 0, 30), local(2024, 1, 1, 0, 30), local(2023, 12, 31, 23, 59), // leap day, new year
  ]);
  const back = () => T - Math.floor(r.pick([0, 1, 30, 600, 1440, r() * 20 * 1440, r() * 400 * 1440, r() * 3000 * 1440])) * MIN;
  const e = { minutes: r.pick([0, 1, 5, 14, 15, 16, 59, 600, 601, r.int(3000), r.int(60000), 600_000]), trackingStart: T };
  if (r() < 0.6) e.lastPlayedAt = r() < 0.05 ? T + r.int(5 * DAY) : back();
  if (r() < 0.4) e.firstPlayedAt = r() < 0.03 ? T + 1000 : back();
  if (r() < 0.2) e.playCount = 1 + r.int(300);
  if (r() < 0.3) e.anchors = Array.from({ length: r.int(12) }, () => (r() < 0.05 ? T + r.int(DAY) : back()));
  if (r() < 0.3) e.recent = { minutes: 1 + r.int(r.pick([10, 500, 5000, 30000])), days: r.pick([14, 7, 1, 30, undefined]) };
  if (r() < 0.2) e.dateAdded = r() < 0.05 ? T + r.int(5 * DAY) : back();
  if (r() < 0.15) e.releaseAt = back();
  if (r() < 0.1) e.accountCreatedAt = back();
  if (r() < 0.2) {
    const [a, b] = [back(), r() < 0.1 ? T + DAY : back()].sort((x, y) => x - y);
    e.manual = r.pick([{ start: a, end: b }, { start: a }, { end: b }]);
  }
  if (r() < 0.03) e.mode = 'undated';
  return e;
}

/** Learned styles of 3, 8, 30 and 300 games (30+ also shape games whose start is unknown). */
const STYLES = [3, 8, 30, 300].map((games, k) => {
  const r = rng(1000 + k);
  return learnStyle(Array.from({ length: games }, () => {
    const t0 = local(2020, 1, 1) + r.int(900) * DAY;
    const span = 8 + r.int(500);
    return Array.from({ length: 4 + r.int(40) }, () => ({ t: t0 + Math.floor(r() * r() * span) * DAY, minutes: 10 + r.int(300) }));
  }));
});

function checkGame(e, opts, res, at) {
  const T = e.trackingStart;
  const total = Math.max(0, Math.round(e.minutes));
  const placed = sum(res.chunks, (c) => c.minutes);
  // conservation
  assert.equal(placed + res.undated, total, `dated + undated = the minutes to explain ${at}`);
  assert.ok(res.undated >= 0, `undated is never negative ${at}`);
  if (e.mode === 'undated') assert.equal(placed, 0, `"don't chart" dates nothing ${at}`);
  if (!res.chunks.length) return;
  assert.ok(res.window[0] < res.window[1], `the window runs forwards ${at}`);
  // bounds
  const hard = e.manual?.start ?? e.firstPlayedAt ?? null;
  const lastPlayed = e.lastPlayedAt ? Math.min(e.lastPlayedAt, T) : null;
  const lastKnown = e.manual?.end ?? lastPlayed;
  const bound = Math.max(e.releaseAt || 0, e.accountCreatedAt || 0, EARLIEST);
  let prevEnd = -Infinity;
  for (const c of res.chunks) {
    const where = `${at} chunk ${new Date(c.start).toISOString()}..${new Date(c.end).toISOString()} ${c.minutes} min`;
    assert.ok(Number.isInteger(c.minutes) && c.minutes > 0, `whole positive minutes ${where}`);
    assert.ok(c.start < c.end, `a real window ${where}`);
    assert.ok(c.end <= T, `nothing after tracking began ${where}`);
    assert.ok(c.start >= startOfDay(EARLIEST), `nothing before 1995 ${where}`);
    assert.ok(c.start >= prevEnd, `stretches never overlap ${where}`);
    prevEnd = c.end;
    assert.ok(c.minutes <= (c.end - c.start) / MIN + 1, `never more minutes than the window lasts ${where}`);
    if (hard != null && hard <= T) {
      assert.ok(c.start >= startOfDay(hard), `not before the first played day ${where}`);
      assert.ok(!(c.start < hard && c.end > hard), `never across the first played time ${where}`);
    }
    // (the recent-play counter overrides a last played date older than its window; dates you set replace it)
    if (lastPlayed != null && !e.recent && !e.manual?.end && !(e.manual?.start > lastPlayed)) assert.ok(c.end <= lastPlayed, `not after last played ${where}`);
    if (e.manual?.end && c.why === 'history') assert.ok(c.end <= e.manual.end, `not after the end you set ${where}`);
    // release / account creation bound the start unless the game was last played before them
    // (or, with a recent-play counter, the rest has to lie before its days; an end worked out from
    // unlock times may be the last moment of the day before)
    if (!e.recent && startOfDay(bound) < (lastKnown ?? T) && (lastKnown != null || !e.anchors?.length)) assert.ok(c.start >= startOfDay(bound), `not before the release / account day ${where}`);
    assert.ok(['recent', 'history'].includes(c.why) && ['high', 'medium', 'low'].includes(c.confidence), `labelled ${where}`);
    if (c.basis === 'anchored') assert.ok((e.anchors || []).some((a) => a >= c.start && a <= c.end), `anchored means an unlock inside ${where}`);
    if (c.basis === 'confirmed') assert.ok(e.manual?.start || e.manual?.end, `confirmed means dates you set ${where}`);
  }
  // caps: 0.01 absorbs the float spread of a multi-day stretch only
  for (const [d, m] of byDay(res.chunks)) {
    assert.ok(m <= opts.maxPerDay + 0.01, `${Math.round(m)} min on ${new Date(d).toDateString()} is above the game's ${opts.maxPerDay} a day ${at}`);
    if (opts.dayRoom) assert.ok(m <= opts.dayRoom(d) + 0.01, `${Math.round(m)} min on ${new Date(d).toDateString()} is above the ${opts.dayRoom(d)} left that day ${at}`);
  }
  // the recent-play counter's minutes stay inside its days
  if (e.recent) {
    const recent = res.chunks.filter((c) => c.why === 'recent');
    assert.ok(sum(recent, (c) => c.minutes) <= Math.min(e.recent.minutes, total), `no more recent minutes than the counter reports ${at}`);
    for (const c of recent) assert.ok(c.start >= startOfDay(T - (e.recent.days || 14) * DAY), `recent minutes inside the counter's days ${at}`);
  }
}

describe('one game: every estimate is conserved, bounded and repeatable', () => {
  test('4000 random games (all kinds of evidence, caps, busy days, learned styles) hold every invariant', () => {
    for (let seed = 1; seed <= 4000; seed++) {
      const r = rng(seed);
      const e = randomEvidence(r);
      const maxPerDay = r.pick([600, 600, 600, 60, 1440, 1, 14]);
      // other games already fill some days: none, a little, half or all of the shared budget
      const roomSeed = r.int(1e9);
      const dayRoom = r() < 0.3 ? (t) => { const x = rng(roomSeed ^ Math.floor(startOfDay(t) / 3_600_000))(); return x < 0.3 ? 0 : x < 0.5 ? 10 : x < 0.7 ? 300 : 720; } : null;
      const opts = { maxPerDay, dayRoom, style: r.pick([null, null, ...STYLES]) };
      const at = `(seed ${seed}: ${JSON.stringify(e)}, cap ${maxPerDay}${dayRoom ? ', busy days' : ''})`;
      const res = inferHistory(structuredClone(e), opts);
      checkGame(e, opts, res, at);
      // the same input gives the same output
      assert.deepEqual(inferHistory(structuredClone(e), opts), res, `repeatable ${at}`);
    }
  });

  test('the order of unlock times does not matter', () => {
    const r = rng(7);
    const T = local(2025, 6, 20);
    const anchors = Array.from({ length: 40 }, () => T - r.int(400) * DAY - r.int(DAY));
    const e = { minutes: 9000, trackingStart: T, lastPlayedAt: T - 3 * DAY, anchors };
    const sorted = inferHistory({ ...e, anchors: [...anchors].sort((a, b) => a - b) });
    assert.deepEqual(shape(inferHistory({ ...e, anchors: [...anchors].reverse() })), shape(sorted));
    assert.deepEqual(e.anchors, anchors, 'the evidence is not modified');
  });

  test('nothing depends on the clock when tracking start is given', () => {
    const e = { minutes: 5000, trackingStart: local(2024, 5, 5), lastPlayedAt: local(2024, 4, 1), dateAdded: local(2023, 1, 1) };
    const first = inferHistory(e);
    const RealDate = Date;
    try {
      globalThis.Date = class extends RealDate {
        constructor(...a) { if (a.length) super(...a); else super(RealDate.UTC(2040, 0, 1)); }
        static now() { return RealDate.UTC(2040, 0, 1); }
      };
      assert.deepEqual(inferHistory(e), first);
    } finally { globalThis.Date = RealDate; }
  });

  test('totals of 0, less than a minute, or negative have no history; a single minute is one dated minute', () => {
    const T = local(2025, 6, 20);
    for (const minutes of [0, 0.4, -5, null, undefined, NaN]) {
      const res = inferHistory({ minutes, trackingStart: T, lastPlayedAt: T - DAY });
      assert.deepEqual([res.chunks, res.undated, res.window], [[], 0, null], String(minutes));
    }
    const one = inferHistory({ minutes: 1, trackingStart: T, lastPlayedAt: T - DAY });
    assert.deepEqual([one.chunks.length, one.chunks[0].minutes, one.undated], [1, 1, 0]);
    assert.ok(one.chunks[0].end <= T - DAY);
  });

  test('10,000 h in a three-day window: 10 h a day are dated, the rest stays undated, nothing is invented', () => {
    const T = local(2025, 6, 20);
    const res = inferHistory({ minutes: 600_000, trackingStart: T, firstPlayedAt: T - 3 * DAY, lastPlayedAt: T - DAY });
    assert.equal(sum(res.chunks, (c) => c.minutes), 1800);
    assert.equal(res.undated, 598_200);
    assert.ok(res.chunks.every((c) => c.start >= T - 3 * DAY && c.end <= T - DAY));
    // with no start it is spread back as far as it takes, never above 10 h a day
    const open = inferHistory({ minutes: 600_000, trackingStart: T, lastPlayedAt: T - DAY });
    assert.equal(sum(open.chunks, (c) => c.minutes) + open.undated, 600_000);
    assert.ok(Math.max(...byDay(open.chunks).values()) <= 600.01);
  });

  test('first played without last played is dated after it; last played without first played before it', () => {
    const T = local(2025, 6, 20);
    const first = inferHistory({ minutes: 3000, trackingStart: T, firstPlayedAt: T - 1000 * DAY });
    assert.equal(first.undated, 0);
    assert.ok(first.window[0] >= T - 1000 * DAY && first.window[1] < T - 900 * DAY, 'a burst after first played, not years of it');
    const last = inferHistory({ minutes: 3000, trackingStart: T, lastPlayedAt: T - 1000 * DAY });
    assert.equal(last.undated, 0);
    assert.ok(last.window[1] <= T - 1000 * DAY);
    assert.equal(first.confidence, 'low');
    assert.equal(last.confidence, 'low');
  });

  test('days that change the clock, the leap day and new year keep the caps and lose nothing', () => {
    // each window crosses the special day; whichever timezone runs this, some of them change the clock
    for (const [from, to] of [[local(2025, 3, 7), local(2025, 3, 11)], [local(2025, 10, 31), local(2025, 11, 4)], [local(2025, 3, 28), local(2025, 4, 1)],
      [local(2025, 10, 24), local(2025, 10, 28)], [local(2025, 4, 4), local(2025, 4, 8)], [local(2025, 9, 25), local(2025, 9, 29)],
      [local(2024, 2, 27), local(2024, 3, 2)], [local(2023, 12, 29), local(2024, 1, 3)]]) {
      const e = { minutes: 2400, trackingStart: to + 30 * DAY, firstPlayedAt: from, lastPlayedAt: to };
      const res = inferHistory(e);
      checkGame(e, { maxPerDay: 600 }, res, `(${new Date(from).toDateString()} - ${new Date(to).toDateString()})`);
      assert.equal(res.undated, 0);
      // a full window: every day at its cap, also the 23 and 25 hour ones
      const full = inferHistory({ ...e, minutes: 20_000 });
      checkGame({ ...e, minutes: 20_000 }, { maxPerDay: 600 }, full, `(full, ${new Date(from).toDateString()})`);
      const days = byDay(full.chunks);
      for (let d = startOfDay(from) + 36 * 3_600_000; d < startOfDay(to); d += DAY) assert.ok(Math.abs(days.get(startOfDay(d)) - 600) < 0.01, `${new Date(d).toDateString()} holds 10 h`);
    }
  });

  test('a first or last day cut short holds no more minutes than it has', () => {
    const T = local(2025, 6, 20);
    // first played 23:30, last played 00:20 two days later: 30 + 600 + 20 minutes fit
    const e = { minutes: 5000, trackingStart: T, firstPlayedAt: local(2025, 6, 10, 23, 30), lastPlayedAt: local(2025, 6, 12, 0, 20) };
    const res = inferHistory(e);
    checkGame(e, { maxPerDay: 600 }, res, '(short days)');
    assert.equal(sum(res.chunks, (c) => c.minutes), 650);
    assert.equal(res.undated, 4350);
  });
});

describe('allocate: minutes over days', () => {
  test('never invents minutes, never exceeds a day\'s cap, and is the same every time', () => {
    for (let seed = 1; seed <= 20_000; seed++) {
      const r = rng(seed);
      const n = 1 + r.int(r.pick([3, 10, 60]));
      const weights = Array.from({ length: n }, () => r.pick([0, 0.05, 1, r() * 5, 100]));
      const cap = Array.from({ length: n }, () => r.pick([0, 5, 14, 15, 20, 100, 600, 600]));
      const minutes = r.pick([1, 14, 15, 16, 40, r.int(2000), r.int(20_000)]);
      const out = allocate(minutes, weights, { cap, minDay: 15 });
      const at = `(seed ${seed})`;
      assert.equal(out.length, n);
      assert.ok(out.every((x, i) => x >= 0 && x <= cap[i] + 1e-9), `within every cap ${at}`);
      assert.ok(sum(out) <= minutes + 1e-6, `nothing invented ${at}`);
      // what it leaves out is at most a remainder too small for a day of its own
      const usable = sum(cap.filter((c) => c >= 15));
      assert.ok(sum(out) >= Math.min(minutes, usable) - 15, `all but less than one minimum day is placed while days have room ${at}`);
      assert.deepEqual(allocate(minutes, weights, { cap, minDay: 15 }), out);
    }
  });

  test('with room everywhere every minute is placed and no active day is below the minimum', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed);
      const n = 1 + r.int(200);
      const weights = Array.from({ length: n }, () => r() * r.pick([1, 10]));
      const minutes = 15 + r.int(n * 500);
      const out = allocate(minutes, weights, { cap: 600, minDay: 15 });
      assert.ok(Math.abs(sum(out) - Math.min(minutes, n * 600)) < 1e-6, `seed ${seed}: ${sum(out)} of ${minutes}`);
      assert.ok(out.every((x) => x === 0 || x >= 15 - 1e-9), `seed ${seed}`);
    }
  });
});

// ---------------------------------------------------------------------------- a library
function randomLibrary(seed, { excluded = true } = {}) {
  const r = rng(seed);
  const db = openDb(':memory:');
  const T = local(2025, 1 + r.int(12), 1 + r.int(28), r.int(24), r.int(60));
  const settings = { history_max_day_minutes: r.pick([720, 720, 300, 1440]), history_max_game_day_minutes: r.pick([600, 600, 120, 1440]) };
  const span = r.pick([10, 30, 200, 1500]);
  const back = () => T - Math.floor(r.pick([0, 30, 600, r() * span * 1440, r() * span * 1440])) * MIN;
  const ids = [];
  const insGame = db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, 0, 0)');
  const insEntry = db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, baseline_min, first_seen_at, excluded, hist)
    VALUES (NULL, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`);
  const insPlay = db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at) VALUES (?, 'manual', 'play', ?, ?, ?, ?, ?, ?)");
  for (let g = 0, n = 5 + r.int(30); g < n; g++) {
    const game = Number(insGame.run(`G${g}`, `g${g}`).lastInsertRowid);
    const baseline = r.pick([0, 1, 14, 60, r.int(3000), r.int(30000), r() < 0.1 ? 600_000 : 90]);
    const h = { tracking_start: r() < 0.8 ? T : back() };
    if (r() < 0.7) h.last_played_at = back();
    if (r() < 0.4) h.first_played_at = back();
    if (r() < 0.2) h.play_count = 1 + r.int(100);
    if (r() < 0.3) h.anchors = Array.from({ length: 1 + r.int(10) }, back).sort((a, b) => a - b);
    if (r() < 0.2) { h.recent_min = 1 + r.int(2000); h.recent_days = 14; }
    if (r() < 0.2) h.date_added = back();
    if (r() < 0.1) h.mode = 'undated';
    if (r() < 0.15) { const [a, b] = [back(), back()].sort((x, y) => x - y); h.manual = { start: a, end: b }; }
    // tracked play: before tracking start too (imported sessions), on days history wants as well
    const plays = Array.from({ length: r() < 0.5 ? r.int(6) : 0 }, () => { const m = 10 + r.int(500); const end = r() < 0.5 ? back() : T + r.int(3 * DAY); return [m, end - m * MIN, end]; });
    const id = Number(insEntry.run(game, `x${g}`, `G${g}`, baseline + sum(plays, (p) => p[0]), baseline, T, excluded && r() < 0.15 ? 1 : 0, JSON.stringify(h)).lastInsertRowid);
    for (const [m, s, e] of plays) insPlay.run(id, m, s, e, s, e, T);
    ids.push(id);
  }
  flushRollups(db);
  return { db, r, T, settings, ids };
}

const fingerprint = (db) => JSON.stringify(db.prepare(`SELECT entry_id, kind, minutes, window_start, window_end, confidence, basis FROM sessions
  WHERE source = 'inferred' ORDER BY entry_id, COALESCE(window_start, 0), id`).all());
const withHistory = (db, ids) => ids.filter((id) => db.prepare('SELECT baseline_min b FROM entries WHERE id = ?').get(id).b > 0);
const redateAll = (db, settings) => { db.prepare('UPDATE entries SET inferred_v = 0 WHERE baseline_min > 0').run(); reinferPending(db, { settings }); flushRollups(db); };

function checkLibrary(db, settings, at) {
  const rows = (sql, ...a) => db.prepare(sql).all(...a).map((x) => ({ ...x }));
  assert.deepEqual(rows(`SELECT e.id, e.baseline_min, COALESCE(SUM(s.minutes), 0) history FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id AND s.source = 'inferred'
    GROUP BY e.id HAVING history != e.baseline_min`), [], `dated + undated history = the pre-tracking minutes ${at}`);
  assert.deepEqual(rows('SELECT e.id, e.playtime_min, COALESCE(SUM(s.minutes), 0) total FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING total != e.playtime_min'), [],
    `sessions add up to the lifetime total ${at}`);
  assert.deepEqual(rows(`SELECT s.id, s.minutes, s.window_start, s.window_end FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE s.kind = 'estimate'
    AND (s.window_end > json_extract(e.hist, '$.tracking_start') OR s.window_start >= s.window_end OR s.minutes <= 0 OR s.minutes > (s.window_end - s.window_start) / 60000.0 + 1)`), [],
  `estimates are real windows before tracking began ${at}`);
  assert.deepEqual(rows("SELECT s.id FROM sessions s WHERE s.source = 'inferred' AND s.kind = 'baseline' AND (s.window_start IS NOT NULL OR s.started_at IS NOT NULL)"), [], `undated history has no date ${at}`);
  // history only fills what tracked play (and other games' history) leaves of a day
  assert.deepEqual(rows(`SELECT day, ROUND(SUM(minutes), 2) minutes, ROUND(SUM(CASE WHEN estimated = 1 THEN minutes ELSE 0 END), 2) estimated FROM play_days WHERE excluded = 0
    GROUP BY day HAVING estimated > 0.01 AND minutes > ? + 1`, settings.history_max_day_minutes), [], `no day with history above ${settings.history_max_day_minutes} min across all games ${at}`);
  assert.deepEqual(rows('SELECT entry_id, day, ROUND(SUM(minutes), 2) minutes FROM play_days WHERE estimated = 1 GROUP BY entry_id, day HAVING minutes > ? + 1', settings.history_max_game_day_minutes), [],
    `no game above ${settings.history_max_game_day_minutes} estimated min a day ${at}`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rollup_queue').get().n, 0, `rollups are up to date ${at}`);
  const est = db.prepare("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE kind = 'estimate'").get().m;
  const rolled = db.prepare('SELECT COALESCE(SUM(minutes), 0) m FROM play_days WHERE estimated = 1').get().m;
  assert.ok(Math.abs(est - rolled) < 0.01, `the charts hold every estimated minute (${rolled} of ${est}) ${at}`);
  assert.deepEqual(rows("SELECT e.id FROM entries e JOIN sessions s ON s.entry_id = e.id WHERE json_extract(e.hist, '$.mode') = 'undated' AND s.kind = 'estimate'"), [], `"don't chart" entries have no estimates ${at}`);
}

describe('a library: shared days, totals and re-dating', () => {
  test('60 random libraries: conserved, capped with tracked play counted, and re-dating changes nothing', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { db, settings, ids } = randomLibrary(seed);
      const at = `(library ${seed})`;
      const totals = () => JSON.stringify(db.prepare('SELECT id, playtime_min, baseline_min FROM entries ORDER BY id').all());
      const before = totals();
      reinferMany(db, withHistory(db, ids), { settings });
      flushRollups(db);
      checkLibrary(db, settings, `${at} first dating`);
      const first = fingerprint(db);
      redateAll(db, settings);
      checkLibrary(db, settings, `${at} re-dated`);
      assert.equal(fingerprint(db), first, `re-dating everything changes nothing ${at}`);
      assert.equal(totals(), before, `no total changes because history was dated ${at}`);
      db.close();
    }
  });

  test('the order entries are handed over in does not change the dating', () => {
    for (let seed = 101; seed <= 110; seed++) {
      const a = randomLibrary(seed);
      const b = randomLibrary(seed);
      reinferMany(a.db, withHistory(a.db, a.ids), { settings: a.settings });
      reinferMany(b.db, withHistory(b.db, b.ids).reverse(), { settings: b.settings });
      assert.equal(fingerprint(b.db), fingerprint(a.db), `library ${seed}`);
      a.db.close(); b.db.close();
    }
  });

  test('changes to a library keep every invariant: shrinking and growing history, "don\'t chart", windows, exclusion', () => {
    for (let seed = 201; seed <= 225; seed++) {
      const { db, r, T, settings, ids } = randomLibrary(seed);
      reinferMany(db, withHistory(db, ids), { settings });
      flushRollups(db);
      for (let step = 0; step < 8; step++) {
        const id = r.pick(ids);
        const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
        const h = JSON.parse(e.hist);
        const what = r.pick(['shrink', 'grow', 'undated', 'auto', 'window', 'reset', 'exclude', 'caps']);
        if (what === 'shrink' || what === 'grow') {
          // (as an import that restores sessions, or a platform that back-fills a total)
          const next = what === 'shrink' ? r.int(e.baseline_min + 1) : e.baseline_min + 1 + r.int(5000);
          db.prepare('UPDATE entries SET baseline_min = ?, playtime_min = playtime_min + ? WHERE id = ?').run(next, next - e.baseline_min, id);
        } else if (what === 'undated') h.mode = 'undated';
        else if (what === 'auto') h.mode = 'auto';
        else if (what === 'window') { const [a, b] = [T - r.int(400) * DAY, T - r.int(400) * DAY].sort((x, y) => x - y); h.manual = r.pick([{ start: a, end: b }, { start: a }, { end: b }]); }
        else if (what === 'reset') { delete h.manual; h.mode = 'auto'; }
        else if (what === 'exclude') db.prepare('UPDATE entries SET excluded = 1 - excluded WHERE id = ?').run(id);
        else settings.history_max_day_minutes = r.pick([300, 720, 1440]);
        db.prepare('UPDATE entries SET hist = ? WHERE id = ?').run(JSON.stringify(h), id);
        flushRollups(db);
        // an entry's own change re-dates it alone; exclusion and caps concern every day's budget
        if (what === 'exclude' || what === 'caps') redateAll(db, settings); else { reinferMany(db, [id], { settings }); flushRollups(db); }
        const at = `(library ${seed}, step ${step}: ${what} entry ${id})`;
        const now = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
        const kinds = Object.fromEntries(db.prepare("SELECT kind, SUM(minutes) m FROM sessions WHERE entry_id = ? AND source = 'inferred' GROUP BY kind").all(id).map((x) => [x.kind, x.m]));
        if (JSON.parse(now.hist).mode === 'undated') assert.deepEqual(kinds, now.baseline_min ? { baseline: now.baseline_min } : {}, `"don't chart" keeps it all undated ${at}`);
        if (what === 'window' && kinds.estimate) {
          const w = db.prepare("SELECT MIN(window_start) a, MAX(window_end) b FROM sessions WHERE entry_id = ? AND kind = 'estimate' AND note = 'Estimated from history'").get(id);
          if (h.manual.start && w.a != null) assert.ok(w.a >= Math.min(h.manual.start, startOfDay(h.manual.start)), `not before the start you set ${at}`);
          if (h.manual.end && w.b != null) assert.ok(w.b <= h.manual.end, `not after the end you set ${at}`);
        }
        // caps hold after a re-date of everything; a single re-date fits into the others as they are
        checkLibrary(db, settings, at);
      }
      db.close();
    }
  });

  test('a confirmed estimate is kept exactly through re-dating, new evidence and "don\'t chart" and back', () => {
    const { db, settings, ids } = randomLibrary(301, { excluded: false });
    reinferMany(db, withHistory(db, ids), { settings });
    flushRollups(db);
    const id = db.prepare("SELECT entry_id id FROM sessions WHERE kind = 'estimate' GROUP BY entry_id ORDER BY COUNT(*) DESC LIMIT 1").get().id;
    const own = () => JSON.stringify(db.prepare("SELECT kind, minutes, window_start, window_end FROM sessions WHERE entry_id = ? AND source = 'inferred' ORDER BY COALESCE(window_start, 0), id").all(id));
    const setHist = (f) => { const h = JSON.parse(db.prepare('SELECT hist FROM entries WHERE id = ?').get(id).hist); f(h); db.prepare('UPDATE entries SET hist = ? WHERE id = ?').run(JSON.stringify(h), id); };
    const before = own();
    // what PATCH /entries/:id/history { confirm: true } stores
    setHist((h) => { h.manual = { start: h.inference.window[0], end: h.inference.window[1], confirmed: true }; h.mode = 'auto'; });
    redateAll(db, { ...settings, history_max_game_day_minutes: 30, history_max_day_minutes: 60 });
    assert.equal(own(), before, 'new caps do not move it');
    setHist((h) => { h.anchors = [h.inference.window[0] - 50 * DAY]; h.last_played_at = h.inference.window[0] - 10 * DAY; });
    redateAll(db, settings);
    assert.equal(own(), before, 'new evidence does not move it');
    setHist((h) => { h.mode = 'undated'; });
    reinferMany(db, [id], { settings });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE entry_id = ? AND kind = 'estimate'").get(id).n, 0);
    setHist((h) => { h.mode = 'auto'; });
    reinferMany(db, [id], { settings });
    flushRollups(db);
    assert.equal(own(), before, 'charting it again brings the confirmed estimate back');
    assert.ok(db.prepare("SELECT COUNT(*) n FROM sessions WHERE entry_id = ? AND kind = 'estimate' AND (basis IS NOT 'confirmed' OR confidence IS NOT 'high')").get(id).n === 0);
    // reset: dated automatically again, still adding up
    setHist((h) => { delete h.manual; });
    redateAll(db, settings);
    checkLibrary(db, settings, '(after reset)');
    db.close();
  });
});

// ---------------------------------------------------------------------------- learning
describe('learned play style', () => {
  const steady = (start, sessions, every, minutes = 90) => Array.from({ length: sessions }, (_, i) => ({ t: start + i * every * DAY, minutes }));

  test('too little to learn from: fewer than 3 usable games teach nothing, and nothing changes', () => {
    const T = local(2025, 6, 20);
    assert.equal(learnStyle([]), null);
    assert.equal(learnStyle([steady(T - 400 * DAY, 30, 2), steady(T - 300 * DAY, 30, 3)]), null);
    // games with under 4 sessions or under a week of play are not usable
    assert.equal(learnStyle([steady(T - 400 * DAY, 30, 2), steady(T - 300 * DAY, 30, 3), steady(T - 200 * DAY, 3, 10), steady(T - 100 * DAY, 6, 1)]), null);
    const e = { minutes: 3000, trackingStart: T, firstPlayedAt: T - 300 * DAY, lastPlayedAt: T - 100 * DAY };
    const plain = inferHistory(e);
    // a style object with too few samples (hand-edited, or from an older version) is ignored
    for (const style of [null, undefined, {}, { v: 3, games: 2, tracked: 2, samples: [] }, { v: 3, games: 50, tracked: 50, samples: [{ m: 100, s: 10, rel: [], back: [] }] }]) {
      assert.deepEqual(inferHistory(e, { style }), plain);
    }
  });

  test('a style of a few games shapes known windows only; one of 20+ tracked games also dates games with no start', () => {
    const T = local(2025, 6, 20);
    const games = (n) => Array.from({ length: n }, (_, k) => steady(T - (2000 - k * 30) * DAY, 40, 9));
    const few = learnStyle(games(8));
    const many = learnStyle(games(25));
    const bounded = { minutes: 3600, trackingStart: T, firstPlayedAt: T - 400 * DAY, lastPlayedAt: T - 40 * DAY };
    const open = { minutes: 3600, trackingStart: T, lastPlayedAt: T - 40 * DAY };
    assert.notDeepEqual(shape(inferHistory(bounded, { style: few })), shape(inferHistory(bounded)));
    assert.deepEqual(shape(inferHistory(open, { style: few })), shape(inferHistory(open)), '8 games say nothing about an unknown start');
    assert.notDeepEqual(shape(inferHistory(open, { style: many })), shape(inferHistory(open)));
    // learned from unlock times alone (no tracked sessions): never for an unknown start
    const unlocksOnly = learnStyle(games(25).map((g) => Object.assign(g, { tracked: false })));
    assert.equal(unlocksOnly.tracked, 0);
    assert.deepEqual(shape(inferHistory(open, { style: unlocksOnly })), shape(inferHistory(open)));
    // learned or not, the invariants hold
    for (const style of [few, many, unlocksOnly]) for (const e of [bounded, open]) checkGame(e, { maxPerDay: 600 }, inferHistory(e, { style }), '(styled)');
  });

  test('only fully tracked, finished games teach it - never estimated history, so re-dating cannot feed itself', () => {
    const T = local(2025, 6, 20);
    const db = openDb(':memory:');
    const entry = (title, { baseline = 0, hist = {}, excluded = 0, plays = [] } = {}) => {
      const game = Number(db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, 0, 0)').run(title, title.toLowerCase()).lastInsertRowid);
      const id = Number(db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, baseline_min, first_seen_at, excluded, hist) VALUES (NULL, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`)
        .run(game, title, title, baseline + sum(plays, (p) => p.minutes), baseline, T - 900 * DAY, excluded, JSON.stringify({ tracking_start: T - 900 * DAY, ...hist })).lastInsertRowid);
      for (const p of plays) db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at) VALUES (?, 'manual', 'play', ?, ?, ?, ?, ?, 0)").run(id, p.minutes, p.t - p.minutes * MIN, p.t, p.t - p.minutes * MIN, p.t);
      return id;
    };
    // history with dates but no unlock times: only estimates to show for it
    const hist = [0, 1, 2, 3, 4, 5].map((k) => entry(`History ${k}`, { baseline: 4000 + k * 500, hist: { first_played_at: T - 1800 * DAY, last_played_at: T - (1000 + k * 20) * DAY } }));
    // tracked games that do not count: also has untracked history, still being played, excluded, too few sessions
    entry('Half tracked', { baseline: 500, plays: steady(T - 800 * DAY, 20, 5) });
    entry('Still playing', { plays: steady(T - 100 * DAY, 20, 5) });
    entry('Excluded', { excluded: 1, plays: steady(T - 800 * DAY, 20, 5) });
    entry('Three sessions', { plays: steady(T - 800 * DAY, 3, 5) });
    entry('Finished 1', { plays: steady(T - 800 * DAY, 20, 5) });
    entry('Finished 2', { plays: steady(T - 700 * DAY, 30, 4) });
    const settings = {};
    assert.equal(hist.length, 6);
    redateAll(db, settings);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM sessions WHERE kind = 'estimate'").get().n > 50, 'there is plenty of estimated history');
    assert.equal(learnStyleFromDb(db, { now: T }), null, 'two finished games and any amount of estimates teach nothing');
    assert.equal(relearnStyle(db, { settings, now: T }), false);
    assert.equal(styleOf(db), null);

    entry('Finished 3', { plays: steady(T - 600 * DAY, 25, 6) });
    const style = learnStyleFromDb(db, { now: T });
    assert.deepEqual([style.games, style.tracked], [3, 3]);
    assert.deepEqual(style.samples.map((x) => x.m), [20 * 90, 25 * 90, 30 * 90], 'exactly the three finished games');
    // learning it re-dates the history with it; learning again from the re-dated library gives the same style
    const before = fingerprint(db);
    assert.equal(relearnStyle(db, { settings, now: T }), true);
    flushRollups(db);
    assert.notEqual(fingerprint(db), before, 'history is re-dated in the learned shape');
    assert.deepEqual(learnStyleFromDb(db, { now: T }), style, 'the re-dated estimates taught nothing new');
    assert.equal(relearnStyle(db, { settings, now: T }), false, 'so it settles at once');
    const settled = fingerprint(db);
    redateAll(db, settings);
    assert.equal(fingerprint(db), settled);
    checkLibrary(db, { history_max_day_minutes: 720, history_max_game_day_minutes: 600 }, '(learned)');
    // switched off: forgotten, and the history is back to the default shape exactly
    assert.equal(relearnStyle(db, { settings: { history_learn: false }, now: T }), true);
    flushRollups(db);
    assert.equal(styleOf(db), null);
    assert.equal(fingerprint(db), before);
    db.close();
  });
});

// ---------------------------------------------------------------------------- cost
describe('cost', () => {
  test('a game\'s dating is linear in the days of its window', () => {
    const T = local(2026, 6, 1);
    const calls = (days) => {
      let n = 0;
      inferHistory({ minutes: days * 20, trackingStart: T, firstPlayedAt: T - days * DAY, lastPlayedAt: T - DAY }, { dayRoom: () => { n++; return 720; } });
      return n;
    };
    // each day of the window is looked at once (a 10-year window: 3650 looks, not 3650 squared)
    for (const days of [100, 1000, 3650]) assert.ok(calls(days) <= days + 2, `${calls(days)} looks for ${days} days`);
    // an open start may widen the window a few times, never per day
    let n = 0;
    inferHistory({ minutes: 60_000, trackingStart: T, lastPlayedAt: T - DAY }, { dayRoom: (t) => { n++; return startOfDay(t) % (2 * DAY) ? 0 : 100; } });
    assert.ok(n <= 6 * 4000, `${n} looks`);
  });

  test('1,000 games with ten years of history each are dated in seconds, and four times the games take about four times as long', () => {
    const T = local(2026, 6, 1);
    const run = (games) => {
      const r = rng(games);
      const db = openDb(':memory:');
      const ids = [];
      db.exec('BEGIN');
      for (let g = 0; g < games; g++) {
        const game = Number(db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, 0, 0)').run(`G${g}`, `g${g}`).lastInsertRowid);
        const first = T - Math.floor((0.5 + r() / 2) * 3650) * DAY;
        const last = T - r.int(30) * DAY;
        const minutes = Math.floor(30 + r() * r() * 12_000);
        const hist = { tracking_start: T, first_played_at: first, last_played_at: last, anchors: Array.from({ length: 20 }, () => Math.floor(first + r() * (last - first))).sort((a, b) => a - b) };
        ids.push(Number(db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, baseline_min, first_seen_at, hist) VALUES (NULL, ?, 'manual', ?, ?, ?, ?, ?, ?)`)
          .run(game, `x${g}`, `G${g}`, minutes, minutes, T, JSON.stringify(hist)).lastInsertRowid));
      }
      db.exec('COMMIT');
      const t = performance.now();
      db.exec('BEGIN');
      reinferMany(db, ids, { settings: {} });
      db.exec('COMMIT');
      flushRollups(db);
      const ms = performance.now() - t;
      checkLibrary(db, { history_max_day_minutes: 720, history_max_game_day_minutes: 600 }, `(${games} games)`);
      db.close();
      return ms;
    };
    const small = run(250);
    const large = run(1000);
    // measured: ~2 s and ~6 s. Quadratic growth would be 16 times; the bounds leave room for a busy machine
    assert.ok(large < 60_000, `1,000 games took ${Math.round(large)} ms`);
    assert.ok(large < small * 10 + 2000, `250 games ${Math.round(small)} ms, 1,000 games ${Math.round(large)} ms`);
  });
});
