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

describe('API edges: session times', () => {
  let h; let game; let session;
  before(async () => {
    guardNetwork();
    h = await startApp();
    game = await addGame(h, 'Manual');
    session = await logSession(h, game, Date.now() - 3 * DAY, 60);
  });
  after(async () => { await h?.close(); restoreNetwork(); });

  test('an edit cannot move a session into the future, as logging one cannot', async () => {
    const future = Date.now() + 30 * DAY;
    assert.equal((await h.call('POST', '/sessions', { game_id: game, minutes: 30, ended_at: future })).status, 400);
    for (const body of [{ ended_at: future }, { started_at: future - HOUR, ended_at: future }, { started_at: future, ended_at: null }, { ended_at: '2999-01-01' }]) {
      const r = await h.call('PATCH', `/sessions/${session.id}`, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status}`);
      assert.equal(r.body.error, 'A session cannot end in the future');
    }
    const s = await h.get(`/sessions/${session.id}`);
    assert.deepEqual([s.started_at, s.ended_at], [session.started_at, session.ended_at], 'unchanged');
    assert.equal((await h.get('/stats?range=7d')).total_minutes, 60, 'still counted on its own day');
  });

  test('moving it within the past, or to a moment ago, is still fine', async () => {
    const end = Date.now() - HOUR;
    const s = await h.patch(`/sessions/${session.id}`, { started_at: end - HOUR, ended_at: end });
    assert.deepEqual([s.started_at, s.ended_at], [end - HOUR, end]);
    // a client echoing the session back with a new note changes no times and is not checked against the clock
    assert.equal((await h.patch(`/sessions/${session.id}`, { started_at: s.started_at, ended_at: s.ended_at, note: 'x' })).note, 'x');
  });
});

describe('API edges: accounts', () => {
  let h; let acc;
  before(async () => {
    guardNetwork();
    h = await startApp();
    acc = await h.post('/accounts', { platform: 'custom', name: 'push', config: { note: 'kept' } });
  });
  after(async () => { await h?.close(); restoreNetwork(); });

  test('"false" and "0" turn an account off, as they turn every other flag off', async () => {
    for (const off of ['false', '0', 0, false]) {
      await h.patch(`/accounts/${acc.id}`, { enabled: true });
      assert.equal((await h.patch(`/accounts/${acc.id}`, { enabled: off })).enabled, false, `enabled: ${JSON.stringify(off)}`);
    }
    for (const on of ['true', '1', 1, true]) assert.equal((await h.patch(`/accounts/${acc.id}`, { enabled: on })).enabled, true, `enabled: ${JSON.stringify(on)}`);
    assert.equal((await h.post('/accounts', { platform: 'custom', name: 'off', config: {}, enabled: 'false' })).enabled, false);
    assert.equal((await h.post('/accounts', { platform: 'custom', name: 'on', config: {} })).enabled, true, 'on unless said otherwise');
    const r = await h.call('PATCH', `/accounts/${acc.id}`, { enabled: 'nope' });
    assert.deepEqual([r.status, r.body.error], [400, 'enabled must be true or false']);
    assert.equal((await h.get('/accounts')).find((a) => a.id === acc.id).enabled, true, 'unchanged by the refusal');
  });

  test('a config or schedule that is not an object is refused, not stored letter by letter', async () => {
    for (const [method, path, body, field] of [
      ['PATCH', `/accounts/${acc.id}`, { config: 'abc' }, 'config'],
      ['PATCH', `/accounts/${acc.id}`, { config: [1, 2] }, 'config'],
      ['PATCH', `/accounts/${acc.id}`, { schedule: 'daily' }, 'schedule'],
      ['POST', '/accounts', { platform: 'custom', config: 'x' }, 'config'],
      ['POST', '/accounts', { platform: 'custom', config: {}, schedule: 'daily' }, 'schedule'],
      ['POST', '/accounts/test', { platform: 'custom', config: 5 }, 'config'],
    ]) {
      const r = await h.call(method, path, body);
      assert.deepEqual([r.status, r.body.error], [400, `${field} must be an object`], `${method} ${path} ${JSON.stringify(body)}`);
    }
    const a = (await h.get('/accounts')).find((x) => x.id === acc.id);
    assert.deepEqual([a.config, a.schedule], [{ note: 'kept' }, null]);
    // an object still is taken, and null still clears a schedule override
    assert.deepEqual((await h.patch(`/accounts/${acc.id}`, { config: { note: 'new' }, schedule: { schedule_mode: 'off' } })).schedule, { schedule_mode: 'off' });
    assert.equal((await h.patch(`/accounts/${acc.id}`, { schedule: null })).schedule, null);
  });
});
