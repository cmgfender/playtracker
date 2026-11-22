// Insights, patterns: what the days of a range say together (GET /stats/records `patterns`): the
// change from the period before, days with play, a typical day, weekend days against weekdays and
// the longest break. Tracked play only.
//
// Sessions are logged through the API at local wall-clock times, so the file passes in any timezone.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clock, local, startApp, guardNetwork, restoreNetwork, addGame, logSession } from './suite/helpers/sessions-stats-harness.js';

// Wednesday 2026-03-18 15:00 local: the last 30 days are Feb 17 – Mar 18, the 30 before Jan 18 – Feb 16
const NOW = local(2026, 3, 18, 15);

describe('records: patterns', () => {
  let h; let a; let b; let c;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    a = await addGame(h, 'Weekender');
    b = await addGame(h, 'Lunch Break');
    c = await addGame(h, 'Twice Only');
    const at = (game, mo, d, minutes) => logSession(h, game, local(2026, mo, d, 19), minutes);
    // Weekender: tracked since Jan 10; 200 minutes in the 30 days before
    await at(a, 1, 10, 60); await at(a, 1, 20, 100); await at(a, 2, 1, 100);
    // 470 in the last 30: 360 on three weekend days, 110 on three weekdays, nothing Feb 23 – Mar 6
    await at(a, 2, 17, 30); await at(a, 2, 18, 20); await at(a, 2, 21, 120); await at(a, 2, 22, 120); await at(a, 3, 7, 120); await at(a, 3, 9, 60);
    // Lunch Break: Monday to Friday of one week, 50 minutes each
    for (const d of [2, 3, 4, 5, 6]) await at(b, 3, d, 50);
    await at(c, 3, 10, 45); await at(c, 3, 11, 45);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  const pat = (r, id) => r.patterns.find((x) => x.id === id);
  const ids = (r) => r.patterns.map((x) => x.id);

  test('a range with a tracked period before it: change, days with play, a typical day, the weekend, the longest break', async () => {
    const r = await h.get(`/stats/records?range=30d&game_id=${a}`);
    assert.deepEqual(ids(r), ['trend', 'days_played', 'typical_day', 'weekend', 'longest_break']);
    assert.deepEqual(pat(r, 'trend'), { id: 'trend', text: '7h 50m: 135% more than the 30 days before (3h 20m).', value: 135, unit: 'percent', minutes: 470, previous_minutes: 200, days: 30 });
    assert.deepEqual(pat(r, 'days_played'), { id: 'days_played', text: 'You played on 6 of 30 days (20%).', value: 20, unit: 'percent', days: 6, of: 30 });
    // the middle of 20, 30, 60, 120, 120, 120
    assert.deepEqual(pat(r, 'typical_day'), { id: 'typical_day', text: 'A day with play is typically 1h 30m.', value: 90, unit: 'minutes' });
    // 8 weekend days with 360 minutes (45 a day), 22 weekdays with 110 (5 a day)
    assert.deepEqual(pat(r, 'weekend'), { id: 'weekend', text: 'A weekend day gets 9 times the play of a weekday (45m against 5m).', value: 9, unit: 'times', lean: 'weekend', weekday_minutes: 5, weekend_minutes: 45 });
    assert.deepEqual(pat(r, 'longest_break'), { id: 'longest_break', text: 'Longest break: 12 days without play (2026-02-23 to 2026-03-06).', value: 12, unit: 'days', from: '2026-02-23', to: '2026-03-06', day: '2026-03-06' });
  });

  test('the highlights are as they were: patterns are a list of their own', async () => {
    const r = await h.get(`/stats/records?range=30d&game_id=${a}`);
    assert.deepEqual(r.highlights.map((x) => x.id), ['longest_session', 'biggest_day', 'best_week', 'longest_streak', 'most_played', 'favorite_weekday', 'time_of_day', 'first_session']);
  });

  test('all time, or a range that starts before tracking did: no period before to compare with, and the days before tracking are not days off', async () => {
    for (const range of ['all', 'year:2026', '365d']) {
      const r = await h.get(`/stats/records?range=${range}&game_id=${a}`);
      assert.equal(pat(r, 'trend'), undefined, range);
      // Jan 10 – Mar 18 is 68 days, 9 of them with play
      assert.deepEqual([pat(r, 'days_played').days, pat(r, 'days_played').of, pat(r, 'days_played').value], [9, 68, 13], range);
    }
  });

  test('a period before that is only partly tracked is not compared', async () => {
    // the 60 days before the last 60 start in November: tracking began on Jan 10
    const r = await h.get(`/stats/records?range=60d&game_id=${a}`);
    assert.equal(pat(r, 'trend'), undefined);
  });

  test('play on weekdays only: all of it, with no number of times; a break still running is not a break', async () => {
    const r = await h.get(`/stats/records?range=30d&game_id=${b}`);
    assert.deepEqual(ids(r), ['days_played', 'typical_day', 'weekend']);
    assert.deepEqual(pat(r, 'weekend'), { id: 'weekend', text: 'All of your play is on weekdays.', value: null, unit: 'times', lean: 'weekday', weekday_minutes: 19, weekend_minutes: 0 });
    // tracked since Mar 2: 17 days to Mar 18
    assert.deepEqual([pat(r, 'days_played').days, pat(r, 'days_played').of], [5, 17]);
    assert.equal(pat(r, 'typical_day').value, 50);
  });

  test('every game together: a weekday and a weekend day that differ by less than a quarter are "about the same"', async () => {
    // one more game, on weekdays, until both kinds of day hold 45 minutes each
    const d = await addGame(h, 'Filler');
    // weekdays so far: 110 + 250 + 90 = 450 of 22 days; 990 are 45 a day
    await logSession(h, d, local(2026, 3, 12, 12), 300);
    await logSession(h, d, local(2026, 3, 13, 12), 240);
    const r = await h.get('/stats/records?range=30d');
    assert.deepEqual(pat(r, 'weekend'), { id: 'weekend', text: 'Weekdays and weekend days get about the same play (45m and 45m a day).', value: 1, unit: 'times', lean: 'even', weekday_minutes: 45, weekend_minutes: 45 });
  });

  test('too little to see a pattern in: fewer than five days with play, or a range under two weeks', async () => {
    assert.deepEqual((await h.get(`/stats/records?range=30d&game_id=${c}`)).patterns, []);
    assert.deepEqual((await h.get(`/stats/records?range=week&game_id=${a}`)).patterns, []);
    assert.deepEqual((await h.get('/stats/records?range=year:2024')).patterns, [], 'a range with no play');
  });

  test('estimated history has no days: a game with only imported hours shows no patterns', async () => {
    const e = await addGame(h, 'Imported');
    const r = await h.get(`/stats/records?range=all&game_id=${e}`);
    assert.deepEqual(r.patterns, []);
  });
});
