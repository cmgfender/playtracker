// Play-tracking edge cases, each as it was reproduced: play that live presence watched but the
// sync window was too short to hold, minutes a platform credits after its own "last played", and
// a sitting presence joined late.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Settings } from '../src/services/settings.js';
import { applyItems, parseAccount, SyncService } from '../src/services/sync.js';

const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function world(platform) {
  const db = openDb(':memory:');
  const settings = new Settings(db);
  const svc = new SyncService({ db, settings, log: quiet });
  const acc = Number(db.prepare("INSERT INTO accounts(platform, name, created_at) VALUES (?, 'me', 0)").run(platform).lastInsertRowid);
  const account = () => parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(acc));
  const sync = (items, now) => {
    const a = account();
    const stats = applyItems(db, a, items, { settings: settings.all(), now, initial: !a.last_sync_at });
    db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(now, acc);
    return stats;
  };
  // one presence poll, as the scheduler runs it
  const poll = (now, playing, intervalSec = 120) => {
    svc.applyPresence(account(), playing ? [{ extId: '7', title: 'Game' }] : [], { intervalSec, now });
    svc.presenceState.set(acc, { lastPoll: now });
  };
  // a finished span presence saw
  const span = (start, end) => db.prepare('INSERT INTO presence(account_id, ext_id, title, started_at, last_seen_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)').run(acc, '7', 'Game', start, end, end);
  const rows = (kind) => db.prepare('SELECT * FROM sessions WHERE kind = ? ORDER BY COALESCE(started_at, window_start), id').all(kind);
  const days = () => Object.fromEntries(db.prepare('SELECT day, SUM(minutes) m FROM play_days WHERE estimated = 0 GROUP BY day').all().map((r) => [r.day, Math.round(r.m)]));
  return { db, sync, poll, span, rows, days };
}

const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const sum = (list) => list.reduce((a, s) => a + s.minutes, 0);
// every minute of the platform's total is in a session
const adds = (db) => db.prepare('SELECT playtime_min p, (SELECT COALESCE(SUM(minutes), 0) FROM sessions s WHERE s.entry_id = entries.id) s FROM entries').all().every((r) => r.p === r.s);

test('a game left running for 20 hours under presence is tracked whole, however recently a sync ran', () => {
  // Steam writes the total when the game closes; a scheduled sync an hour before that left a
  // window of an hour for 1200 minutes
  const w = world('steam');
  const launch = new Date(2026, 5, 2, 18, 0).getTime();
  const exit = launch + 20 * HOUR;
  const item = (total, recent, lastPlayedAt) => [{ extId: '7', title: 'Game', playtimeMin: total, recentMin: recent, lastPlayedAt, devices: { windows: total, offline: 0 } }];
  w.sync(item(500, 0, launch - 30 * DAY), launch - DAY);
  for (let t = launch; t < exit; t += 2 * MIN) {
    w.poll(t, true);
    if (t === launch + 19 * HOUR) w.sync(item(500, 0, launch), t);
  }
  w.poll(exit, false);
  const stats = w.sync(item(1700, 1200, launch), exit + 2 * MIN);
  const play = w.rows('play');
  assert.equal(play.length, 1);
  assert.equal(play[0].minutes, 1200, 'all of it is the session presence watched');
  assert.equal(play[0].confidence, 'exact');
  assert.equal(play[0].started_at, launch);
  assert.equal(stats.late_minutes, 0, 'nothing is filed as an undated late upload');
  assert.equal(w.rows('baseline').filter((s) => s.source !== 'inferred').length, 0);
  assert.ok(adds(w.db));
});

test('minutes credited a day late for a session presence watched are tracked, even when a sync ran just before the next play', () => {
  // Xbox (PC): Thursday's two hours arrive with Friday's 35 minutes, 58 minutes after a sync
  const w = world('xbox');
  const thu = new Date(2026, 5, 4, 14, 0).getTime();
  const fri = thu + DAY;
  const item = (total) => [{ extId: '7', title: 'Game', playtimeMin: total, lastPlayedAt: null }];
  w.sync(item(1000), thu - 20 * HOUR);
  w.span(thu, thu + 2 * HOUR);
  w.sync(item(1000), thu + 2 * HOUR + 15 * MIN); // the stat has not moved
  w.sync(item(1000), fri - 10 * MIN);
  w.span(fri, fri + 35 * MIN);
  const stats = w.sync(item(1155), fri + 48 * MIN);
  assert.equal(stats.late_minutes, 0);
  assert.deepEqual(w.rows('play').map((s) => [s.started_at, s.minutes, s.confidence]), [[thu, 120, 'exact'], [fri, 35, 'exact']]);
  assert.deepEqual(w.days(), { [dayOf(thu)]: 120, [dayOf(fri)]: 35 });
  assert.ok(adds(w.db));
});

test('a delta beyond the window that presence did not watch is still an undated late upload', () => {
  const w = world('xbox');
  const t = new Date(2026, 5, 4, 14, 0).getTime();
  const item = (total) => [{ extId: '7', title: 'Game', playtimeMin: total, lastPlayedAt: null }];
  w.sync(item(1000), t - DAY);
  w.sync(item(1000), t - 10 * MIN);
  w.span(t, t + 35 * MIN);
  const stats = w.sync(item(1400), t + 48 * MIN); // 400 minutes in under an hour, 35 of them seen
  assert.ok(stats.late_minutes >= 300, `${stats.late_minutes} late`);
  assert.ok(sum(w.rows('play')) <= 100);
  assert.ok(adds(w.db));
});

test('minutes credited after an unchanged last-played time join the session that ended then', () => {
  // Xbox, presence off: played 22:10-23:10; the sync at 23:45 reads a stat still 10 minutes
  // short, the morning sync reads the rest - with the same last-played time
  const w = world('xbox');
  const end = new Date(2026, 5, 2, 23, 10).getTime();
  const item = (total, lastPlayedAt) => [{ extId: '7', title: 'Game', playtimeMin: total, lastPlayedAt }];
  w.sync(item(500, end - 3 * DAY), end - DAY);
  w.sync(item(550, end), end + 35 * MIN);
  w.sync(item(560, end), end + 10 * HOUR);
  const play = w.rows('play');
  assert.deepEqual(play.map((s) => [s.started_at, s.ended_at, s.minutes, s.confidence]), [[end - HOUR, end, 60, 'pinned']]);
  assert.deepEqual(w.days(), { [dayOf(end)]: 60 }, 'nothing on the morning after: the game was not played then');
  assert.ok(adds(w.db));
});

test('a total that lands after its last-played time was already reported is a session ending then', () => {
  // PlayStation: the sync at 23:45 sees the new last-played time and launch, not yet the hour
  const w = world('psn');
  const end = new Date(2026, 5, 2, 23, 10).getTime();
  const item = (total, lastPlayedAt, playCount) => [{ extId: '7', title: 'Game', playtimeMin: total, lastPlayedAt, playCount, firstPlayedAt: end - 30 * DAY }];
  w.sync(item(500, end - 3 * DAY, 5), end - DAY);
  w.sync(item(500, end, 6), end + 35 * MIN);
  w.sync(item(560, end, 6), end + 10 * HOUR);
  assert.deepEqual(w.rows('play').map((s) => [s.started_at, s.ended_at, s.minutes, s.confidence]), [[end - HOUR, end, 60, 'pinned']]);
  assert.deepEqual(w.days(), { [dayOf(end)]: 60 });
  assert.ok(adds(w.db));
});

test('late minutes after an unchanged last-played time keep the times presence saw', () => {
  const w = world('xbox');
  const end = new Date(2026, 5, 2, 23, 10).getTime();
  const item = (total, lastPlayedAt) => [{ extId: '7', title: 'Game', playtimeMin: total, lastPlayedAt }];
  w.sync(item(500, end - 3 * DAY), end - DAY);
  w.span(end - 50 * MIN, end); // presence joined ten minutes in
  w.sync(item(550, end), end + 35 * MIN);
  w.sync(item(560, end), end + 10 * HOUR);
  assert.deepEqual(w.rows('play').map((s) => [s.started_at, s.ended_at, s.minutes, s.confidence]), [[end - 50 * MIN, end, 60, 'exact']]);
  assert.deepEqual(w.days(), { [dayOf(end)]: 60 });
});

// PlayStation: 200 minutes played 19:00-22:20; presence (down until 21:20) saw the last hour
function joinedLate(launches) {
  const w = world('psn');
  const start = new Date(2026, 5, 2, 19, 0).getTime();
  const end = start + 200 * MIN;
  const item = (total, lastPlayedAt, playCount) => [{ extId: '7', title: 'Game', playtimeMin: total, lastPlayedAt, playCount, firstPlayedAt: start - 30 * DAY }];
  w.sync(item(500, start - 30 * DAY, 5), start - DAY);
  w.sync(item(500, start - 30 * DAY, 5), start - 5 * HOUR);
  w.span(start + 140 * MIN, end);
  w.sync(item(700, end, 5 + launches), end + 20 * MIN);
  return { w, start, end };
}

test('a sitting presence joined late is one session from where it began, not two over the same hour', () => {
  const { w, start, end } = joinedLate(1);
  assert.deepEqual(w.rows('play').map((s) => [s.started_at, s.ended_at, s.minutes]), [[start, end, 200]]);
  // no hour holds more than 60 minutes of one game
  const busiest = w.db.prepare('SELECT MAX(m) m FROM (SELECT SUM(minutes) m FROM play_hours GROUP BY day, hour)').get().m;
  assert.ok(busiest <= 60.5, `${busiest} minutes in one hour`);
  assert.ok(adds(w.db));
});

test('with a second launch reported, what presence did not see stays a session of its own', () => {
  const { w, start, end } = joinedLate(2);
  const play = w.rows('play');
  assert.ok(play.length >= 2);
  assert.equal(sum(play), 200);
  const seen = play.find((s) => s.confidence === 'exact');
  assert.deepEqual([seen.started_at, seen.ended_at], [start + 140 * MIN, end], 'the session presence saw keeps its times');
});

test('a reporter that pushes totals without refreshing last played gets each delta in its own window', () => {
  const w = world('custom');
  const t = new Date(2026, 5, 2, 12, 0).getTime();
  const item = (total) => [{ extId: '7', title: 'Game', playtimeMin: total, lastPlayedAt: t - HOUR }];
  w.sync(item(500), t - DAY);
  w.sync(item(530), t);
  w.sync(item(560), t + 5 * HOUR);
  const play = w.rows('play');
  assert.equal(play.length, 2);
  assert.ok((play[1].started_at ?? play[1].window_start) >= t - 5 * MIN, 'the second delta is not put on the first session');
});
