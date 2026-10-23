// Sessions & stats, black-box through the HTTP API (fresh suite, no shared helpers).
//
// Expectations come from README.md, docs/PLATFORMS.md, the API route summaries and what a correct
// playtime tracker must do: totals add up, nothing is counted twice or lost, bad input is
// rejected, estimated history never inflates tracked KPIs, local days / DST are respected.
//
// The whole file runs in America/New_York (both DST transitions are exercised); the last block
// switches the process timezone to check rollup rebuilds, a half-hour offset zone and a zone
// whose DST change skips midnight. "Now" is a fixed instant controlled by the harness clock.
process.env.TZ = 'America/New_York';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RealDate, MIN, HOUR, DAY, clock, guardNetwork, restoreNetwork, local, dayOf, daysBetween,
  startApp, addGame, logSession, syncedGame, report, assertInvariants, totalsMismatch, sum, expectedDays,
} from './helpers/sessions-stats-harness.js';

// Wednesday 2026-03-18 15:00 EDT (DST began 2026-03-08; it ended 2025-11-02)
const NOW = local(2026, 3, 18, 15, 0);
const iso = (ms) => new RealDate(ms).toISOString();
const near = (a, b, tol = 1, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ±${tol}, got ${a}`);

before(() => { guardNetwork(); clock.install(NOW); });
after(() => { clock.uninstall(); restoreNetwork(); process.env.TZ = 'America/New_York'; });

// ======================================================================================
describe('logging manual sessions', () => {
  let h; let g;
  before(async () => { clock.set(NOW); h = await startApp(); g = await addGame(h, 'Hades'); });
  after(() => h.close());
  const life = () => h.get('/stats/lifetime');

  test('minutes + started_at: end is derived, the session is exact and counts toward every total', async () => {
    const start = local(2026, 3, 17, 20, 0);
    const s = await h.post('/sessions', { game_id: g, minutes: 90, started_at: iso(start), note: 'Chapter 3' });
    assert.equal(s.game_id, g);
    assert.equal(s.source, 'manual');
    assert.equal(s.kind, 'play');
    assert.equal(s.minutes, 90);
    assert.equal(s.started_at, start);
    assert.equal(s.ended_at, start + 90 * MIN);
    assert.equal(s.precise, true);
    assert.equal(s.note, 'Chapter 3');
    assert.deepEqual(await h.get(`/sessions/${s.id}`), s);
    const game = await h.get(`/games/${g}`);
    assert.equal(game.minutes, 90);
    assert.equal(game.summary.tracked_minutes, 90);
    assert.equal(game.summary.sessions, 1);
    const l = await life();
    assert.equal(l.total_minutes, 90);
    assert.equal(l.tracked_minutes, 90);
    assert.equal(l.sessions, 1);
    assert.equal((await h.get('/stats/heatmap?year=2026')).days['2026-03-17'], 90);
    assertInvariants(h);
  });

  test('minutes + ended_at (epoch ms): start is derived from the end', async () => {
    const end = local(2026, 3, 16, 22, 0);
    const s = await h.post('/sessions', { game_id: g, minutes: 40, ended_at: end });
    assert.equal(s.ended_at, end);
    assert.equal(s.started_at, end - 40 * MIN);
    assertInvariants(h);
  });

  test('hours (number or string) and numeric-string minutes are accepted and converted', async () => {
    const before_ = (await life()).total_minutes;
    const a = await h.post('/sessions', { game_id: g, hours: 1.5, started_at: local(2026, 3, 9, 10) });
    const b = await h.post('/sessions', { game_id: g, hours: '2', started_at: local(2026, 3, 9, 14) });
    const c = await h.post('/sessions', { game_id: g, minutes: '45', started_at: local(2026, 3, 9, 18) });
    assert.deepEqual([a.minutes, b.minutes, c.minutes], [90, 120, 45]);
    assert.equal((await life()).total_minutes, before_ + 255);
    assert.equal((await h.get('/stats/heatmap?year=2026')).days['2026-03-09'], 255);
    assertInvariants(h);
  });

  test('date only: the session is placed on that local calendar day', async () => {
    const s = await h.post('/sessions', { game_id: g, minutes: 60, date: '2026-03-05' });
    assert.equal(dayOf(s.started_at), '2026-03-05');
    assert.equal(dayOf(s.ended_at - 1), '2026-03-05');
    assert.equal((await h.get('/stats/heatmap?year=2026')).days['2026-03-05'], 60);
  });

  test('no time given: the session ends now and shows up in today\'s numbers', async () => {
    const todayBefore = (await h.get('/summary')).today.total_minutes;
    const s = await h.post('/sessions', { game_id: g, minutes: 30 });
    assert.equal(s.ended_at, NOW);
    assert.equal(s.started_at, NOW - 30 * MIN);
    const sum_ = await h.get('/summary');
    assert.equal(sum_.today.total_minutes, todayBefore + 30);
    assert.equal(sum_.recent_sessions[0].id, s.id, 'newest session first on the dashboard');
  });

  test('started_at + ended_at + minutes that agree are stored as given', async () => {
    const st = local(2026, 3, 4, 10); const en = local(2026, 3, 4, 11);
    const s = await h.post('/sessions', { game_id: g, minutes: 60, started_at: st, ended_at: en });
    assert.deepEqual([s.started_at, s.ended_at, s.minutes], [st, en, 60]);
  });

  test('status sets the game status; an unknown status is not stored', async () => {
    await h.post('/sessions', { game_id: g, minutes: 10, started_at: local(2026, 3, 3, 10), status: 'playing' });
    assert.equal((await h.get(`/games/${g}`)).status, 'playing');
    await h.call('POST', '/sessions', { game_id: g, minutes: 10, started_at: local(2026, 3, 3, 12), status: 'bogus' });
    assert.equal((await h.get(`/games/${g}`)).status, 'playing');
  });

  test('a manual session on a synced game never changes the platform\'s total', async () => {
    clock.set(NOW - DAY);
    const sg = await syncedGame(h, { title: 'Stardew Valley', history: 600, delta: 90, lastPlayedAt: NOW - 2 * HOUR });
    assert.equal(clock.now, NOW);
    const gid = (await h.get('/games?q=Stardew')).items[0].id;
    await h.post('/sessions', { game_id: gid, minutes: 30, started_at: local(2026, 3, 18, 9) });
    const game = await h.get(`/games/${gid}`);
    const synced = game.entries.find((e) => e.account_id === sg.accountId);
    const manual = game.entries.find((e) => e.platform === 'manual');
    assert.equal(synced.playtime_min, 690, 'synced entry keeps the platform total');
    assert.equal(manual.playtime_min, 30);
    assert.equal(game.minutes, 720);
    assertInvariants(h);
  });

  test('boundaries: 1 and 10080 minutes are accepted', async () => {
    const a = await h.post('/sessions', { game_id: g, minutes: 1, started_at: local(2026, 2, 1, 10) });
    const b = await h.post('/sessions', { game_id: g, minutes: 10080, started_at: local(2026, 1, 1, 0) });
    assert.equal(a.minutes, 1);
    assert.equal(b.minutes, 10080);
    assert.equal(b.ended_at - b.started_at, 10080 * MIN);
    // a 7-day session is spread over the days it covers (DST-free stretch: exactly 1440/day)
    const heat = (await h.get('/stats/heatmap?year=2026')).days;
    for (const d of daysBetween('2026-01-01', '2026-01-07')) assert.equal(heat[d], 1440, d);
    assertInvariants(h);
  });

  test('invalid minutes are rejected with 400 and nothing is stored', async () => {
    const l0 = await life();
    for (const body of [{ minutes: 0 }, { minutes: -5 }, { minutes: 10081 }, { minutes: 'abc' }, { minutes: null }, { hours: 0 }, { hours: -1 }, {}]) {
      const r = await h.call('POST', '/sessions', { game_id: g, started_at: local(2026, 2, 2, 10), ...body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.body.error, 'error message');
    }
    const l1 = await life();
    assert.equal(l1.total_minutes, l0.total_minutes);
    assert.equal(l1.sessions, l0.sessions);
  });

  test('missing, unknown or malformed game_id is rejected with 400', async () => {
    const l0 = await life();
    for (const game_id of [undefined, 999_999, 'abc', 0, -1]) {
      const r = await h.call('POST', '/sessions', { game_id, minutes: 30, started_at: local(2026, 2, 2, 10) });
      assert.equal(r.status, 400, String(game_id));
    }
    assert.equal((await life()).sessions, l0.sessions);
  });

  test('ended_at before started_at is rejected', { todo: 'APP BUG sessions-stats-1: POST /sessions stores a session whose ended_at is before started_at' }, async () => {
    const l0 = await life();
    const r = await h.call('POST', '/sessions', { game_id: g, minutes: 60, started_at: local(2026, 2, 3, 11), ended_at: local(2026, 2, 3, 10) });
    assert.equal(r.status, 400, `got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal((await life()).sessions, l0.sessions);
  });

  test('an unparseable started_at is rejected instead of being logged at the current time', { todo: 'APP BUG sessions-stats-2: POST /sessions silently logs an unparseable started_at as ending now' }, async () => {
    const l0 = await life();
    const r = await h.call('POST', '/sessions', { game_id: g, minutes: 60, started_at: 'last tuesday-ish' });
    assert.equal(r.status, 400, `got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal((await life()).sessions, l0.sessions);
  });

  test('a session that would end in the future is rejected', { todo: 'APP BUG sessions-stats-4: POST /sessions accepts sessions in the future' }, async () => {
    const l0 = await life();
    const r = await h.call('POST', '/sessions', { game_id: g, minutes: 60, started_at: NOW + 2 * DAY });
    assert.equal(r.status, 400, `got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal((await life()).sessions, l0.sessions);
  });

  test('a date-only session (up to 24 h) stays on the day it was logged for', { todo: 'APP BUG sessions-stats-5: date-only sessions start at noon, so >12 h spills into the next day' }, async () => {
    const g2 = await addGame(h, 'Long Day Game');
    await h.post('/sessions', { game_id: g2, minutes: 900, date: '2026-02-20' });
    const heat = (await h.get(`/stats/heatmap?year=2026&game_id=${g2}`)).days;
    assert.deepEqual(heat, { '2026-02-20': 900 }, 'logged "15 h on Feb 20" must not spill into Feb 21');
  });

  test('unknown / malformed session ids give 404, malformed JSON gives 400', async () => {
    for (const id of [999_999, 'abc']) {
      assert.equal((await h.call('GET', `/sessions/${id}`)).status, 404);
      assert.equal((await h.call('PATCH', `/sessions/${id}`, { note: 'x' })).status, 404);
      assert.equal((await h.call('DELETE', `/sessions/${id}`)).status, 404);
    }
    const r = await h.call('POST', '/sessions', '{"game_id": 1, "minutes": ', { 'content-type': 'application/json' });
    assert.equal(r.status, 400);
    assertInvariants(h);
  });
});

// ======================================================================================
describe('editing sessions', () => {
  let h; let g; let m; let synced;
  before(async () => {
    clock.set(NOW - DAY);
    h = await startApp();
    await syncedGame(h, { title: 'Stardew Valley', history: 600, delta: 90, lastPlayedAt: NOW - 2 * HOUR });
    synced = (await h.get('/sessions?source=sync')).items[0];
    g = await addGame(h, 'Celeste');
    m = await logSession(h, g, local(2026, 3, 10, 20), 60);
  });
  after(() => h.close());

  test('note can be set and cleared', async () => {
    assert.equal((await h.patch(`/sessions/${m.id}`, { note: 'Chapter 7 B-side' })).note, 'Chapter 7 B-side');
    assert.equal((await h.patch(`/sessions/${m.id}`, { note: '' })).note, null);
  });

  test('minutes of a manual session can be changed and every total follows', async () => {
    const l0 = await h.get('/stats/lifetime');
    const s = await h.patch(`/sessions/${m.id}`, { minutes: 30 });
    assert.equal(s.minutes, 30);
    assert.equal((await h.get(`/games/${g}`)).minutes, 30);
    const l1 = await h.get('/stats/lifetime');
    assert.equal(l1.total_minutes, l0.total_minutes - 30);
    assert.equal(l1.tracked_minutes, l0.tracked_minutes - 30);
    assert.equal((await h.get(`/stats/heatmap?year=2026&game_id=${g}`)).days['2026-03-10'], 30);
    assertInvariants(h);
  });

  test('invalid minutes on edit are rejected and nothing changes', async () => {
    for (const minutes of [0, -1, 'x', null]) {
      const r = await h.call('PATCH', `/sessions/${m.id}`, { minutes });
      assert.equal(r.status, 400, String(minutes));
    }
    assert.equal((await h.get(`/sessions/${m.id}`)).minutes, 30);
    assertInvariants(h);
  });

  test('editing minutes is held to the same 10080-minute limit as logging', { todo: 'APP BUG sessions-stats-6: PATCH /sessions/:id accepts minutes above the 10080 limit' }, async () => {
    try {
      const r = await h.call('PATCH', `/sessions/${m.id}`, { minutes: 50_000 });
      assert.equal(r.status, 400, `got ${r.status}`);
      assert.equal((await h.get(`/sessions/${m.id}`)).minutes, 30);
    } finally { await h.patch(`/sessions/${m.id}`, { minutes: 30 }); } // keep later tests independent
  });

  test('moving a session to other times moves it in the stats, totals unchanged', async () => {
    const l0 = await h.get('/stats/lifetime');
    const st = local(2026, 3, 12, 20); const en = local(2026, 3, 12, 20, 30);
    const s = await h.patch(`/sessions/${m.id}`, { started_at: iso(st), ended_at: iso(en) });
    assert.deepEqual([s.started_at, s.ended_at, s.minutes], [st, en, 30]);
    assert.deepEqual((await h.get(`/stats/heatmap?year=2026&game_id=${g}`)).days, { '2026-03-12': 30 });
    assert.equal((await h.get('/stats/lifetime')).total_minutes, l0.total_minutes);
    const st7 = await h.get(`/stats?range=7d&game_id=${g}`);
    assert.equal(st7.total_minutes, 30);
    assert.equal(st7.hours[20], 30);
    assertInvariants(h);
  });

  test('end before/at start is rejected, also when only one side is changed', async () => {
    const before_ = await h.get(`/sessions/${m.id}`);
    assert.equal((await h.call('PATCH', `/sessions/${m.id}`, { started_at: local(2026, 3, 12, 21), ended_at: local(2026, 3, 12, 20) })).status, 400);
    assert.equal((await h.call('PATCH', `/sessions/${m.id}`, { started_at: local(2026, 3, 12, 20), ended_at: local(2026, 3, 12, 20) })).status, 400);
    assert.equal((await h.call('PATCH', `/sessions/${m.id}`, { started_at: local(2026, 3, 12, 23) })).status, 400);
    assert.equal((await h.call('PATCH', `/sessions/${m.id}`, { ended_at: local(2026, 3, 12, 19) })).status, 400);
    assert.deepEqual(await h.get(`/sessions/${m.id}`), before_);
  });

  test('an unparseable timestamp on edit is rejected (the session keeps its times)', { todo: "APP BUG sessions-stats-3: PATCH /sessions/:id with an unparseable timestamp wipes the session's start time" }, async () => {
    const before_ = await h.get(`/sessions/${m.id}`);
    try {
      const r = await h.call('PATCH', `/sessions/${m.id}`, { started_at: 'not a date' });
      assert.equal(r.status, 400, `got ${r.status} ${JSON.stringify(r.body)}`);
      assert.deepEqual(await h.get(`/sessions/${m.id}`), before_);
    } finally { await h.patch(`/sessions/${m.id}`, { started_at: before_.started_at, ended_at: before_.ended_at }); }
  });

  test('kind baseline drops a session from stats but keeps lifetime; kind play restores it', async () => {
    const l0 = await h.get('/stats/lifetime');
    const s0 = await h.get(`/stats?range=30d&game_id=${g}`);
    assert.equal(s0.total_minutes, 30);
    await h.patch(`/sessions/${m.id}`, { kind: 'baseline' });
    const l1 = await h.get('/stats/lifetime');
    assert.equal(l1.total_minutes, l0.total_minutes, 'lifetime unchanged');
    assert.equal(l1.tracked_minutes, l0.tracked_minutes - 30);
    assert.equal(l1.baseline_minutes, l0.baseline_minutes + 30);
    assert.equal((await h.get(`/stats?range=30d&game_id=${g}`)).total_minutes, 0);
    assert.deepEqual((await h.get(`/stats/heatmap?year=2026&game_id=${g}`)).days, {});
    assert.ok(!(await h.get(`/sessions?game_id=${g}`)).items.some((x) => x.id === m.id), 'not listed as play');
    assert.ok((await h.get(`/sessions?game_id=${g}&kind=baseline`)).items.some((x) => x.id === m.id), 'listed as history');
    await h.patch(`/sessions/${m.id}`, { kind: 'play' });
    assert.deepEqual(await h.get('/stats/lifetime'), l0);
    assert.deepEqual(await h.get(`/stats?range=30d&game_id=${g}`), s0);
    assertInvariants(h);
  });

  test('kind other than play/baseline is rejected', async () => {
    for (const kind of ['estimate', 'bogus', '']) assert.equal((await h.call('PATCH', `/sessions/${m.id}`, { kind })).status, 400, kind);
    assert.equal((await h.get(`/sessions/${m.id}`)).kind, 'play');
  });

  test('synced session: minutes come from the platform (400), note/kind/times are editable', async () => {
    const l0 = await h.get('/stats/lifetime');
    const r = await h.call('PATCH', `/sessions/${synced.id}`, { minutes: 10 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /platform|baseline/i);
    assert.equal((await h.get(`/sessions/${synced.id}`)).minutes, 90);
    assert.equal((await h.patch(`/sessions/${synced.id}`, { note: 'co-op' })).note, 'co-op');
    await h.patch(`/sessions/${synced.id}`, { kind: 'baseline' });
    assert.equal((await h.get('/stats/lifetime')).tracked_minutes, l0.tracked_minutes - 90);
    await h.patch(`/sessions/${synced.id}`, { kind: 'play' });
    // re-time it to yesterday evening: the stats follow, the platform total does not change
    const st = local(2026, 3, 17, 19); const en = local(2026, 3, 17, 20, 30);
    await h.patch(`/sessions/${synced.id}`, { started_at: st, ended_at: en });
    const gid = synced.game_id;
    assert.deepEqual((await h.get(`/stats/heatmap?year=2026&game_id=${gid}`)).days, { '2026-03-17': 90 });
    assert.equal((await h.get('/stats/lifetime')).total_minutes, l0.total_minutes);
    assertInvariants(h);
  });

  test('an empty edit changes nothing', async () => {
    const before_ = await h.get(`/sessions/${m.id}`);
    assert.deepEqual(await h.patch(`/sessions/${m.id}`, {}), before_);
  });
});

// ======================================================================================
describe('deleting sessions', () => {
  let h;
  before(async () => { clock.set(NOW - DAY); h = await startApp(); });
  after(() => h.close());

  test('a manual session is deleted for good; totals drop; a second delete is 404', async () => {
    clock.set(NOW);
    const g = await addGame(h, 'Hades');
    const keep = await logSession(h, g, local(2026, 3, 16, 20), 45);
    const s = await logSession(h, g, local(2026, 3, 17, 20), 60);
    const l0 = await h.get('/stats/lifetime');
    const r = await h.del(`/sessions/${s.id}`);
    assert.equal(r.result, 'deleted');
    assert.equal((await h.call('GET', `/sessions/${s.id}`)).status, 404);
    assert.equal((await h.call('DELETE', `/sessions/${s.id}`)).status, 404);
    const l1 = await h.get('/stats/lifetime');
    assert.equal(l1.total_minutes, l0.total_minutes - 60);
    assert.equal(l1.sessions, l0.sessions - 1);
    assert.equal((await h.get(`/games/${g}`)).minutes, 45);
    assert.deepEqual((await h.get(`/stats/heatmap?year=2026&game_id=${g}`)).days, { '2026-03-16': 45 });
    assert.equal((await h.get(`/sessions/${keep.id}`)).minutes, 45, 'other sessions untouched');
    assertInvariants(h);
  });

  test('a synced session is moved to history (baseline): lifetime keeps the platform total', async () => {
    clock.set(NOW - DAY);
    const { accountId } = await syncedGame(h, { title: 'Stardew Valley', ext: 'sdv', history: 600, delta: 90, lastPlayedAt: NOW - 2 * HOUR });
    const s = (await h.get(`/sessions?account_id=${accountId}`)).items[0];
    assert.equal(s.source, 'sync');
    const l0 = await h.get('/stats/lifetime');
    const r = await h.del(`/sessions/${s.id}`);
    assert.equal(r.result, 'baseline');
    const after_ = await h.get(`/sessions/${s.id}`);
    assert.equal(after_.kind, 'baseline');
    assert.equal(after_.minutes, 90);
    assert.ok(after_.note, 'gets an explanatory note');
    const l1 = await h.get('/stats/lifetime');
    assert.equal(l1.total_minutes, l0.total_minutes);
    assert.equal(l1.tracked_minutes, l0.tracked_minutes - 90);
    assert.equal((await h.get(`/stats?range=7d&game_id=${s.game_id}`)).total_minutes, 0);
    // deleting it again is harmless (still history, nothing counted twice)
    assert.equal((await h.del(`/sessions/${s.id}`)).result, 'baseline');
    assert.equal((await h.get('/stats/lifetime')).total_minutes, l0.total_minutes);
    assertInvariants(h);
  });

  test('after dropping a synced session, the next report does not re-count it; new play is counted once', async () => {
    const acc = (await h.get('/accounts')).find((a) => a.name === 'acct-sdv');
    const l0 = await h.get('/stats/lifetime');
    clock.advance(HOUR);
    const r1 = await report(h, acc.id, [{ id: 'sdv', title: 'Stardew Valley', playtime_minutes: 690 }]);
    assert.equal(r1.sessions_created, 0);
    assert.deepEqual(await h.get('/stats/lifetime'), l0);
    clock.advance(2 * HOUR);
    const r2 = await report(h, acc.id, [{ id: 'sdv', title: 'Stardew Valley', playtime_minutes: 720, last_played_at: clock.now - 10 * MIN }]);
    assert.equal(r2.minutes_added, 30);
    const l1 = await h.get('/stats/lifetime');
    assert.equal(l1.total_minutes, l0.total_minutes + 30);
    assert.equal(l1.tracked_minutes, l0.tracked_minutes + 30);
    clock.set(NOW);
    assertInvariants(h);
  });

  test('deleting the undated history of a synced game keeps the platform total and is never re-counted as play', { todo: "APP BUG sessions-stats-7: deleting a synced game's history lowers the platform total; the next sync re-counts it as new play" }, async () => {
    clock.set(NOW - DAY);
    const acc = await h.post('/accounts', { platform: 'custom', name: 'undated', config: {} });
    await report(h, acc.id, [{ id: 'cl', title: 'Civ Legacy', playtime_minutes: 600 }]);
    const hist = (await h.get(`/sessions?account_id=${acc.id}&kind=baseline`)).items;
    assert.equal(hist.length, 1);
    assert.equal(hist[0].minutes, 600);
    const gid = hist[0].game_id;
    const today0 = (await h.get('/summary')).today.total_minutes;
    await h.call('DELETE', `/sessions/${hist[0].id}`);
    assert.equal((await h.get(`/games/${gid}`)).minutes, 600, 'lifetime total still comes from the platform');
    clock.set(NOW);
    const r = await report(h, acc.id, [{ id: 'cl', title: 'Civ Legacy', playtime_minutes: 600 }]);
    assert.equal(r.sessions_created, 0, 'an unchanged platform total must not create play');
    assert.equal((await h.get('/summary')).today.total_minutes, today0, 'pre-tracking time never shows up as today\'s play');
    assertInvariants(h);
  });

  test('deleting estimated history of a synced game keeps the platform total and is never re-counted as play', { todo: "APP BUG sessions-stats-7: deleting a synced game's history lowers the platform total; the next sync re-counts it as new play" }, async () => {
    clock.set(NOW - DAY);
    const acc = await h.post('/accounts', { platform: 'custom', name: 'hist', config: {} });
    await report(h, acc.id, [{ id: 'ow', title: 'Outer Wilds', playtime_minutes: 1200, first_played_at: '2025-09-01', last_played_at: '2025-10-15' }]);
    const est = (await h.get(`/sessions?account_id=${acc.id}&kind=estimate&limit=1000`)).items;
    assert.ok(est.length > 0, 'the history is dated as estimated sessions');
    const gid = est[0].game_id;
    assert.equal((await h.get(`/games/${gid}`)).minutes, 1200);
    await h.call('DELETE', `/sessions/${est[0].id}`);
    assert.equal((await h.get(`/games/${gid}`)).minutes, 1200, 'lifetime total still comes from the platform');
    clock.set(NOW);
    const r = await report(h, acc.id, [{ id: 'ow', title: 'Outer Wilds', playtime_minutes: 1200 }]);
    assert.equal(r.sessions_created, 0, 'an unchanged platform total must not create play');
    assert.equal((await h.get(`/stats?range=7d&game_id=${gid}`)).total_minutes, 0);
    assertInvariants(h);
  });

  test('imported sessions can be fully edited and deleted', async () => {
    clock.set(NOW);
    const imp = await h.post('/import', { games: [{ title: 'Zelda: TotK', platform: 'switch', playtime_minutes: 200, sessions: [{ started_at: iso(local(2026, 3, 14, 18)), minutes: 120 }, { date: '2026-03-15', minutes: 80 }] }] });
    assert.equal(imp.sessions, 2);
    const list = (await h.get('/sessions?source=import')).items;
    assert.equal(list.length, 2);
    assert.ok(list.every((s) => s.platform === 'switch' && s.kind === 'play'));
    const gid = list[0].game_id;
    const big = list.find((s) => s.minutes === 120);
    assert.equal((await h.patch(`/sessions/${big.id}`, { minutes: 100 })).minutes, 100);
    assert.equal((await h.get(`/games/${gid}`)).minutes, 180);
    assert.equal((await h.del(`/sessions/${big.id}`)).result, 'deleted');
    assert.equal((await h.get(`/games/${gid}`)).minutes, 80);
    assertInvariants(h);
  });
});

// ======================================================================================
describe('bulk actions', () => {
  let h; let g; let ids; let syncedId;
  before(async () => {
    clock.set(NOW - DAY);
    h = await startApp();
    await syncedGame(h, { title: 'Stardew Valley', history: 600, delta: 90, lastPlayedAt: NOW - 2 * HOUR });
    syncedId = (await h.get('/sessions?source=sync')).items[0].id;
    g = await addGame(h, 'Hades');
    ids = [];
    for (let d = 10; d <= 15; d++) ids.push((await logSession(h, g, local(2026, 3, d, 20), 60)).id);
  });
  after(() => h.close());

  test('convert to history (baseline) and back (play) round-trips every stat exactly', async () => {
    const s0 = await h.get('/stats?range=30d');
    const l0 = await h.get('/stats/lifetime');
    const r = await h.post('/sessions/bulk', { ids: ids.slice(0, 3), action: 'baseline' });
    assert.equal(r.count, 3);
    const s1 = await h.get('/stats?range=30d');
    assert.equal(s1.total_minutes, s0.total_minutes - 180);
    assert.equal(s1.sessions, s0.sessions - 3);
    const l1 = await h.get('/stats/lifetime');
    assert.equal(l1.total_minutes, l0.total_minutes);
    assert.equal(l1.baseline_minutes, l0.baseline_minutes + 180);
    await h.post('/sessions/bulk', { ids: ids.slice(0, 3), action: 'play' });
    assert.deepEqual(await h.get('/stats?range=30d'), s0);
    assert.deepEqual(await h.get('/stats/lifetime'), l0);
    assertInvariants(h);
  });

  test('bulk delete: manual sessions are deleted, synced ones become history', async () => {
    const l0 = await h.get('/stats/lifetime');
    const r = await h.post('/sessions/bulk', { ids: [ids[5], syncedId], action: 'delete' });
    assert.equal(r.count, 2);
    assert.equal((await h.call('GET', `/sessions/${ids[5]}`)).status, 404);
    assert.equal((await h.get(`/sessions/${syncedId}`)).kind, 'baseline');
    const l1 = await h.get('/stats/lifetime');
    assert.equal(l1.total_minutes, l0.total_minutes - 60, 'only the manual minutes leave the lifetime total');
    assert.equal(l1.tracked_minutes, l0.tracked_minutes - 150);
    ids.pop();
    assertInvariants(h);
  });

  test('invalid action or ids shape is rejected and nothing changes', async () => {
    const l0 = await h.get('/stats/lifetime');
    for (const body of [{ ids, action: 'nuke' }, { ids, action: 'estimate' }, { ids }, { ids: '1,2', action: 'delete' }, { ids: { a: 1 }, action: 'delete' }]) {
      assert.equal((await h.call('POST', '/sessions/bulk', body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual(await h.get('/stats/lifetime'), l0);
  });

  test('empty ids is a no-op', async () => {
    const l0 = await h.get('/stats/lifetime');
    assert.equal((await h.post('/sessions/bulk', { ids: [], action: 'delete' })).count, 0);
    assert.deepEqual(await h.get('/stats/lifetime'), l0);
  });

  test('a batch with an unknown id is all-or-nothing (no partial apply) and reports honestly', async () => {
    const l0 = await h.get('/stats/lifetime');
    const r = await h.call('POST', '/sessions/bulk', { ids: [ids[0], 987_654], action: 'delete' });
    if (r.status >= 400) {
      assert.equal(r.status, 404);
      assert.deepEqual(await h.get('/stats/lifetime'), l0, 'rolled back');
      assert.equal((await h.get(`/sessions/${ids[0]}`)).minutes, 60);
    } else {
      // tolerated alternative: skip unknown ids, but then count must be what really happened
      assert.equal(r.body.count, 1);
      ids.shift();
    }
    assertInvariants(h);
  });

  test('duplicate ids in one batch act once and do not fail the batch', { todo: 'APP BUG sessions-stats-8: bulk delete with a repeated id fails the whole batch with 404' }, async () => {
    const target = ids[ids.length - 1];
    const l0 = await h.get('/stats/lifetime');
    const r = await h.call('POST', '/sessions/bulk', { ids: [target, target], action: 'delete' });
    assert.equal(r.status, 200, `got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal((await h.call('GET', `/sessions/${target}`)).status, 404);
    assert.equal((await h.get('/stats/lifetime')).total_minutes, l0.total_minutes - 60, 'minutes removed once');
    assertInvariants(h);
  });
});

// ======================================================================================
describe('session listing filters', () => {
  let h; const G = {};
  before(async () => {
    clock.set(NOW - DAY);
    h = await startApp();
    await syncedGame(h, { title: 'Stardew Valley', history: 600, delta: 90, lastPlayedAt: NOW - HOUR });
    G.hades = await addGame(h, 'Hades');
    G.celeste = await addGame(h, 'Celeste');
    G.hl = await addGame(h, 'Half_Life');
    G.hx = await addGame(h, 'HalfXLife');
    G.oj = await addGame(h, '100% Orange Juice');
    G.ojx = await addGame(h, '1000 Orange Juice');
    await logSession(h, G.hades, local(2026, 3, 15, 20), 60);
    await logSession(h, G.hades, local(2026, 3, 16, 20), 30);
    await logSession(h, G.celeste, local(2026, 3, 12, 9), 45);
    await logSession(h, G.hl, local(2026, 3, 11, 10), 20);
    await logSession(h, G.hx, local(2026, 3, 11, 12), 25);
    await logSession(h, G.oj, local(2026, 3, 10, 10), 15);
    await logSession(h, G.ojx, local(2026, 3, 10, 12), 5);
    await h.post('/import', { games: [{ title: 'Zelda: TotK', platform: 'switch', playtime_minutes: 300, sessions: [{ started_at: iso(local(2026, 3, 14, 18)), minutes: 120 }] }] });
  });
  after(() => h.close());
  const list = async (q) => h.get(`/sessions?limit=1000&${q}`);

  test('default: play sessions only, newest (by end) first, totals match the items', async () => {
    const r = await list('');
    assert.equal(r.total, 9);
    assert.equal(r.items.length, 9);
    assert.ok(r.items.every((s) => s.kind === 'play'));
    assert.equal(r.total_minutes, sum(r.items.map((s) => s.minutes)));
    assert.equal(r.total_minutes, 90 + 60 + 30 + 45 + 20 + 25 + 15 + 5 + 120);
    const ends = r.items.map((s) => s.ended_at ?? s.window_end);
    assert.deepEqual(ends, [...ends].sort((a, b) => b - a));
    assert.equal(r.items[0].title, 'Stardew Valley');
    assert.equal(r.next, null);
  });

  test('kind=baseline / estimate / all; kind=all adds up to the lifetime total', async () => {
    const all = await list('kind=all');
    const play = await list('kind=play');
    const base = await list('kind=baseline');
    const est = await list('kind=estimate');
    assert.ok(base.items.every((s) => s.kind === 'baseline'));
    assert.ok(est.items.every((s) => s.kind === 'estimate'));
    assert.equal(all.total, play.total + base.total + est.total);
    assert.equal(all.total_minutes, (await h.get('/stats/lifetime')).total_minutes);
    assert.equal(base.total_minutes + est.total_minutes, 600 + 180, 'synced + imported history');
  });

  test('platform filter', async () => {
    assert.equal((await list('platform=manual')).total, 7);
    assert.deepEqual((await list('platform=custom')).items.map((s) => s.title), ['Stardew Valley']);
    assert.deepEqual((await list('platform=switch')).items.map((s) => s.minutes), [120]);
    assert.equal((await list('platform=xbox')).total, 0);
  });

  test('source filter', async () => {
    assert.equal((await list('source=manual')).total, 7);
    assert.deepEqual((await list('source=sync')).items.map((s) => s.minutes), [90]);
    assert.deepEqual((await list('source=import')).items.map((s) => s.minutes), [120]);
    assert.equal((await list('source=nope')).total, 0);
    const syncSession = (await list('source=sync')).items[0];
    assert.deepEqual((await list(`sync_id=${syncSession.sync_id}`)).items.map((x) => x.id), [syncSession.id]);
  });

  test('game filter', async () => {
    const r = await list(`game_id=${G.hades}`);
    assert.deepEqual(r.items.map((s) => s.minutes), [30, 60]);
    assert.equal(r.total_minutes, 90);
    assert.equal((await list('game_id=999999')).total, 0);
  });

  test('title search is case-insensitive substring', async () => {
    assert.deepEqual((await list('q=hAdEs')).items.map((s) => s.game_id), [G.hades, G.hades]);
    assert.equal((await list('q=zelda')).total, 1);
    assert.equal((await list('q=nothing-matches')).total, 0);
  });

  test('title search treats _ and % literally', { todo: 'APP BUG sessions-stats-9: session title search passes _ and % to LIKE as wildcards' }, async () => {
    assert.deepEqual((await list(`q=${encodeURIComponent('Half_')}`)).items.map((s) => s.title), ['Half_Life']);
    assert.deepEqual((await list(`q=${encodeURIComponent('100%')}`)).items.map((s) => s.title), ['100% Orange Juice']);
  });

  test('title search with SQL metacharacters is harmless', async () => {
    const r = await h.call('GET', `/sessions?q=${encodeURIComponent("'; DROP TABLE sessions; --")}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 0);
    assert.equal((await list('')).total, 9);
  });

  test('from/to with exact timestamps select sessions overlapping the window', async () => {
    // mid-session `from` still includes the Hades session of Mar 15 20:00-21:00
    const a = await list(`from=${encodeURIComponent(iso(local(2026, 3, 15, 20, 30)))}`);
    assert.deepEqual(a.items.map((s) => s.title).sort(), ['Hades', 'Hades', 'Stardew Valley']);
    const b = await list(`to=${local(2026, 3, 11, 10, 10)}`);
    assert.deepEqual(b.items.map((s) => s.title).sort(), ['1000 Orange Juice', '100% Orange Juice', 'Half_Life'].sort());
    const c = await list(`from=${local(2026, 3, 11, 0)}&to=${local(2026, 3, 12, 23, 59)}`);
    assert.deepEqual(c.items.map((s) => s.title).sort(), ['Celeste', 'HalfXLife', 'Half_Life'].sort());
  });

  test('date-only from/to cover the whole local day', { todo: 'APP BUG sessions-stats-10: date-only from/to filters are read as 12:00 noon, dropping half the day' }, async () => {
    const r = await list('from=2026-03-12&to=2026-03-12');
    assert.deepEqual(r.items.map((s) => s.title), ['Celeste'], 'Celeste was played 09:00-09:45 on 2026-03-12');
    const r2 = await list('to=2026-03-11');
    assert.deepEqual(r2.items.map((s) => s.title).sort(), ['1000 Orange Juice', '100% Orange Juice', 'HalfXLife', 'Half_Life'].sort());
  });

  test('filters combine (AND)', async () => {
    assert.deepEqual((await list('platform=manual&q=half')).items.map((s) => s.title).sort(), ['HalfXLife', 'Half_Life']);
    assert.equal((await list('platform=switch&q=hades')).total, 0);
    assert.equal((await list(`source=manual&game_id=${G.celeste}&kind=all`)).total, 1);
  });

  test('excluded entries are hidden from listings and stats unless asked for', async () => {
    const game = await h.get(`/games/${G.celeste}`);
    const entry = game.entries[0];
    const s0 = await h.get('/stats?range=30d');
    await h.patch(`/entries/${entry.id}`, { excluded: true });
    assert.equal((await list('')).total, 8);
    assert.equal((await list('include_excluded=true')).total, 9);
    assert.equal((await h.get('/stats?range=30d')).total_minutes, s0.total_minutes - 45);
    assert.equal((await h.get('/stats/lifetime')).total_minutes, (await list('kind=all')).total_minutes);
    await h.patch(`/entries/${entry.id}`, { excluded: false });
    assert.deepEqual(await h.get('/stats?range=30d'), s0);
    assertInvariants(h);
  });

  test('limit is clamped to sane bounds', async () => {
    const two = await h.get('/sessions?limit=2');
    assert.equal(two.items.length, 2);
    assert.ok(two.next);
    const huge = await h.get('/sessions?limit=100000');
    assert.ok(huge.limit <= 1000);
    assert.equal(huge.items.length, 9);
    for (const l of ['0', '-3', 'abc']) {
      const r = await h.call('GET', `/sessions?limit=${l}`);
      assert.equal(r.status, 200, l);
      assert.ok(r.body.items.length >= 1 && r.body.limit >= 1, l);
    }
  });
});

// ======================================================================================
describe('cursor pagination', () => {
  let h; const games = []; let all;
  before(async () => {
    clock.set(NOW);
    h = await startApp();
    for (const t of ['Alpha', 'Beta', 'Gamma']) games.push(await addGame(h, t));
    // 237 sessions: 40 groups of three that end at exactly the same instant (ties), plus singles
    let t = local(2026, 3, 18, 12);
    for (let i = 0; i < 40; i++) {
      t -= 3 * HOUR;
      for (const g of games) await logSession(h, g, t, 50);
    }
    for (let i = 0; i < 117; i++) { t -= 2 * HOUR; await logSession(h, games[i % 3], t, 30 + (i % 7)); }
    all = (await h.get('/sessions?limit=1000')).items;
  });
  after(() => h.close());

  async function walk(q, limit) {
    const seen = []; let next = null; let pages = 0; let total = null;
    do {
      const r = await h.get(`/sessions?limit=${limit}${q}${next ? `&before=${encodeURIComponent(next)}` : ''}`);
      if (total == null) total = r.total;
      assert.equal(r.total, total, 'total is stable across pages');
      seen.push(...r.items.map((s) => s.id));
      next = r.next;
      if (++pages > 500) throw new Error('pagination does not terminate');
    } while (next);
    return { seen, total };
  }

  test('one big page is ordered newest first, ties broken consistently', async () => {
    assert.equal(all.length, 237);
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1]; const b = all[i];
      assert.ok(a.ended_at > b.ended_at || (a.ended_at === b.ended_at && a.id > b.id), `order at ${i}`);
    }
  });

  test('walking the cursor visits every session exactly once, in order (page boundaries inside tie groups)', async () => {
    for (const limit of [7, 10, 236, 237, 238]) {
      const { seen, total } = await walk('', limit);
      assert.equal(total, 237);
      assert.equal(new Set(seen).size, seen.length, `no duplicates (limit ${limit})`);
      assert.deepEqual(seen, all.map((s) => s.id), `same order as one page (limit ${limit})`);
    }
  });

  test('offset paging and cursor paging agree', async () => {
    const out = [];
    for (let off = 0; off < 237; off += 25) out.push(...(await h.get(`/sessions?limit=25&offset=${off}`)).items.map((s) => s.id));
    assert.deepEqual(out, all.map((s) => s.id));
  });

  test('cursor paging with a filter stays within the filter', async () => {
    const { seen, total } = await walk(`&game_id=${games[1]}`, 9);
    assert.equal(seen.length, total);
    assert.equal(total, all.filter((s) => s.game_id === games[1]).length);
    assert.deepEqual(seen, all.filter((s) => s.game_id === games[1]).map((s) => s.id));
  });

  test('deleting sessions between pages neither duplicates nor skips the rest', async () => {
    const p1 = await h.get('/sessions?limit=10');
    const goneSeen = p1.items[3].id;
    const goneAhead = all[30].id;
    await h.del(`/sessions/${goneSeen}`);
    await h.del(`/sessions/${goneAhead}`);
    const rest = [];
    let next = p1.next;
    while (next) {
      const r = await h.get(`/sessions?limit=10&before=${encodeURIComponent(next)}`);
      rest.push(...r.items.map((s) => s.id));
      next = r.next;
    }
    const got = [...p1.items.map((s) => s.id), ...rest];
    assert.equal(new Set(got).size, got.length);
    assert.deepEqual(rest, all.slice(10).map((s) => s.id).filter((id) => id !== goneAhead));
    assertInvariants(h);
  });

  test('a garbage cursor never causes a server error', async () => {
    for (const c of ['abc', '1:', ':5', '-1:-1', '99999999999999999999:1', "1:1' OR 1=1"]) {
      const r = await h.call('GET', `/sessions?before=${encodeURIComponent(c)}`);
      assert.ok(r.status === 200 || r.status === 400, `${c} -> ${r.status}`);
    }
  });
});

// ======================================================================================
describe('stats: ranges, groupings, platforms, top games, hours, weekdays', () => {
  let h; const G = {};
  // [game, y, m, d, h, mi, minutes]   (all exact manual sessions unless noted)
  const S = [
    ['Alpha', 2026, 3, 18, 10, 0, 60], // S1 today (Wed)
    ['Alpha', 2026, 3, 16, 20, 0, 120], // S2 Monday this week
    ['Alpha', 2026, 3, 15, 14, 0, 90], // S3 Sunday (last week with Monday start)
    ['Alpha', 2026, 3, 12, 0, 30, 30], // S4 first day of the 7-day range
    ['Alpha', 2026, 3, 11, 22, 0, 60], // S5 one day before the 7-day range
    ['Alpha', 2026, 3, 1, 9, 0, 60], // S6 first of the month
    ['Alpha', 2026, 2, 28, 23, 0, 120], // S7 crosses into March: 60 Feb + 60 Mar
    ['Alpha', 2026, 2, 17, 8, 0, 60], // S8 first day of the 30-day range
    ['Alpha', 2026, 2, 16, 20, 0, 60], // S9 one day before the 30-day range
    ['Alpha', 2026, 1, 1, 0, 30, 60], // S10 first hour of the year
    ['Alpha', 2025, 12, 31, 23, 0, 120], // S11 crosses New Year: 60 + 60
    ['Beta', 2025, 6, 15, 12, 0, 120], // S12
    ['Beta', 2024, 2, 29, 10, 0, 60], // S13 leap day
  ];
  before(async () => {
    clock.set(NOW);
    h = await startApp();
    G.Alpha = await addGame(h, 'Alpha');
    G.Beta = await addGame(h, 'Beta');
    for (const [t, y, m, d, hh, mi, min] of S) await logSession(h, G[t], local(y, m, d, hh, mi), min);
    // S14: imported exact session on another platform
    await h.post('/import', { games: [{ title: 'Gamma', platform: 'switch', playtime_minutes: 60, sessions: [{ started_at: iso(local(2026, 3, 17, 18)), minutes: 60 }] }] });
    G.Gamma = (await h.get('/games?q=Gamma')).items[0].id;
  });
  after(() => h.close());
  const stats = (q) => h.get(`/stats?${q}`);

  function consistent(s, label) {
    near(sum(s.series.map((x) => x.minutes)), s.total_minutes, 1, `${label} series sum`);
    near(sum(s.platforms.map((p) => p.minutes)), s.total_minutes, 1, `${label} platform sum`);
    if (s.games_played <= s.top_games.length) near(sum(s.top_games.map((x) => x.minutes)), s.total_minutes, 1, `${label} top games sum`);
    assert.equal(new Set(s.series.map((x) => x.key)).size, s.series.length, `${label} unique keys`);
    for (const [, arr] of Object.entries(s.series_by_platform)) assert.equal(arr.length, s.series.length);
    s.series.forEach((x, i) => near(sum(Object.values(s.series_by_platform).map((a) => a[i])) + x.estimated, x.minutes, 1, `${label} stack ${x.key}`));
  }

  const cases = [
    // range, total, sessions, games, first series key, last key, #keys (group=day where given)
    ['range=7d', 360, 5, 2, '2026-03-12', '2026-03-18', 7], // Alpha + Gamma
    ['range=30d', 660, 9, 2, '2026-02-17', '2026-03-18', 30], // Beta has no play in the last 30 days
    ['range=week', 240, 3, 2, '2026-03-16', '2026-03-18', 3],
    ['range=month', 540, 8, 2, '2026-03-01', '2026-03-18', 18],
    ['range=90d&group=day', 900, 12, 2, '2025-12-19', '2026-03-18', 90], // S11 fully inside
    ['range=365d&group=day', 1020, 13, 3, '2025-03-19', '2026-03-18', 365],
    ['range=month:2026-02&group=day', 180, 2, 1, '2026-02-01', '2026-02-28', 28],
    ['range=month:2024-02&group=day', 60, 1, 1, '2024-02-01', '2024-02-29', 29],
  ];
  for (const [q, total, sessions, games, k0, k1, n] of cases) {
    test(`${q}: total ${total}, ${sessions} sessions, series ${k0}..${k1}`, async () => {
      const s = await stats(q);
      assert.equal(s.total_minutes, total);
      assert.equal(s.tracked_minutes, total);
      assert.equal(s.estimated_minutes, 0);
      assert.equal(s.sessions, sessions);
      assert.equal(s.games_played, games);
      assert.equal(s.series.length, n);
      assert.equal(s.series[0].key, k0);
      assert.equal(s.series.at(-1).key, k1);
      assert.deepEqual(s.series.map((x) => x.key), daysBetween(k0, k1));
      consistent(s, q);
    });
  }

  test('7d per-day values, days played, busiest day, longest session', async () => {
    const s = await stats('range=7d');
    const byDay = Object.fromEntries(s.series.map((x) => [x.key, x.minutes]));
    assert.deepEqual(byDay, { '2026-03-12': 30, '2026-03-13': 0, '2026-03-14': 0, '2026-03-15': 90, '2026-03-16': 120, '2026-03-17': 60, '2026-03-18': 60 });
    assert.equal(s.days_played, 5);
    assert.deepEqual(s.busiest_day, { day: '2026-03-16', minutes: 120 });
    assert.equal(s.longest_session.minutes, 120);
    assert.equal(s.longest_session.title, 'Alpha');
    assert.equal(s.avg_session_minutes, 72);
  });

  test('year / year:YYYY / all with month and year groupings', async () => {
    const y = await stats('range=year&group=month');
    assert.equal(y.total_minutes, 840);
    assert.equal(y.sessions, 12);
    assert.deepEqual(y.series.map((x) => [x.key, x.minutes]), [['2026-01', 120], ['2026-02', 180], ['2026-03', 540]]);
    const y25 = await stats('range=year:2025&group=month');
    assert.equal(y25.total_minutes, 180);
    assert.equal(y25.sessions, 1, 'the New Year session is counted once, in the year it ends');
    assert.equal(y25.games_played, 2);
    assert.equal(y25.series.length, 12);
    assert.deepEqual(y25.series.filter((x) => x.minutes).map((x) => [x.key, x.minutes]), [['2025-06', 120], ['2025-12', 60]]);
    const y24 = await stats('range=year:2024');
    assert.equal(y24.total_minutes, 60);
    const all = await stats('range=all&group=year');
    assert.equal(all.total_minutes, 1080);
    assert.equal(all.sessions, 14);
    assert.deepEqual(all.series.map((x) => [x.key, x.minutes]), [['2024', 60], ['2025', 180], ['2026', 840]]);
    for (const s of [y, y25, y24, all]) consistent(s, s.range.label);
  });

  test('adjacent ranges partition sessions and minutes (nothing counted twice or lost)', async () => {
    const jan = await stats('range=month:2026-01'); const feb = await stats('range=month:2026-02'); const mar = await stats('range=month:2026-03');
    const y = await stats('range=year:2026');
    assert.equal(jan.total_minutes + feb.total_minutes + mar.total_minutes, y.total_minutes);
    assert.equal(jan.sessions + feb.sessions + mar.sessions, y.sessions);
    const y24 = await stats('range=year:2024'); const y25 = await stats('range=year:2025'); const all = await stats('range=all');
    assert.equal(y24.total_minutes + y25.total_minutes + y.total_minutes, all.total_minutes);
    assert.equal(y24.sessions + y25.sessions + y.sessions, all.sessions);
    assert.equal(all.total_minutes, (await h.get('/stats/lifetime')).tracked_minutes);
  });

  test('group=week uses Monday keys by default; group=day/week/month over one range agree', async () => {
    const w = await stats('range=30d&group=week');
    assert.equal(w.series[0].key, '2026-02-16');
    for (const x of w.series) assert.equal(new RealDate(`${x.key}T12:00:00`).getDay(), 1, x.key);
    for (let i = 1; i < w.series.length; i++) assert.equal(daysBetween(w.series[i - 1].key, w.series[i].key).length, 8);
    const d = await stats('range=30d&group=day'); const m = await stats('range=30d&group=month');
    assert.equal(w.total_minutes, d.total_minutes);
    assert.equal(m.total_minutes, d.total_minutes);
    assert.deepEqual(m.series.map((x) => x.key), ['2026-02', '2026-03']);
  });

  test('top games: ordered by minutes, with per-game sessions and platforms', async () => {
    const s = await stats('range=all');
    assert.deepEqual(s.top_games.map((x) => [x.title, x.minutes, x.sessions]), [['Alpha', 840, 11], ['Beta', 180, 2], ['Gamma', 60, 1]]);
    assert.deepEqual(s.top_games[2].platforms, ['switch']);
    const w = await stats('range=7d');
    assert.deepEqual(w.top_games.map((x) => [x.title, x.minutes]), [['Alpha', 300], ['Gamma', 60]]);
  });

  test('top games list is capped but games_played counts every game', async () => {
    const h2 = await startApp();
    try {
      for (let i = 0; i < 30; i++) {
        const gid = await addGame(h2, `Game ${String(i).padStart(2, '0')}`);
        await logSession(h2, gid, local(2026, 3, 17, 0, 0) + i * 20 * MIN, i + 1);
      }
      const s = await h2.get('/stats?range=7d');
      assert.equal(s.games_played, 30);
      assert.ok(s.top_games.length < 30 && s.top_games.length >= 10);
      assert.equal(s.top_games[0].title, 'Game 29');
      for (let i = 1; i < s.top_games.length; i++) assert.ok(s.top_games[i - 1].minutes >= s.top_games[i].minutes);
      assert.equal(s.total_minutes, (30 * 31) / 2);
    } finally { h2.close(); }
  });

  test('per-platform split and platform filter', async () => {
    const s = await stats('range=7d');
    assert.deepEqual(s.platforms, [{ platform: 'manual', minutes: 300 }, { platform: 'switch', minutes: 60 }]);
    assert.equal(sum(s.series_by_platform.switch), 60);
    assert.equal(s.series_by_platform.switch[5], 60, 'on 2026-03-17');
    const sw = await stats('range=all&platform=switch');
    assert.equal(sw.total_minutes, 60);
    assert.equal(sw.games_played, 1);
  });

  test('game filter', async () => {
    const b = await stats(`range=all&game_id=${G.Beta}`);
    assert.equal(b.total_minutes, 180);
    assert.equal(b.sessions, 2);
    assert.deepEqual(b.top_games.map((x) => x.title), ['Beta']);
    assert.equal((await stats(`range=7d&game_id=${G.Beta}`)).total_minutes, 0);
  });

  test('hour-of-day and weekday breakdowns (local time, 0 = Sunday)', async () => {
    const s = await stats('range=7d');
    const hours = Array(24).fill(0);
    Object.assign(hours, { 0: 30, 10: 60, 14: 60, 15: 30, 18: 60, 20: 60, 21: 60 });
    assert.deepEqual(s.hours, hours);
    assert.equal(sum(s.hours), s.total_minutes, 'every exact minute has an hour');
    assert.deepEqual(s.weekday, [90, 120, 60, 60, 30, 0, 0]);
  });

  test('ranges with no data, and future/past years, return zeros (no errors)', async () => {
    for (const q of ['range=year:2027', 'range=year:1999', 'range=month:2023-07', `range=7d&game_id=999999`]) {
      const s = await stats(q);
      assert.equal(s.total_minutes, 0, q);
      assert.equal(s.sessions, 0, q);
      assert.deepEqual(s.top_games, [], q);
      assert.equal(s.busiest_day, null, q);
      assert.equal(s.longest_session, null, q);
    }
  });

  test('an impossible month (month:2025-13) is rejected, not answered with another month\'s data', async () => {
    const r = await h.call('GET', '/stats?range=month:2025-13');
    assert.ok(r.status === 400 || r.body.total_minutes === 0, `got ${r.status}: ${r.body.range?.label} total=${r.body.total_minutes}`);
  });

  test('unknown group is rejected or mapped to a real grouping', async () => {
    const r = await h.call('GET', '/stats?range=30d&group=fortnight');
    assert.ok(r.status === 400 || ['day', 'week', 'month', 'year'].includes(r.body.range.group), `got ${r.status} group=${r.body.range?.group}`);
  });

  test('degenerate day ranges never error', async () => {
    for (const q of ['range=0d', 'range=1d', 'range=-5d', 'range=bogus', 'range=']) {
      const r = await h.call('GET', `/stats?${q}`);
      assert.ok(r.status === 200 || r.status === 400, `${q} -> ${r.status}`);
      if (r.status === 200) assert.ok(r.body.total_minutes >= 0 && r.body.total_minutes <= 1080, q);
    }
    assert.equal((await stats('range=1d')).total_minutes, 60, '1d = today');
  });

  test('a huge day range answers quickly (no runaway loop)', async () => {
    const t0 = RealDate.now();
    const r = await h.call('GET', '/stats?range=2000000d');
    const ms = RealDate.now() - t0;
    assert.ok(r.status === 200 || r.status === 400, `status ${r.status}`);
    assert.ok(ms < 1000, `took ${ms} ms (one request blocks the whole server meanwhile)`);
  });
});

// ======================================================================================
describe('streaks', () => {
  async function withDays(days, fn, { now = NOW } = {}) {
    clock.set(now);
    const h = await startApp();
    try {
      const g = await addGame(h, 'Streaky');
      for (const [y, m, d, hh = 20, min = 30] of days) await logSession(h, g, local(y, m, d, hh), min);
      return await fn(h, g);
    } finally { h.close(); clock.set(NOW); }
  }
  const streaks = async (h, q = 'range=30d') => (await h.get(`/stats?${q}`)).streaks;

  test('no play: current 0, longest 0', () => withDays([], async (h) => {
    const s = await streaks(h);
    assert.equal(s.current, 0);
    assert.equal(s.longest, 0);
  }));

  test('today and the two days before: current 3', () => withDays([[2026, 3, 16], [2026, 3, 17], [2026, 3, 18, 9]], async (h) => {
    const s = await streaks(h);
    assert.equal(s.current, 3);
    assert.equal(s.longest, 3);
    assert.equal(s.longest_end, '2026-03-18');
  }));

  test('played yesterday and before but not yet today: the streak is still alive', () => withDays([[2026, 3, 16], [2026, 3, 17]], async (h) => {
    assert.equal((await streaks(h)).current, 2);
  }));

  test('last played two days ago: current 0, longest kept', () => withDays([[2026, 3, 15], [2026, 3, 16]], async (h) => {
    const s = await streaks(h);
    assert.equal(s.current, 0);
    assert.equal(s.longest, 2);
    assert.equal(s.longest_end, '2026-03-16');
  }));

  test('longest picks the longest run anywhere in history; current is the run ending today', () => withDays([
    [2025, 1, 1], [2025, 1, 2], [2025, 1, 3],
    [2025, 5, 10], [2025, 5, 11], [2025, 5, 12], [2025, 5, 13], [2025, 5, 14],
    [2026, 3, 17], [2026, 3, 18, 9],
  ], async (h) => {
    const s = await streaks(h);
    assert.equal(s.longest, 5);
    assert.equal(s.longest_end, '2025-05-14');
    assert.equal(s.current, 2);
  }));

  test('runs across DST spring-forward (23 h day) and fall-back (25 h day) are unbroken', () => withDays([
    [2026, 3, 6], [2026, 3, 7], [2026, 3, 8, 12], [2026, 3, 9], [2026, 3, 10],
    [2025, 10, 31], [2025, 11, 1], [2025, 11, 2, 12], [2025, 11, 3],
  ], async (h) => {
    const s = await streaks(h);
    assert.equal(s.longest, 5);
    assert.equal(s.longest_end, '2026-03-10');
    const y25 = await h.get('/stats/year/2025');
    assert.equal(y25.longest_streak, 4);
  }));

  test('a run across New Year is one run', () => withDays([[2025, 12, 30], [2025, 12, 31], [2026, 1, 1], [2026, 1, 2]], async (h) => {
    const s = await streaks(h);
    assert.equal(s.longest, 4);
    assert.equal(s.longest_end, '2026-01-02');
  }));

  test('a session crossing midnight counts for both days', () => withDays([[2026, 3, 16, 23, 120], [2026, 3, 18, 9]], async (h) => {
    assert.equal((await streaks(h)).current, 3);
  }));

  test('estimated (pre-tracking) history never extends a streak', async () => {
    clock.set(NOW);
    const h = await startApp();
    try {
      const g = await addGame(h, 'Tracked');
      await logSession(h, g, local(2026, 3, 16, 20), 30);
      await logSession(h, g, local(2026, 3, 18, 9), 30);
      await h.post('/import', { games: [{ title: 'Imported', platform: 'switch', playtime_minutes: 120, first_played: '2026-03-17', last_played: '2026-03-17' }] });
      const heat = await h.get('/stats/heatmap?year=2026');
      assert.ok(heat.estimated_days['2026-03-17'] > 0, 'precondition: history is dated on the gap day');
      const s = await streaks(h);
      assert.equal(s.current, 1);
      assert.equal(s.longest, 1);
    } finally { h.close(); }
  });

  test('sessions moved to history and excluded entries do not count', () => withDays([[2026, 3, 16], [2026, 3, 17], [2026, 3, 18, 9]], async (h, g) => {
    const mid = (await h.get(`/sessions?game_id=${g}`)).items.find((s) => dayOf(s.started_at) === '2026-03-17');
    await h.post('/sessions/bulk', { ids: [mid.id], action: 'baseline' });
    assert.equal((await streaks(h)).current, 1);
    await h.post('/sessions/bulk', { ids: [mid.id], action: 'play' });
    assert.equal((await streaks(h)).current, 3);
    const entry = (await h.get(`/games/${g}`)).entries[0];
    await h.patch(`/entries/${entry.id}`, { excluded: true });
    const s = await streaks(h);
    assert.equal(s.current, 0);
    assert.equal(s.longest, 0);
  }));

  test('dashboard and widget report the same current streak as /stats', () => withDays([[2026, 3, 15], [2026, 3, 16], [2026, 3, 17], [2026, 3, 18, 9]], async (h) => {
    const s = await streaks(h);
    assert.equal(s.current, 4);
    assert.equal((await h.get('/summary')).month.streaks.current, 4);
    assert.equal((await h.get('/widget')).streak_days, 4);
  }));
});

// ======================================================================================
describe('heatmap, year in review, years', () => {
  let h; const G = {};
  const S = [
    ['Alpha', 2025, 3, 3, 20, 60], ['Alpha', 2025, 3, 4, 20, 90], ['Alpha', 2025, 3, 5, 20, 30],
    ['Alpha', 2025, 7, 10, 10, 240],
    ['Beta', 2025, 7, 11, 12, 120], ['Beta', 2025, 7, 12, 12, 60], ['Beta', 2025, 7, 13, 12, 30],
    ['Gamma', 2024, 5, 1, 10, 60], ['Gamma', 2025, 8, 1, 10, 60],
    ['Alpha', 2025, 12, 31, 23, 120], // 60 in 2025, 60 in 2026
    ['Delta', 2026, 2, 10, 10, 45], ['Delta', 2026, 3, 10, 10, 30],
  ];
  before(async () => {
    clock.set(NOW);
    h = await startApp();
    for (const t of ['Alpha', 'Beta', 'Gamma', 'Delta']) G[t] = await addGame(h, t);
    for (const [t, y, m, d, hh, min] of S) await logSession(h, G[t], local(y, m, d, hh), min);
  });
  after(() => h.close());

  test('heatmap: exact minutes per local day, sums match the year\'s stats', async () => {
    const hm = await h.get('/stats/heatmap?year=2025');
    assert.equal(hm.year, 2025);
    assert.deepEqual(hm.days, { '2025-03-03': 60, '2025-03-04': 90, '2025-03-05': 30, '2025-07-10': 240, '2025-07-11': 120, '2025-07-12': 60, '2025-07-13': 30, '2025-08-01': 60, '2025-12-31': 60 });
    assert.deepEqual(hm.estimated_days, {});
    assert.equal(sum(Object.values(hm.days)), (await h.get('/stats?range=year:2025')).total_minutes);
    const hm26 = await h.get('/stats/heatmap?year=2026');
    assert.deepEqual(hm26.days, { '2026-01-01': 60, '2026-02-10': 45, '2026-03-10': 30 });
    assert.equal(sum(Object.values(hm26.days)), (await h.get('/stats?range=year:2026')).total_minutes);
  });

  test('heatmap defaults to the current year, filters by game, empty years are empty', async () => {
    assert.equal((await h.get('/stats/heatmap')).year, 2026);
    assert.deepEqual((await h.get(`/stats/heatmap?year=2025&game_id=${G.Beta}`)).days, { '2025-07-11': 120, '2025-07-12': 60, '2025-07-13': 30 });
    assert.deepEqual((await h.get('/stats/heatmap?year=2023')).days, {});
  });

  test('year in review for a past year', async () => {
    const y = await h.get('/stats/year/2025');
    assert.equal(y.year, 2025);
    assert.equal(y.total_minutes, 750);
    assert.equal(y.tracked_minutes, 750);
    assert.equal(y.sessions, 8);
    assert.equal(y.games_played, 3);
    assert.equal(y.days_played, 9);
    assert.equal(y.months.length, 12);
    assert.deepEqual(y.months.map((x) => x.minutes), [0, 0, 180, 0, 0, 0, 450, 60, 0, 0, 0, 60]);
    assert.equal(y.months[0].month, 'Jan');
    assert.deepEqual(y.best_month, { month: 'Jul', minutes: 450 });
    assert.deepEqual(y.busiest_day, { day: '2025-07-10', minutes: 240 });
    assert.equal(y.longest_session.minutes, 240);
    assert.equal(y.longest_session.title, 'Alpha');
    assert.equal(y.longest_streak, 4);
    assert.deepEqual(y.top_games.map((x) => [x.title, x.minutes]), [['Alpha', 480], ['Beta', 210], ['Gamma', 60]]);
    assert.equal(y.new_games, 2, 'Alpha and Beta were first played in 2025, Gamma in 2024');
    assert.deepEqual(y.new_game_list.map((x) => x.title), ['Alpha', 'Beta']);
    assert.equal(sum(y.weekday), 750);
    assert.deepEqual(y.platforms, [{ platform: 'manual', minutes: 750 }]);
    const stats = await h.get('/stats?range=year:2025');
    assert.equal(y.total_minutes, stats.total_minutes);
    assert.equal(y.sessions, stats.sessions);
  });

  test('year in review for the current year and for an empty year', async () => {
    const y = await h.get('/stats/year/2026');
    assert.equal(y.total_minutes, 135);
    assert.equal(y.sessions, 3);
    assert.equal(y.new_games, 1);
    assert.deepEqual(y.new_game_list.map((x) => x.title), ['Delta']);
    assert.equal(y.longest_streak, 1);
    const e = await h.get('/stats/year/2023');
    assert.equal(e.total_minutes, 0);
    assert.equal(e.sessions, 0);
    assert.equal(e.best_month, null);
    assert.equal(e.busiest_day, null);
    assert.equal(e.longest_session, null);
    assert.equal(e.longest_streak, 0);
    assert.equal(e.new_games, 0);
    assert.equal(e.months.length, 12);
    assert.ok(e.months.every((x) => x.minutes === 0));
  });

  test('a malformed year is rejected, not answered with other data', async () => {
    for (const y of ['abc', '26', '0']) {
      const r = await h.call('GET', `/stats/year/${y}`);
      assert.ok(r.status === 400 || (r.body.total_minutes === 0 && r.body.sessions === 0), `/stats/year/${y} -> ${r.status} total=${r.body.total_minutes}`);
    }
  });

  test('completed games are counted in the year they were completed', async () => {
    await h.patch(`/games/${G.Beta}`, { status: 'completed' });
    assert.equal((await h.get('/stats/year/2026')).completed, 1);
    assert.equal((await h.get('/stats/year/2025')).completed, 0);
  });

  test('years with data, newest first, always including the current year', async () => {
    assert.deepEqual(await h.get('/stats/years'), [2026, 2025, 2024]);
    const h2 = await startApp();
    try { assert.deepEqual(await h2.get('/stats/years'), [2026]); } finally { h2.close(); }
  });
});

// ======================================================================================
describe('estimated history: include / exclude / only', () => {
  let h; let tracked;
  before(async () => {
    clock.set(NOW);
    h = await startApp();
    tracked = await addGame(h, 'Tracked');
    await logSession(h, tracked, local(2025, 6, 10, 20), 60);
    await logSession(h, tracked, local(2026, 3, 18, 10), 30);
    await h.post('/import', { games: [
      { title: 'Old Game', platform: 'switch', playtime_minutes: 1200, first_played: '2025-06-01', last_played: '2025-06-30' },
      { title: 'Fresh Import', platform: 'switch', playtime_minutes: 300, first_played: '2026-03-16', last_played: '2026-03-17' },
    ] });
  });
  after(() => h.close());

  test('lifetime: history counts toward the total, never toward tracked play or sessions', async () => {
    const l = await h.get('/stats/lifetime');
    assert.equal(l.total_minutes, 1590);
    assert.equal(l.tracked_minutes, 90);
    assert.equal(l.estimated_minutes + l.baseline_minutes, 1500);
    assert.equal(l.sessions, 2);
    assertInvariants(h);
  });

  test('estimated history stays inside the first/last played window and within the daily caps', async () => {
    const heat = await h.get('/stats/heatmap?year=2025&estimates=only');
    const days = Object.keys(heat.days);
    assert.ok(days.length > 0, 'Old Game history is dated');
    for (const d of days) assert.ok(d >= '2025-06-01' && d <= '2025-06-30', d);
    for (const [d, m] of Object.entries(heat.days)) assert.ok(m <= 720, `${d}: ${m} min > 12 h`);
    const h26 = await h.get('/stats/heatmap?year=2026&estimates=only');
    for (const d of Object.keys(h26.days)) assert.ok(d >= '2026-03-16' && d <= '2026-03-17', d);
  });

  test('stats: include = tracked + estimated, exclude = tracked, only = estimated', async () => {
    const inc = await h.get('/stats?range=year:2025&estimates=include');
    const exc = await h.get('/stats?range=year:2025&estimates=exclude');
    const only = await h.get('/stats?range=year:2025&estimates=only');
    assert.ok(inc.estimated_minutes > 0 && inc.estimated_minutes <= 1200);
    assert.equal(inc.tracked_minutes, 60);
    assert.equal(inc.total_minutes, inc.tracked_minutes + inc.estimated_minutes);
    assert.deepEqual([exc.total_minutes, exc.tracked_minutes, exc.estimated_minutes], [60, 60, 0]);
    assert.equal(only.total_minutes, inc.estimated_minutes);
    assert.equal(only.tracked_minutes, 0);
    assert.equal(only.estimated_minutes, inc.estimated_minutes);
    near(sum(inc.series.map((x) => x.estimated)), inc.estimated_minutes, 1);
    near(sum(inc.series.map((x) => x.minutes)), inc.total_minutes, 1);
  });

  test('session counts, averages, days played and busiest day use tracked play only', async () => {
    for (const mode of ['include', 'exclude']) {
      const s = await h.get(`/stats?range=year:2025&estimates=${mode}`);
      assert.equal(s.sessions, 1, mode);
      assert.equal(s.avg_session_minutes, 60, mode);
      assert.equal(s.days_played, 1, mode);
      assert.deepEqual(s.busiest_day, { day: '2025-06-10', minutes: 60 }, mode);
      assert.equal(s.longest_session.minutes, 60, mode);
    }
    assert.equal((await h.get('/stats?range=year:2025&estimates=only')).sessions, 0);
  });

  test('top games show estimated minutes when included, and drop history-only games when excluded', async () => {
    const inc = await h.get('/stats?range=year:2025');
    const old = inc.top_games.find((x) => x.title === 'Old Game');
    assert.ok(old && old.estimated_minutes === old.minutes && old.minutes > 0);
    assert.equal(old.sessions, 0);
    const exc = await h.get('/stats?range=year:2025&estimates=exclude');
    assert.deepEqual(exc.top_games.map((x) => x.title), ['Tracked']);
  });

  test('heatmap include / exclude / only', async () => {
    const inc = await h.get('/stats/heatmap?year=2025&estimates=include');
    const exc = await h.get('/stats/heatmap?year=2025&estimates=exclude');
    const only = await h.get('/stats/heatmap?year=2025&estimates=only');
    assert.deepEqual(exc.days, { '2025-06-10': 60 });
    assert.deepEqual(exc.estimated_days, {});
    near(sum(Object.values(inc.days)), 60 + sum(Object.values(only.days)), 3);
    for (const d of Object.keys(inc.estimated_days)) assert.ok(d in only.days);
  });

  test('today / this week KPIs and streaks count tracked play only (dashboard and widget)', async () => {
    const sum_ = await h.get('/summary');
    assert.equal(sum_.today.total_minutes, 30);
    assert.equal(sum_.week.total_minutes, 30, 'history dated on Mon/Tue is not "played this week"');
    assert.equal(sum_.month.streaks.current, 1);
    const w = await h.get('/widget');
    assert.equal(w.today_hours, 0.5);
    assert.equal(w.week_hours, 0.5, 'widget "this week" must not include estimated history');
    assert.equal(w.streak_days, 1);
  });

  test('stats_estimates setting changes the default; explicit parameter wins; bad values are rejected', async () => {
    const st = await h.put('/settings', { stats_estimates: 'exclude' });
    assert.equal(st.stats_estimates, 'exclude');
    assert.equal((await h.get('/stats?range=year:2025')).estimated_minutes, 0);
    assert.deepEqual((await h.get('/stats/heatmap?year=2025')).days, { '2025-06-10': 60 });
    assert.equal((await h.get('/stats/year/2025')).estimated_minutes, 0);
    assert.ok((await h.get('/stats?range=year:2025&estimates=include')).estimated_minutes > 0);
    for (const v of ['only', 'bogus']) assert.equal((await h.call('PUT', '/settings', { stats_estimates: v })).status, 400, v);
    assert.equal((await h.get('/settings')).stats_estimates, 'exclude');
    await h.put('/settings', { stats_estimates: 'include' });
    assert.ok((await h.get('/stats?range=year:2025')).estimated_minutes > 0);
  });

  test('year in review include vs exclude', async () => {
    const inc = await h.get('/stats/year/2025?estimates=include');
    const exc = await h.get('/stats/year/2025?estimates=exclude');
    assert.ok(inc.estimated_minutes > 0);
    assert.equal(exc.estimated_minutes, 0);
    assert.equal(exc.total_minutes, 60);
    assert.equal(inc.total_minutes, 60 + inc.estimated_minutes);
    assert.equal(inc.sessions, 1);
    assert.equal(exc.sessions, 1);
    assert.equal(exc.new_games, 1);
    assert.deepEqual(exc.new_game_list.map((x) => x.title), ['Tracked']);
    assert.equal(inc.longest_streak, 1, 'streaks never use history');
  });
});

// ======================================================================================
describe('week start setting', () => {
  let h; let g;
  before(async () => {
    clock.set(NOW);
    h = await startApp();
    g = await addGame(h, 'Weekly');
    for (const [d, m] of [[14, 30], [15, 90], [16, 120], [18, 60]]) await logSession(h, g, local(2026, 3, d, 10), m);
  });
  after(() => h.close());

  test('default Monday: this week = Mon..now, weekly keys are Mondays', async () => {
    assert.equal((await h.get('/settings')).week_starts_on, 1);
    assert.equal((await h.get('/stats?range=week')).total_minutes, 180);
    assert.equal((await h.get('/summary')).week.total_minutes, 180);
    assert.equal((await h.get('/widget')).week_hours, 3);
    const w = await h.get('/stats?range=30d&group=week');
    assert.ok(w.series.every((x) => new RealDate(`${x.key}T12:00`).getDay() === 1));
  });

  test('Sunday start: weekly keys are Sundays and the totals are re-bucketed', async () => {
    await h.put('/settings', { week_starts_on: 0 });
    const w = await h.get('/stats?range=30d&group=week');
    assert.ok(w.series.every((x) => new RealDate(`${x.key}T12:00`).getDay() === 0), w.series.map((x) => x.key).join(','));
    const last = w.series.at(-1);
    assert.deepEqual([last.key, last.minutes], ['2026-03-15', 270]);
    assert.equal(w.total_minutes, 300);
    await h.put('/settings', { week_starts_on: 1 });
  });

  test('Sunday start: "this week" starts on Sunday (stats, dashboard, widget)', async () => {
    await h.put('/settings', { week_starts_on: 0 });
    try {
      const s = await h.get('/stats?range=week');
      assert.equal(s.series[0].key, '2026-03-15');
      assert.equal(s.total_minutes, 270);
      assert.equal((await h.get('/summary')).week.total_minutes, 270);
      assert.equal((await h.get('/widget')).week_hours, 4.5);
    } finally { await h.put('/settings', { week_starts_on: 1 }); }
  });

  test('switching back to Monday restores Monday weeks', async () => {
    assert.equal((await h.get('/stats?range=week')).total_minutes, 180);
  });

  test('out-of-range week start values are rejected', { todo: 'APP BUG sessions-stats-17: week_starts_on accepts 7, -1, 3.5, 100 (week buckets in the future / not 7 days apart)' }, async () => {
    try {
      for (const v of ['abc', 7, -1, 3.5, 100]) {
        const r = await h.call('PUT', '/settings', { week_starts_on: v });
        assert.equal(r.status, 400, `week_starts_on=${v} -> ${r.status}`);
        assert.equal((await h.get('/settings')).week_starts_on, 1, `unchanged after ${v}`);
      }
    } finally { await h.put('/settings', { week_starts_on: 1 }); }
  });

  test('on a Sunday with Monday start, the week began the Monday before', async () => {
    clock.set(local(2026, 3, 15, 18));
    const h2 = await startApp();
    try {
      const g2 = await addGame(h2, 'X');
      await logSession(h2, g2, local(2026, 3, 9, 10), 40); // Monday
      await logSession(h2, g2, local(2026, 3, 8, 10), 50); // previous Sunday
      await logSession(h2, g2, local(2026, 3, 15, 10), 20); // today
      const s = await h2.get('/stats?range=week');
      assert.equal(s.series[0].key, '2026-03-09');
      assert.equal(s.total_minutes, 60);
    } finally { h2.close(); clock.set(NOW); }
  });
});

// ======================================================================================
describe('midnight, DST and local-time boundaries (America/New_York)', () => {
  let h;
  before(async () => { clock.set(NOW); h = await startApp(); });
  after(() => h.close());
  async function one(title, start, minutes, extra) {
    const g = await addGame(h, title);
    const s = await logSession(h, g, start, minutes, extra);
    return { g, s };
  }
  const heat = async (y, g) => (await h.get(`/stats/heatmap?year=${y}&game_id=${g}`)).days;

  test('a session crossing midnight is split between the two days but counted once', async () => {
    const { g } = await one('Midnight', local(2026, 3, 2, 23), 120);
    assert.deepEqual(await heat(2026, g), { '2026-03-02': 60, '2026-03-03': 60 });
    const s = await h.get(`/stats?range=month&game_id=${g}`);
    assert.equal(s.total_minutes, 120);
    assert.equal(s.sessions, 1);
    assert.equal(s.top_games[0].sessions, 1);
    assert.equal(s.days_played, 2);
    assert.equal(s.hours[23], 60);
    assert.equal(s.hours[0], 60);
  });

  test('a session crossing the start of a range only contributes its in-range part', async () => {
    const { g } = await one('Edge', local(2026, 3, 11, 23), 120); // 7d starts 2026-03-12 00:00
    const s7 = await h.get(`/stats?range=7d&game_id=${g}`);
    assert.equal(s7.total_minutes, 60);
    assert.equal(s7.sessions, 1);
    const s30 = await h.get(`/stats?range=30d&game_id=${g}`);
    assert.equal(s30.total_minutes, 120);
    assert.equal(s30.sessions, 1);
  });

  test('spring forward: 01:30 EST + 60 min ends 03:30 EDT, split 30/30 over hours 1 and 3', async () => {
    const start = local(2026, 3, 8, 1, 30);
    const { g, s } = await one('Spring', start, 60);
    assert.equal(new RealDate(s.ended_at).getHours(), 3, 'precondition: the 02:00 hour does not exist');
    assert.deepEqual(await heat(2026, g), { '2026-03-08': 60 });
    const st = await h.get(`/stats?range=month&game_id=${g}`);
    assert.equal(st.hours[1], 30);
    assert.equal(st.hours[2], 0);
    assert.equal(st.hours[3], 30);
  });

  test('spring forward across midnight: 23:00 + 180 min = 3 real hours, 60 before / 120 after midnight', async () => {
    const { g, s } = await one('Spring Night', local(2026, 3, 7, 23), 180);
    assert.equal(new RealDate(s.ended_at).getHours(), 3);
    assert.deepEqual(await heat(2026, g), { '2026-03-07': 60, '2026-03-08': 120 });
    assert.deepEqual(await heat(2026, g), expectedDays([{ start: s.started_at, minutes: 180 }]));
  });

  test('fall back: 00:30 EDT + 180 min ends 02:30 EST; the repeated 1 AM hour holds 120 min', async () => {
    const start = local(2025, 11, 2, 0, 30);
    const { g, s } = await one('Fall', start, 180);
    assert.equal(new RealDate(s.ended_at).getHours(), 2, 'precondition: 01:00 happens twice');
    assert.deepEqual(await heat(2025, g), { '2025-11-02': 180 });
    const st = await h.get(`/stats?range=year:2025&game_id=${g}`);
    assert.equal(st.hours[0], 30);
    assert.equal(st.hours[1], 120);
    assert.equal(st.hours[2], 30);
    assert.equal(st.total_minutes, 180);
  });

  test('fall back across midnight: 23:00 EDT + 150 min = 60 on Nov 1, 90 on Nov 2', async () => {
    const { g } = await one('Fall Night', local(2025, 11, 1, 23), 150);
    assert.deepEqual(await heat(2025, g), { '2025-11-01': 60, '2025-11-02': 90 });
  });

  test('date-only sessions on DST days land on that day', async () => {
    const g = await addGame(h, 'Date Only DST');
    await h.post('/sessions', { game_id: g, minutes: 60, date: '2026-03-08' });
    await h.post('/sessions', { game_id: g, minutes: 60, date: '2025-11-02' });
    assert.deepEqual(await heat(2026, g), { '2026-03-08': 60 });
    assert.deepEqual(await heat(2025, g), { '2025-11-02': 60 });
  });

  test('years are local: 23:30 on Dec 31 (already Jan 1 in UTC) belongs to the old year', async () => {
    const { g } = await one('NYE', local(2025, 12, 31, 23, 30), 25);
    assert.deepEqual(await heat(2025, g), { '2025-12-31': 25 });
    assert.deepEqual(await heat(2026, g), {});
    assert.equal((await h.get(`/stats?range=year:2025&game_id=${g}`)).total_minutes, 25);
    assert.equal((await h.get(`/stats?range=year:2026&game_id=${g}`)).total_minutes, 0);
    assert.equal((await h.get(`/stats/year/2025`)).months[11].minutes >= 25, true);
  });

  test('day series stay contiguous and unique across DST changes', async () => {
    const y = await h.get('/stats?range=year:2025&group=day');
    assert.deepEqual(y.series.map((x) => x.key), daysBetween('2025-01-01', '2025-12-31'));
    const nov = await h.get('/stats?range=month:2025-11&group=day');
    assert.equal(nov.series.length, 30);
    const mar = await h.get('/stats?range=month&group=day');
    assert.deepEqual(mar.series.map((x) => x.key), daysBetween('2026-03-01', '2026-03-18'));
    const d30 = await h.get('/stats?range=30d');
    assert.deepEqual(d30.series.map((x) => x.key), daysBetween('2026-02-17', '2026-03-18'));
  });

  test('weekly series across DST are exactly 7 calendar days apart', async () => {
    const w = await h.get('/stats?range=year:2025&group=week');
    for (let i = 1; i < w.series.length; i++) assert.equal(daysBetween(w.series[i - 1].key, w.series[i].key).length, 8, w.series[i].key);
    assert.equal(sum(w.series.map((x) => x.minutes)), w.total_minutes);
    assertInvariants(h);
  });
});

// ======================================================================================
describe('consistency between stats, heatmap, year in review and the sessions', () => {
  let h;
  before(async () => {
    clock.set(local(2026, 3, 1, 12));
    h = await startApp();
    // two synced games: history at connection time, then a month of daily reports with play
    const acc = await h.post('/accounts', { platform: 'custom', name: 'PC', config: {} });
    await report(h, acc.id, [
      { id: 'a', title: 'Synced A', playtime_minutes: 3000, first_played_at: '2025-01-10', last_played_at: '2026-02-20' },
      { id: 'b', title: 'Synced B', playtime_minutes: 500 },
    ]);
    let a = 3000; let b = 500;
    for (let day = 1; day <= 17; day++) {
      clock.set(local(2026, 3, 1 + day, 4));
      a += (day * 37) % 150; if (day % 3 === 0) b += 45;
      await report(h, acc.id, [
        { id: 'a', title: 'Synced A', playtime_minutes: a, last_played_at: local(2026, 3, day, 22) },
        { id: 'b', title: 'Synced B', playtime_minutes: b, last_played_at: local(2026, 3, day, 20) },
      ]);
    }
    clock.set(NOW);
    const m = await addGame(h, 'Manual M');
    for (const [y, mo, d, hh, min] of [[2025, 4, 2, 21, 75], [2025, 12, 31, 22, 180], [2026, 2, 14, 13, 50], [2026, 3, 18, 11, 25]]) await logSession(h, m, local(y, mo, d, hh), min);
    await h.post('/import', { games: [
      { title: 'Imported I', platform: 'switch', playtime_minutes: 900, first_played: '2025-05-01', last_played: '2025-09-30', sessions: [{ started_at: iso(local(2025, 10, 5, 19)), minutes: 100 }] },
      { title: 'Synced B', platform: 'custom', playtime_minutes: 500 }, // a duplicate of the synced copy
    ] });
    // edits: one synced session dropped from stats, one manual session shortened
    const syncedOne = (await h.get('/sessions?source=sync&limit=5')).items[2];
    await h.del(`/sessions/${syncedOne.id}`);
    const man = (await h.get(`/sessions?game_id=${m}`)).items[0];
    await h.patch(`/sessions/${man.id}`, { minutes: 20 });
  });
  after(() => h.close());

  test('entry totals equal their sessions, rollups equal sessions', () => {
    assertInvariants(h);
  });

  test('lifetime equals the entries and the full session listing', async () => {
    const l = await h.get('/stats/lifetime');
    const all = await h.get('/sessions?kind=all&limit=1');
    assert.equal(all.total_minutes, l.total_minutes);
    const play = await h.get('/sessions?kind=play&limit=1');
    assert.equal(play.total_minutes, l.tracked_minutes);
    assert.equal(play.total, l.sessions);
    assert.equal(sum(l.platforms.map((p) => p.minutes)), l.total_minutes);
    const games = await h.get('/games?limit=5000');
    assert.equal(games.total_minutes, l.total_minutes);
  });

  test('all-time stats equal tracked play + dated history; lifetime minus undated history', async () => {
    const s = await h.get('/stats?range=all&estimates=include');
    const l = await h.get('/stats/lifetime');
    const est = await h.get('/sessions?kind=estimate&limit=1');
    near(s.tracked_minutes, l.tracked_minutes, 1);
    near(s.estimated_minutes, est.total_minutes, 1);
    near(s.total_minutes, l.total_minutes - l.baseline_minutes, 1);
    assert.equal(s.sessions, l.sessions);
  });

  test('every year: heatmap = stats = year in review; years add up to all time', async () => {
    const years = await h.get('/stats/years');
    assert.ok(years.includes(2025) && years.includes(2026));
    let total = 0; let sessions = 0;
    for (const y of years) {
      const s = await h.get(`/stats?range=year:${y}`);
      const hm = await h.get(`/stats/heatmap?year=${y}`);
      const yr = await h.get(`/stats/year/${y}`);
      near(sum(Object.values(hm.days)), s.total_minutes, Math.max(1, Object.keys(hm.days).length / 2), `heatmap ${y}`);
      assert.equal(yr.total_minutes, s.total_minutes, `review ${y}`);
      assert.equal(yr.sessions, s.sessions);
      near(sum(yr.months.map((x) => x.minutes)), yr.total_minutes, 12, `months ${y}`);
      total += s.total_minutes; sessions += s.sessions;
    }
    const all = await h.get('/stats?range=all');
    near(total, all.total_minutes, years.length);
    assert.equal(sessions, all.sessions);
  });

  test('per-game stats add up to the overall stats; per-game totals match the library', async () => {
    const all = await h.get('/stats?range=all');
    let t = 0;
    for (const tg of all.top_games) {
      const gs = await h.get(`/stats?range=all&game_id=${tg.game_id}`);
      near(gs.total_minutes, tg.minutes, 1, tg.title);
      t += gs.total_minutes;
    }
    near(t, all.total_minutes, all.top_games.length);
    for (const gm of (await h.get('/games?limit=5000')).items) {
      const d = await h.get(`/games/${gm.id}`);
      assert.equal(d.minutes, sum(d.entries.filter((e) => !e.excluded).map((e) => e.playtime_min)), gm.title);
    }
  });

  test('30-day stats equal the sessions\' minutes inside the window (independent computation)', async () => {
    const s = await h.get('/stats?range=30d&estimates=exclude');
    const from = local(2026, 2, 17);
    const items = (await h.get('/sessions?limit=1000')).items;
    let expect = 0;
    for (const x of items) {
      const a = x.started_at ?? x.window_start; const b = x.ended_at ?? x.window_end;
      if (b <= a) { if (b >= from) expect += x.minutes; continue; }
      expect += (x.minutes * Math.max(0, Math.min(b, NOW) - Math.max(a, from))) / (b - a);
    }
    near(s.total_minutes, expect, 2);
  });

  test('excluding an entry removes it everywhere at once; including it restores everything', async () => {
    const g = (await h.get('/games?q=Synced A')).items[0];
    const entry = (await h.get(`/games/${g.id}`)).entries.find((e) => e.account_id);
    const before_ = { s: await h.get('/stats?range=all'), l: await h.get('/stats/lifetime'), hm: await h.get('/stats/heatmap?year=2026'), y: await h.get('/stats/year/2026') };
    await h.patch(`/entries/${entry.id}`, { excluded: true });
    const s1 = await h.get('/stats?range=all');
    assert.ok(!s1.top_games.some((x) => x.game_id === g.id));
    assert.equal((await h.get('/stats/lifetime')).total_minutes, before_.l.total_minutes - entry.playtime_min);
    assert.equal((await h.get(`/sessions?game_id=${g.id}`)).total, 0);
    await h.patch(`/entries/${entry.id}`, { excluded: false });
    assert.deepEqual(await h.get('/stats?range=all'), before_.s);
    assert.deepEqual(await h.get('/stats/lifetime'), before_.l);
    assert.deepEqual(await h.get('/stats/heatmap?year=2026'), before_.hm);
    assert.deepEqual(await h.get('/stats/year/2026'), before_.y);
    assertInvariants(h);
  });
});

// ======================================================================================
describe('timezones: rollup rebuild on TZ change, half-hour offsets, DST at midnight', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sessions-stats-')); });
  after(() => { process.env.TZ = 'America/New_York'; fs.rmSync(dir, { recursive: true, force: true }); });

  test('changing the server timezone re-buckets days and hours on restart; totals unchanged', async () => {
    const file = path.join(dir, 'tz.db');
    const start = RealDate.UTC(2026, 5, 11, 3, 30); // 2026-06-10 23:30 EDT = 2026-06-11 09:00 IST
    clock.set(RealDate.UTC(2026, 6, 1, 12));
    process.env.TZ = 'America/New_York';
    let h = await startApp({ dbFile: file });
    let l0;
    try {
      const g = await addGame(h, 'Night Owl');
      await logSession(h, g, start, 60);
      assert.deepEqual((await h.get('/stats/heatmap?year=2026')).days, { '2026-06-10': 30, '2026-06-11': 30 });
      const s = await h.get('/stats?range=year:2026');
      assert.equal(s.hours[23], 30);
      assert.equal(s.hours[0], 30);
      l0 = await h.get('/stats/lifetime');
    } finally { h.close(); }
    process.env.TZ = 'Asia/Kolkata';
    h = await startApp({ dbFile: file });
    try {
      assert.ok(['Asia/Kolkata', 'Asia/Calcutta'].includes((await h.get('/health')).tz), 'ICU may report the legacy alias');
      assert.deepEqual((await h.get('/stats/heatmap?year=2026')).days, { '2026-06-11': 60 });
      const s = await h.get('/stats?range=year:2026');
      assert.equal(s.hours[9], 60, 'half-hour offset: 09:00-10:00 IST');
      assert.equal(sum(s.hours), 60);
      assert.deepEqual(await h.get('/stats/lifetime'), l0);
      assertInvariants(h);
    } finally { h.close(); }
  });

  test('a DST change that skips midnight (America/Santiago) keeps days and streaks right', async () => {
    process.env.TZ = 'America/Santiago';
    // find the 2026 day whose local midnight does not exist
    let skip = null;
    for (let t = local(2026, 1, 1, 12); t < local(2027, 1, 1); t += DAY) {
      const d = new RealDate(t);
      if (new RealDate(d.getFullYear(), d.getMonth(), d.getDate()).getHours() !== 0) { skip = d; break; }
    }
    assert.ok(skip, 'tzdata: Santiago has a DST change at midnight in 2026');
    const y = skip.getFullYear(); const m = skip.getMonth() + 1; const d = skip.getDate();
    const prev = dayOf(local(y, m, d - 1, 12)); const day = dayOf(local(y, m, d, 12));
    clock.set(local(y, m, d, 20));
    const h = await startApp();
    try {
      const g = await addGame(h, 'Chile');
      const start = local(y, m, d - 1, 23);
      const s = await logSession(h, g, start, 120); // 2 real hours: 23:00 -> 02:00 (00:00-01:00 skipped)
      assert.equal(s.ended_at - s.started_at, 120 * MIN);
      const hm = (await h.get(`/stats/heatmap?year=${y}`)).days;
      assert.deepEqual(hm, { [prev]: 60, [day]: 60 });
      const st = await h.get('/stats?range=7d');
      assert.deepEqual(st.series.map((x) => x.key), daysBetween(st.series[0].key, day));
      assert.equal(st.series.length, 7);
      assert.equal(st.total_minutes, 120);
      assert.equal(st.streaks.current, 2);
      assertInvariants(h);
    } finally { h.close(); process.env.TZ = 'America/New_York'; clock.set(NOW); }
  });
});

test('no entry anywhere ends up with sessions that disagree with its total (sanity of the harness)', async () => {
  clock.set(NOW);
  const h = await startApp();
  try {
    const g = await addGame(h, 'Sanity');
    await logSession(h, g, local(2026, 3, 1, 10), 10);
    assert.deepEqual(totalsMismatch(h.db), []);
    h.db.prepare('UPDATE entries SET playtime_min = playtime_min + 1 WHERE game_id = ?').run(g);
    assert.equal(totalsMismatch(h.db).length, 1, 'the invariant check detects a broken total');
  } finally { h.close(); }
});
