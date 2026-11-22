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

describe('API edges: text fields', () => {
  let h; let acc; let game; let session;
  before(async () => {
    guardNetwork();
    h = await startApp();
    acc = await h.post('/accounts', { platform: 'custom', name: 'push', config: {} });
    await report(h, acc.id, [{ id: 'old', title: 'Old Favourite', playtime_minutes: 3000 }]);
    game = await addGame(h, 'Manual');
    session = await logSession(h, game, Date.now() - 3 * DAY, 60, { note: 'first evening' });
  });
  after(async () => { await h?.close(); restoreNetwork(); });

  test('a note or a cover that is not text is a 400 naming the field, not a 500 quoting the database', async () => {
    const entry = h.db.prepare('SELECT id FROM entries WHERE game_id = ?').get(game).id;
    for (const [method, path, body, field] of [
      ['POST', '/sessions', { game_id: game, minutes: 5, note: {} }, 'note'],
      ['POST', '/sessions', { game_id: game, minutes: 5, note: 7 }, 'note'],
      ['PATCH', `/sessions/${session.id}`, { note: { text: 'x' } }, 'note'],
      ['PATCH', `/sessions/${session.id}`, { note: 5 }, 'note'],
      ['POST', `/entries/${entry}/playtime`, { playtime_minutes: 500, note: [] }, 'note'],
      ['POST', '/games', { title: 'Cover', cover_url: {} }, 'cover_url'],
      ['PATCH', `/games/${game}`, { cover_url: 5 }, 'cover_url'],
      ['PATCH', `/games/${game}`, { cover_url: ['x'] }, 'cover_url'],
    ]) {
      const r = await h.call(method, path, body);
      assert.equal(r.status, 400, `${method} ${path} ${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, `${field} must be text`);
    }
    // nothing was written on the way to the refusal
    const g = await h.get(`/games/${game}`);
    assert.deepEqual([g.minutes, g.cover_url, g.sessions.length, g.sessions[0].note], [60, null, 1, 'first evening']);
    assert.equal((await h.get('/games?q=Cover')).total, 0);
  });

  test('text is stored as it is, and an empty value clears it', async () => {
    assert.equal((await h.patch(`/sessions/${session.id}`, { note: 'second thoughts' })).note, 'second thoughts');
    assert.equal((await h.patch(`/sessions/${session.id}`, { note: '' })).note, null);
    assert.equal((await h.patch(`/games/${game}`, { cover_url: 'https://example.test/c.jpg' })).cover_url, 'https://example.test/c.jpg');
    assert.equal((await h.patch(`/games/${game}`, { cover_url: null })).cover_url, null);
  });

  test('a push client sending an object where text belongs is taken without it, not answered with a server error', async () => {
    const rep = await h.call('POST', `/accounts/${acc.id}/report`, { games: [{ id: 'q', title: { en: 'Q' }, playtime_minutes: 5, cover_url: {}, icon_url: 9 }] });
    assert.equal(rep.status, 200, JSON.stringify(rep.body));
    const q = (await h.get('/games?q=q')).items.find((x) => x.title === 'q');
    assert.ok(q, 'named by its id, never "[object Object]"');
    assert.equal(q.cover_url, null);
    const pres = await h.call('POST', `/accounts/${acc.id}/presence`, { playing: [{ id: 'old', title: {}, device: {} }, {}] });
    assert.equal(pres.status, 200, JSON.stringify(pres.body));
    assert.equal(pres.body.open, 1, 'the entry naming no game is skipped');
  });
});
