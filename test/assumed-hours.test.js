// Assumed hours (services/assumed.js): with the setting on, a game a platform reports achievements
// for and no playtime (Xbox 360, PS3) gets hours of its own - IGDB's typical time x the share of
// its achievements unlocked, dated by the unlocks - as an entry beside the platform's, told apart
// as 'assumed' everywhere. Off (the default) leaves nothing behind.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { assume, MAX_TYPICAL } from '../src/services/assumed.js';
import { clock, local, startApp, guardNetwork, restoreNetwork, addGame, logSession, assertInvariants } from './suite/helpers/sessions-stats-harness.js';

const NOW = local(2026, 3, 18, 15);

describe('the hours assumed for one game', () => {
  test('typical time x the share of achievements, from the longest time IGDB knows', () => {
    assert.deepEqual(assume({ unlocked: 36, total: 65, ttb_main: 1500, ttb_extra: 2400, ttb_complete: 3600 }), { minutes: 1995, typical_minutes: 3600, typical: 'complete', share: 0.554, floor: false });
    assert.equal(assume({ unlocked: 10, total: 40, ttb_main: 600, ttb_extra: 1200 }).typical, 'extra');
    assert.equal(assume({ unlocked: 10, total: 40, ttb_main: 600 }).minutes, 150);
  });
  test('nothing without unlocks or a typical time; a finished game is at least its main story; no endless game', () => {
    assert.equal(assume({ unlocked: 0, total: 40, ttb_main: 600 }), null);
    assert.equal(assume({ unlocked: 5, total: 40 }), null);
    assert.deepEqual(assume({ unlocked: 4, total: 40, ttb_main: 600, ttb_complete: 2000, finished: true }), { minutes: 600, typical_minutes: 2000, typical: 'complete', share: 0.1, floor: true });
    assert.equal(assume({ unlocked: 40, total: 40, ttb_complete: 751457 }).minutes, MAX_TYPICAL);
    assert.equal(assume({ unlocked: 1, total: 1000, ttb_main: 600 }).minutes, 15, 'never less than a quarter of an hour');
  });
});

describe('assumed hours in a library', () => {
  let h; const id = {}; const entry = {};
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    const { db } = h;
    const acc = Number(db.prepare("INSERT INTO accounts(platform, name, enabled, created_at) VALUES ('xbox', 'Xbox', 0, 0)").run().lastInsertRowid);
    const game = db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, ?, ?)');
    const ins = db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, last_played_at) VALUES (?, ?, 'xbox', ?, ?, ?, ?, ?)");
    const ach = db.prepare('INSERT INTO achievements(entry_id, ach_id, name, unlocked, unlocked_at, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)');
    const meta = db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, name, release_date, ttb_main, ttb_extra, ttb_complete, fetched_at) VALUES (?, ?, 'title', ?, ?, ?, ?, ?, 1)");
    const seen = local(2026, 1, 1);
    const xbox = (key, title, { minutes = 0, last = null, unlocked = 0, total = 0, days = [], ttb = null } = {}) => {
      const g = Number(game.run(title, title.toLowerCase(), seen, seen).lastInsertRowid);
      const e = Number(ins.run(acc, g, key, title, minutes, seen, last).lastInsertRowid);
      for (let i = 0; i < total; i++) ach.run(e, `a${i}`, `A${i}`, i < unlocked ? 1 : 0, i < unlocked && days.length ? days[i % days.length] : null);
      if (ttb) meta.run(g, g, title, Date.UTC(2011, 2, 8), ...ttb);
      id[key] = g; entry[key] = e;
    };
    const week = [8, 9, 10, 11, 12, 13, 14].map((d) => local(2011, 3, d, 21));
    // an Xbox 360 game: unlocks over a week, last played at its end, no time
    xbox('da2', 'Dragon Age 2', { last: local(2011, 3, 14, 23), unlocked: 36, total: 65, days: week, ttb: [1500, 2400, 3600] });
    // unlocks, and no typical time on IGDB; real time from the platform; never launched
    xbox('odd', 'Obscure Arcade Game', { last: local(2012, 1, 1), unlocked: 3, total: 12 });
    xbox('real', 'Timed Game', { minutes: 0, last: local(2020, 1, 1), unlocked: 0, total: 10, ttb: [600, 900, 1200] });
    xbox('hand', 'Game With My Own Hours', { last: local(2013, 5, 1), unlocked: 5, total: 10, days: [local(2013, 4, 20, 20)], ttb: [600, 900, 1200] });
    await h.post('/games', { title: 'Game With My Own Hours', history: { minutes: 300 } });
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  const assumedEntries = () => h.db.prepare("SELECT * FROM entries WHERE account_id IS NULL AND ext_id LIKE 'assumed:%' ORDER BY id").all();

  test('off by default: nothing is assumed, and the summary says what on would add', async () => {
    assert.equal((await h.get('/settings')).assumed_hours, false);
    assert.deepEqual(assumedEntries(), []);
    const a = await h.get('/history/assumed');
    assert.deepEqual([a.enabled, a.games, a.minutes, a.no_typical, a.counted_games, a.counted_minutes], [false, 1, 1995, 1, 0, 0]);
    assert.deepEqual(a.by_platform, [{ platform: 'xbox', games: 1, minutes: 1995 }]);
    assert.equal((await h.get('/stats/lifetime')).assumed_minutes, 0);
  });

  test('on: an entry of its own beside the platform\'s, dated by the unlocks, and told apart everywhere', async () => {
    await h.put('/settings', { assumed_hours: true });
    const es = assumedEntries();
    assert.deepEqual(es.map((e) => [e.game_id, e.platform, e.ext_id, e.playtime_min, e.baseline_min]), [[id.da2, 'xbox', `assumed:${entry.da2}`, 1995, 1995]]);
    assert.deepEqual(JSON.parse(es[0].meta).assumed, { source_entry: entry.da2, unlocked: 36, total: 65, minutes: 1995, typical_minutes: 3600, typical: 'complete', share: 0.554, floor: false });
    // what the platform reported is untouched
    assert.equal(h.db.prepare('SELECT playtime_min FROM entries WHERE id = ?').get(entry.da2).playtime_min, 0);
    // every minute is history of basis 'assumed', inside the week of the unlocks
    const rows = h.db.prepare('SELECT kind, basis, minutes, window_start, window_end FROM sessions WHERE entry_id = ?').all(es[0].id);
    assert.ok(rows.length && rows.every((s) => s.kind === 'estimate' && s.basis === 'assumed'), JSON.stringify(rows));
    assert.equal(rows.reduce((a, s) => a + s.minutes, 0), 1995);
    assert.ok(rows.every((s) => s.window_start >= local(2011, 3, 8) && s.window_end <= local(2011, 3, 15, 23, 59)), 'dated to the week of the unlocks');
    assert.deepEqual(h.db.prepare('SELECT DISTINCT basis, estimated FROM play_days WHERE entry_id = ?').all(es[0].id).map((r) => ({ ...r })), [{ basis: 5, estimated: 1 }]);
    assertInvariants(h);
    const g = await h.get(`/games/${id.da2}`);
    assert.equal(g.minutes, 1995);
    assert.ok(g.entries.some((e) => e.meta.assumed?.source_entry === entry.da2), 'the game says how its hours were worked out');
    const stats = await h.get('/stats?range=all');
    assert.equal(stats.minutes_by_basis.assumed, 1995);
    assert.equal(stats.minutes_by_basis.estimated + stats.minutes_by_basis.anchored, 300 - (await h.get('/stats/lifetime')).baseline_minutes, 'history that is not assumed keeps its own kinds');
    assert.equal(stats.sessions, 0, 'no session, no streak: history');
    const life = await h.get('/stats/lifetime');
    assert.deepEqual([life.assumed_minutes, life.assumed_games, life.total_minutes], [1995, 1, 2295]);
    const a = await h.get('/history/assumed');
    assert.deepEqual([a.enabled, a.counted_games, a.counted_minutes], [true, 1, 1995]);
  });

  test('not a double count, not exported, kept in step: real time from the platform or the setting off takes it away', async () => {
    assert.equal((await h.get('/duplicates')).counts.double_counted, 0);
    const exp = await h.get('/export');
    assert.ok(!JSON.stringify(exp).includes('assumed'), 'an export holds what was reported and entered');
    // "Looks right" keeps the hours assumed
    const e = assumedEntries()[0];
    await h.patch(`/entries/${e.id}/history`, { confirm: true });
    assert.deepEqual(h.db.prepare('SELECT DISTINCT basis FROM sessions WHERE entry_id = ?').all(e.id).map((r) => r.basis), ['assumed']);
    // the dates you set stay when it is worked out again
    h.db.prepare('UPDATE game_meta SET ttb_complete = 3000 WHERE game_id = ?').run(id.da2);
    h.inst.app.sync.assume();
    assert.equal(assumedEntries()[0].playtime_min, 1660);
    assertInvariants(h);
    // the platform reports time after all
    h.db.prepare('UPDATE entries SET playtime_min = 90 WHERE id = ?').run(entry.da2);
    h.db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, started_at, ended_at, created_at) VALUES (?, 'sync', 'play', 90, ?, ?, ?)").run(entry.da2, NOW - 90 * 60000, NOW, NOW);
    h.inst.app.sync.assume();
    assert.deepEqual(assumedEntries(), []);
    h.db.prepare('DELETE FROM sessions WHERE entry_id = ?').run(entry.da2);
    h.db.prepare('UPDATE entries SET playtime_min = 0 WHERE id = ?').run(entry.da2);
    h.inst.app.sync.assume();
    assert.equal(assumedEntries().length, 1);
    await h.put('/settings', { assumed_hours: false });
    assert.deepEqual(assumedEntries(), []);
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sessions WHERE basis = 'assumed'").get().n, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM play_days WHERE basis = 5').get().n, 0);
    assertInvariants(h);
    assert.equal((await h.get('/stats/lifetime')).total_minutes, 300);
  });
});
