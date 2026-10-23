// Import / export area: CSV + JSON imports, merging into what is already here ("imports assist,
// never replace"), adopting imported copies when an account is linked later, dry-run previews,
// streamed JSON/CSV export round trips, SQLite backup, GameTrack ZIP import and the Steam
// licenses paste. Black-box through the HTTP API; expectations come from README.md,
// docs/PLATFORMS.md and the API route summaries, never from the implementation.
//
// Run: node --disable-warning=ExperimentalWarning --test test/suite/import-export.test.js
import './helpers/import-export-tz.js'; // must stay first: pins TZ=America/New_York
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  startApp, installFetchMock, SteamMock, buildZip, toCsv, readCsv, dayOf, endOfDay, iso, MIN, HOUR, DAY,
} from './helpers/import-export-harness.js';

// every time in this file is relative to one captured instant
const NOW = Date.now();
const ago = (days, hours = 0) => NOW - days * DAY - hours * HOUR;

let restoreFetch;
before(() => { restoreFetch = installFetchMock(); });
after(() => restoreFetch());

const NO_ODDITIES = { negative_totals: 0, nonpositive_sessions: 0, future_play: 0, future_history: 0, empty_games: 0, rollup_mismatch: 0 };
function consistent(t, label = '') {
  assert.deepEqual(t.sumViolations(), [], `${label} every entry's sessions must add up to its total`);
  assert.deepEqual(t.oddities(), NO_ODDITIES, `${label} no impossible rows`);
}

/** Local days that hold estimated (charted) history for an entry. */
function historyDays(t, entryId) {
  return t.db.prepare('SELECT day, SUM(minutes) m FROM play_days WHERE entry_id = ? AND estimated = 1 GROUP BY day ORDER BY day').all(entryId);
}
const kindMinutes = (t, entryId, kind) => t.db.prepare('SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ? AND kind = ?').get(entryId, kind).m;
const historyMinutes = (t, entryId) => kindMinutes(t, entryId, 'estimate') + kindMinutes(t, entryId, 'baseline');

// =====================================================================================
describe('CSV import: columns, delimiters, quoting, validation', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(() => t.close());

  test('the README example: hours become dated history, nothing is counted as play today', async () => {
    const last = ago(60);
    const csv = toCsv([
      ['title', 'platform', 'playtime_hours', 'last_played', 'status', 'rating'],
      ['Hades', 'switch', '42', dayOf(last), 'completed', '10'],
      ['Celeste', 'import', '12.5', '', 'beaten', ''],
    ]);
    const r = await t.importCsv(csv);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.games, 2, 'two rows read');

    const hades = await t.gameByTitle('Hades');
    assert.equal(hades.minutes, 42 * 60);
    assert.equal(hades.status, 'completed');
    assert.equal(hades.rating, 10);
    assert.deepEqual(hades.platforms, ['switch']);
    const celeste = await t.gameByTitle('Celeste');
    assert.equal(celeste.minutes, 750);
    assert.equal(celeste.status, 'beaten');
    assert.equal(celeste.rating, null);

    const life = await t.lifetime();
    assert.equal(life.total_minutes, 42 * 60 + 750);
    assert.equal(life.tracked_minutes, 0, 'imported totals are never tracked play');
    assert.equal(life.sessions, 0);
    assert.equal(life.estimated_minutes + life.baseline_minutes, 42 * 60 + 750, 'all of it is history (dated or undated)');

    const week = await t.ok(t.get('/stats', { range: '7d', estimates: 'exclude' }));
    assert.equal(week.total_minutes, 0, 'no import-day spike');
    const sum = await t.ok(t.get('/summary'));
    assert.equal(sum.today.total_minutes, 0);
    assert.equal(sum.week.total_minutes, 0);

    // Hades was last played 60 days ago: its history cannot be dated after that day
    const [e] = t.entriesOf('Hades');
    const days = historyDays(t, e.id);
    assert.ok(days.length > 0, 'Hades history is dated (it has a last-played date)');
    assert.ok(days.at(-1).day <= dayOf(last), `latest history day ${days.at(-1).day} <= last played ${dayOf(last)}`);
    consistent(t);
  });

  test('playtime columns: playtime_minutes, decimal hours, h:mm, and exact minutes win over rounded hours', async () => {
    await t.ok(t.importCsv(toCsv([['title', 'playtime_minutes'], ['Minutes Only', '95']])));
    await t.ok(t.importCsv(toCsv([['title', 'playtime_hours'], ['Clock Short', '1:30'], ['Clock Long', '120:05'], ['Quarter Hour', '0.25']])));
    await t.ok(t.importCsv(toCsv([['title', 'playtime_minutes', 'playtime_hours'], ['Both Columns', '125', '2.1']])));
    const want = { 'Minutes Only': 95, 'Clock Short': 90, 'Clock Long': 120 * 60 + 5, 'Quarter Hour': 15, 'Both Columns': 125 };
    for (const [title, minutes] of Object.entries(want)) assert.equal((await t.gameByTitle(title))?.minutes, minutes, title);
    consistent(t);
  });

  test('semicolon-, tab- and comma-separated files with BOM, CRLF and capitalised headers', async () => {
    await t.ok(t.importCsv('title;platform;playtime_hours;status\nOri and the Blind Forest;switch;8;beaten\n'));
    await t.ok(t.importCsv('title\tplaytime_hours\tstatus\nTunic\t10\tplaying\n'));
    await t.ok(t.importCsv('﻿Title,Playtime Hours,Status\r\nInside,3,completed\r\nLimbo,2,beaten\r\n'));
    const ori = await t.gameByTitle('Ori and the Blind Forest');
    assert.equal(ori.minutes, 480); assert.equal(ori.status, 'beaten'); assert.deepEqual(ori.platforms, ['switch']);
    const tunic = await t.gameByTitle('Tunic');
    assert.equal(tunic.minutes, 600); assert.equal(tunic.status, 'playing');
    const inside = await t.gameByTitle('Inside');
    assert.ok(inside, 'BOM is not part of the first header / title');
    assert.equal(inside.minutes, 180); assert.equal(inside.status, 'completed');
    assert.equal((await t.gameByTitle('Limbo')).minutes, 120, 'CRLF rows all read');
    consistent(t);
  });

  test('quoted fields keep commas, escaped quotes and newlines', async () => {
    const notes = 'line one\nline "two", three';
    await t.ok(t.importCsv(toCsv([['title', 'playtime_hours', 'notes'], ['Hello, World', '2', notes], ['Plain After', '1', '']])));
    const g = await t.gameByTitle('Hello, World');
    assert.ok(g, 'a quoted title with a comma stays one field');
    assert.equal(g.minutes, 120);
    assert.equal(g.notes, notes);
    assert.equal((await t.gameByTitle('Plain After')).minutes, 60, 'the row after a multi-line field is read normally');
  });

  test('semicolon file (European spreadsheet): decimal comma hours and a comma in the title', { todo: 'APP BUG import-export-1: CSV parser splits on , ; and tab at once' }, async () => {
    await t.ok(t.importCsv('title;platform;playtime_hours\nWarhammer 40,000: Space Marine 2;pc;12,5\n'));
    const g = await t.gameByTitle('Warhammer 40,000: Space Marine 2');
    assert.ok(g, `title kept whole; library has: ${(await t.gamesAll()).map((x) => x.title).join(' | ')}`);
    assert.equal(g.minutes, 750, '12,5 hours = 750 minutes');
  });

  test('tab-separated file: a comma inside an unquoted title', { todo: 'APP BUG import-export-1: CSV parser splits on , ; and tab at once' }, async () => {
    await t.ok(t.importCsv('title\tplaytime_hours\nWarhammer 40,000: Dawn of War\t20\n'));
    const g = await t.gameByTitle('Warhammer 40,000: Dawn of War');
    assert.ok(g, `title kept whole; library has: ${(await t.gamesAll()).map((x) => x.title).join(' | ')}`);
    assert.equal(g.minutes, 1200);
  });

  test('comma file: an unquoted semicolon inside notes stays part of the notes', { todo: 'APP BUG import-export-1: CSV parser splits on , ; and tab at once' }, async () => {
    await t.ok(t.importCsv('title,playtime_hours,notes\nSemicolon Notes,4,great; would replay\n'));
    const g = await t.gameByTitle('Semicolon Notes');
    assert.equal(g?.minutes, 240);
    assert.equal(g?.notes, 'great; would replay');
  });

  test('statuses are validated, case-insensitive; ratings stay within 0..10; zero-hour rows add a game without time', async () => {
    await t.ok(t.importCsv(toCsv([
      ['title', 'playtime_hours', 'status', 'rating'],
      ['Status Backlog', '1', 'backlog', '7'],
      ['Status Playing', '1', 'Playing', ''],
      ['Status Paused', '1', 'paused', ''],
      ['Status Dropped', '1', 'dropped', ''],
      ['Status Wishlist', '0', 'wishlist', ''],
      ['Status Bogus', '1', 'finished-ish', 'abc'],
      ['Rating High', '1', '', '15'],
      ['Rating Negative', '1', '', '-3'],
    ])));
    const g = async (title) => t.gameByTitle(title);
    assert.equal((await g('Status Backlog')).status, 'backlog');
    assert.equal((await g('Status Backlog')).rating, 7);
    assert.equal((await g('Status Playing')).status, 'playing');
    assert.equal((await g('Status Paused')).status, 'paused');
    assert.equal((await g('Status Dropped')).status, 'dropped');
    const wish = await g('Status Wishlist');
    assert.equal(wish.status, 'wishlist');
    assert.equal(wish.minutes, 0);
    assert.equal(wish.summary.sessions, 0);
    const bogus = await g('Status Bogus');
    assert.equal(bogus.status, 'unset', 'an unknown status is not stored');
    assert.equal(bogus.rating, null, 'a non-numeric rating is not stored');
    const high = (await g('Rating High')).rating;
    assert.ok(high === null || high === 10, `rating 15 is clamped or ignored, got ${high}`);
    const neg = (await g('Rating Negative')).rating;
    assert.ok(neg === null || neg === 0, `a negative rating is clamped or ignored, got ${neg}`);
    consistent(t);
  });

  test('bad rows are skipped, good rows imported, and no total is ever negative', async () => {
    const r = await t.importCsv(toCsv([
      ['title', 'playtime_hours'],
      ['', '5'],
      ['   ', '3'],
      ['Negative Hours', '-5'],
      ['Garbage Hours', 'lots'],
      ['Valid Row', '2'],
    ]));
    assert.equal(r.status, 200, r.text);
    assert.ok(r.data.skipped >= 2, 'rows without a title are skipped');
    assert.equal((await t.gameByTitle('Valid Row')).minutes, 120);
    for (const title of ['Negative Hours', 'Garbage Hours']) {
      const g = await t.gameByTitle(title);
      if (g) assert.equal(g.minutes, 0, `${title}: no negative / NaN total`);
    }
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM games WHERE TRIM(title) = ''").get().n, 0, 'no untitled game');
    consistent(t);
  });

  test('empty and header-only files change nothing', async () => {
    const before_ = t.snapshot();
    for (const body of ['', '\n\n', 'title,platform,playtime_hours\n', '﻿']) {
      const r = await t.importCsv(body);
      assert.ok(r.status === 200 || r.status === 400, `${JSON.stringify(body)} -> ${r.status}`);
      if (r.status === 200) assert.equal(r.data.games, 0);
    }
    assert.deepEqual(t.snapshot(), before_);
  });

  test('first played / last played / date added bound the dated history', async () => {
    const first = ago(200); const last = ago(100);
    const added = ago(300); const last2 = ago(250);
    await t.ok(t.importCsv(toCsv([
      ['title', 'platform', 'playtime_hours', 'first_played', 'last_played', 'date_added', 'play_count'],
      ['Window Game', 'switch', '40', dayOf(first), dayOf(last), '', '12'],
      ['Added Game', 'switch', '10', '', dayOf(last2), dayOf(added), ''],
    ])));
    const [w] = t.entriesOf('Window Game');
    const wd = historyDays(t, w.id);
    assert.ok(wd.length > 0);
    assert.ok(wd[0].day >= dayOf(first), `history starts ${wd[0].day} >= first played ${dayOf(first)}`);
    assert.ok(wd.at(-1).day <= dayOf(last), `history ends ${wd.at(-1).day} <= last played ${dayOf(last)}`);
    assert.ok(wd.every((d) => d.m <= 600 + 1e-6), 'at most 10 hours a day per game');
    assert.equal(historyMinutes(t, w.id), 2400);
    assert.equal(kindMinutes(t, w.id, 'play'), 0);
    const detail = await t.gameByTitle('Window Game');
    const ev = detail.entries[0].history.evidence;
    assert.equal(dayOf(ev.first_played_at), dayOf(first));
    assert.equal(ev.play_count, 12);

    const [a] = t.entriesOf('Added Game');
    const ad = historyDays(t, a.id);
    assert.ok(ad.length > 0);
    assert.ok(ad[0].day >= dayOf(added), `history starts ${ad[0].day} >= date added ${dayOf(added)}`);
    assert.ok(ad.at(-1).day <= dayOf(last2));
    assert.equal(dayOf((await t.gameByTitle('Added Game')).entries[0].history.evidence.date_added), dayOf(added));
    consistent(t);
  });

  test('a huge import loses no minute and dates nothing after last played', async () => {
    const first = ago(20); const last = ago(11);
    await t.ok(t.importCsv(toCsv([
      ['title', 'platform', 'playtime_hours', 'first_played', 'last_played'],
      ['Cap Game A', 'switch', '300', dayOf(first), dayOf(last)],
      ['Cap Game B', 'switch', '300', dayOf(first), dayOf(last)],
      ['Cap Game C', 'switch', '300', dayOf(first), dayOf(last)],
      ['Forever Game', 'pc', '100000', '', ''],
    ])));
    for (const title of ['Cap Game A', 'Cap Game B', 'Cap Game C']) {
      const [e] = t.entriesOf(title);
      assert.equal(e.playtime_min, 18000);
      assert.equal(historyMinutes(t, e.id), 18000, `${title}: dated + undated history = total`);
      assert.ok(historyDays(t, e.id).every((d) => d.day <= dayOf(last)), `${title}: nothing dated after last played`);
    }
    const [f] = t.entriesOf('Forever Game');
    assert.equal(f.playtime_min, 6_000_000);
    assert.equal(historyMinutes(t, f.id), 6_000_000);
    const life = await t.lifetime();
    assert.equal(life.tracked_minutes, 0);
    consistent(t);
  });

  test('estimated history never puts more than 10 h of one game, or 12 h of all games, on one day', { todo: 'APP BUG import-export-3: multi-day history chunks cut at a mid-day last-played time are re-spread by the rollup, overfilling days' }, async () => {
    // after the import above (900 h between 20 and 11 days ago, last played = a date -> local noon)
    const perGame = t.db.prepare('SELECT g.title, p.day, SUM(p.minutes) m FROM play_days p JOIN games g ON g.id = p.game_id WHERE p.estimated = 1 GROUP BY p.game_id, p.day HAVING m > 600.001').all();
    assert.deepEqual(perGame.map((x) => `${x.title} ${x.day} ${Math.round(x.m)}`), [], 'per game: at most 10 h a day');
    const perDay = t.db.prepare('SELECT day, SUM(minutes) m FROM play_days WHERE estimated = 1 GROUP BY day HAVING m > 720.001').all();
    assert.deepEqual(perDay.map((x) => `${x.day} ${Math.round(x.m)}`), [], 'library: at most 12 h a day');
    const heat = await t.ok(t.get('/stats/heatmap', { year: new Date(ago(11)).getFullYear(), estimates: 'only' }));
    assert.ok(Object.values(heat.days).every((m) => m <= 720), 'the heatmap shows no day above 12 h of estimated history');
  });

  test('hours that cannot fit between first and last played stay undated instead of being dated before the game was first played', { todo: 'APP BUG import-export-2: history is dated before the known first-played date when the hours do not fit the window' }, async () => {
    // 'Cap Game A/B/C' above: 300 h each between first played (20 days ago) and last played
    // (11 days ago) - at most 10 h/game/day and 12 h/day overall fit; the rest cannot be dated
    const first = ago(20);
    for (const title of ['Cap Game A', 'Cap Game B', 'Cap Game C']) {
      const [e] = t.entriesOf(title);
      const days = historyDays(t, e.id);
      assert.ok(days.every((d) => d.day >= dayOf(first)), `${title}: history dated from ${days[0]?.day}, first played ${dayOf(first)}`);
      assert.ok(kindMinutes(t, e.id, 'baseline') > 0, `${title}: the part that cannot be dated is kept as undated history`);
    }
  });

  test('re-importing the same file changes nothing', async () => {
    const csv = toCsv([
      ['title', 'platform', 'playtime_hours', 'first_played', 'last_played', 'status', 'rating', 'notes'],
      ['Idem One', 'switch', '15', dayOf(ago(90)), dayOf(ago(30)), 'beaten', '8', 'Some notes'],
      ['Idem Two', '', '7.5', '', dayOf(ago(10)), 'playing', '', ''],
    ]);
    await t.ok(t.importCsv(csv));
    const snap = t.snapshot();
    const life = await t.lifetime();
    const again = await t.importCsv(csv);
    assert.equal(again.status, 200);
    assert.deepEqual(t.snapshot(), snap, 'second import of the same file is a no-op');
    assert.deepEqual(await t.lifetime(), life);
  });
});

// =====================================================================================
describe('CSV import at scale (2,000 rows) and streamed export of it', () => {
  let t;
  const N = 2000;
  const rows = [['title', 'platform', 'playtime_hours', 'last_played', 'status']];
  let expected = 0;
  for (let i = 0; i < N; i++) {
    const hours = (i % 97) + 1 + (i % 2 ? 0.5 : 0);
    expected += Math.round(hours * 60);
    rows.push([`Scale Game ${String(i).padStart(4, '0')}`, i % 3 ? 'switch' : 'import', String(hours), dayOf(ago(1 + (i % 700))), i % 5 ? '' : 'backlog']);
  }
  const csv = toCsv(rows);
  before(async () => { t = await startApp(); });
  after(() => t.close());

  test('imports quickly with exact totals', async () => {
    const t0 = Date.now();
    const r = await t.importCsv(csv);
    const ms = Date.now() - t0;
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.games, N);
    assert.ok(ms < 30_000, `took ${ms} ms`);
    const life = await t.lifetime();
    assert.equal(life.total_minutes, expected);
    assert.equal(life.games, N);
    assert.equal(life.tracked_minutes, 0);
    assert.equal(life.status.backlog, N / 5);
    consistent(t);
  });

  test('re-importing the big file is a no-op', async () => {
    const snap = t.snapshot();
    await t.ok(t.importCsv(csv));
    assert.deepEqual(t.snapshot(), snap);
  });

  test('the streamed JSON and CSV exports contain every entry', async () => {
    const j = await t.get('/export');
    assert.equal(j.status, 200);
    const doc = JSON.parse(j.text);
    assert.equal(doc.games.length, N);
    assert.equal(doc.games.reduce((a, g) => a + g.playtime_minutes, 0), expected);
    const c = await t.get('/export', { format: 'csv' });
    assert.equal(c.status, 200);
    const recs = readCsv(c.text);
    assert.equal(recs.length, N);
    assert.equal(recs.reduce((a, r) => a + Number(r.playtime_minutes), 0), expected);
  });
});

// =====================================================================================
describe('JSON import: totals, sessions, body shapes, time zones', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(() => t.close());

  test('the README example: listed sessions are tracked play on their day, the rest is history before them', async () => {
    const day = ago(30);
    const life0 = await t.lifetime();
    const r = await t.importJson({ games: [{ title: 'Zelda: TotK', platform: 'switch', playtime_minutes: 9000, sessions: [{ date: dayOf(day), minutes: 120 }] }] });
    assert.equal(r.status, 200, r.text);
    const g = await t.gameByTitle('Zelda: TotK');
    assert.equal(g.minutes, 9000);
    assert.equal(g.summary.tracked_minutes, 120);
    assert.equal(g.summary.sessions, 1);
    const [e] = t.entriesOf('Zelda: TotK');
    assert.equal(historyMinutes(t, e.id), 8880, 'the total not covered by sessions is history');
    const play = t.sessionsOf(e.id, 'play');
    assert.equal(play.length, 1);
    assert.equal(play[0].minutes, 120);
    assert.equal(play[0].source, 'import');
    assert.equal(dayOf(play[0].started_at), dayOf(day));
    const heat = await t.ok(t.get('/stats/heatmap', { year: new Date(day).getFullYear(), game_id: g.id, estimates: 'exclude' }));
    assert.equal(heat.days[dayOf(day)], 120, 'the session counts on its own day');
    const life = await t.lifetime();
    assert.equal(life.tracked_minutes - life0.tracked_minutes, 120);
    assert.equal(life.total_minutes - life0.total_minutes, 9000);
    const listed = await t.ok(t.get('/sessions', { source: 'import', game_id: String(g.id) }));
    assert.equal(listed.total, 1);
    assert.equal(listed.total_minutes, 120);
    const days = historyDays(t, e.id);
    assert.ok(days.every((d) => d.day <= dayOf(day)), `pre-tracking history (${days.at(-1)?.day}) is dated before the first tracked session (${dayOf(day)})`);
    consistent(t);
  });

  test('accepted bodies: a JSON array, { games }, { csv }, playtime_hours; rejected: {}, a non-array, broken JSON', async () => {
    assert.equal((await t.importJson([{ title: 'Array Body', playtime_minutes: 30 }])).status, 200);
    assert.equal((await t.gameByTitle('Array Body')).minutes, 30);
    assert.equal((await t.importJson({ csv: 'title,playtime_hours\nCsv In Json,2\n' })).status, 200);
    assert.equal((await t.gameByTitle('Csv In Json')).minutes, 120);
    assert.equal((await t.importJson({ games: [{ title: 'Hours Json', playtime_hours: 1.5 }] })).status, 200);
    assert.equal((await t.gameByTitle('Hours Json')).minutes, 90);

    const snap = t.snapshot();
    for (const [label, req] of [
      ['{}', () => t.importJson({})],
      ['games: "x"', () => t.importJson({ games: 'x' })],
      ['games: 5', () => t.importJson({ games: 5 })],
      ['broken JSON', () => t.call('/import', { method: 'POST', body: '{"games": [', type: 'application/json' })],
    ]) {
      const r = await req();
      assert.equal(r.status, 400, `${label} -> ${r.status} ${r.text}`);
      assert.ok(r.data?.error, `${label}: readable error`);
    }
    const empty = await t.importJson([]);
    assert.equal(empty.status, 200);
    assert.equal(empty.data.games, 0);
    const junk = await t.importJson({ games: [null, 5, 'str', [], { title: '' }, { title: '   ' }, { playtime_minutes: 10 }] });
    assert.equal(junk.status, 200, junk.text);
    assert.equal(junk.data.skipped, 7, 'every unusable row is skipped');
    assert.deepEqual(t.snapshot(), snap, 'rejected and empty imports change nothing');
  });

  test('sessions adding up to more than the stated total: nothing is lost, the total grows to cover them', async () => {
    await t.ok(t.importJson({ games: [{ title: 'Over Sessions', platform: 'switch', playtime_minutes: 100, sessions: [{ date: dayOf(ago(10)), minutes: 80 }, { date: dayOf(ago(9)), minutes: 70 }] }] }));
    const [e] = t.entriesOf('Over Sessions');
    assert.equal(e.playtime_min, 150);
    assert.equal(kindMinutes(t, e.id, 'play'), 150);
    assert.equal(historyMinutes(t, e.id), 0);
    consistent(t);
  });

  test('unusable sessions are skipped, usable ones kept', async () => {
    const d = dayOf(ago(5));
    await t.ok(t.importJson({ games: [{ title: 'Messy Sessions', platform: 'switch', playtime_minutes: 300, sessions: [
      { date: d, minutes: 0 }, { date: d, minutes: -10 }, { date: d, minutes: 'abc' }, { minutes: 30 }, { date: 'not a date', minutes: 30 },
      { date: dayOf(ago(4)), minutes: 45, note: 'the good one' },
    ] }] }));
    const [e] = t.entriesOf('Messy Sessions');
    const play = t.sessionsOf(e.id, 'play');
    assert.deepEqual(play.map((s) => [s.minutes, s.note]), [[45, 'the good one']]);
    assert.equal(e.playtime_min, 300);
    assert.equal(historyMinutes(t, e.id), 255);
    consistent(t);
  });

  test('timestamps as ISO with offsets, epoch seconds and epoch milliseconds are all understood', async () => {
    const s1 = ago(3, 5); const s2 = ago(2, 4); const s3 = ago(1, 3);
    await t.ok(t.importJson({ games: [{ title: 'Stamp Formats', platform: 'switch', playtime_minutes: 90, sessions: [
      { started_at: new Date(s1).toISOString().replace('Z', '+00:00'), minutes: 30 },
      { started_at: Math.floor(s2 / 1000), minutes: 30 },
      { started_at: s3, minutes: 30 },
    ] }] }));
    const [e] = t.entriesOf('Stamp Formats');
    const starts = t.sessionsOf(e.id, 'play').map((s) => s.started_at);
    assert.deepEqual(starts, [s1, Math.floor(s2 / 1000) * 1000, s3]);
  });

  test('DST and midnight: sessions are counted on the right local days (America/New_York)', async () => {
    await t.ok(t.importJson({ games: [{ title: 'Clock Game', platform: 'switch', playtime_minutes: 360, sessions: [
      { started_at: '2025-03-08T23:00:00-05:00', minutes: 120 }, // crosses midnight into the spring-forward day
      { started_at: '2025-03-09T01:30:00-05:00', minutes: 60 }, // runs through the skipped hour
      { date: '2025-11-02', minutes: 90 }, // the 25-hour fall-back day
      { started_at: '2025-11-01T23:30:00-04:00', minutes: 90 }, // crosses midnight into the fall-back day
    ] }] }));
    const g = await t.gameByTitle('Clock Game');
    assert.equal(g.minutes, 360);
    assert.equal(g.summary.tracked_minutes, 360);
    const heat = await t.ok(t.get('/stats/heatmap', { year: '2025', game_id: String(g.id), estimates: 'exclude' }));
    assert.deepEqual(heat.days, { '2025-03-08': 60, '2025-03-09': 120, '2025-11-01': 30, '2025-11-02': 150 });
    consistent(t);
  });

  test('re-importing a JSON file with sessions changes nothing', async () => {
    const body = { games: [
      { title: 'Idem Json', platform: 'switch', playtime_minutes: 600, status: 'playing', notes: 'json notes', sessions: [{ started_at: iso(ago(20, 3)), minutes: 60 }, { started_at: iso(ago(15, 2)), minutes: 45 }] },
      { title: 'Idem Json Two', playtime_minutes: 200, last_played: dayOf(ago(40)) },
    ] };
    await t.ok(t.importJson(body));
    const snap = t.snapshot();
    const r = await t.importJson(body);
    assert.equal(r.status, 200);
    assert.equal(r.data.sessions, 0, 'no session imported twice');
    assert.deepEqual(t.snapshot(), snap);
  });

  test('an updated file that lists one more session does not count that session twice', { todo: 'APP BUG import-export-4: a re-import that adds a session to an unchanged total adds its minutes on top of the total' }, async () => {
    const s1 = { started_at: iso(ago(40, 2)), minutes: 120 };
    const s2 = { started_at: iso(ago(35, 2)), minutes: 60 };
    const v1 = { games: [{ title: 'Growing Game', platform: 'switch', playtime_minutes: 600, sessions: [s1] }] };
    const v2 = { games: [{ title: 'Growing Game', platform: 'switch', playtime_minutes: 600, sessions: [s1, s2] }] };
    await t.ok(t.importJson(v1));
    await t.ok(t.importJson(v2));
    const [e] = t.entriesOf('Growing Game');
    // the file says 600 minutes in total, 180 of them in listed sessions - the same as importing v2 alone
    const fresh = await startApp();
    try {
      await fresh.ok(fresh.importJson(v2));
      const [f] = fresh.entriesOf('Growing Game');
      assert.equal(f.playtime_min, 600);
      assert.equal(e.playtime_min, f.playtime_min, 'v1 then v2 gives the same total as v2 alone');
      assert.equal(kindMinutes(t, e.id, 'play'), 180);
      assert.equal(historyMinutes(t, e.id), 420);
    } finally { await fresh.close(); }
  });

  test('an updated file with a higher total and a new session adds exactly the difference', async () => {
    const s1 = { started_at: iso(ago(60, 2)), minutes: 100 };
    const s2 = { started_at: iso(ago(55, 2)), minutes: 50 };
    await t.ok(t.importJson({ games: [{ title: 'Grown Game', platform: 'switch', playtime_minutes: 500, sessions: [s1] }] }));
    await t.ok(t.importJson({ games: [{ title: 'Grown Game', platform: 'switch', playtime_minutes: 550, sessions: [s1, s2] }] }));
    const [e] = t.entriesOf('Grown Game');
    assert.equal(e.playtime_min, 550);
    assert.equal(kindMinutes(t, e.id, 'play'), 150);
    assert.equal(historyMinutes(t, e.id), 400);
    consistent(t);
  });

  test('future-dated sessions and last-played dates never become play or history in the future', { todo: 'APP BUG import-export-5: imported sessions dated in the future are stored as tracked play in the future' }, async () => {
    await t.importJson({ games: [
      { title: 'Future Session', platform: 'switch', playtime_minutes: 100, sessions: [{ started_at: iso(NOW + 10 * DAY), minutes: 60 }] },
      { title: 'Future Last Played', platform: 'switch', playtime_minutes: 600, last_played: iso(NOW + 30 * DAY) },
    ] });
    const o = t.oddities();
    assert.equal(o.future_play, 0, 'no tracked session lies in the future');
    assert.equal(o.future_history, 0, 'no estimated history lies in the future');
    const week = await t.ok(t.get('/stats', { range: '7d', estimates: 'exclude' }));
    assert.ok(week.total_minutes >= 0);
    assert.deepEqual(t.sumViolations(), []);
  });

  test('a body over 4 MB is accepted by the import endpoint (imports take large files)', async () => {
    const r = await t.importJson({ games: [{ title: 'Big Body', platform: 'switch', playtime_minutes: 10 }], padding: 'x'.repeat(5 * 1024 * 1024) });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal((await t.gameByTitle('Big Body')).minutes, 10);
  });
});

// =====================================================================================
describe('imports assist, never replace: your details win', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(() => t.close());

  test('status, rating and notes you set are kept; notes from the file are added once; empty details are filled', async () => {
    const mine = await t.ok(t.post('/games', { title: 'Hollow Knight', status: 'playing' }));
    await t.ok(t.patch(`/games/${mine.id}`, { rating: 8, notes: 'My notes' }));
    const empty = await t.ok(t.post('/games', { title: 'Dead Cells' }));
    const csv = toCsv([
      ['title', 'platform', 'playtime_hours', 'status', 'rating', 'notes'],
      ['Hollow Knight', 'switch', '30', 'completed', '3', 'From the file'],
      ['Dead Cells', 'switch', '12', 'beaten', '7', 'Filled in'],
    ]);
    await t.ok(t.importCsv(csv));
    const hk = await t.ok(t.get(`/games/${mine.id}`));
    assert.equal(hk.status, 'playing');
    assert.equal(hk.rating, 8);
    assert.ok(hk.notes.startsWith('My notes'), `notes: ${JSON.stringify(hk.notes)}`);
    assert.equal(hk.notes.split('From the file').length - 1, 1);
    assert.equal(hk.minutes, 1800, 'the hours join the game you already have');
    const dc = await t.ok(t.get(`/games/${empty.id}`));
    assert.equal(dc.status, 'beaten');
    assert.equal(dc.rating, 7);
    assert.equal(dc.notes, 'Filled in');

    await t.ok(t.importCsv(csv));
    const again = await t.ok(t.get(`/games/${mine.id}`));
    assert.equal(again.notes, hk.notes, 'notes are not appended a second time');
    assert.equal((await t.gamesAll()).filter((g) => g.title === 'Hollow Knight').length, 1, 'no second copy of the game');
    consistent(t);
  });

  test('favorite and hidden choices stay; a file can mark a favorite but never clear one', async () => {
    const fav = await t.ok(t.post('/games', { title: 'Favorite Game' }));
    await t.ok(t.patch(`/games/${fav.id}`, { favorite: true, hidden: true }));
    const plain = await t.ok(t.post('/games', { title: 'Plain Game' }));
    await t.ok(t.importJson({ games: [
      { title: 'Favorite Game', platform: 'switch', playtime_minutes: 60, favorite: false, hidden: false },
      { title: 'Plain Game', platform: 'switch', playtime_minutes: 60, favorite: true },
    ] }));
    const f = await t.ok(t.get(`/games/${fav.id}`));
    assert.equal(f.favorite, true);
    assert.equal(f.hidden, true);
    assert.equal((await t.ok(t.get(`/games/${plain.id}`))).favorite, true);
  });

  test('your exclusions stand: an excluded entry stays excluded, an entry you included stays included', async () => {
    await t.ok(t.importJson({ games: [
      { title: 'Excl Game', platform: 'switch', playtime_minutes: 600 },
      { title: 'Born Excluded', platform: 'switch', playtime_minutes: 60, excluded: true },
    ] }));
    const [ex] = t.entriesOf('Excl Game');
    const [born] = t.entriesOf('Born Excluded');
    assert.equal(born.excluded, 1, 'an exported exclusion is applied to the entry the file creates');
    await t.ok(t.patch(`/entries/${ex.id}`, { excluded: true }));
    await t.ok(t.patch(`/entries/${born.id}`, { excluded: false }));
    const life = await t.lifetime();
    await t.ok(t.importJson({ games: [
      { title: 'Excl Game', platform: 'switch', playtime_minutes: 600, excluded: false },
      { title: 'Born Excluded', platform: 'switch', playtime_minutes: 60, excluded: true },
    ] }));
    assert.equal(t.entriesOf('Excl Game')[0].excluded, 1);
    assert.equal(t.entriesOf('Born Excluded')[0].excluded, 0);
    assert.deepEqual(await t.lifetime(), life);
  });

  test('sessions you logged by hand survive an import of the same game', async () => {
    const g = await t.ok(t.post('/games', { title: 'Hand Logged' }));
    const s = await t.ok(t.post('/sessions', { game_id: g.id, minutes: 45, started_at: iso(ago(2, 5)), note: 'mine' }));
    await t.ok(t.importCsv(toCsv([['title', 'platform', 'playtime_hours'], ['Hand Logged', 'switch', '10']])));
    const after_ = await t.ok(t.get(`/games/${g.id}`));
    const kept = await t.get(`/sessions/${s.id}`);
    assert.equal(kept.status, 200);
    assert.equal(kept.data.minutes, 45);
    assert.equal(kept.data.note, 'mine');
    assert.equal(after_.summary.tracked_minutes, 45);
    assert.equal(after_.minutes, 600 + 45, 'the manual session and the imported hours both count, once each');
    consistent(t);
  });

  test('a later file never lowers a total; a higher total adds only the difference, as history', async () => {
    await t.ok(t.importCsv(toCsv([['title', 'platform', 'playtime_hours'], ['Ori Total', 'switch', '20']])));
    await t.ok(t.importCsv(toCsv([['title', 'platform', 'playtime_hours'], ['Ori Total', 'switch', '10']])));
    const [e] = t.entriesOf('Ori Total');
    assert.equal(e.playtime_min, 1200, 'a smaller number in a file does not remove recorded time');
    await t.ok(t.importCsv(toCsv([['title', 'platform', 'playtime_hours'], ['Ori Total', 'switch', '25']])));
    const [e2] = t.entriesOf('Ori Total');
    assert.equal(e2.playtime_min, 1500);
    assert.equal(historyMinutes(t, e2.id), 1500);
    assert.equal(kindMinutes(t, e2.id, 'play'), 0, 'growth from a spreadsheet is never a fake session today');
    assert.equal(t.entriesOf('Ori Total').length, 1);
    consistent(t);
  });

  test('your "Don\'t chart" choice for a game\'s history survives a re-import', async () => {
    const csv = toCsv([['title', 'platform', 'playtime_hours', 'last_played'], ['Undated Choice', 'switch', '30', dayOf(ago(100))]]);
    await t.ok(t.importCsv(csv));
    const [e] = t.entriesOf('Undated Choice');
    assert.ok(kindMinutes(t, e.id, 'estimate') > 0, 'dated before the choice');
    await t.ok(t.patch(`/entries/${e.id}/history`, { mode: 'undated' }));
    assert.equal(kindMinutes(t, e.id, 'estimate'), 0);
    await t.ok(t.importCsv(csv));
    const g = await t.gameByTitle('Undated Choice');
    assert.equal(g.entries[0].history.mode, 'undated');
    assert.equal(kindMinutes(t, e.id, 'estimate'), 0, 'still not charted');
    assert.equal(historyMinutes(t, e.id), 1800);
  });
});

// =====================================================================================
describe('rows for games a synced Steam account tracks join it', () => {
  let t; let steam; let acc;
  before(async () => {
    t = await startApp();
    steam = new SteamMock({ games: [
      { appid: 620, name: 'Portal 2', minutes: 900, lastPlayed: ago(100) },
      { appid: 1145360, name: 'Hades', minutes: 1200, lastPlayed: ago(5) },
      { appid: 504230, name: 'Celeste', minutes: 600, lastPlayed: ago(40) },
      { appid: 413150, name: 'Stardew Valley', minutes: 3000, lastPlayed: ago(20) },
    ] });
    acc = (await t.linkSteam(steam)).account;
  });
  after(async () => { await t.close(); steam.dispose(); });

  const portal = { games: [{ title: 'Portal 2', platform: 'steam', playtime_minutes: 1000, first_played: dayOf(ago(400)), sessions: [
    { started_at: iso(ago(300, 2)), minutes: 120, note: 'co-op' }, { started_at: iso(ago(200, 2)), minutes: 60 },
  ] }] };

  test('the platform total stays, exact pre-tracking sessions and the first-played date are added, no second copy', async () => {
    const life0 = await t.lifetime();
    const r = await t.importJson(portal);
    assert.equal(r.status, 200, r.text);
    const entries = t.entriesOf('Portal 2');
    assert.equal(entries.length, 1, 'no second copy');
    const [e] = entries;
    assert.equal(e.account_id, acc.id);
    assert.equal(e.playtime_min, 900, "Steam's total stands (the file's 1000 is not used)");
    const play = t.sessionsOf(e.id, 'play');
    assert.deepEqual(play.map((s) => [s.minutes, s.started_at, s.source, s.note]), [[120, ago(300, 2), 'import', 'co-op'], [60, ago(200, 2), 'import', null]]);
    assert.equal(historyMinutes(t, e.id), 720, 'the exact sessions replace that much estimated history');
    const g = await t.gameByTitle('Portal 2');
    assert.equal(g.entries.length, 1);
    assert.equal(dayOf(g.entries[0].history.evidence.first_played_at), dayOf(ago(400)));
    const days = historyDays(t, e.id);
    assert.ok(days[0].day >= dayOf(ago(400)) && days.at(-1).day <= dayOf(ago(100)), `history ${days[0].day}..${days.at(-1).day} within first played..last played`);
    const life = await t.lifetime();
    assert.equal(life.total_minutes, life0.total_minutes, 'lifetime unchanged');
    assert.equal(life.tracked_minutes - life0.tracked_minutes, 180);
    consistent(t);
  });

  test('re-importing the joined rows changes nothing', async () => {
    const snap = t.snapshot();
    const r = await t.importJson(portal);
    assert.equal(r.status, 200);
    assert.deepEqual(t.snapshot(), snap);
  });

  test('sessions that are already tracked, or more than the platform reports, are not added', async () => {
    // a real tracked Hades session, reported through the API
    const [h] = t.entriesOf('Hades');
    const at = Date.now() - 40 * MIN;
    await t.ok(t.post(`/entries/${h.id}/playtime`, { playtime_minutes: 1230, last_played_at: iso(at) }));
    steam.set(1145360, { minutes: 1230, lastPlayed: at });
    const synced = t.sessionsOf(h.id, 'play');
    assert.equal(synced.length, 1);
    const tracked = synced[0];
    // the same play, as a spreadsheet remembers it, plus a Celeste diary longer than Steam's total
    await t.ok(t.importJson({ games: [
      { title: 'Hades', platform: 'steam', playtime_minutes: 1230, sessions: [{ started_at: iso(tracked.started_at), minutes: 30 }] },
      { title: 'Celeste', platform: 'steam', playtime_minutes: 700, sessions: [{ started_at: iso(ago(100, 3)), minutes: 400 }, { started_at: iso(ago(90, 3)), minutes: 300 }] },
    ] }));
    const hp = t.sessionsOf(h.id, 'play');
    assert.equal(hp.length, 1, 'the tracked session is not duplicated');
    assert.equal(t.entriesOf('Hades')[0].playtime_min, 1230);
    const [c] = t.entriesOf('Celeste');
    assert.equal(c.playtime_min, 600, "Steam's total stands");
    const cp = kindMinutes(t, c.id, 'play');
    assert.ok(cp > 0 && cp <= 600, `restored ${cp} min, never more than the platform reports`);
    assert.equal(cp + historyMinutes(t, c.id), 600);
    assert.equal(t.entriesOf('Celeste').length, 1);
    consistent(t);
  });

  test('rows without a platform join the synced copy when the hours fit; more hours means another copy', async () => {
    const life0 = await t.lifetime();
    await t.ok(t.importCsv(toCsv([['title', 'playtime_hours'], ['Stardew Valley', '45']])));
    assert.equal(t.entriesOf('Stardew Valley').length, 1, '45 h fits the 50 h Steam reports: joined');
    assert.equal((await t.lifetime()).total_minutes, life0.total_minutes);
    await t.ok(t.importCsv(toCsv([['title', 'playtime_hours'], ['Celeste', '30']])));
    const cel = t.entriesOf('Celeste');
    assert.equal(cel.length, 2, '30 h is more than the 10 h on Steam: a different copy');
    assert.equal(new Set(cel.map((e) => e.game_id)).size, 1, 'grouped under the same game');
    assert.equal(cel.find((e) => e.account_id == null).playtime_min, 1800);
    assert.equal((await t.lifetime()).total_minutes, life0.total_minutes + 1800);
    consistent(t);
  });

  test('a row on another platform is a separate copy of the same game; the Steam entry is untouched', async () => {
    const before_ = t.entriesOf('Hades').find((e) => e.account_id);
    await t.ok(t.importCsv(toCsv([['title', 'platform', 'playtime_hours'], ['Hades', 'switch', '15']])));
    const hs = t.entriesOf('Hades');
    assert.equal(hs.length, 2);
    assert.equal(new Set(hs.map((e) => e.game_id)).size, 1);
    const st = hs.find((e) => e.account_id);
    assert.equal(st.playtime_min, before_.playtime_min);
    assert.equal(st.baseline_min, before_.baseline_min);
    assert.equal(hs.find((e) => e.platform === 'switch').playtime_min, 900);
  });

  test('a copy with near-identical hours on another platform is flagged as double-counted; excluding it fixes the total', async () => {
    const life0 = await t.lifetime();
    await t.ok(t.importCsv(toCsv([['title', 'platform', 'playtime_hours'], ['Stardew Valley', 'switch', '50']])));
    assert.equal((await t.lifetime()).total_minutes, life0.total_minutes + 3000);
    const d = await t.ok(t.get('/duplicates'));
    const hit = d.double_counted.find((x) => x.game.title === 'Stardew Valley');
    assert.ok(hit, `flagged; got ${JSON.stringify(d.double_counted.map((x) => x.game.title))}`);
    const copy = t.entriesOf('Stardew Valley').find((e) => e.platform === 'switch');
    assert.equal(hit.suggest_exclude, copy.id, 'the imported copy is the one to exclude');
    await t.ok(t.patch(`/entries/${copy.id}`, { excluded: true }));
    assert.equal((await t.lifetime()).total_minutes, life0.total_minutes);
  });

  test('details from the file fill the synced game\'s gaps; what you set stays', async () => {
    const hades = await t.gameByTitle('Hades');
    await t.ok(t.patch(`/games/${hades.id}`, { status: 'playing' }));
    await t.ok(t.importCsv(toCsv([
      ['title', 'platform', 'playtime_hours', 'status', 'rating', 'notes'],
      ['Portal 2', 'steam', '15', 'completed', '9', 'Wheatley!'],
      ['Hades', 'steam', '20', 'dropped', '4', ''],
    ])));
    const p = await t.gameByTitle('Portal 2');
    assert.equal(p.status, 'completed');
    assert.equal(p.rating, 9);
    assert.equal(p.notes, 'Wheatley!');
    const h = await t.gameByTitle('Hades');
    assert.equal(h.status, 'playing');
    assert.equal(h.rating, 4, 'an empty rating is filled');
    assert.equal(t.entriesOf('Portal 2').length, 1);
    assert.equal(t.entriesOf('Portal 2')[0].playtime_min, 900);
    consistent(t);
  });
});

// =====================================================================================
describe('linking an account later adopts imported copies', () => {
  test('spreadsheet first, Steam linked later: one copy per game, your sessions, exclusions and details kept', async () => {
    const t = await startApp();
    const steam = new SteamMock({ games: [
      { appid: 620, name: 'Portal 2', minutes: 900, lastPlayed: ago(10) },
      { appid: 504230, name: 'Celeste', minutes: 600, lastPlayed: ago(40) },
      { appid: 1145360, name: 'Hades', minutes: 300, lastPlayed: ago(2) },
    ] });
    try {
      await t.ok(t.importJson({ games: [
        { title: 'Portal 2', platform: 'steam', playtime_minutes: 800, status: 'beaten', notes: 'from sheet', sessions: [{ started_at: iso(ago(50, 3)), minutes: 90 }] },
        { title: 'Celeste', platform: 'steam', playtime_minutes: 500, excluded: true },
        { title: 'Untouched Sheet Game', platform: 'switch', playtime_minutes: 100 },
      ] }));
      const p0 = await t.gameByTitle('Portal 2');
      await t.ok(t.patch(`/games/${p0.id}`, { rating: 9 }));
      await t.linkSteam(steam);

      const games = await t.gamesAll();
      for (const title of ['Portal 2', 'Celeste', 'Hades', 'Untouched Sheet Game']) assert.equal(games.filter((g) => g.title === title).length, 1, `${title} once`);
      const [p] = t.entriesOf('Portal 2');
      assert.equal(t.entriesOf('Portal 2').length, 1, 'the imported copy was adopted, not kept beside the synced one');
      assert.ok(p.account_id, 'the remaining entry is the synced one');
      assert.equal(p.playtime_min, 900, "Steam's total stands");
      assert.deepEqual(t.sessionsOf(p.id, 'play').map((s) => [s.minutes, s.started_at]), [[90, ago(50, 3)]], 'your exact session is kept');
      assert.equal(historyMinutes(t, p.id), 810);
      const pg = await t.gameByTitle('Portal 2');
      assert.equal(pg.status, 'beaten');
      assert.equal(pg.rating, 9);
      assert.equal(pg.notes, 'from sheet');
      const cel = t.entriesOf('Celeste');
      assert.equal(cel.length, 1);
      assert.equal(cel[0].excluded, 1, 'your exclusion carries over');
      assert.equal(cel[0].playtime_min, 600);
      assert.equal(t.entriesOf('Untouched Sheet Game')[0].playtime_min, 100);
      assert.equal(t.db.prepare("SELECT COUNT(*) n FROM entries WHERE platform = 'steam' AND account_id IS NULL").get().n, 0);
      const life = await t.lifetime();
      assert.equal(life.total_minutes, 900 + 300 + 100, 'Celeste stays excluded');
      assert.equal(life.tracked_minutes, 90);
      assert.equal((await t.ok(t.get('/duplicates'))).double_counted.length, 0, 'nothing double-counted');
      consistent(t);
    } finally { await t.close(); steam.dispose(); }
  });

  test('a restored export, then the account relinked: no game twice, exact sessions kept, same totals', async () => {
    const lib = [
      { appid: 620, name: 'Portal 2', minutes: 900, lastPlayed: ago(100) },
      { appid: 1145360, name: 'Hades', minutes: 1200, lastPlayed: ago(5) },
      { appid: 504230, name: 'Celeste', minutes: 600, lastPlayed: ago(40) },
    ];
    const a = await startApp();
    const m1 = new SteamMock({ games: lib });
    let exported; let A;
    try {
      await a.linkSteam(m1);
      const [h] = a.entriesOf('Hades');
      const at = Date.now() - 40 * MIN;
      await a.ok(a.post(`/entries/${h.id}/playtime`, { playtime_minutes: 1230, last_played_at: iso(at) }));
      m1.set(1145360, { minutes: 1230, lastPlayed: at });
      await a.ok(a.importJson({ games: [{ title: 'Portal 2', platform: 'steam', playtime_minutes: 900, sessions: [{ started_at: iso(ago(300, 2)), minutes: 120 }] }] }));
      const mc = await a.ok(a.post('/games', { title: 'Minecraft', status: 'playing' }));
      await a.ok(a.post('/sessions', { game_id: mc.id, minutes: 120, started_at: iso(ago(3, 4)) }));
      await a.ok(a.patch(`/games/${mc.id}`, { notes: 'Survival, "hardcore"\nworld 2', rating: 7 }));
      await a.ok(a.importJson({ games: [{ title: 'Zelda: Echoes', platform: 'switch', playtime_minutes: 1500, rating: 9, sessions: [{ started_at: iso(ago(20, 3)), minutes: 60 }] }] }));
      await a.ok(a.patch(`/entries/${a.entriesOf('Celeste')[0].id}`, { excluded: true }));
      await a.ok(a.patch(`/games/${(await a.gameByTitle('Portal 2')).id}`, { status: 'completed' }));
      await a.ok(a.patch(`/games/${(await a.gameByTitle('Hades')).id}`, { favorite: true }));
      consistent(a, 'A');
      A = await describeInstance(a);
      exported = (await a.get('/export')).text;
    } finally { await a.close(); m1.dispose(); }

    const b = await startApp();
    const m2 = new SteamMock({ games: lib.map((g) => (g.appid === 1145360 ? { ...g, minutes: 1230, lastPlayed: Date.now() - 40 * MIN } : g)) });
    try {
      await b.ok(b.importJson(JSON.parse(exported)));
      const restored = await describeInstance(b);
      assert.equal(restored.lifetime.total_minutes, A.lifetime.total_minutes, 'restored total');
      assert.equal(restored.lifetime.tracked_minutes, A.lifetime.tracked_minutes, 'restored tracked minutes');
      assert.deepEqual(restored.games, A.games, 'restored games and details');
      consistent(b, 'B restored');

      await b.linkSteam(m2);
      const B = await describeInstance(b);
      assert.deepEqual(B.games, A.games, 'every game once, with the same minutes and details');
      assert.deepEqual(B.play, A.play, 'every exact session kept, none doubled');
      assert.deepEqual(B.excluded, A.excluded);
      assert.equal(B.entries, A.entries, 'no extra entries');
      assert.equal(B.lifetime.total_minutes, A.lifetime.total_minutes);
      assert.equal(B.lifetime.tracked_minutes, A.lifetime.tracked_minutes);
      assert.equal(b.db.prepare("SELECT COUNT(*) n FROM entries WHERE platform = 'steam' AND account_id IS NULL").get().n, 0, 'imported Steam copies adopted');
      consistent(b, 'B relinked');
    } finally { await b.close(); m2.dispose(); }
  });
});

/** What a user sees of an instance, independent of row ids. */
async function describeInstance(t) {
  const games = (await t.gamesAll()).map((g) => ({ title: g.title, minutes: g.minutes, status: g.status, rating: g.rating, notes: g.notes, favorite: g.favorite, hidden: g.hidden }));
  const play = t.db.prepare(`SELECT g.title, s.minutes, COALESCE(s.started_at, s.window_start, s.window_end) at FROM sessions s JOIN entries e ON e.id = s.entry_id JOIN games g ON g.id = e.game_id
    WHERE s.kind = 'play' ORDER BY g.title, at, s.minutes`).all().map((x) => ({ ...x }));
  const excluded = t.db.prepare('SELECT g.title, e.platform FROM entries e JOIN games g ON g.id = e.game_id WHERE e.excluded = 1 ORDER BY g.title, e.platform').all().map((x) => ({ ...x }));
  const entries = t.db.prepare('SELECT COUNT(*) n FROM entries').get().n;
  const life = await t.lifetime();
  return { games, play, excluded, entries, lifetime: { total_minutes: life.total_minutes, tracked_minutes: life.tracked_minutes, sessions: life.sessions, games: life.games } };
}

// =====================================================================================
describe('?dry_run=true previews an import without changing anything', () => {
  let t; let steam;
  const COUNTS = ['games', 'entries_created', 'entries_updated', 'merged_synced', 'sessions', 'sessions_restored', 'baseline_minutes', 'tracked_minutes', 'skipped', 'details_filled'];
  const pick = (r) => Object.fromEntries(COUNTS.map((k) => [k, r[k]]));
  async function reads() {
    return {
      lifetime: await t.lifetime(),
      games: (await t.ok(t.get('/games', { limit: '500' }))),
      dupes: await t.ok(t.get('/duplicates')),
      stats: await t.ok(t.get('/stats', { range: 'all' })),
      sessions: await t.ok(t.get('/sessions', { kind: 'all', limit: '1000' })),
    };
  }
  before(async () => {
    t = await startApp();
    steam = new SteamMock({ games: [
      { appid: 620, name: 'Portal 2', minutes: 900, lastPlayed: ago(100) },
      { appid: 1145360, name: 'Hades', minutes: 1200, lastPlayed: ago(5) },
    ] });
    await t.linkSteam(steam);
  });
  after(async () => { await t.close(); steam.dispose(); });

  test('CSV preview: reports what would happen, changes nothing; the real run then does exactly that', async () => {
    const csv = toCsv([
      ['title', 'platform', 'playtime_hours', 'last_played', 'status'],
      ['Preview Switch Game', 'switch', '12', dayOf(ago(30)), 'beaten'],
      ['Portal 2', 'steam', '15', '', 'completed'],
      ['Hades', '', '10', '', ''],
      ['', '', '1', '', ''],
    ]);
    const snap = t.snapshot();
    const seen = await reads();
    const p = await t.importCsv(csv, { dry_run: 'true' });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.data.dry_run, true);
    assert.deepEqual(t.snapshot(), snap, 'the database is untouched');
    assert.deepEqual(await reads(), seen, 'no cached view shows previewed data');
    assert.equal(p.data.entries_created, 1);
    assert.equal(p.data.merged_synced, 2);
    assert.equal(p.data.skipped, 1);
    const real = await t.ok(t.importCsv(csv));
    assert.equal(real.dry_run, undefined);
    assert.deepEqual(pick(p.data), pick(real), 'the preview predicted the real import');
    assert.notDeepEqual(t.snapshot(), snap);
    consistent(t);
  });

  test('JSON preview with sessions joining a synced game changes nothing', async () => {
    const body = { games: [{ title: 'Hades', platform: 'steam', playtime_minutes: 1200, first_played: dayOf(ago(500)), sessions: [{ started_at: iso(ago(200, 3)), minutes: 100 }] }] };
    const snap = t.snapshot();
    const p = await t.ok(t.importJson(body, { dry_run: 'true' }));
    assert.equal(p.dry_run, true);
    assert.equal(p.sessions_restored, 1);
    assert.deepEqual(t.snapshot(), snap);
    const real = await t.ok(t.importJson(body));
    assert.deepEqual(pick(p), pick(real));
    assert.equal(t.sessionsOf(t.entriesOf('Hades')[0].id, 'play').length, 1);
  });

  test('a rejected body is rejected in preview too, and nothing changes', async () => {
    const snap = t.snapshot();
    const r = await t.importJson({ nope: true }, { dry_run: 'true' });
    assert.equal(r.status, 400);
    assert.deepEqual(t.snapshot(), snap);
    // the instance keeps working normally afterwards (no transaction left open)
    assert.equal((await t.importJson({ games: [{ title: 'After Preview', playtime_minutes: 5 }] })).status, 200);
    assert.equal((await t.gameByTitle('After Preview')).minutes, 5);
  });
});

// =====================================================================================
describe('export (streamed JSON / CSV), round trips and SQLite backup', () => {
  let a; let steam; let A;
  before(async () => {
    a = await startApp();
    steam = new SteamMock({ games: [
      { appid: 620, name: 'Portal 2', minutes: 900, lastPlayed: ago(100) },
      { appid: 1145360, name: 'Hades', minutes: 1200, lastPlayed: ago(5) },
    ] });
    await a.linkSteam(steam);
    const [h] = a.entriesOf('Hades');
    const at = Date.now() - 50 * MIN;
    await a.ok(a.post(`/entries/${h.id}/playtime`, { playtime_minutes: 1245, last_played_at: iso(at) }));
    steam.set(1145360, { minutes: 1245, lastPlayed: at });
    const mc = await a.ok(a.post('/games', { title: 'Minecraft', status: 'playing' }));
    await a.ok(a.post('/sessions', { game_id: mc.id, minutes: 120, started_at: iso(ago(3, 4)), note: 'base, "castle"' }));
    await a.ok(a.patch(`/games/${mc.id}`, { notes: 'Survival, "hardcore";\nworld 2', rating: 7, favorite: true }));
    await a.ok(a.importJson({ games: [
      { title: 'Zelda: Echoes', platform: 'switch', playtime_minutes: 1500, rating: 9, status: 'beaten', sessions: [{ started_at: iso(ago(20, 3)), minutes: 60, note: 'dungeon 3' }] },
      { title: 'Excluded Copy', platform: 'switch', playtime_minutes: 400 },
      { title: 'Undated History', platform: 'switch', playtime_minutes: 700, last_played: dayOf(ago(90)) },
    ] }));
    await a.ok(a.patch(`/entries/${a.entriesOf('Excluded Copy')[0].id}`, { excluded: true }));
    const hidden = await a.ok(a.post('/games', { title: 'Hidden Tool' }));
    await a.ok(a.post('/sessions', { game_id: hidden.id, minutes: 30, started_at: iso(ago(6, 2)) }));
    await a.ok(a.patch(`/games/${hidden.id}`, { hidden: true }));
    const covered = await a.ok(a.post('/games', { title: 'Covered Game', cover_url: 'https://img.example/covered.jpg' }));
    await a.ok(a.post('/sessions', { game_id: covered.id, minutes: 15, started_at: iso(ago(8, 2)) }));
    await a.ok(a.patch(`/entries/${a.entriesOf('Undated History')[0].id}/history`, { mode: 'undated' }));
    A = await describeInstance(a);
  });
  after(async () => { await a.close(); steam.dispose(); });

  const visible = (games) => games.map(({ hidden, ...g }) => g);

  test('JSON export: an attachment with every entry, its sessions and your details, and no credentials', async () => {
    const r = await a.get('/export');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.match(r.headers.get('content-disposition') || '', /attachment;.*\.json/);
    const doc = JSON.parse(r.text);
    assert.equal(doc.format, 'playtracker-export');
    assert.equal(doc.games.length, a.db.prepare('SELECT COUNT(*) n FROM entries').get().n);
    assert.ok(!r.text.includes(steam.key), 'the Steam API key is not in the export');
    const life = await a.lifetime();
    assert.equal(doc.games.filter((g) => !g.excluded).reduce((s, g) => s + g.playtime_minutes, 0), life.total_minutes);
    assert.equal(doc.games.filter((g) => !g.excluded).flatMap((g) => g.sessions).reduce((s, x) => s + x.minutes, 0), life.tracked_minutes);
    const mc = doc.games.find((g) => g.title === 'Minecraft');
    assert.equal(mc.notes, 'Survival, "hardcore";\nworld 2');
    assert.equal(mc.status, 'playing');
    assert.equal(mc.rating, 7);
    assert.equal(mc.favorite, true);
    assert.equal(doc.games.find((g) => g.title === 'Excluded Copy').excluded, true);
    assert.deepEqual(doc.games.find((g) => g.title === 'Zelda: Echoes').sessions.map((s) => [s.minutes, s.note]), [[60, 'dungeon 3']]);
  });

  test('CSV export: an attachment, one row per entry, quoting that survives commas, quotes and newlines', async () => {
    const r = await a.get('/export', { format: 'csv' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition') || '', /attachment;.*\.csv/);
    assert.ok(!r.text.includes(steam.key));
    const recs = readCsv(r.text);
    assert.equal(recs.length, a.db.prepare('SELECT COUNT(*) n FROM entries').get().n);
    for (const col of ['title', 'platform', 'playtime_minutes', 'status', 'rating', 'excluded', 'notes']) assert.ok(col in recs[0], `column ${col}`);
    const mc = recs.find((x) => x.title === 'Minecraft');
    assert.equal(mc.notes, 'Survival, "hardcore";\nworld 2');
    assert.equal(Number(mc.playtime_minutes), 120);
    const life = await a.lifetime();
    assert.equal(recs.filter((x) => x.excluded !== 'true').reduce((s, x) => s + Number(x.playtime_minutes), 0), life.total_minutes);
  });

  test('JSON round trip into a fresh instance: lifetime, tracked minutes, sessions, exclusions, statuses and details', async () => {
    const b = await startApp();
    try {
      const exported = (await a.get('/export')).text;
      await b.ok(b.importJson(JSON.parse(exported)));
      const B = await describeInstance(b);
      assert.deepEqual(B.lifetime, A.lifetime);
      assert.deepEqual(visible(B.games), visible(A.games));
      assert.deepEqual(B.play, A.play);
      assert.deepEqual(B.excluded, A.excluded);
      assert.equal(B.entries, A.entries);
      consistent(b, 'B');
      const snap = b.snapshot();
      await b.ok(b.importJson(JSON.parse(exported)));
      assert.deepEqual(b.snapshot(), snap, 'importing the same export again changes nothing');
    } finally { await b.close(); }
  });

  test('CSV round trip into a fresh instance: lifetime total, statuses, ratings, notes, favorites and exclusions', async () => {
    const c = await startApp();
    try {
      await c.ok(c.importCsv((await a.get('/export', { format: 'csv' })).text));
      const C = await describeInstance(c);
      assert.equal(C.lifetime.total_minutes, A.lifetime.total_minutes);
      assert.equal(C.lifetime.games, A.lifetime.games);
      assert.deepEqual(visible(C.games), visible(A.games));
      assert.deepEqual(C.excluded, A.excluded);
      assert.equal(C.lifetime.tracked_minutes, 0, 'a CSV has no sessions: the time comes back as history');
      consistent(c, 'C');
    } finally { await c.close(); }
  });

  test('importing your own export back into the same instance changes nothing', async () => {
    const snap = a.snapshot();
    const life = await a.lifetime();
    await a.ok(a.importJson(JSON.parse((await a.get('/export')).text)));
    assert.deepEqual(a.snapshot(), snap, 'JSON export re-imported');
    await a.ok(a.importCsv((await a.get('/export', { format: 'csv' })).text));
    assert.deepEqual(a.snapshot(), snap, 'CSV export re-imported');
    assert.deepEqual(await a.lifetime(), life);
  });

  test('hidden games and your own cover art survive an export / import round trip', { todo: 'APP BUG import-export-6: the export omits hidden flags and cover art, so a restore loses them' }, async () => {
    const b = await startApp();
    try {
      await b.ok(b.importJson(JSON.parse((await a.get('/export')).text)));
      const hidden = await b.gameByTitle('Hidden Tool');
      assert.ok(hidden, 'the hidden game is restored');
      assert.equal(hidden.hidden, true, 'and stays hidden');
      assert.equal((await b.gameByTitle('Covered Game')).cover_url, 'https://img.example/covered.jpg');
    } finally { await b.close(); }
  });

  test('your "Don\'t chart" history choice survives an export / import round trip', { todo: 'APP BUG import-export-7: history corrections (Don\'t chart / manual window) are not exported' }, async () => {
    const b = await startApp();
    try {
      await b.ok(b.importJson(JSON.parse((await a.get('/export')).text)));
      const g = await b.gameByTitle('Undated History');
      assert.equal(g.entries[0].history?.mode, 'undated');
      assert.equal(kindMinutes(b, g.entries[0].id, 'estimate'), 0, 'its history is not charted');
    } finally { await b.close(); }
  });

  test('SQLite backup: a consistent database file with everything in it', async () => {
    const r = await a.get('/backup');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/vnd\.sqlite3/);
    assert.match(r.headers.get('content-disposition') || '', /attachment;.*\.db/);
    assert.equal(r.buf.subarray(0, 16).toString('latin1'), 'SQLite format 3\u0000');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ie-backup-'));
    const file = path.join(dir, 'backup.db');
    try {
      fs.writeFileSync(file, r.buf);
      const copy = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        for (const table of ['games', 'entries', 'sessions', 'accounts', 'snapshots']) {
          assert.equal(copy.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, a.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, table);
        }
        assert.equal(copy.prepare('SELECT SUM(playtime_min) m FROM entries WHERE excluded = 0').get().m, (await a.lifetime()).total_minutes);
        assert.equal(copy.prepare('PRAGMA user_version').get().user_version, a.db.prepare('PRAGMA user_version').get().user_version);
      } finally { copy.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// =====================================================================================
describe('import / export security boundaries', () => {
  let t; let token;
  before(async () => {
    t = await startApp({ password: 'correct horse battery' });
    const login = await t.post('/auth/login', { password: 'correct horse battery' });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    t.setHeaders({ Cookie: cookie });
    token = (await t.ok(t.post('/tokens', { name: 'suite' }))).token;
    await t.ok(t.post('/accounts', { platform: 'custom', name: 'Pushed', config: {} }));
    t.setHeaders({});
  });
  after(() => t.close());

  test('without credentials every import, export and backup is refused and nothing is imported', async () => {
    const zip = buildZip({ 'games.csv': 'uuid,title,hours_played\nA,Sneaky,5\n' });
    for (const [label, req] of [
      ['import csv', () => t.importCsv('title,playtime_hours\nSneaky,5\n')],
      ['import json', () => t.importJson({ games: [{ title: 'Sneaky', playtime_minutes: 5 }] })],
      ['import gametrack', () => t.importZip(zip)],
      ['licenses', () => t.post('/accounts/1/licenses', { text: '20 Nov, 2015\tSneaky\tSteam Store' })],
      ['export json', () => t.get('/export')],
      ['export csv', () => t.get('/export', { format: 'csv' })],
      ['backup', () => t.get('/backup')],
      ['wrong token', () => t.call('/export', { headers: { Authorization: 'Bearer pt_not_a_real_token' } })],
    ]) {
      const r = await req();
      assert.equal(r.status, 401, `${label} -> ${r.status}`);
      assert.ok(!r.text.includes('SQLite format'), `${label}: no data leaked`);
    }
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM games WHERE title = 'Sneaky'").get().n, 0);
  });

  test('an API token can import, export and download the backup', async () => {
    t.setHeaders({ Authorization: `Bearer ${token}` });
    try {
      assert.equal((await t.importCsv('title,platform,playtime_hours\nToken Game,switch,2\n')).status, 200);
      const ex = await t.get('/export');
      assert.equal(ex.status, 200);
      assert.ok(JSON.parse(ex.text).games.some((g) => g.title === 'Token Game'));
      const b = await t.get('/backup');
      assert.equal(b.status, 200);
      assert.equal(b.buf.subarray(0, 15).toString('latin1'), 'SQLite format 3');
    } finally { t.setHeaders({}); }
  });

  test('a logged-in browser cannot be made to import from another site (cross-origin write blocked)', async () => {
    const login = await t.post('/auth/login', { password: 'correct horse battery' });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const evil = await t.call('/import', { method: 'POST', body: 'title,playtime_hours\nCsrf Game,99\n', type: 'text/csv', headers: { Cookie: cookie, Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM games WHERE title = 'Csrf Game'").get().n, 0);
    const same = await t.call('/import', { method: 'POST', body: 'title,playtime_hours\nSame Origin Game,1\n', type: 'text/csv', headers: { Cookie: cookie, Origin: t.origin } });
    assert.equal(same.status, 200, same.text);
  });

  test('an instance without a password still blocks cross-site imports', async () => {
    const open = await startApp();
    try {
      const r = await open.call('/import', { method: 'POST', body: { games: [{ title: 'Drive By', playtime_minutes: 600 }] }, headers: { Origin: 'https://evil.example' } });
      assert.equal(r.status, 403);
      assert.equal(open.db.prepare('SELECT COUNT(*) n FROM games').get().n, 0);
    } finally { await open.close(); }
  });
});
