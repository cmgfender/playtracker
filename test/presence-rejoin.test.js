// A sitting that live presence loses sight of for a moment (the console's Home screen, a poll that
// missed the game) is one session, not two beside a hole of five minutes - as recorded from a real
// Xbox evening: seen 12:44-14:24, not at 14:24, seen again 14:29-16:09, credited 216 minutes.
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
  const lines = [];
  const svc = new SyncService({ db, settings, log: { ...quiet, info: (m) => lines.push(String(m)), scoped() { return this; }, child() { return this; } } });
  const acc = Number(db.prepare("INSERT INTO accounts(platform, name, created_at) VALUES (?, 'me', 0)").run(platform).lastInsertRowid);
  const account = () => parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(acc));
  const sync = (items, now) => {
    const a = account();
    const stats = applyItems(db, a, items, { settings: settings.all(), now, initial: !a.last_sync_at });
    db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(now, acc);
    return stats;
  };
  // one presence poll, as the scheduler runs it: the titles seen (by id), or none
  const poll = (now, ids, intervalSec = 300) => {
    svc.applyPresence(account(), (ids || []).map((id) => ({ extId: String(id), title: `Game ${id}` })), { intervalSec, now });
    svc.presenceState.set(acc, { lastPoll: now });
  };
  const spans = () => db.prepare('SELECT * FROM presence ORDER BY started_at').all();
  const plays = () => db.prepare("SELECT * FROM sessions WHERE kind = 'play' ORDER BY COALESCE(started_at, window_start), id").all();
  return { db, sync, poll, spans, plays, lines };
}
const item = (total, lastPlayedAt, id = 7) => ({ extId: String(id), title: `Game ${id}`, playtimeMin: total, lastPlayedAt });
const T0 = new Date(2026, 10, 24, 12, 44).getTime();

/** Polls every five minutes from `from` to `to` (inclusive) seeing `ids`. */
function run(w, from, to, ids) { for (let t = from; t <= to; t += 5 * MIN) w.poll(t, ids); }

test('Xbox: a game gone for one poll and back is one span and one session', () => {
  const w = world('xbox');
  w.sync([item(1000, T0 - 5 * DAY)], T0 - DAY);
  run(w, T0, T0 + 95 * MIN, [7]);            // 12:44 - 14:19
  w.poll(T0 + 100 * MIN, []);                 // 14:24: the Home screen
  assert.equal(w.spans().filter((s) => s.ended_at != null).length, 1, 'the span ends when the game is gone');
  run(w, T0 + 105 * MIN, T0 + 200 * MIN, [7]); // 14:29 - 16:04
  w.poll(T0 + 205 * MIN, []);                  // 16:09: put down
  const spans = w.spans();
  assert.equal(spans.length, 1, 'one span for the sitting');
  assert.ok(spans[0].ended_at >= T0 + 200 * MIN && spans[0].started_at <= T0);
  assert.ok(w.lines.some((l) => /is back in Game 7: the same session goes on/.test(l)), w.lines.join('\n'));
  w.sync([item(1216, T0 + 205 * MIN)], T0 + 215 * MIN);
  const plays = w.plays();
  assert.equal(plays.length, 1, 'one session, not two with a hole between');
  assert.equal(plays[0].minutes, 216);
  assert.equal(plays[0].confidence, 'exact');
  assert.ok(plays[0].started_at <= T0 && plays[0].ended_at >= T0 + 200 * MIN);
});

test('Xbox: two polls away (ten minutes) is still the same sitting; twenty minutes is another session', () => {
  const near = world('xbox');
  near.sync([item(1000, T0 - 5 * DAY)], T0 - DAY);
  run(near, T0, T0 + 30 * MIN, [7]);
  near.poll(T0 + 35 * MIN, []); near.poll(T0 + 40 * MIN, []);
  run(near, T0 + 45 * MIN, T0 + 90 * MIN, [7]);
  near.poll(T0 + 95 * MIN, []);
  assert.equal(near.spans().length, 1);

  const far = world('xbox');
  far.sync([item(1000, T0 - 5 * DAY)], T0 - DAY);
  run(far, T0, T0 + 30 * MIN, [7]);
  for (const m of [35, 40, 45, 50]) far.poll(T0 + m * MIN, []);
  run(far, T0 + 55 * MIN, T0 + 90 * MIN, [7]);
  far.poll(T0 + 95 * MIN, []);
  assert.equal(far.spans().length, 2, 'a break of twenty minutes is a break');
  far.sync([item(1070, T0 + 95 * MIN)], T0 + 105 * MIN);
  assert.equal(far.plays().length, 2);
});

test('Xbox: another game played in between keeps them apart', () => {
  const w = world('xbox');
  w.sync([item(1000, T0 - 5 * DAY), item(500, T0 - 5 * DAY, 8)], T0 - DAY);
  run(w, T0, T0 + 30 * MIN, [7]);
  w.poll(T0 + 35 * MIN, [8]);                  // five minutes of another game
  run(w, T0 + 40 * MIN, T0 + 70 * MIN, [7]);
  w.poll(T0 + 75 * MIN, []);
  const of7 = w.spans().filter((s) => s.ext_id === '7');
  assert.equal(of7.length, 2, 'the first sitting ended when the other game began');
});

test('Xbox: a sync that ran while the game was out of sight does not split the session either', () => {
  const w = world('xbox');
  w.sync([item(1000, T0 - 5 * DAY)], T0 - DAY);
  run(w, T0, T0 + 60 * MIN, [7]);
  w.poll(T0 + 65 * MIN, []);
  // the sync a session's end schedules, running before the game is seen again: 62 minutes so far
  w.sync([item(1062, T0 + 62 * MIN)], T0 + 68 * MIN);
  assert.equal(w.plays().length, 1);
  run(w, T0 + 70 * MIN, T0 + 120 * MIN, [7]);
  w.poll(T0 + 125 * MIN, []);
  w.sync([item(1124, T0 + 122 * MIN)], T0 + 135 * MIN);
  const plays = w.plays();
  assert.equal(plays.length, 1, 'the session reported over two syncs stays one');
  assert.equal(plays[0].minutes, 124);
  assert.equal(w.spans().length, 1);
});

test('Steam: leaving and coming back are two plays (its total is written when the game closes)', () => {
  const w = world('steam');
  w.sync([{ ...item(1000, T0 - 5 * DAY), recentMin: 0 }], T0 - DAY);
  for (let t = T0; t <= T0 + 30 * MIN; t += 2 * MIN) w.poll(t, [7], 120);
  w.poll(T0 + 32 * MIN, [], 120);
  for (let t = T0 + 34 * MIN; t <= T0 + 60 * MIN; t += 2 * MIN) w.poll(t, [7], 120);
  w.poll(T0 + 62 * MIN, [], 120);
  assert.equal(w.spans().length, 2);
  assert.ok(!w.lines.some((l) => /is back in/.test(l)));
});

// ---- the one-time repair of sittings recorded as several sessions before this
import { joinSittings } from '../src/services/sync.js';
import { flushRollups } from '../src/services/rollup.js';

/** A library with sessions as the old version recorded them: [entry ext id, start minute, end minute, minutes, source?, confidence?]. */
function recorded(platform, sessions) {
  const w = world(platform);
  w.sync([item(1000, T0 - 5 * DAY), item(500, T0 - 5 * DAY, 8)], T0 - DAY);
  const entry = (id) => w.db.prepare('SELECT id FROM entries WHERE ext_id = ?').get(String(id)).id;
  const ins = w.db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, confidence, created_at) VALUES (?, ?, 'play', ?, ?, ?, ?, ?, ?, ?)");
  for (const [id, a, b, m, source = 'sync', confidence = 'exact'] of sessions) {
    ins.run(entry(id), source, m, T0 + a * MIN, T0 + b * MIN, T0 + a * MIN, T0 + b * MIN, confidence, T0);
    w.db.prepare('UPDATE entries SET playtime_min = playtime_min + ? WHERE id = ?').run(m, entry(id));
  }
  const account = () => parseAccount(w.db.prepare('SELECT * FROM accounts').get());
  const totals = () => Object.fromEntries(w.db.prepare("SELECT e.ext_id, e.playtime_min p, (SELECT SUM(minutes) FROM sessions s WHERE s.entry_id = e.id AND s.kind = 'play') m FROM entries e").all().map((r) => [r.ext_id, [r.p, r.m]]));
  flushRollups(w.db);
  const dayMinutes = () => Math.round(w.db.prepare('SELECT COALESCE(SUM(minutes), 0) m FROM play_days WHERE estimated = 0').get().m);
  return { ...w, account, totals, dayMinutes };
}

test('repair: the evening recorded as two sessions with a hole of five minutes becomes one; totals and days stay what they were', () => {
  // 12:44-14:24 and 14:29-16:09, 108 minutes each
  const w = recorded('xbox', [[7, 0, 100, 108], [7, 105, 205, 108]]);
  const before = { totals: w.totals(), days: w.dayMinutes() };
  assert.equal(joinSittings(w.db, w.account()), 1);
  const plays = w.plays();
  assert.equal(plays.length, 1);
  assert.deepEqual([plays[0].minutes, plays[0].started_at, plays[0].ended_at], [216, T0, T0 + 205 * MIN]);
  assert.deepEqual(w.totals(), before.totals, 'every total is what it was');
  assert.equal(w.dayMinutes(), before.days, 'the days hold the same minutes');
  assert.equal(joinSittings(w.db, w.account()), 0, 'nothing left to join');
});

test('repair: three in a row become one; a break of twenty minutes, another game between, and sessions that are not exact stay apart', () => {
  const w = recorded('xbox', [
    [7, 0, 5, 5], [7, 15, 55, 40], [7, 60, 115, 55], // 5 + 40 + 55, ten and five minutes apart: one sitting
    [7, 135, 160, 25],                                // twenty minutes later: another
    [7, 300, 330, 30], [8, 332, 340, 8], [7, 342, 370, 28], // another game between
    [7, 500, 530, 30, 'sync', 'pinned'], [7, 535, 560, 25], // an estimated one is not folded
    [7, 700, 730, 30, 'manual'], [7, 733, 760, 27],          // nor one logged by hand
  ]);
  const before = w.totals();
  assert.equal(joinSittings(w.db, w.account()), 2);
  const of7 = w.plays().filter((s) => s.minutes !== 8).map((s) => [(s.started_at - T0) / MIN, (s.ended_at - T0) / MIN, s.minutes]);
  assert.deepEqual(of7, [[0, 115, 100], [135, 160, 25], [300, 330, 30], [342, 370, 28], [500, 530, 30], [535, 560, 25], [700, 730, 30], [733, 760, 27]]);
  assert.deepEqual(w.totals(), before);
});

test('repair: presence spans of a folded session point at the one it joined', () => {
  const w = recorded('xbox', [[7, 0, 100, 108], [7, 105, 205, 108]]);
  const [a, b] = w.plays();
  const span = w.db.prepare('INSERT INTO presence(account_id, ext_id, title, started_at, last_seen_at, ended_at, session_id) VALUES (1, ?, ?, ?, ?, ?, ?)');
  span.run('7', 'Game 7', a.started_at, a.ended_at, a.ended_at, a.id);
  span.run('7', 'Game 7', b.started_at, b.ended_at, b.ended_at, b.id);
  joinSittings(w.db, w.account());
  assert.deepEqual(w.spans().map((s) => s.session_id), [a.id, a.id]);
});

test('repair: Steam is left alone (leaving and coming back are two plays there)', () => {
  const w = recorded('steam', [[7, 0, 100, 108], [7, 105, 205, 108]]);
  assert.equal(joinSittings(w.db, w.account()), 0);
  assert.equal(w.plays().length, 2);
});

test('repair: runs once, with the next sync of the account, and says what it joined', async () => {
  const { createApp } = await import('../src/server.js');
  const lines = [];
  const log = { info: (m) => lines.push(String(m)), warn() {}, error() {}, debug() {} };
  const { app, close } = createApp({ dbFile: ':memory:', password: '', scheduler: false, log });
  try {
    const { db, sync } = app;
    const acc = Number(db.prepare("INSERT INTO accounts(platform, name, config, created_at) VALUES ('custom', 'Deck', '{}', 0)").run().lastInsertRowid);
    await sync.report(acc, [{ extId: '7', title: 'Game 7', playtimeMin: 1000 }]);
    // (that first report already marked the account: mark it as an account of an earlier version)
    db.prepare("UPDATE accounts SET state = json_remove(state, '$.sittings_joined') WHERE id = ?").run(acc);
    const entry = db.prepare('SELECT id FROM entries WHERE account_id = ?').get(acc).id;
    const ins = db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, confidence, created_at) VALUES (?, 'sync', 'play', 60, ?, ?, ?, ?, 'exact', 0)");
    ins.run(entry, T0, T0 + 60 * MIN, T0, T0 + 60 * MIN);
    ins.run(entry, T0 + 65 * MIN, T0 + 125 * MIN, T0 + 65 * MIN, T0 + 125 * MIN);
    db.prepare('UPDATE entries SET playtime_min = playtime_min + 120 WHERE id = ?').run(entry);
    const plays = () => db.prepare("SELECT minutes FROM sessions WHERE entry_id = ? AND kind = 'play'").all(entry).map((r) => r.minutes);
    await sync.report(acc, [{ extId: '7', title: 'Game 7', playtimeMin: 1120 }]);
    assert.deepEqual(plays(), [120]);
    assert.ok(lines.some((l) => /1 session joined to the sitting/.test(l)), lines.join('\n'));
    assert.equal(JSON.parse(db.prepare('SELECT state FROM accounts WHERE id = ?').get(acc).state).sittings_joined, 1);
    // done: sessions that close together later are not touched again
    ins.run(entry, T0 + DAY, T0 + DAY + 30 * MIN, T0 + DAY, T0 + DAY + 30 * MIN);
    ins.run(entry, T0 + DAY + 33 * MIN, T0 + DAY + 60 * MIN, T0 + DAY + 33 * MIN, T0 + DAY + 60 * MIN);
    db.prepare('UPDATE entries SET playtime_min = playtime_min + 120 WHERE id = ?').run(entry);
    await sync.report(acc, [{ extId: '7', title: 'Game 7', playtimeMin: 1240 }]);
    assert.equal(plays().length, 3);
  } finally { close(); }
});
