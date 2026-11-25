// Insights, edge cases: what the records say when the range is only a part of the tracked play.
//
// Sessions are logged through the API at local wall-clock times, so the file passes in any timezone.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clock, local, startApp, guardNetwork, restoreNetwork, addGame, logSession } from './suite/helpers/sessions-stats-harness.js';

// Wednesday 2026-03-18 15:00 local
const NOW = local(2026, 3, 18, 15);

describe('records: the first tracked session of a range', () => {
  let h; let old; let fresh;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    old = await addGame(h, 'Old Faithful');
    fresh = await addGame(h, 'Fresh Start');
    await logSession(h, old, local(2025, 6, 10, 20), 60);
    await logSession(h, old, local(2026, 2, 3, 19), 90);
    await logSession(h, fresh, local(2026, 2, 20, 19), 30);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  const first = (r) => r.highlights.find((x) => x.id === 'first_session');

  test('over all time, the first session is where tracking starts', async () => {
    const r = await h.get('/stats/records');
    assert.equal(r.first_session.day, '2025-06-10');
    assert.equal(first(r).first_ever, true);
    assert.equal(first(r).text, 'First tracked session: Old Faithful on 2025-06-10.');
  });

  test('in a range with tracked play before it, the first session is the first of the range only', async () => {
    const r = await h.get('/stats/records?range=year:2026');
    assert.equal(r.first_session.day, '2026-02-03');
    assert.equal(first(r).first_ever, false, 'a session of June 2025 came before');
    assert.equal(first(r).text, 'First tracked session in this range: Old Faithful on 2026-02-03.');
    const recent = await h.get('/stats/records?range=30d');
    assert.deepEqual([recent.first_session.day, first(recent).first_ever], ['2026-02-20', false]);
  });

  test('a range that holds the very first session still starts the trail', async () => {
    const r = await h.get('/stats/records?range=year:2025');
    assert.deepEqual([r.first_session.day, first(r).first_ever], ['2025-06-10', true]);
  });

  test('earlier play of other games does not count against a game filter', async () => {
    const r = await h.get(`/stats/records?range=year:2026&game_id=${fresh}`);
    assert.deepEqual([r.first_session.day, first(r).first_ever], ['2026-02-20', true]);
    const o = await h.get(`/stats/records?range=year:2026&game_id=${old}`);
    assert.deepEqual([o.first_session.day, first(o).first_ever], ['2026-02-03', false]);
  });
});
