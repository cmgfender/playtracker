// What history rests on, kept apart all the way to the charts: estimates with an achievement
// unlock inside them (anchored), estimates you confirmed or dated yourself (confirmed), other
// estimates, imported exact sessions and play tracked live - on sessions, in the rollup
// (play_days.basis), in /stats and a game's curve. Totals are unchanged by any of it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { inferHistory } from '../src/services/inference.js';
import { flushRollups } from '../src/services/rollup.js';

const DAY = 86_400_000;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('inferHistory: chunks with an unlock inside are anchored; dates you set make them confirmed', () => {
  const T = Date.UTC(2026, 5, 1);
  const anchors = [T - 40 * DAY, T - 38 * DAY];
  const r = inferHistory({ minutes: 1200, trackingStart: T, firstPlayedAt: T - 60 * DAY, lastPlayedAt: T - 20 * DAY, anchors });
  const placed = r.chunks.reduce((a, c) => a + c.minutes, 0) + r.undated;
  assert.equal(placed, 1200);
  const anchored = r.chunks.filter((c) => c.basis === 'anchored');
  assert.ok(anchored.length >= 1, 'a chunk holds the unlocks');
  for (const c of anchored) assert.ok(anchors.some((a) => a >= c.start && a <= c.end));
  for (const c of r.chunks.filter((x) => x.basis !== 'anchored')) assert.ok(!anchors.some((a) => a >= c.start && a <= c.end));
  const mine = inferHistory({ minutes: 600, trackingStart: T, manual: { start: T - 30 * DAY, end: T - 10 * DAY } });
  assert.ok(mine.chunks.length && mine.chunks.every((c) => c.basis === 'confirmed'));
});

describe('through the API', () => {
  let srv; let close; let base; let app;
  const get = async (p) => (await fetch(base + p)).json();
  const send = async (p, method, body) => (await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  before(async () => {
    ({ server: srv, close, app } = createApp({ dbFile: ':memory:', password: '', scheduler: false, log: quiet }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}/api/v1`;
  });
  after(() => close());

  test('imported sessions, confirmed and plain estimates are told apart; totals stay the same', async () => {
    const day = (n) => new Date(Date.now() - n * DAY).toISOString();
    // an import with exact past sessions (and the rest of its total as history), and one with history only
    await send('/import', 'POST', { games: [
      { title: 'Celeste', platform: 'switch', playtime_minutes: 600, last_played: day(40), sessions: [{ started_at: day(60), minutes: 90 }, { started_at: day(55), minutes: 60 }] },
      { title: 'Hades', platform: 'switch', playtime_minutes: 900, last_played: day(80), first_played: day(200) },
    ] });
    const before = await get('/stats?range=all');
    assert.equal(before.minutes_by_basis.imported, 150);
    assert.equal(before.minutes_by_basis.tracked, 0);
    assert.ok(before.minutes_by_basis.estimated > 0);
    const hades = app.db.prepare("SELECT e.id, e.game_id FROM entries e JOIN games g ON g.id = e.game_id WHERE g.title = 'Hades'").get();
    await send(`/entries/${hades.id}/history`, 'PATCH', { confirm: true });
    const after = await get('/stats?range=all');
    assert.equal(after.total_minutes, before.total_minutes, 'confirming changes no totals');
    assert.ok(after.minutes_by_basis.confirmed > 0);
    assert.equal(after.minutes_by_basis.confirmed + after.minutes_by_basis.estimated + after.minutes_by_basis.anchored, after.estimated_minutes);
    // per bucket, the parts add up to the bucket
    after.series.forEach((s, i) => assert.equal(Object.values(after.series_by_basis).reduce((a, v) => a + v[i], 0), s.minutes, s.key));
    assert.deepEqual(Object.keys(after.series_imported_by_platform), ['switch']);
    // sessions say what they rest on
    const ses = await get(`/sessions?game_id=${hades.game_id}&kind=estimate&limit=5`);
    assert.ok((ses.items || ses).every((x) => x.basis === 'confirmed'));
    const imp = await get('/sessions?limit=50');
    assert.ok((imp.items || imp).filter((x) => x.source === 'import').every((x) => x.basis === 'imported'));
    // the game's curve too
    const curve = await get(`/games/${hades.game_id}/stats`);
    assert.ok(curve.series.at(-1).cumulative_by_basis.confirmed > 0);
  });
});

test('migration 10 sorts the history of an existing database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-basis-'));
  const file = path.join(dir, 'old.db');
  // a database at schema 9: one imported session, one confirmed estimate, one plain estimate
  const db0 = openDb(file);
  const g = Number(db0.prepare("INSERT INTO games(title, norm_title, created_at, updated_at) VALUES ('X', 'x', 0, 0)").run().lastInsertRowid);
  const mk = (hist) => Number(db0.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, hist) VALUES (NULL, ?, 'manual', ?, 'X', 0, 0, ?)").run(g, `x${Math.random()}`, JSON.stringify(hist)).lastInsertRowid);
  const a = mk({}); const b = mk({ manual: { start: 1, end: 2, confirmed: true } }); const c = mk({});
  db0.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, created_at) VALUES (?, 'import', 'play', 60, ?, ?, 0)").run(a, Date.now() - 3 * DAY, Date.now() - 3 * DAY + 3600_000);
  db0.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, created_at) VALUES (?, 'inferred', 'estimate', 120, ?, ?, 0)").run(b, Date.now() - 30 * DAY, Date.now() - 29 * DAY);
  db0.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, created_at) VALUES (?, 'inferred', 'estimate', 90, ?, ?, 0)").run(c, Date.now() - 50 * DAY, Date.now() - 49 * DAY);
  flushRollups(db0);
  db0.close();
  // roll it back to before migration 10, then open it again
  const raw = new DatabaseSync(file);
  raw.exec('DROP INDEX play_days_range; DROP INDEX play_days_game;');
  raw.exec('CREATE INDEX play_days_range ON play_days(excluded, estimated, day, platform, game_id, minutes, ends); CREATE INDEX play_days_game ON play_days(game_id, excluded, estimated, day, platform, minutes, ends);');
  raw.exec('UPDATE play_days SET basis = 0; UPDATE sessions SET basis = NULL; PRAGMA user_version = 9;');
  raw.exec('ALTER TABLE play_days DROP COLUMN basis; ALTER TABLE sessions DROP COLUMN basis;');
  raw.close();
  const db = openDb(file);
  const by = Object.fromEntries(db.prepare('SELECT basis, ROUND(SUM(minutes)) m FROM play_days GROUP BY basis').all().map((r) => [r.basis, r.m]));
  assert.deepEqual(by, { 1: 60, 3: 120, 4: 90 });
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'play_days_range'").get().sql, /basis/);
  db.close();
});

test('migration 10 marks history exactly as re-dating by v6 would, so nothing is re-dated on upgrade', async () => {
  const { importRows } = await import('../src/services/importer.js');
  const { reinferPending, mergeEvidence, reinferMany, INFER_VERSION } = await import('../src/services/inference.js');
  const { Settings } = await import('../src/services/settings.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-basis-'));
  const file = path.join(dir, 'lib.db');
  const db0 = openDb(file);
  const settings = new Settings(db0);
  const now = Date.now();
  const day = (n) => new Date(now - n * DAY).toISOString();
  importRows(db0, Array.from({ length: 12 }, (_, i) => ({ title: `Game ${i}`, platform: 'switch', playtime_minutes: 300 + i * 97, first_played: day(400 - i * 20), last_played: day(60 + i * 5) })), { settings: settings.all(), now });
  const ids = db0.prepare('SELECT id FROM entries ORDER BY id').all().map((r) => r.id);
  // unlock times on some, a confirmed estimate and dates set by hand on others
  for (const id of ids.slice(0, 5)) mergeEvidence(db0, id, { anchors: [now - (300 - id * 7) * DAY, now - (250 - id * 5) * DAY, now - (120 - id) * DAY] });
  reinferMany(db0, ids.slice(0, 5), { settings: settings.all() });
  const h = (id) => JSON.parse(db0.prepare('SELECT hist FROM entries WHERE id = ?').get(id).hist);
  const setHist = (id, x) => db0.prepare('UPDATE entries SET hist = ?, inferred_v = 0 WHERE id = ?').run(JSON.stringify(x), id);
  setHist(ids[6], { ...h(ids[6]), manual: { start: now - 200 * DAY, end: now - 100 * DAY } });
  reinferPending(db0, { settings: settings.all() });
  const w = h(ids[7]).inference.window;
  setHist(ids[7], { ...h(ids[7]), manual: { start: w[0], end: w[1], confirmed: true } });
  reinferPending(db0, { settings: settings.all() });
  flushRollups(db0);
  const snap = (db) => db.prepare("SELECT id, basis FROM sessions WHERE source = 'inferred' AND kind = 'estimate' ORDER BY id").all().map((r) => `${r.id}:${r.basis}`).join(',');
  const pd = (db) => db.prepare('SELECT session_id, day, basis FROM play_days ORDER BY session_id, day').all().map((r) => `${r.session_id}/${r.day}:${r.basis}`).join(',');
  const want = snap(db0); const wantDays = pd(db0);
  assert.match(want, /anchored/); assert.match(want, /confirmed/); assert.match(want, /:null/);
  db0.close();
  // back to how the previous release left it: no basis columns, history dated by v5
  const raw = new DatabaseSync(file);
  raw.exec('DROP INDEX play_days_range; DROP INDEX play_days_game;');
  raw.exec('CREATE INDEX play_days_range ON play_days(excluded, estimated, day, platform, game_id, minutes, ends); CREATE INDEX play_days_game ON play_days(game_id, excluded, estimated, day, platform, minutes, ends);');
  raw.exec('ALTER TABLE play_days DROP COLUMN basis; ALTER TABLE sessions DROP COLUMN basis; UPDATE entries SET inferred_v = 5 WHERE baseline_min > 0; PRAGMA user_version = 9;');
  raw.close();
  const db = openDb(file);
  assert.equal(snap(db), want, 'sessions marked as re-dating would');
  assert.equal(pd(db), wantDays, 'per-day rows marked as re-dating would');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entries WHERE baseline_min > 0 AND inferred_v < ?').get(INFER_VERSION).n, 0, 'nothing left to re-date');
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'play_days_range'").get().sql, /platform, basis/);
  db.close();
});
