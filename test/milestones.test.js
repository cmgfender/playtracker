// Milestones (GET /stats/milestones): the round numbers of a player's history with the day each
// was reached, and the ones coming up.
//
// Sessions are logged through the API at local wall-clock times, so the file passes in any timezone.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clock, local, startApp, guardNetwork, restoreNetwork, addGame, logSession } from './suite/helpers/sessions-stats-harness.js';
import { milestones } from '../src/services/milestones.js';

// Wednesday 2026-03-18 15:00 local
const NOW = local(2026, 3, 18, 15);

describe('milestones', () => {
  let h; let big; let side;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    big = await addGame(h, 'Big <One>');
    side = await addGame(h, 'Side');
    // Big: ten hours a day, January 1 to 12 2026 (120 hours); then two hours on each of the last three days
    for (let d = 1; d <= 12; d++) await logSession(h, big, local(2026, 1, d, 8), 600);
    for (const d of [16, 17, 18]) await logSession(h, big, local(2026, 3, d, 8), 120);
    // Side: six hours on January 3, one more on March 17
    await logSession(h, side, local(2026, 1, 3, 20), 360);
    await logSession(h, side, local(2026, 3, 17, 20), 60);
    // eight more games, a quarter of an hour each on February 1 to 8: ten games in all
    for (let i = 1; i <= 8; i++) await logSession(h, await addGame(h, `Small ${i}`), local(2026, 2, i, 12), 15);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('each round number with the day it was reached, newest first', async () => {
    const m = await h.get('/stats/milestones');
    assert.equal(m.day, '2026-03-18');
    assert.deepEqual(m.reached.slice(0, 4).map((x) => [x.day, x.kind, x.text]), [
      ['2026-02-08', 'games', 'Your 10th game: Small 8'],
      ['2026-01-10', 'game_hours', '100 hours in Big <One>'],
      ['2026-01-10', 'hours', '100 hours of play'],
      ['2026-01-10', 'days', '10 days with play'],
    ]);
    const at = (kind, value, game) => m.reached.find((x) => x.kind === kind && x.value === value && (!game || x.game_id === game))?.day;
    // Big alone: 10 h on Jan 1, 25 on Jan 3, 50 on Jan 5, 100 on Jan 10
    assert.deepEqual([10, 25, 50, 100].map((v) => at('game_hours', v, big)), ['2026-01-01', '2026-01-03', '2026-01-05', '2026-01-10']);
    // in all, Side's six hours on Jan 3 bring 100 hours forward by nothing (96 h after Jan 9, 106 after Jan 10)
    assert.deepEqual([10, 50, 100].map((v) => at('hours', v)), ['2026-01-01', '2026-01-05', '2026-01-10']);
    assert.equal(at('days', 10), '2026-01-10');
    assert.equal(at('streak', 7), '2026-01-07');
    assert.equal(at('games', 10), '2026-02-08');
    assert.equal(m.reached.find((x) => x.kind === 'games').game_id > 0, true);
    assert.equal(at('game_hours', 10, side), undefined, 'Side has seven hours');
    assert.deepEqual(m.counts, { games: 1, hours: 3, game_hours: 4, days: 1, streak: 1 });
    assert.equal(m.total, 10);
    assert.ok(m.reached.every((x, i) => !i || m.reached[i - 1].day >= x.day), 'newest first');
  });

  test('what is coming up, nearest first: hours in all, the games still played, days, games, sessions', async () => {
    const m = await h.get('/stats/milestones');
    const by = (kind, game) => m.coming.find((x) => x.kind === kind && (!game || x.game_id === game));
    // 126 h of Big + 7 of Side + 2 of the small ones = 135 of 250
    assert.deepEqual([by('hours').target, by('hours').current, by('hours').percent, by('hours').text], [250, 135, 54, '250 hours of play']);
    // Big: 126 of 250 hours; Side: 7 of 10
    assert.deepEqual([by('game_hours', big).target, by('game_hours', big).current, by('game_hours', big).percent], [250, 126, 50]);
    assert.deepEqual([by('game_hours', side).target, by('game_hours', side).current, by('game_hours', side).text], [10, 7, '10 hours in Side']);
    // 12 days in January, 8 in February, 3 in March
    assert.deepEqual([by('days').target, by('days').current], [50, 23]);
    assert.deepEqual([by('games').target, by('games').current], [25, 10]);
    assert.deepEqual([by('sessions').target, by('sessions').current], [100, 25]);
    // three days in a row now, towards the 14 no streak has reached (the best was 12): too far off to list
    assert.equal(by('streak'), undefined);
    assert.ok(m.coming.every((x, i) => !i || m.coming[i - 1].percent >= x.percent), 'nearest first');
    assert.ok(m.coming.every((x) => x.percent < 100));
  });

  test('a game not played for three months is not "coming up"; limit cuts the list, not the counts', async () => {
    const old = await addGame(h, 'Shelved');
    await logSession(h, old, local(2025, 10, 1, 9), 540); // nine of ten hours, in October
    const m = await h.get('/stats/milestones?limit=2');
    assert.equal(m.coming.find((x) => x.game_id === old), undefined);
    assert.equal(m.reached.length, 2);
    assert.equal(m.total, 10, 'nothing new was reached');
    assert.equal((await h.call('GET', '/stats/milestones?limit=0')).status, 200);
  });

  test('excluded play reaches nothing', async () => {
    const before_ = (await h.get('/stats/milestones')).total;
    const x = await addGame(h, 'Excluded');
    await logSession(h, x, local(2026, 3, 1, 9), 700);
    const g = await h.get(`/games/${x}`);
    await h.patch(`/entries/${g.entries[0].id}`, { excluded: true });
    const m = await h.get('/stats/milestones');
    assert.equal(m.total, before_);
    assert.equal(m.reached.find((r) => r.game_id === x), undefined);
  });
});

describe('milestones: an empty library', () => {
  let h;
  before(async () => { guardNetwork(); clock.install(NOW); h = await startApp(); });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('nothing reached; the first of each kind is ahead, at 0%', () => {
    const m = milestones(h.db, { now: NOW });
    assert.deepEqual([m.total, m.reached, m.counts], [0, [], {}]);
    assert.deepEqual(m.coming.map((x) => [x.kind, x.target, x.current, x.percent]).sort(), [['achievements', 50, 0, 0], ['days', 10, 0, 0], ['games', 10, 0, 0], ['hours', 10, 0, 0], ['sessions', 100, 0, 0]]);
  });
});
