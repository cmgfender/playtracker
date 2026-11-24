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
