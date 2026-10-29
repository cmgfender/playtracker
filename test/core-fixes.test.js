// Tracking-core fixes from the bug scan, each as it was reproduced: merging hand-logged games with
// history, presence spans left open across an outage, PSN state written back stale, big
// multi-day deltas spilling before the previous report, an Xbox stat read while it still lags,
// an Xbox title whose stats keep failing, nested transactions on Node without isTransaction, and
// syncs left "running" by a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, tx } from '../src/db.js';
import { Settings } from '../src/services/settings.js';
import { applyItems, parseAccount, SyncService } from '../src/services/sync.js';
import { importRows } from '../src/services/importer.js';
import { mergeGames } from '../src/services/library.js';
import { reinferPending } from '../src/services/inference.js';
import { flushRollups } from '../src/services/rollup.js';
import { importGameTrack } from '../src/services/gametrack.js';
import { xbox } from '../src/providers/xbox.js';
import { ProviderError } from '../src/providers/http.js';

const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const sums = (db) => db.prepare('SELECT e.playtime_min p, (SELECT COALESCE(SUM(minutes), 0) FROM sessions s WHERE s.entry_id = e.id) s FROM entries e').all();

test('merging two hand-logged games with history keeps all of it through a re-date', () => {
  const db = openDb(':memory:');
  const settings = new Settings(db);
  const now = Date.now();
  importRows(db, [
    { title: 'Breath of the Wild', platform: 'manual', playtime_minutes: 600, last_played: new Date(now - 40 * DAY).toISOString(), sessions: [{ started_at: new Date(now - 30 * DAY).toISOString(), minutes: 60 }] },
    { title: 'Zelda BotW', platform: 'manual', playtime_minutes: 900, last_played: new Date(now - 50 * DAY).toISOString(), sessions: [{ started_at: new Date(now - 20 * DAY).toISOString(), minutes: 90 }] },
  ], { settings: settings.all(), now });
  const [a, b] = db.prepare('SELECT id FROM games ORDER BY id').all().map((g) => g.id);
  tx(db, () => mergeGames(db, a, [b]));
  flushRollups(db);
  db.prepare('UPDATE entries SET inferred_v = 0 WHERE baseline_min > 0').run();
  reinferPending(db, { settings: settings.all() });
  for (const r of sums(db)) assert.equal(r.s, r.p, 'sessions add up to the total');
  assert.equal(sums(db).reduce((t, r) => t + r.p, 0), 1500);
});

test('a presence span left open across an outage ends where it was last seen', () => {
  const db = openDb(':memory:');
  const settings = new Settings(db);
  const svc = new SyncService({ db, settings, log: quiet });
  const acc = Number(db.prepare("INSERT INTO accounts(platform, name, created_at, enabled) VALUES ('steam', 'me', 0, 0)").run().lastInsertRowid);
  const A = () => parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(acc));
  const sync = (now, total, lastPlayedAt) => tx(db, () => {
    const a = A();
    applyItems(db, a, [{ extId: '10', title: 'Hades', playtimeMin: total, recentMin: total - 100, lastPlayedAt, devices: { windows: total, offline: 0 } }], { settings: settings.all(), now, initial: !a.last_sync_at });
    db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(now, acc);
  });
  const poll = (now, playing) => { svc.applyPresence(A(), playing ? [{ extId: '10' }] : [], { intervalSec: 120, now }); svc.presenceState.set(acc, { lastPoll: now }); };
  const mon = new Date(2026, 5, 1, 20, 0).getTime();
  sync(mon - HOUR, 100, mon - 5 * DAY);
  for (let t = mon; t <= mon + 30 * MIN; t += 2 * MIN) poll(t, true); // then the server is down until Wednesday
  const wed = mon + 2 * DAY;
  sync(wed, 160, wed - 10 * MIN);
  for (let t = wed; t <= wed + 60 * MIN; t += 2 * MIN) poll(t, true);
  poll(wed + 62 * MIN, false);
  sync(wed + 64 * MIN, 230, wed - 10 * MIN);
  const spans = db.prepare('SELECT started_at, ended_at FROM presence ORDER BY started_at').all();
  assert.equal(spans.length, 2, 'two sittings, not one span over two days');
  assert.ok(spans.every((s) => s.ended_at - s.started_at < 2 * HOUR));
  const days = Object.fromEntries(db.prepare('SELECT day, SUM(minutes) m FROM play_days WHERE estimated = 0 GROUP BY day').all().map((r) => [r.day, r.m]));
  assert.equal(days['2026-06-02'], undefined, 'nothing on Tuesday');
  assert.ok(days['2026-06-01'] >= 30, 'Monday keeps its sitting');
  for (const r of sums(db)) assert.equal(r.s, r.p);
});

test('PSN enrichment leaves account state written while it ran alone', async () => {
  const db = openDb(':memory:');
  const settings = new Settings(db);
  const svc = new SyncService({ db, settings, log: quiet });
  const now = Date.now();
  const state = { access_token: 'A1', access_expires_at: now + HOUR, refresh_token: 'R1', refresh_expires_at: now + 50 * DAY, account_id: '123', calibration: { last_played: { start: 0, end: 2 } } };
  const acc = Number(db.prepare("INSERT INTO accounts(platform, name, created_at, state, last_sync_at) VALUES ('psn', 'me', 0, ?, ?)").run(JSON.stringify(state), now).lastInsertRowid);
  const g = Number(db.prepare("INSERT INTO games(title, norm_title, created_at, updated_at) VALUES ('X','x',0,0)").run().lastInsertRowid);
  db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, baseline_min, first_seen_at) VALUES (?, ?, 'psn', 'PPSA1_00', 'X', 100, 100, 0)").run(acc, g);
  const prev = globalThis.fetch;
  globalThis.fetch = async () => {
    const cur = JSON.parse(db.prepare('SELECT state FROM accounts WHERE id = ?').get(acc).state);
    db.prepare('UPDATE accounts SET state = ? WHERE id = ?').run(JSON.stringify({ ...cur, access_token: 'A2', refresh_token: 'R2', calibration: { last_played: { start: 0, end: 3 } } }), acc);
    return new Response(JSON.stringify({ titles: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { await svc.enrich(acc); } finally { globalThis.fetch = prev; }
  const after = JSON.parse(db.prepare('SELECT state FROM accounts WHERE id = ?').get(acc).state);
  assert.deepEqual([after.access_token, after.refresh_token, after.calibration.last_played.end], ['A2', 'R2', 3]);
});

test('a multi-day delta stays inside the window: the first, partial day holds only its part', () => {
  const db = openDb(':memory:');
  const settings = new Settings(db);
  const acc = Number(db.prepare("INSERT INTO accounts(platform, name, created_at) VALUES ('custom', 'me', 0)").run().lastInsertRowid);
  const run = (now, total, lp) => tx(db, () => {
    const a = parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(acc));
    applyItems(db, a, [{ extId: '1', title: 'Hades', playtimeMin: total, lastPlayedAt: lp }], { settings: settings.all(), now, initial: !a.last_sync_at });
    db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(now, acc);
  });
  const mon = new Date(2026, 5, 1, 23, 30).getTime();
  run(mon, 100, mon - HOUR);
  run(mon + 3 * DAY, 1300, mon + 3 * DAY - HOUR);
  const rows = db.prepare("SELECT minutes, window_start FROM sessions WHERE kind = 'play' AND source = 'sync'").all();
  assert.ok(rows.every((s) => s.window_start >= mon), 'nothing starts before the previous report');
  const monday = db.prepare("SELECT COALESCE(SUM(minutes), 0) m FROM play_days WHERE estimated = 0 AND day = '2026-06-01'").get().m;
  assert.ok(monday <= 30, `Monday holds ${monday} of the 30 minutes the window covers`);
  for (const r of sums(db)) assert.equal(r.s, r.p);
});

test('Xbox: a stat read within an hour of play is read again later; one that keeps failing stops holding the account', async () => {
  const end = Date.now() - 13 * MIN;
  let stat = 150;
  const calls = [];
  const ctx = (entry) => ({
    http: async (url) => {
      calls.push(url);
      if (url.endsWith('/player/titleHistory')) return { content: { xuid: '1', titles: [{ titleId: 42, name: 'Halo', type: 'Game', titleHistory: { lastTimePlayed: new Date(end).toISOString() } }] }, code: 200 };
      return { statlistscollection: [{ stats: [{ name: 'MinutesPlayed', value: String(stat) }] }] };
    },
    getEntry: () => entry, remainingBudget: () => 150,
  });
  const account = { config: { api_key: 'k' }, state: {}, last_sync_at: end - HOUR };
  let r = await xbox.fetchLibrary(account, ctx({ playtime_min: 100, last_played_at: end - DAY }));
  assert.equal(r.items[0].playtimeMin, 150);
  stat = 160;
  r = await xbox.fetchLibrary({ ...account, state: r.state }, ctx({ playtime_min: 150, last_played_at: end }));
  assert.equal(r.items[0].playtimeMin, 160, 'the lagging stat is read again');

  const lp = new Date(Date.now() - 30 * DAY).toISOString();
  const failing = {
    http: async (url) => {
      if (url.endsWith('/player/titleHistory')) return { content: { xuid: '1', titles: [{ titleId: 1, name: 'OK', type: 'Game', titleHistory: { lastTimePlayed: lp } }, { titleId: 2, name: 'Broken', type: 'Game', titleHistory: { lastTimePlayed: lp } }] } };
      if (url.includes('/stats/2')) throw new ProviderError('xbl.io responded 500', { status: 500 });
      return { stats: [{ name: 'MinutesPlayed', value: '100' }] };
    },
    getEntry: (id) => ({ playtime_min: 100, last_played_at: Date.parse(lp) - (id === '2' ? 1000 : 0) }),
    remainingBudget: () => 150,
  };
  let state = {}; const seen = [];
  for (let i = 0; i < 4; i++) { const x = await xbox.fetchLibrary({ config: { api_key: 'k' }, state, last_sync_at: Date.now() - HOUR }, failing); state = x.state; seen.push(x.complete); }
  assert.deepEqual(seen, [false, false, true, true], 'deferred twice, then its stored minutes are kept');
  assert.deepEqual(state.deferred_titles, []);
});

test('nested transactions work without db.isTransaction (Node before 22.16)', () => {
  const real = openDb(':memory:');
  const settings = new Settings(real);
  const extra = {};
  const db = new Proxy(real, { get: (t, k) => (k === 'isTransaction' ? undefined : k in extra ? extra[k] : typeof t[k] === 'function' ? t[k].bind(t) : t[k]), set: (t, k, v) => { extra[k] = v; return true; } });
  assert.doesNotThrow(() => importGameTrack(db, { games: [{ uuid: 'u1', title: 'Zelda', owned_platform: 'Nintendo Switch', hours_played: '10' }] }, { settings: settings.all() }));
});

test('syncs cut off by a restart are marked interrupted when the scheduler starts', () => {
  const db = openDb(':memory:');
  const settings = new Settings(db);
  const acc = Number(db.prepare("INSERT INTO accounts(platform, name, created_at, enabled) VALUES ('custom', 'me', 0, 0)").run().lastInsertRowid);
  db.prepare("INSERT INTO syncs(account_id, trigger, started_at, initial, status) VALUES (?, 'schedule', 1000, 0, 'running')").run(acc);
  const svc = new SyncService({ db, settings, log: quiet });
  svc.start(); svc.stop();
  assert.deepEqual({ ...db.prepare('SELECT status, error FROM syncs').get() }, { status: 'error', error: 'Interrupted by a restart' });
});
