// History dating against evidence seen in a real library: placeholder dates, unlocks that
// contradict a release or last played date, periods answered by year, and games older than 1995.
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { inferHistory, looksCoarse, realTime, reinferMany, INFER_VERSION } from '../src/services/inference.js';
import { flushRollups } from '../src/services/rollup.js';

const DAY = 86_400_000;
// noon, local time: whole days on both sides in any timezone
const T = new Date(2026, 9, 22, 12).getTime();
const dated = (res) => res.chunks.reduce((a, c) => a + c.minutes, 0);
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
// minutes per month, each stretch spread evenly over its days (as the charts spread it)
const byMonth = (res) => {
  const out = {};
  for (const c of res.chunks) {
    const days = [];
    for (let d = new Date(c.start).setHours(0, 0, 0, 0); d <= c.end; d = new Date(new Date(d).setDate(new Date(d).getDate() + 1)).getTime()) days.push(d);
    for (const d of days) {
      const k = `${new Date(d).getFullYear()}-${String(new Date(d).getMonth() + 1).padStart(2, '0')}`;
      out[k] = (out[k] || 0) + c.minutes / days.length;
    }
  }
  return out;
};
const perDay = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v / new Date(Number(k.slice(0, 4)), Number(k.slice(5)), 0).getDate()]));

test('placeholder times (Steam\'s 1 Jan 1970 + a day) are no dates: nothing is dated in 1970', () => {
  assert.equal(realTime(86_400_000), null);
  assert.equal(realTime(0), null);
  assert.equal(realTime(NaN), null);
  assert.equal(realTime(at(2014, 3, 1)), at(2014, 3, 1));
  // World of Goo: 14 minutes, last played "2 Jan 1970", released 2008
  const res = inferHistory({ minutes: 14, trackingStart: T, lastPlayedAt: 86_400_000, releaseAt: at(2008, 10, 13) });
  assert.ok(res.chunks.every((c) => c.start >= at(2008, 10, 13) - DAY), 'nothing before the release');
  assert.ok(!res.reasons.some((r) => /last played date is known/.test(r)), 'the placeholder is not "the last played date"');
  // the same with nothing else known: undated, not 1970
  const bare = inferHistory({ minutes: 14, trackingStart: T, lastPlayedAt: 86_400_000 });
  assert.equal(bare.undated, 14);
  assert.equal(bare.chunks.length, 0);
});

test('an unlock before the release or account date is play: the bound moves to it (early access, a deluxe head start)', () => {
  // Mortal Shell II: unlocks from 17 Aug, store release 20 Aug, last played 24 Aug
  const unlocks = [at(2026, 8, 17, 20), at(2026, 8, 18, 21), at(2026, 8, 21, 20), at(2026, 8, 24, 19)];
  const res = inferHistory({ minutes: 780, trackingStart: T, lastPlayedAt: at(2026, 8, 24, 20), releaseAt: at(2026, 8, 20, 0), anchors: unlocks });
  assert.equal(dated(res), 780);
  assert.ok(res.window[0] <= unlocks[0], `starts by the first unlock, not at the release (${new Date(res.window[0]).toDateString()})`);
  assert.ok(res.reasons.some((r) => /before the release date - not bounded/.test(r)));
  // without an unlock before it, the release still bounds the start
  const later = inferHistory({ minutes: 780, trackingStart: T, lastPlayedAt: at(2026, 8, 24, 20), releaseAt: at(2026, 8, 20, 0), anchors: unlocks.slice(2) });
  assert.ok(later.window[0] >= new Date(2026, 7, 20).getTime());
});

test('unlocks after the platform\'s last played date mean that date is stale: history runs to the last unlock', () => {
  // Ori: Xbox says last played May 2015; all 13 unlocks are from January 2019
  const unlocks = Array.from({ length: 13 }, (_, i) => at(2019, 1, 20 + (i % 4), 19 + (i % 3)));
  const res = inferHistory({ minutes: 150, trackingStart: T, lastPlayedAt: at(2015, 5, 5), anchors: unlocks });
  assert.equal(dated(res), 150);
  assert.ok(res.window[1] >= at(2019, 1, 22), 'runs to the unlocks');
  // from the stale date, a day it was still played (the first stretch lands once its days add up to a session)
  assert.ok(res.window[0] >= new Date(2015, 4, 5).getTime() && res.window[0] < at(2019, 1, 1), 'some of it between the stale date and the unlocks');
  const in2019 = res.chunks.filter((c) => c.start >= new Date(2019, 0, 1).getTime()).reduce((a, c) => a + c.minutes, 0);
  assert.ok(in2019 >= 75, `most of it when the unlocks are (${in2019} of 150 min)`);
  assert.ok(res.reasons.some((r) => /after the platform's last played date/.test(r)));
  // Gears of War 4: last played June 2017 but unlocks went on until March 2018
  const gears = inferHistory({ minutes: 2700, trackingStart: T, lastPlayedAt: at(2017, 6, 12), anchors: [at(2016, 10, 7), at(2016, 10, 9), at(2017, 1, 3), at(2018, 3, 25)] });
  assert.equal(dated(gears), 2700);
  assert.ok(gears.window[1] >= at(2018, 3, 25) - DAY && gears.window[1] <= at(2018, 3, 25) + DAY, 'ends at the last unlock');
  // an unlock a few hours after a last played time stamped at launch (Steam) just ends the window there
  const steam = inferHistory({ minutes: 300, trackingStart: T, lastPlayedAt: at(2020, 3, 1, 20), anchors: [at(2020, 2, 20), at(2020, 3, 1, 22)] });
  assert.ok(steam.window[1] >= at(2020, 3, 1, 22) - 60_000);
  assert.ok(!steam.reasons.some((r) => /after the platform's last played date/.test(r)), 'the same evening is not a stale date');
  // dates you set still win
  const yours = inferHistory({ minutes: 150, trackingStart: T, lastPlayedAt: at(2015, 5, 5), anchors: unlocks, manual: { start: at(2015, 3, 1), end: at(2015, 6, 1) } });
  assert.ok(yours.window[1] <= at(2015, 6, 1));
});

test('a period answered by year or quarter is spread evenly, not front-loaded on its first days', () => {
  const year = { start: new Date(2018, 0, 1, 12).getTime(), end: new Date(2018, 11, 31, 20).getTime() };
  assert.ok(looksCoarse(year));
  assert.ok(!looksCoarse({ ...year, confirmed: true }), 'a confirmed estimate keeps its exact days');
  assert.ok(!looksCoarse({ start: at(2018, 1, 3), end: at(2018, 5, 17, 20) }), 'days you picked are not a period');
  // Fortnite-sized: 485 h answered as "2018 until 2019"
  const span = { start: new Date(2018, 0, 1, 12).getTime(), end: new Date(2019, 11, 31, 20).getTime() };
  const res = inferHistory({ minutes: 29113, trackingStart: T, manual: span });
  assert.equal(dated(res), 29113);
  const months = Object.values(perDay(byMonth(res)));
  assert.equal(months.length, 24, 'every month of the two years has play');
  assert.ok(Math.max(...months) < 1.1 * Math.min(...months), `even: ${Math.min(...months)}..${Math.max(...months)} min a day by month`);
  assert.ok(res.reasons.includes('Spread evenly over the period you set'));
  // the flag says so explicitly for answers saved with it (an end cut at today is still a period)
  const flagged = inferHistory({ minutes: 600, trackingStart: T, manual: { start: at(2024, 4, 1), end: at(2024, 6, 9, 15), coarse: true } });
  const fm = perDay(byMonth(flagged));
  assert.equal(dated(flagged), 600);
  assert.ok(fm['2024-04'] < 1.5 * fm['2024-05'] && fm['2024-05'] < 1.5 * fm['2024-04'], JSON.stringify(fm));
  // exact days you set keep the usual shape: more after the start than in the middle
  const exact = inferHistory({ minutes: 6000, trackingStart: T, manual: { start: at(2018, 1, 3), end: at(2018, 12, 17, 20) } });
  const em = byMonth(exact);
  assert.ok(em['2018-01'] > em['2018-07'], JSON.stringify(em));
});

test('dates you set before 1995 date history there (a game played on its own console in 1991)', () => {
  const res = inferHistory({ minutes: 2400, trackingStart: T, manual: { start: new Date(1991, 0, 1, 12).getTime(), end: new Date(1992, 11, 31, 20).getTime() } });
  assert.equal(res.undated, 0, 'not "does not fit after the first played date"');
  assert.equal(dated(res), 2400);
  assert.ok(res.window[0] >= new Date(1991, 0, 1).getTime() && res.window[1] <= new Date(1993, 0, 1).getTime());
  // automatic dating still never reaches back before 1995 (the day of 1 Jan 1995 UTC)
  const auto = inferHistory({ minutes: 60000, trackingStart: T, lastPlayedAt: at(1996, 2, 1) });
  assert.ok(auto.chunks.every((c) => c.start >= new Date(Date.UTC(1995, 0, 1)).setHours(0, 0, 0, 0)));
});

test('migration 11 removes placeholder last played times; re-dating then dates nothing in 1970', () => {
  assert.equal(INFER_VERSION, 7);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-1970-'));
  const file = path.join(dir, 'lib.db');
  let db = openDb(file);
  const game = Number(db.prepare("INSERT INTO games(title, norm_title, created_at, updated_at) VALUES ('World of Goo', 'world of goo', 0, 0)").run().lastInsertRowid);
  const id = Number(db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, baseline_min, first_seen_at, last_played_at, hist)
    VALUES (NULL, ?, 'manual', 'x', 'World of Goo', 14, 14, ?, ?, ?)`).run(game, T, 86_400_000, JSON.stringify({ tracking_start: T, last_played_at: 86_400_000, release_at: at(2008, 10, 13) })).lastInsertRowid);
  db.exec('PRAGMA user_version = 10');
  db.close();
  db = openDb(file);
  const e = db.prepare('SELECT last_played_at, hist FROM entries WHERE id = ?').get(id);
  assert.equal(e.last_played_at, null);
  assert.equal(JSON.parse(e.hist).last_played_at, undefined);
  assert.equal(JSON.parse(e.hist).release_at, at(2008, 10, 13), 'other evidence stays');
  reinferMany(db, [id]);
  flushRollups(db);
  const rows = db.prepare("SELECT window_start FROM sessions WHERE entry_id = ? AND source = 'inferred' AND kind = 'estimate'").all(id);
  assert.ok(rows.every((r) => r.window_start >= at(2008, 1, 1)), 'not in 1970');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
