// Played with no time on record: an older console (Xbox 360) reports unlocks and a last played date
// for a game and no playtime. Such a game is played, wherever the app says what you have played:
// its series, your legends, the milestones and what to play next.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clock, local, startApp, guardNetwork, restoreNetwork, addGame, logSession } from './suite/helpers/sessions-stats-harness.js';

const NOW = local(2026, 3, 18, 15);

describe('games played with no time on record', () => {
  let h; const id = {};
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    const { db } = h;
    const acc = Number(db.prepare("INSERT INTO accounts(platform, name, enabled, created_at) VALUES ('xbox', 'Xbox', 0, 0)").run().lastInsertRowid);
    const game = db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, ?, ?)');
    const entry = db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, last_played_at) VALUES (?, ?, 'xbox', ?, ?, 0, ?, ?)");
    const ach = db.prepare('INSERT INTO achievements(entry_id, ach_id, name, unlocked, unlocked_at, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)');
    const added = local(2025, 1, 1);
    // IGDB's year tells the 2007 game from the collection that holds it
    const meta = db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, name, release_date, fetched_at) VALUES (?, ?, 'title', ?, ?, 0)");
    const xbox = (title, year, lastPlayed, unlocks = []) => {
      const g = Number(game.run(title, title.toLowerCase(), added, added).lastInsertRowid);
      meta.run(g, year, title, Date.UTC(year, 5, 1));
      const e = Number(entry.run(acc, g, title, title, added, lastPlayed).lastInsertRowid);
      unlocks.forEach((at, i) => ach.run(e, `a${i}`, `Unlock ${i}`, at ? 1 : 0, at || null));
      return g;
    };
    // unlocks and a last played date; a last played date alone; never launched
    id.me1 = xbox('Mass Effect', 2007, local(2012, 4, 2), [local(2012, 3, 1), local(2012, 4, 2), 0]);
    id.me2 = xbox('Mass Effect 2', 2010, local(2013, 6, 1));
    id.me3 = xbox('Mass Effect 3', 2012, null, [0, 0]);
    id.mea = await addGame(h, 'Mass Effect: Andromeda');
    meta.run(id.mea, 2017, 'Mass Effect: Andromeda', Date.UTC(2017, 2, 21));
    await logSession(h, id.mea, local(2026, 2, 1, 20), 120);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('its series: played, not merely owned', async () => {
    const f = await h.get('/franchises/mass-effect');
    const state = Object.fromEntries(f.items.map((it) => [it.title, it.state]));
    assert.equal(state['Mass Effect'], 'played');
    assert.equal(state['Mass Effect 2'], 'played');
    assert.equal(state['Mass Effect 3'], 'owned');
    assert.equal(f.played, 3);
    assert.equal(f.mainline.played, 3);
  });

  test('your legends: the career and the platform count it', async () => {
    const l = await h.get('/legends');
    assert.equal(l.career.played, 3);
    const xbox = l.platforms.find((p) => p.id === 'xbox');
    assert.deepEqual([xbox.games, xbox.played], [3, 2]);
    const story = await h.get('/legends/platform/xbox');
    assert.equal(story.totals.played, 2);
  });

  test('milestones: a game with only a last played date counts, without a day', async () => {
    const m = await h.get('/stats/milestones');
    assert.equal(m.coming.find((x) => x.kind === 'games').current, 3);
  });

  test('what to play next: not new to you, and never "Never played"', async () => {
    const fresh = await h.get('/suggest?mode=new&count=10');
    assert.deepEqual(fresh.picks.filter((p) => p.mode_match).map((p) => p.title), ['Mass Effect 3']);
    assert.match(fresh.picks[0].reasons[0].text, /^Never played/);
    const all = await h.get('/suggest?count=10');
    for (const p of all.picks) if (p.game_id !== id.me3) assert.ok(!p.reasons.some((r) => /Never played|In your library for/.test(r.text)), `${p.title}: ${p.reasons.map((r) => r.text).join(' / ')}`);
    const me2 = all.picks.find((p) => p.game_id === id.me2);
    if (me2) assert.ok(me2.reasons.some((r) => /Last played .* ago, no time on record/.test(r.text)), me2.reasons.map((r) => r.text).join(' / '));
  });
});
