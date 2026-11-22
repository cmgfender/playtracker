// Edges of the API: values a script can send by mistake (a timestamp where minutes belong, an
// object where text belongs, "false" for a boolean, a time in the future) are refused with a 400
// that says what is wrong - never stored, and never a 500 quoting the database.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, guardNetwork, restoreNetwork, addGame, logSession, report, HOUR, DAY } from './suite/helpers/sessions-stats-harness.js';

describe('API edges: lifetime totals', () => {
  let h; let acc; let game; let entry;
  before(async () => {
    guardNetwork();
    h = await startApp();
    acc = await h.post('/accounts', { platform: 'custom', name: 'push', config: {} });
    await report(h, acc.id, [{ id: 'old', title: 'Old Favourite', playtime_minutes: 3000 }]);
    game = await addGame(h, 'Manual');
    await logSession(h, game, Date.now() - 3 * DAY, 60);
    entry = h.db.prepare('SELECT id FROM entries WHERE game_id = ?').get(game).id;
  });
  after(async () => { await h?.close(); restoreNetwork(); });

  test('a total no lifetime could hold is refused, and the library still loads', async () => {
    // 1e17 minutes fits the database but not a JavaScript number: once stored, every page reading the entry failed
    for (const total of [1e17, 1e15, 100 * 366 * 1440 + 1]) {
      const r = await h.call('POST', `/entries/${entry}/playtime`, { playtime_minutes: total });
      assert.equal(r.status, 400, `playtime_minutes ${total}`);
      assert.match(r.body.error, /hundred years/);
    }
    for (const g of [{ playtime_minutes: 1e17 }, { playtime_minutes: 1e300 }, { playtime_hours: 1e16 }, { playtime_hours: 100 * 366 * 24 + 1 }]) {
      const r = await h.call('POST', `/accounts/${acc.id}/report`, { games: [{ id: 'old', title: 'Old Favourite', ...g }] });
      assert.equal(r.status, 400, JSON.stringify(g));
      assert.match(r.body.error, /games\[0\]\.playtime_(minutes|hours) cannot be more than/);
    }
    const lib = await h.get('/games');
    assert.equal(lib.total_minutes, 3060, 'nothing was added');
    assert.equal((await h.get('/summary')).lifetime.total_minutes, 3060);
    assert.equal((await h.get(`/games/${game}`)).minutes, 60);
  });

  test('a large but possible total is still taken', async () => {
    assert.equal((await h.post(`/entries/${entry}/playtime`, { playtime_minutes: 60 + 600 })).delta, 600);
    await report(h, acc.id, [{ id: 'old', title: 'Old Favourite', playtime_hours: 20000 }]);
    assert.equal((await h.get('/games?sort=playtime')).items[0].minutes, 20000 * 60);
  });
});
