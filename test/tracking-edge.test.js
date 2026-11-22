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
