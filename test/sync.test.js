import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Settings } from '../src/services/settings.js';
import { applyItems, parseAccount } from '../src/services/sync.js';
import { computeStats, lifetime, spreadByDay } from '../src/services/stats.js';
import { findDuplicates } from '../src/services/duplicates.js';
import { importRows, parseCsv } from '../src/services/importer.js';
import { nextRun } from '../src/services/schedule.js';
import { normalizeTitle, matchScore } from '../src/services/titles.js';
import { parseDuration } from '../src/providers/psn.js';
import { findMinutesPlayed } from '../src/providers/xbox.js';

const H = 3600_000;
const D = 24 * H;

function setup() {
  const db = openDb(':memory:');
  const settings = new Settings(db);
  return { db, settings };
}

function addAccount(db, platform = 'custom') {
  const id = Number(db.prepare("INSERT INTO accounts(platform, name, created_at) VALUES (?, 'test', 0)").run(platform).lastInsertRowid);
  return id;
}

function runSync(db, settings, accountId, items, now) {
  const account = parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId));
  const syncId = Number(db.prepare('INSERT INTO syncs(account_id, started_at) VALUES (?, ?)').run(accountId, now).lastInsertRowid);
  const stats = applyItems(db, account, items, { settings: settings.all(), now, syncId, initial: !account.last_sync_at });
  db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(now, accountId);
  return stats;
}

const sessions = (db, kind) => db.prepare(`SELECT * FROM sessions ${kind ? 'WHERE kind = ?' : ''} ORDER BY id`).all(...(kind ? [kind] : []));

test('initial import never lands on import day: history is dated by inference', () => {
  const { db, settings } = setup();
  const acc = addAccount(db);
  const t0 = new Date(2026, 5, 1, 4).getTime();
  const s = runSync(db, settings, acc, [
    { extId: '1', title: 'Hades', playtimeMin: 6000, recentMin: 120, lastPlayedAt: t0 - D },
    { extId: '2', title: 'Celeste', playtimeMin: 900 },
    { extId: '3', title: 'Unplayed', playtimeMin: 0 },
  ], t0);
  assert.equal(s.games_new, 3);
  assert.equal(s.sessions_created, 0, 'no tracked play on an initial import');
  assert.equal(s.history_minutes, 6900);
  assert.equal(s.estimated_minutes, 6000, 'Hades is dated (last played + 2-week counter)');
  assert.equal(s.baseline_minutes, 900, 'Celeste has no dates -> undated history');
  const l = lifetime(db);
  assert.equal(l.total_minutes, 6900);
  assert.equal(l.tracked_minutes, 0);
  assert.equal(l.estimated_minutes, 6000);
  // nothing after last played, the 2-week minutes inside the last 14 days, per-day cap respected
  const days = db.prepare('SELECT day, SUM(minutes) m FROM play_days GROUP BY day').all();
  const lastDay = new Date(t0 - D); lastDay.setHours(23, 59, 59, 999);
  const lastKey = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`;
  assert.ok(days.every((d) => d.day <= lastKey), 'no history after last played');
  assert.ok(days.every((d) => d.m <= 600.5), 'no day over 10h');
  const recentKey = new Date(t0 - 14 * D).toISOString().slice(0, 10);
  const recent = days.filter((d) => d.day >= recentKey).reduce((a, d) => a + d.m, 0);
  assert.ok(recent >= 119.5, 'two-week minutes placed inside the last 14 days');
  // today's / this week's tracked stats stay empty
  const st = computeStats(db, { range: '7d', now: t0, estimates: 'exclude' });
  assert.equal(st.total_minutes, 0);
});

test('deltas between syncs become sessions, small deltas accumulate', () => {
  const { db, settings } = setup();
  settings.set({ min_session_minutes: 5 });
  const acc = addAccount(db);
  const t0 = new Date(2026, 5, 1, 4).getTime();
  runSync(db, settings, acc, [{ extId: '1', title: 'Hades', playtimeMin: 100 }], t0);
  let s = runSync(db, settings, acc, [{ extId: '1', title: 'Hades', playtimeMin: 160 }], t0 + D);
  assert.equal(s.sessions_created, 1);
  assert.equal(s.minutes_added, 60);
  // 3 minutes - below threshold, nothing recorded yet
  s = runSync(db, settings, acc, [{ extId: '1', title: 'Hades', playtimeMin: 163 }], t0 + 2 * D);
  assert.equal(s.sessions_created, 0);
  // +4 more -> 7 total pending -> recorded, window spans both days
  s = runSync(db, settings, acc, [{ extId: '1', title: 'Hades', playtimeMin: 167 }], t0 + 3 * D);
  assert.equal(s.minutes_added, 7);
  const last = sessions(db, 'play').at(-1);
  assert.equal(last.window_start, t0 + D);
  assert.equal(last.window_end, t0 + 3 * D);
  assert.equal(lifetime(db).total_minutes, 167);
});

test('delta larger than wall-clock time is split into play + baseline', () => {
  const { db, settings } = setup();
  const acc = addAccount(db);
  const t0 = Date.now() - 10 * D;
  runSync(db, settings, acc, [{ extId: '1', title: 'X', playtimeMin: 10 }], t0);
  const s = runSync(db, settings, acc, [{ extId: '1', title: 'X', playtimeMin: 10 + 5000 }], t0 + 2 * H);
  assert.equal(s.minutes_added, 120);
  assert.equal(s.baseline_minutes, 4880);
});

test('new game after initial sync: counted if plausible, baseline if played before last sync', () => {
  const { db, settings } = setup();
  const acc = addAccount(db);
  const t0 = Date.now() - 10 * D;
  runSync(db, settings, acc, [{ extId: '1', title: 'A', playtimeMin: 10 }], t0);
  const s = runSync(db, settings, acc, [
    { extId: '1', title: 'A', playtimeMin: 10 },
    { extId: '2', title: 'New Game', playtimeMin: 90, lastPlayedAt: t0 + D - H },
    { extId: '3', title: 'Old Unseen', playtimeMin: 600, lastPlayedAt: t0 - 30 * D },
  ], t0 + D);
  assert.equal(s.sessions_created, 1);
  assert.equal(s.minutes_added, 90);
  assert.equal(s.history_minutes, 600);
  assert.equal(s.estimated_minutes, 600, 'old title is dated before its last played time');
});

test('weekly windows spread across days; pinned sessions land on one day', () => {
  const s1 = { minutes: 70, window_start: new Date(2026, 0, 1).getTime(), window_end: new Date(2026, 0, 8).getTime() };
  const parts = spreadByDay(s1);
  assert.equal(parts.length, 7);
  assert.ok(Math.abs(parts.reduce((a, p) => a + p[1], 0) - 70) < 1e-9);
  const s2 = { minutes: 60, started_at: new Date(2026, 0, 3, 20).getTime(), ended_at: new Date(2026, 0, 3, 21).getTime() };
  assert.deepEqual(spreadByDay(s2).map((p) => p[0]), ['2026-01-03']);
});

test('auto-merge groups same game across platforms; duplicates flagged', () => {
  const { db, settings } = setup();
  const steamAcc = addAccount(db, 'steam');
  const psnAcc = addAccount(db, 'psn');
  const t0 = Date.now() - 5 * D;
  runSync(db, settings, steamAcc, [{ extId: '1', title: 'DOOM Eternal', playtimeMin: 600 }, { extId: '2', title: 'Hollow Knight', playtimeMin: 100 }], t0);
  runSync(db, settings, psnAcc, [{ extId: 'CUSA1', title: 'DOOM Eternal (PS4)', playtimeMin: 300 }, { extId: 'CUSA2', title: 'Hollow Knight: Voidheart Edition', playtimeMin: 100 }], t0);
  const games = db.prepare('SELECT * FROM games').all();
  assert.equal(games.length, 3); // DOOM merged; Hollow Knight variants separate but suggested
  const dup = findDuplicates(db);
  assert.equal(dup.suggestions.length, 1);
  assert.match(dup.suggestions[0].games[0].title, /Hollow Knight/);
  assert.equal(dup.cross_platform.length, 1);

  // An import of the same game on the same platform is flagged as double counted
  importRows(db, [{ title: 'DOOM Eternal', platform: 'steam', playtime_hours: 10 }], { settings: settings.all() });
  const dup2 = findDuplicates(db);
  assert.equal(dup2.double_counted.length, 1);
  assert.match(dup2.double_counted[0].reason, /twice on steam/);
});

test('import: sessions are tracked, remainder is baseline, re-import is idempotent', () => {
  const { db, settings } = setup();
  const rows = [{ title: 'Zelda', platform: 'switch', playtime_hours: 10, status: 'completed', sessions: [{ date: '2026-03-01', minutes: 90 }, { date: '2026-03-02', minutes: 30 }] }];
  const r = importRows(db, rows, { settings: settings.all() });
  assert.equal(r.sessions, 2);
  assert.equal(r.baseline_minutes, 600 - 120);
  importRows(db, rows, { settings: settings.all() });
  assert.equal(lifetime(db).total_minutes, 600);
  assert.equal(lifetime(db).tracked_minutes, 120);
  assert.equal(db.prepare('SELECT status FROM games').get().status, 'completed');
  const csv = parseCsv('Title,Platform,Hours\n"Hades, the game",steam,"12,5"\n');
  assert.equal(csv[0].title, 'Hades, the game');
  assert.equal(csv[0].hours, '12,5');
});

test('stats aggregate by day and platform', () => {
  const { db, settings } = setup();
  const acc = addAccount(db);
  const now = Date.now();
  const t0 = now - 3 * D;
  runSync(db, settings, acc, [{ extId: '1', title: 'A', playtimeMin: 0 }], t0);
  runSync(db, settings, acc, [{ extId: '1', title: 'A', playtimeMin: 60 }], t0 + D);
  runSync(db, settings, acc, [{ extId: '1', title: 'A', playtimeMin: 180 }], t0 + 2 * D);
  const st = computeStats(db, { range: '7d', now });
  assert.equal(st.total_minutes, 180);
  assert.equal(st.sessions, 2);
  assert.equal(st.top_games[0].title, 'A');
  assert.equal(st.platforms[0].platform, 'custom');
  assert.equal(st.series.length, 7);
});

test('schedule: daily / every N days / weekly / monthly / hours', () => {
  const s = { schedule_time: '04:00', schedule_every: 3, schedule_weekday: 1, schedule_monthday: 15 };
  const last = new Date(2026, 9, 21, 10, 0).getTime(); // Wed Oct 21 2026 10:00
  assert.equal(new Date(nextRun({ ...s, schedule_mode: 'daily' }, last)).toString(), new Date(2026, 9, 22, 4).toString());
  assert.equal(new Date(nextRun({ ...s, schedule_mode: 'days' }, last)).toString(), new Date(2026, 9, 24, 4).toString());
  assert.equal(new Date(nextRun({ ...s, schedule_mode: 'weekly' }, last)).getDay(), 1);
  assert.equal(new Date(nextRun({ ...s, schedule_mode: 'monthly' }, last)).toString(), new Date(2026, 10, 15, 4).toString());
  assert.equal(nextRun({ ...s, schedule_mode: 'hours' }, last), last + 3 * H);
  assert.equal(nextRun({ ...s, schedule_mode: 'off' }, last), null);
  assert.equal(nextRun({ ...s, schedule_mode: 'daily' }, null, 123), 123);
});

test('title normalisation and matching', () => {
  assert.equal(normalizeTitle('DOOM Eternal (PS4)'), normalizeTitle('DOOM Eternal'));
  assert.equal(normalizeTitle('The Witcher® 3: Wild Hunt – Game of the Year Edition'), normalizeTitle('The Witcher 3: Wild Hunt'));
  assert.equal(normalizeTitle('Final Fantasy VII'), 'final fantasy 7');
  assert.ok(matchScore(normalizeTitle('Hades'), normalizeTitle('Hades II')) < 0.8);
  assert.ok(matchScore(normalizeTitle('Hollow Knight'), normalizeTitle('Hollow Knight: Voidheart Edition')) >= 0.8);
});

test('provider parsers', () => {
  assert.equal(parseDuration('PT228H56M33S'), 228 * 60 + 56);
  assert.equal(parseDuration('P1DT2H'), 26 * 60);
  assert.equal(parseDuration('PT45S'), 0);
  assert.equal(findMinutesPlayed({ statlistscollection: [{ stats: [{ name: 'MinutesPlayed', value: '1234' }] }] }), 1234);
  assert.equal(findMinutesPlayed({ foo: 1 }), null);
});

// ---- regressions from the bug scan: every entry's sessions add up to its total ----
const consistent = (db) => db.prepare('SELECT e.id FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min').all();

test('a temporary drop in reported playtime is not counted again when it comes back', () => {
  const { db, settings } = setup();
  const acc = addAccount(db, 'xbox');
  const t0 = new Date('2026-03-10T10:00:00').getTime();
  runSync(db, settings, acc, [{ extId: 1, title: 'G', playtimeMin: 1000, lastPlayedAt: t0 - 5 * D }], t0);
  runSync(db, settings, acc, [{ extId: 1, title: 'G', playtimeMin: 0, lastPlayedAt: t0 - 5 * D }], t0 + H);
  runSync(db, settings, acc, [{ extId: 1, title: 'G', playtimeMin: 1000, lastPlayedAt: t0 - 5 * D }], t0 + 2 * H);
  assert.equal(db.prepare('SELECT playtime_min FROM entries').get().playtime_min, 1000);
  assert.equal(sessions(db, 'play').length, 0, 'no play invented');
  assert.deepEqual(consistent(db), []);
  // real play above the old peak still counts
  runSync(db, settings, acc, [{ extId: 1, title: 'G', playtimeMin: 1060, lastPlayedAt: t0 + 2.5 * H }], t0 + 3 * H);
  assert.equal(sessions(db, 'play').reduce((a, s) => a + s.minutes, 0), 60);
});

test('a total that only now became available is history, not play today', () => {
  const { db, settings } = setup();
  const acc = addAccount(db, 'xbox');
  const t0 = new Date('2026-03-10T10:00:00').getTime();
  runSync(db, settings, acc, [{ extId: 1, title: 'PC', playtimeMin: 0, lastPlayedAt: t0 - 5 * D }], t0);
  db.prepare(`UPDATE accounts SET state = '{"unmetered":{"1":1}}' WHERE id = ?`).run(acc);
  const e = db.prepare('SELECT id FROM entries').get().id;
  db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, confidence, created_at) VALUES (?, 'presence', 'play', 45, ?, ?, ?, ?, 'exact', ?)")
    .run(e, t0 + 10 * 60_000, t0 + 55 * 60_000, t0 + 10 * 60_000, t0 + 55 * 60_000, t0);
  db.prepare('UPDATE entries SET playtime_min = 45 WHERE id = ?').run(e);
  runSync(db, settings, acc, [{ extId: 1, title: 'PC', playtimeMin: 600, lastPlayedAt: t0 + 55 * 60_000, backfill: true }], t0 + H);
  const play = sessions(db, 'play');
  assert.equal(play.length, 1);
  assert.equal(play[0].minutes, 45, 'tracked session untouched');
  assert.equal(db.prepare('SELECT baseline_min FROM entries').get().baseline_min, 555);
  assert.deepEqual(consistent(db), []);
});

test('large deltas whose last-played is exactly local midnight keep every minute', () => {
  for (const plat of ['psn', 'xbox', 'steam']) {
    const { db, settings } = setup();
    const acc = addAccount(db, plat);
    const t0 = new Date('2026-03-05T10:00:00').getTime();
    runSync(db, settings, acc, [{ extId: 1, title: 'G', playtimeMin: 1000, lastPlayedAt: t0 - 5 * D, recentMin: 0 }], t0);
    runSync(db, settings, acc, [{ extId: 1, title: 'G', playtimeMin: 2200, lastPlayedAt: new Date('2026-03-10T00:00:00').getTime(), recentMin: 1200 }], t0 + 6 * D);
    assert.deepEqual(consistent(db), [], plat);
  }
});

test('a minute or two beyond what presence saw stays part of that session', () => {
  const { db, settings } = setup();
  const acc = addAccount(db, 'steam');
  const t0 = new Date('2026-03-10T10:00:00').getTime();
  runSync(db, settings, acc, [{ extId: 1, title: 'G', playtimeMin: 100, lastPlayedAt: t0 - 5 * D, recentMin: 0 }], t0);
  db.prepare('INSERT INTO presence(account_id, ext_id, title, started_at, last_seen_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)').run(acc, '1', 'G', t0 + H, t0 + H + 20 * 60_000, t0 + H + 20 * 60_000);
  runSync(db, settings, acc, [{ extId: 1, title: 'G', playtimeMin: 131, lastPlayedAt: t0 + H, recentMin: 31 }], t0 + 3 * H);
  assert.deepEqual(consistent(db), []);
  assert.equal(sessions(db, 'play').reduce((a, s) => a + s.minutes, 0), 31);
});
