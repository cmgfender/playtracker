// Xbox (OpenXBL) sync - black-box suite.
//
// Expected behaviour comes from README.md, docs/PLATFORMS.md (Xbox section, hourly budget, history
// models) and the API route summaries - never from the engine's code. OpenXBL is mocked with the
// reply shapes seen in production (see helpers/xbox-sync-harness.js).
//
// Run: node --disable-warning=ExperimentalWarning --test test/suite/xbox-sync.test.js
import './helpers/xbox-sync-tz.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MIN, HOUR, DAY, T0, clock, FakeXbl, device, setup, unbalanced, badRollups, futureSessions, unexpectedHosts, restoreFetch, HOME_IDS,
} from './helpers/xbox-sync-harness.js';

/** Invariants that must hold after anything the app does. */
async function invariants(h, label = '') {
  await h.get('/health'); // a request flushes pending rollups
  assert.deepEqual(unbalanced(h.db), [], `${label} every entry's sessions add up to its lifetime total`);
  assert.deepEqual(badRollups(h.db), [], `${label} per-day rollups equal their sessions`);
  assert.deepEqual(futureSessions(h.db), [], `${label} no play session ends in the future`);
  assert.deepEqual(unexpectedHosts(), [], `${label} no request left for an unknown host`);
}

const statsCalls = (x, id) => x.count('stats', (c) => id == null || c.titleId === String(id));

/** A fake with `n` played games ("Game 0".."Game n-1"), most recent first, `base` + i minutes each. */
function library(x, n, { base = 100, from = T0 - DAY, idBase = 5000 } = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = String(idBase + i);
    x.title(id, { name: `Game ${i}`, minutes: base + i, lastPlayed: from - i * HOUR });
    ids.push(id);
  }
  return ids;
}

// =====================================================================================
describe('title history import', () => {
  test('initial import: every game becomes an entry with its MinutesPlayed total, filed as history (never play)', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('1001', { name: 'Forza Horizon 5', minutes: 6000, lastPlayed: T0 - 3 * DAY, devices: ['XboxSeries', 'PC'] });
      x.title('1002', { name: 'Halo Infinite', minutes: 125, lastPlayed: T0 - 40 * DAY });
      x.title('1003', { name: 'Starfield', minutes: 1, lastPlayed: T0 - 200 * DAY });
      const acc = await h.link(x);
      const r = await h.sync(acc.id);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.initial, true);
      assert.equal(r.body.games_seen, 3);
      assert.equal(r.body.sessions_created, 0, 'existing hours are history, not sessions');
      assert.equal(r.body.history_minutes, 6126);

      const es = h.entries(acc.id);
      assert.deepEqual(es.map((e) => [e.ext_id, e.title, e.playtime_min]), [['1001', 'Forza Horizon 5', 6000], ['1002', 'Halo Infinite', 125], ['1003', 'Starfield', 1]]);
      assert.equal(es[0].last_played_at, T0 - 3 * DAY, 'last played comes from titleHistory.lastTimePlayed (7-digit fractions parsed)');
      assert.equal(es[0].platform, 'xbox');
      assert.equal(h.playSessions(acc.id).length, 0);

      const life = await h.get('/stats/lifetime');
      assert.equal(life.total_minutes, 6126);
      assert.equal(life.tracked_minutes, 0);
      const week = await h.get('/stats?range=7d&estimates=exclude');
      assert.equal(week.tracked_minutes, 0, 'import day shows no fake play');
      assert.equal(week.sessions, 0);
      // history is dated before tracking started, never on import day or later
      const est = h.db.prepare("SELECT MAX(COALESCE(window_end, ended_at)) t FROM sessions WHERE kind = 'estimate'").get().t;
      assert.ok(est == null || est <= T0, 'estimated history never lies after the start of tracking');
      // one title-history request plus one stats request per game
      assert.equal(x.count('titleHistory'), 1);
      assert.equal(statsCalls(x), 3);
      const games = await h.get('/games?q=Forza');
      assert.equal(games.items.length, 1);
      assert.equal(games.items[0].minutes, 6000);
      assert.deepEqual(games.items[0].platforms, ['xbox']);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('Xbox Home / dashboard ids are ignored and apps are skipped unless "Track apps" is on - without spending stats requests on them', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('1001', { name: 'Forza Horizon 5', minutes: 300, lastPlayed: T0 - DAY });
      for (const id of HOME_IDS) x.title(id, { name: `Home ${id}`, type: 'App', minutes: 99999, lastPlayed: T0 - HOUR });
      x.title('2001', { name: 'Netflix', type: 'App', minutes: 4000, lastPlayed: T0 - 2 * HOUR });
      const acc = await h.link(x);
      await h.sync(acc.id);
      assert.deepEqual(h.entries(acc.id).map((e) => e.ext_id), ['1001']);
      assert.deepEqual(x.calls.filter((c) => c.ep === 'stats').map((c) => c.titleId), ['1001'], 'no budget spent on home/app titles');
      assert.equal((await h.get('/stats/lifetime')).total_minutes, 300);

      // a second account (same Microsoft account, different key) with apps tracked
      const y = new FakeXbl({ key: 'xbl-key-B' });
      for (const [id, t] of x.titles) y.title(id, { ...t });
      const acc2 = await h.link(y, { include_apps: 'on' }, 'Xbox with apps');
      await h.sync(acc2.id);
      assert.deepEqual(h.entries(acc2.id).map((e) => e.ext_id), ['1001', '2001'], 'apps tracked when asked; home ids never');
      assert.equal(h.entry(acc2.id, '2001').playtime_min, 4000);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('per-title minutes: MinutesPlayed read from the Hero group of each stats reply', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('11', { name: 'Big', minutes: 123456, lastPlayed: T0 - DAY });
      x.title('12', { name: 'Zero', minutes: 0, lastPlayed: T0 - 2 * DAY });
      x.title('13', { name: 'Small', minutes: 7, lastPlayed: T0 - 3 * DAY });
      // the same title reported with a numeric value instead of a string
      x.on.stats = (u, rec) => (rec.titleId === '14'
        ? new Response(JSON.stringify({ content: { groups: [{ name: 'Hero', titleid: '14', statlistscollection: [{ arrangebyfield: 'xuid', stats: [{ name: 'MinutesPlayed', type: 'Integer', value: 95 }] }] }], statlistscollection: [] }, code: 200 }), { status: 200, headers: { 'content-type': 'application/json' } })
        : null);
      x.title('14', { name: 'Numeric', minutes: 95, lastPlayed: T0 - 4 * DAY });
      const acc = await h.link(x);
      await h.sync(acc.id);
      const by = Object.fromEntries(h.entries(acc.id).map((e) => [e.ext_id, e.playtime_min]));
      assert.deepEqual(by, { 11: 123456, 12: 0, 13: 7, 14: 95 });
      // the 0-minute title is a real total (owned, barely played), not "no stat"
      assert.equal((await h.account(acc.id)).missing_minutes_samples, undefined, 'no title is reported as missing its playtime');
      assert.equal((await h.get('/stats/lifetime')).total_minutes, 123456 + 7 + 95);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('bare (unwrapped) replies are parsed the same as {content, code} envelopes', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl({ wrap: false });
      x.title('21', { name: 'Gears 5', minutes: 480, lastPlayed: T0 - 5 * DAY });
      x.title('22', { name: 'Sea of Thieves', minutes: 75, lastPlayed: T0 - 6 * DAY });
      const acc = await h.link(x);
      const r = await h.sync(acc.id);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(h.entries(acc.id).map((e) => e.playtime_min), [480, 75]);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('re-sync with nothing played: only the title history is requested, totals unchanged, no sessions', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      library(x, 5);
      const acc = await h.link(x);
      await h.sync(acc.id);
      const before = x.calls.length;
      const totals = h.entries(acc.id).map((e) => e.playtime_min);
      // the platform's counter moves without a new last-played time (should not happen, but the
      // docs say unchanged titles reuse the stored value) - it is not looked up
      x.title('5000').minutes += 30;
      clock.advance(DAY);
      const r = await h.sync(acc.id);
      assert.equal(r.status, 200, r.text);
      const spent = x.callsSince(before);
      assert.deepEqual(spent.map((c) => c.ep).filter((e) => e !== 'screenshots' && e !== 'gameclips' && e !== 'achievements'), ['titleHistory'], 'one request: the title list');
      assert.deepEqual(h.entries(acc.id).map((e) => e.playtime_min), totals);
      assert.equal(r.body.sessions_created, 0);
      assert.equal(h.playSessions(acc.id).length, 0);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('a title with MinutesPlayed 0 and an unchanged last-played time is not looked up again on every sync', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('31', { name: 'Demo I opened once', minutes: 0, lastPlayed: T0 - 30 * DAY });
      x.title('32', { name: 'Played game', minutes: 900, lastPlayed: T0 - 2 * DAY });
      const acc = await h.link(x);
      await h.sync(acc.id);
      assert.equal(statsCalls(x, '31'), 1);
      for (let i = 1; i <= 3; i++) {
        clock.advance(DAY);
        await h.sync(acc.id);
      }
      // "Only titles whose last-played time changed are looked up again" (README / PLATFORMS.md);
      // titles without a usable stat are rechecked weekly at most
      assert.equal(statsCalls(x, '32'), 1, 'unchanged played game reuses its stored value');
      assert.equal(statsCalls(x, '31'), 1, 'unchanged 0-minute title must not cost a request every sync');
    } finally { await h.close(); }
  });

  test('linking an account without sync:false starts the initial import on its own', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      library(x, 3);
      const r = await h.post('/accounts', { platform: 'xbox', name: 'Auto', config: { api_key: x.key } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.config.api_key.startsWith('••••••'), true, 'the API key is never echoed back');
      assert.ok(!JSON.stringify(r.body).includes(x.key), 'key not in the response');
      await h.settle();
      assert.equal(h.entries(r.body.id).length, 3);
      const s = h.lastSync(r.body.id);
      assert.equal(s.trigger, 'initial');
      assert.equal(s.status, 'ok');
      await invariants(h);
    } finally { await h.close(); }
  });

  test('missing API key is rejected when linking; a revoked key fails the sync cleanly (502) without touching data', async () => {
    const h = await setup();
    try {
      const bad = await h.post('/accounts', { platform: 'xbox', name: 'No key', config: {} });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /OpenXBL API key/);

      const x = new FakeXbl();
      library(x, 2);
      const acc = await h.link(x);
      await h.sync(acc.id);
      const totals = h.entries(acc.id).map((e) => e.playtime_min);
      x.key = 'revoked-key'; // the account still sends the old key -> OpenXBL answers 401
      clock.advance(DAY);
      const r = await h.sync(acc.id);
      assert.equal(r.status, 502, r.text);
      assert.match(r.body.error, /401/);
      const a = await h.account(acc.id);
      assert.equal(a.last_status, 'error');
      assert.match(a.last_error, /credentials/i, 'tells the user to update the key');
      assert.deepEqual(h.entries(acc.id).map((e) => e.playtime_min), totals, 'nothing lost');
      assert.equal(h.lastSync(acc.id).status, 'error');
      await invariants(h);
    } finally { await h.close(); }
  });
});

// =====================================================================================
describe('hourly budget, deferred titles and hourly back-fill', () => {
  /** Titles inserted in scrambled order, so "most recently played first" is the app's doing. */
  function scrambled(x, n, { base = 60, idBase = 7000 } = {}) {
    const ids = Array.from({ length: n }, (_, i) => i);
    for (let k = 0; k < n; k++) {
      const i = ids[(k * 37) % n];
      x.title(String(idBase + i), { name: `Library ${i}`, minutes: base + i, lastPlayed: T0 - DAY - i * HOUR });
    }
    // fix the permutation if 37 and n share a factor
    for (let i = 0; i < n; i++) if (!x.titles.has(String(idBase + i))) x.title(String(idBase + i), { name: `Library ${i}`, minutes: base + i, lastPlayed: T0 - DAY - i * HOUR });
    return Array.from({ length: n }, (_, i) => String(idBase + i));
  }
  const sumMinutes = (n, base) => n * base + (n * (n - 1)) / 2;

  test('a first import bigger than the free plan (150/h) keeps 15% in reserve, defers the rest with a warning, and back-fills an hour later as history', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl({ limit: 150 });
      const ids = scrambled(x, 200);
      const acc = await h.link(x);
      const r = await h.sync(acc.id);
      assert.equal(r.status, 200, r.text);
      const hour1 = x.calls.filter((c) => c.hour === x.hour(T0));
      const syncCalls = hour1.filter((c) => c.ep === 'titleHistory' || c.ep === 'stats');
      assert.ok(syncCalls.length <= Math.floor(150 * 0.85), `sync used ${syncCalls.length} of 150 (must keep 15% in reserve)`);
      assert.ok(syncCalls.length >= 100, `the budget is actually used (${syncCalls.length})`);
      assert.ok(hour1.length <= 150 && !hour1.some((c) => c.status === 429), 'never over the plan in the hour, no 429');
      const fetched = h.entries(acc.id).map((e) => e.ext_id);
      assert.equal(fetched.length, statsCalls(x), 'every looked-up title is imported');
      // most recently played first
      assert.deepEqual([...fetched].sort(), ids.slice(0, fetched.length).sort(), 'the most recently played titles are looked up first');
      const s = h.lastSync(acc.id);
      assert.equal(s.status, 'warning');
      const m = /(\d+) titles deferred/.exec(s.error || '');
      assert.ok(m, `warning names the deferred count: ${s.error}`);
      assert.equal(Number(m[1]), 200 - fetched.length);
      assert.equal(h.playSessions(acc.id).length, 0);
      // the back-fill runs within the hour, not at the next daily slot
      const a = await h.account(acc.id);
      assert.ok(a.next_sync_at > a.last_sync_at && a.next_sync_at - a.last_sync_at <= 65 * MIN, `next sync ${(a.next_sync_at - a.last_sync_at) / MIN} min after the last`);

      // ---- an hour later: only the deferred titles are looked up, all as history
      clock.set(a.next_sync_at);
      const before = x.calls.length;
      const r2 = await h.sync(acc.id);
      assert.equal(r2.status, 200, r2.text);
      const back = x.callsSince(before).filter((c) => c.ep === 'stats');
      assert.equal(back.length, 200 - fetched.length, 'only deferred titles cost a request');
      assert.ok(!back.some((c) => fetched.includes(c.titleId)), 'already imported, unchanged titles are not looked up again');
      assert.equal(h.entries(acc.id).length, 200);
      assert.equal(h.playSessions(acc.id).length, 0, 'deferred time is history, not new play');
      assert.equal(r2.body.sessions_created, 0);
      assert.equal((await h.get('/stats/lifetime')).total_minutes, sumMinutes(200, 60));
      assert.equal((await h.get('/stats?range=7d&estimates=exclude')).tracked_minutes, 0);
      assert.equal(h.lastSync(acc.id).status, 'ok', 'nothing deferred any more');
      const a2 = await h.account(acc.id);
      assert.ok(a2.next_sync_at - a2.last_sync_at > 2 * HOUR, 'back to the normal (daily) schedule');
      await invariants(h);
    } finally { await h.close(); }
  });

  test('a smaller configured plan limit is respected hour by hour until the library is complete', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl({ limit: 20 });
      scrambled(x, 30, { base: 10 });
      const acc = await h.link(x, { hourly_limit: '20' });
      assert.equal((await h.account(acc.id)).hourly_limit, 20);
      let hours = 0;
      for (; hours < 5 && h.entries(acc.id).length < 30; hours++) {
        if (hours) clock.set((await h.account(acc.id)).next_sync_at);
        const hr = x.hour();
        const r = await h.sync(acc.id);
        assert.equal(r.status, 200, r.text);
        const own = x.calls.filter((c) => c.hour === hr && (c.ep === 'titleHistory' || c.ep === 'stats')).length;
        assert.ok(own <= 17, `hour ${hours}: sync used ${own} of 20`);
        assert.ok(!x.calls.some((c) => c.status === 429), 'never rate limited');
      }
      assert.equal(h.entries(acc.id).length, 30, 'complete after the back-fills');
      assert.ok(hours >= 2, 'needed more than one hour');
      assert.equal((await h.get('/stats/lifetime')).total_minutes, sumMinutes(30, 10));
      assert.equal(h.playSessions(acc.id).length, 0);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('a paid plan limit imports a big library in one sync, without a warning', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl({ limit: 1000 });
      scrambled(x, 200);
      const acc = await h.link(x, { hourly_limit: '1000' });
      const r = await h.sync(acc.id);
      assert.equal(r.status, 200);
      assert.equal(h.entries(acc.id).length, 200);
      assert.equal(h.lastSync(acc.id).status, 'ok');
      assert.equal(h.lastSync(acc.id).error, null);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('requests made elsewhere with the same key (x-ratelimit-remaining) tighten the budget: the sync still leaves 15% of the plan', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl({ limit: 150 });
      scrambled(x, 60);
      x.useElsewhere(120); // another tool already spent 120 of this hour's 150
      const acc = await h.link(x);
      const r = await h.sync(acc.id);
      assert.equal(r.status, 200, r.text);
      const own = x.calls.filter((c) => c.ep === 'titleHistory' || c.ep === 'stats').length;
      assert.ok(150 - 120 - own >= 22, `left ${150 - 120 - own} of the reported quota (15% of 150 = 22.5)`);
      assert.ok(!x.calls.some((c) => c.status === 429), 'no 429');
      assert.equal(h.entries(acc.id).length, statsCalls(x));
      assert.match(h.lastSync(acc.id).error || '', /deferred/);
      const a = await h.account(acc.id);
      assert.equal(a.api_quota.limit, 150, 'the quota the API reported is shown');
      assert.ok(a.api_quota.remaining <= 30);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('a title gone from a complete title history is marked "no longer in library"; not while titles are deferred', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl({ limit: 20 });
      x.title('1', { name: 'Kept', minutes: 100, lastPlayed: T0 - DAY });
      x.title('2', { name: 'Hidden later', minutes: 50, lastPlayed: T0 - 2 * DAY });
      const acc = await h.link(x, { hourly_limit: '20' });
      await h.sync(acc.id);
      // next day: 'Hidden later' disappears and 25 new titles need lookups (more than the budget)
      clock.advance(DAY);
      x.titles.delete('2');
      for (let i = 0; i < 25; i++) x.title(String(100 + i), { name: `New ${i}`, minutes: 5 + i, lastPlayed: T0 - 300 * DAY - i * HOUR });
      await h.sync(acc.id);
      assert.match(h.lastSync(acc.id).error || '', /deferred/);
      assert.equal(h.entry(acc.id, '2').missing_since, null, 'an incomplete report removes nothing');
      // once nothing is deferred, the report is complete
      for (let i = 0; i < 3 && /deferred/.test(h.lastSync(acc.id).error || ''); i++) {
        clock.set((await h.account(acc.id)).next_sync_at);
        await h.sync(acc.id);
      }
      assert.equal(h.lastSync(acc.id).status, 'ok');
      assert.ok(h.entry(acc.id, '2').missing_since > 0, 'marked as no longer in library');
      assert.equal(h.entry(acc.id, '1').missing_since, null);
      assert.equal(h.entry(acc.id, '2').playtime_min, 50, 'its minutes are kept');
      const g = (await h.get('/games?q=Hidden')).items[0];
      assert.ok((await h.get(`/games/${g.id}`)).entries[0].missing_since > 0);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('a library with more never-played (0-minute) titles than one hour\'s budget still finishes its back-fill', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl({ limit: 20 });
      x.title('1', { name: 'Main game', minutes: 900, lastPlayed: T0 - DAY });
      // 25 demos / trials opened for a few seconds: MinutesPlayed 0
      for (let i = 0; i < 25; i++) x.title(String(100 + i), { name: `Demo ${i}`, minutes: 0, lastPlayed: T0 - 30 * DAY - i * HOUR });
      const acc = await h.link(x, { hourly_limit: '20' });
      await h.sync(acc.id);
      for (let i = 0; i < 4 && /deferred/.test(h.lastSync(acc.id).error || ''); i++) {
        clock.set((await h.account(acc.id)).next_sync_at);
        await h.sync(acc.id);
      }
      assert.equal(h.entries(acc.id).length, 26, 'every title imported within a few hours');
      assert.equal(h.lastSync(acc.id).status, 'ok', 'no longer deferring');
      const a = await h.account(acc.id);
      assert.ok(a.next_sync_at - a.last_sync_at > 2 * HOUR, 'hourly back-fill stops once done');
    } finally { await h.close(); }
  });

  test('a server error on one title\'s stats defers that title (never imported as 0 or as "no stat"); it arrives on the next sync as history', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('41', { name: 'Flaky', minutes: 700, lastPlayed: T0 - DAY });
      x.title('42', { name: 'Fine', minutes: 300, lastPlayed: T0 - 2 * DAY });
      x.failNext('stats', { status: 503 }, { status: 503 }); // first lookup (Flaky) fails, its retry too
      const acc = await h.link(x);
      const r = await h.sync(acc.id);
      assert.equal(r.status, 200, r.text);
      assert.equal(h.entry(acc.id, '41'), undefined, 'not imported with a made-up 0');
      assert.equal(h.entry(acc.id, '42').playtime_min, 300);
      assert.match(h.lastSync(acc.id).error || '', /1 titles deferred/);
      assert.equal((await h.account(acc.id)).missing_minutes_samples, undefined, 'a server error is not "no playtime stat"');
      clock.set((await h.account(acc.id)).next_sync_at);
      await h.sync(acc.id);
      assert.equal(h.entry(acc.id, '41').playtime_min, 700);
      assert.equal(h.playSessions(acc.id).length, 0, 'still history');
      assert.equal(h.entry(acc.id, '41').baseline_min, 700);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('play after tracking started stays play even when its lookup had to wait for the next hour', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('51', { name: 'Forza Horizon 5', minutes: 1000, lastPlayed: T0 - 5 * DAY });
      const acc = await h.link(x);
      await h.sync(acc.id); // tracking starts at T0 (Tue 14:05)
      // Tue evening: Forza 21:00-22:00, and a brand-new game 19:00-20:30
      const evening = T0 - 14 * HOUR - 5 * MIN + DAY; // Tue 00:00 + 1 day = Wed 00:00
      x.play('51', { end: evening - 2 * HOUR, minutes: 60 });
      x.title('52', { name: 'Brand New Game', minutes: 90, lastPlayed: evening - 3.5 * HOUR });
      // Wed 04:05 daily sync: the title list arrives, then the quota runs out (another app)
      clock.set(evening + 4 * HOUR + 5 * MIN);
      x.failNext('stats', { status: 429 });
      const r = await h.sync(acc.id);
      assert.equal(r.status, 200, r.text);
      assert.match(h.lastSync(acc.id).error || '', /deferred/);
      // after the reset the deferred lookups are made
      clock.set(Math.max((await h.account(acc.id)).next_sync_at, x.resetAt() + MIN));
      const r2 = await h.sync(acc.id);
      assert.equal(r2.status, 200, r2.text);
      const forza = h.sessions(h.entry(acc.id, '51').id);
      assert.equal(forza.reduce((a, s) => a + s.minutes, 0), 60, 'existing title: its delta is a session');
      assert.equal(forza.at(-1).ended_at, evening - 2 * HOUR);
      const fresh = h.entry(acc.id, '52');
      assert.equal(fresh.playtime_min, 90);
      assert.equal(h.sumKind(fresh.id, 'play'), 90, 'a game first played after tracking started is play, not pre-tracking history');
      await invariants(h);
    } finally { await h.close(); }
  });
});

// =====================================================================================
describe('quota exhausted (429): pause until the reset, no retry storm', () => {
  test('429 on the title history (OpenXBL body, no reset header): answers 429, one request only, account paused until resetAt', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      library(x, 3);
      const acc = await h.link(x);
      x.exhaust(); // another tool used the whole hour
      const reset = x.resetAt();
      const r = await h.sync(acc.id);
      assert.equal(r.status, 429, r.text);
      assert.match(r.body.error, /rate limit/i);
      assert.equal(x.calls.length, 1, 'no retry after a 429 that names a far reset');
      const a = await h.account(acc.id);
      assert.equal(a.last_status, 'warning', 'a used-up quota is not an account failure');
      assert.match(a.last_error, /paused/i);
      assert.ok(a.api_quota.blockedUntil >= reset && a.api_quota.blockedUntil <= reset + MIN, `paused until ${new Date(a.api_quota.blockedUntil).toISOString()} (reset ${new Date(reset).toISOString()})`);
      assert.ok(a.next_sync_at >= reset, 'next sync waits for the reset');
      assert.deepEqual(a.api_usage_hour, { calls: 1, errors: 1, rate_limited: 1 }, 'the refused request is counted');
      const s = (await h.get(`/syncs?account_id=${acc.id}`))[0];
      assert.equal(s.status, 'warning');
      assert.ok(s.details.rate_limited_until >= reset);
      assert.equal(h.entries(acc.id).length, 0);

      // presence during the pause: no request at all
      clock.advance(5 * MIN);
      await h.poll(acc.id);
      assert.equal(x.calls.length, 1, 'presence is paused too');
      // a manual "Sync now" during the pause spends at most one request and keeps the pause
      const r2 = await h.sync(acc.id);
      assert.ok(x.calls.length <= 2, `manual sync during the pause made ${x.calls.length - 1} requests`);
      assert.ok(r2.status === 429 || r2.status === 200, r2.text);
      assert.ok((await h.account(acc.id)).api_quota.blockedUntil >= reset, 'still paused until the reset');

      // after the reset everything resumes
      clock.set(reset + 10_000);
      const r3 = await h.sync(acc.id);
      assert.equal(r3.status, 200, r3.text);
      assert.equal(h.entries(acc.id).length, 3);
      assert.equal((await h.account(acc.id)).last_status, 'ok');
      await invariants(h);
    } finally { await h.close(); }
  });

  test('429 in the middle of an import: no further requests in that sync, looked-up titles kept, the rest back-filled after the reset', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      const ids = library(x, 10);
      let n = 0;
      // the 2nd stats reply is the last one of the hour (another client spends the rest meanwhile)
      x.on.stats = () => { if (++n === 2) x.useElsewhere(x.remaining()); return null; };
      const acc = await h.link(x);
      const r = await h.sync(acc.id);
      assert.equal(r.status, 200, r.text);
      const stats = x.calls.filter((c) => c.ep === 'stats');
      assert.equal(stats.length, 3, 'two answered, one refused, then it stops');
      assert.equal(stats[2].status, 429);
      const after429 = x.calls.slice(x.calls.indexOf(stats[2]) + 1);
      assert.deepEqual(after429.filter((c) => c.ep === 'stats' || c.ep === 'titleHistory'), [], 'the sync sends nothing more once the quota is used up');
      assert.deepEqual(h.entries(acc.id).map((e) => e.ext_id), ids.slice(0, 2));
      assert.match(h.lastSync(acc.id).error || '', /8 titles deferred/);
      const reset = x.resetAt();
      const a = await h.account(acc.id);
      assert.ok(a.api_quota.blockedUntil >= reset);
      assert.ok(a.next_sync_at >= reset, 'the back-fill waits for the reset');
      clock.advance(5 * MIN);
      await h.poll(acc.id);
      assert.equal(x.count('presence'), 0, 'presence paused');

      clock.set(a.next_sync_at);
      const r2 = await h.sync(acc.id);
      assert.equal(r2.status, 200, r2.text);
      assert.equal(h.entries(acc.id).length, 10);
      assert.equal(h.playSessions(acc.id).length, 0, 'back-filled titles are history');
      assert.equal((await h.get('/stats/lifetime')).total_minutes, 10 * 100 + 45);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('while the account is paused, background enrichment sends nothing either', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      library(x, 10);
      let n = 0;
      x.on.stats = () => { if (++n === 2) x.useElsewhere(x.remaining()); return null; };
      const acc = await h.link(x);
      await h.sync(acc.id); // the 3rd lookup gets the 429 -> paused; enrichment then starts in the background
      const first429 = x.calls.findIndex((c) => c.status === 429);
      assert.ok(first429 > 0);
      assert.deepEqual(x.calls.slice(first429 + 1).map((c) => `${c.ep}:${c.status}`), [], 'no request of any kind until the reset');
      // an explicit enrichment run during the pause is just as quiet
      await h.post(`/accounts/${acc.id}/enrich?wait=true`);
      assert.deepEqual(x.calls.slice(first429 + 1).map((c) => `${c.ep}:${c.status}`), []);
    } finally { await h.close(); }
  });

  test('429 whose resetAt is already past (clock skew) falls back to retryAfter', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      library(x, 2);
      const acc = await h.link(x);
      x.failNext('titleHistory', { status: 429, resetAt: Date.now() - 10 * MIN, retryAfter: 786 });
      const r = await h.sync(acc.id);
      assert.equal(r.status, 429);
      const until = (await h.account(acc.id)).api_quota.blockedUntil;
      assert.ok(Math.abs(until - (T0 + 786_000)) <= 30_000, `paused ${(until - T0) / 1000}s (retryAfter 786s)`);
      assert.equal(x.calls.length, 1);
    } finally { await h.close(); }
  });

  test('429 that names no reset at all still pauses (never an immediate retry loop)', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      library(x, 2);
      const acc = await h.link(x);
      x.on.titleHistory = () => new Response('Too Many Requests', { status: 429, headers: { 'content-type': 'text/plain' } });
      const r = await h.sync(acc.id);
      assert.equal(r.status, 429);
      assert.equal(x.calls.length, 1);
      const until = (await h.account(acc.id)).api_quota.blockedUntil;
      assert.ok(until >= T0 + MIN && until <= T0 + HOUR + 2 * MIN, `paused for ${(until - T0) / MIN} min`);
      const a = await h.account(acc.id);
      assert.ok(a.next_sync_at >= until);
    } finally { await h.close(); }
  });

  test('the pause survives a restart (presence and syncs stay quiet until the reset)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-xbox-'));
    const file = path.join(dir, 'pt.db');
    let h = await setup({ dbFile: file });
    let reset;
    let accId;
    try {
      const x = new FakeXbl();
      library(x, 2);
      const acc = await h.link(x);
      accId = acc.id;
      await h.sync(acc.id);
      clock.advance(10 * MIN);
      x.exhaust();
      reset = x.resetAt();
      assert.equal((await h.sync(acc.id)).status, 429);
    } finally { await h.close(); }
    h = await setup({ dbFile: file, now: T0 + 15 * MIN });
    try {
      const x = new FakeXbl();
      library(x, 2);
      const a = await h.account(accId);
      assert.ok(h.svc.blockedUntil(accId) >= reset, 'pause restored from the database');
      assert.ok(a.next_sync_at == null || a.next_sync_at >= reset || h.svc.computeNext(h.svc.account(accId)) >= reset, 'no sync before the reset');
      assert.ok(h.svc.computeNext(h.svc.account(accId)) >= reset);
      await h.poll(accId);
      assert.equal(x.calls.length, 0, 'presence stays paused after the restart');
    } finally {
      await h.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =====================================================================================
describe('sessions from MinutesPlayed deltas', () => {
  const at = (hh, mm = 0, dayOffset = 0) => Date.UTC(2026, 9, 20 + dayOffset, hh, mm); // T0's day (Tue 20 Oct 2026, UTC)

  /** Initial import of one game at T0, then return helpers. */
  async function oneGame(h, { minutes = 1000, config = {} } = {}) {
    const x = new FakeXbl();
    x.title('61', { name: 'Forza Horizon 5', minutes, lastPlayed: T0 - 5 * DAY });
    const acc = await h.link(x, config);
    await h.sync(acc.id);
    return { x, acc, entry: () => h.entry(acc.id, '61') };
  }

  test('a 90-minute delta becomes one session ending at the new last-played time', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await oneGame(h);
      x.play('61', { end: at(20, 30), minutes: 90 }); // 19:00-20:30
      clock.set(at(21, 5));
      const r = await h.sync(acc.id);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.sessions_created, 1);
      assert.equal(r.body.minutes_added, 90);
      const s = h.sessions(entry().id);
      assert.equal(s.length, 1);
      assert.equal(s[0].minutes, 90);
      assert.equal(s[0].ended_at, at(20, 30), 'Xbox last played marks the end of the session');
      assert.equal(s[0].started_at, at(19, 0));
      assert.equal(entry().playtime_min, 1090);
      assert.equal(entry().last_played_at, at(20, 30));
      const snaps = await h.get(`/entries/${entry().id}/snapshots`);
      assert.equal((snaps.items ?? snaps)[0].playtime_min, 1090, 'the new total is snapshotted');
      const week = await h.get('/stats?range=7d&estimates=exclude');
      assert.equal(week.tracked_minutes, 90);
      assert.equal(week.sessions, 1);
      const list = await h.get(`/sessions?account_id=${acc.id}`);
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0].precise, true);
      assert.equal(list.items[0].platform, 'xbox');
      await invariants(h);
    } finally { await h.close(); }
  });

  test('a delta longer than the long-session default (240 min) is split: a typical session ending at last played, the rest before it', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await oneGame(h);
      x.play('61', { end: at(23, 0), minutes: 300 }); // played on and off through the evening
      clock.set(at(4, 5, 1)); // next morning's daily sync
      await h.sync(acc.id);
      const s = h.sessions(entry().id);
      assert.equal(s.reduce((a, x) => a + x.minutes, 0), 300, 'every minute kept');
      assert.ok(s.length >= 2, `${s.length} sessions`);
      const last = s.at(-1);
      assert.equal(last.ended_at, at(23, 0));
      assert.equal(last.minutes, 120, 'typical (default 120 min) session at the end');
      for (const x2 of s.slice(0, -1)) {
        const end = x2.ended_at ?? x2.window_end;
        assert.ok(end <= last.started_at, 'earlier play lies before the last session');
        assert.ok((x2.started_at ?? x2.window_start) >= T0 - 15 * MIN, 'and after the previous sync');
      }
      await invariants(h);
    } finally { await h.close(); }
  });

  test('deltas below the minimum session (2 min) are held back and join the next one', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await oneGame(h);
      x.play('61', { end: at(18, 0), minutes: 1 });
      clock.set(at(18, 30));
      const r = await h.sync(acc.id);
      assert.equal(r.body.sessions_created, 0, 'a 1-minute blip is not a session');
      assert.equal(h.sessions(entry().id).length, 0);
      await invariants(h, 'held back:');
      x.play('61', { end: at(20, 0), minutes: 4 });
      clock.set(at(20, 30));
      await h.sync(acc.id);
      const s = h.sessions(entry().id);
      assert.equal(s.length, 1);
      assert.equal(s[0].minutes, 5, 'the held-back minute is part of the next session');
      assert.equal(entry().playtime_min, 1005);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('a long session across hourly syncs (minutes flushed during play) stays one session', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await oneGame(h, { config: {} });
      await h.patch(`/accounts/${acc.id}`, { schedule: { schedule_mode: 'hourly' } });
      // playing 15:00-17:40; Xbox credits minutes during play with ~10 min lag
      x.play('61', { end: at(15, 55), minutes: 55 }); clock.set(at(16, 5)); await h.sync(acc.id);
      x.play('61', { end: at(16, 55), minutes: 60 }); clock.set(at(17, 5)); await h.sync(acc.id);
      x.play('61', { end: at(17, 40), minutes: 45 }); clock.set(at(18, 5)); await h.sync(acc.id);
      const s = h.sessions(entry().id);
      assert.equal(s.length, 1, `one real session, got ${s.map((z) => z.minutes).join('+')}`);
      assert.equal(s[0].minutes, 160);
      assert.equal(s[0].ended_at, at(17, 40));
      assert.ok(Math.abs(s[0].started_at - at(15, 0)) <= 5 * MIN);
      const week = await h.get('/stats?range=7d&estimates=exclude');
      assert.equal(week.sessions, 1);
      assert.equal(week.tracked_minutes, 160);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('more minutes than wall-clock time since the last sync: capped at the elapsed time, the excess is undated history', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await oneGame(h);
      x.play('61', { end: T0 + 50 * MIN, minutes: 500 }); // platform back-fill / offline play
      clock.set(T0 + HOUR);
      const r = await h.sync(acc.id);
      assert.equal(r.status, 200);
      const play = h.sumKind(entry().id, 'play');
      assert.ok(play > 0 && play <= 60 + 15, `${play} play minutes in a 60-minute window`);
      const late = h.sessions(entry().id, 'baseline').filter((z) => z.created_at >= T0 + HOUR);
      assert.equal(late.reduce((a, z) => a + z.minutes, 0), 500 - play, 'the excess is undated history');
      assert.equal(entry().playtime_min, 1500, 'the lifetime total follows the platform');
      const today = await h.get('/stats?range=1d&estimates=exclude');
      assert.equal(today.tracked_minutes, play, 'undated minutes never count as today');
      await invariants(h);
    } finally { await h.close(); }
  });

  test('MinutesPlayed going down (a glitch) creates no session, and nothing is counted twice when it recovers', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await oneGame(h);
      x.title('61', { minutes: 940, lastPlayed: at(18, 0) }); clock.set(at(18, 30)); await h.sync(acc.id);
      assert.equal(h.sessions(entry().id).length, 0, 'a lower total is not play');
      await invariants(h, 'after decrease:');
      x.title('61', { minutes: 1000, lastPlayed: at(19, 0) }); clock.set(at(19, 30)); await h.sync(acc.id);
      assert.equal(h.sessions(entry().id).length, 0, 'recovering to the old total is not play either');
      x.title('61', { minutes: 1030, lastPlayed: at(20, 0) }); clock.set(at(20, 30)); await h.sync(acc.id);
      const s = h.sessions(entry().id);
      assert.deepEqual(s.map((z) => z.minutes), [30], 'only play above the previous high is new');
      assert.equal(entry().playtime_min, 1030);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('a game first played after tracking started is recorded as play; one last played long ago is history', async () => {
    const h = await setup();
    try {
      const { x, acc } = await oneGame(h);
      x.title('62', { name: 'Brand New', minutes: 45, lastPlayed: at(20, 30) });
      x.title('63', { name: 'Old, just unhidden', minutes: 600, lastPlayed: T0 - 60 * DAY });
      clock.set(at(21, 5));
      await h.sync(acc.id);
      const fresh = h.entry(acc.id, '62');
      const s = h.sessions(fresh.id);
      assert.equal(s.length, 1);
      assert.equal(s[0].minutes, 45);
      assert.equal(s[0].ended_at, at(20, 30));
      assert.equal(fresh.baseline_min, 0, 'nothing of it is history');
      const old = h.entry(acc.id, '63');
      assert.equal(h.sessions(old.id).length, 0, 'last played before the previous sync -> history');
      assert.equal(old.baseline_min, 600);
      assert.equal((await h.get('/stats?range=7d&estimates=exclude')).tracked_minutes, 45);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('presence seen on the console makes the delta session exact; the post-session sync is scheduled ~10 min after it ends', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await oneGame(h);
      const console_ = [device('Scarlett', { id: '750323071', name: 'Home', placement: 'Background' }, { id: '61', name: 'Forza Horizon 5', placement: 'Full' })];
      await h.presenceSpan(x, acc.id, console_, at(18, 0), at(19, 30));
      const ended = Date.now();
      const a = await h.account(acc.id);
      assert.ok(Math.abs(a.next_sync_at - (ended + 10 * MIN)) <= 2 * MIN, `sync scheduled ${(a.next_sync_at - ended) / MIN} min after the session ended`);
      x.play('61', { end: at(19, 30), minutes: 90 });
      clock.set(a.next_sync_at);
      await h.sync(acc.id);
      const s = h.sessions(entry().id);
      assert.equal(s.length, 1);
      assert.equal(s[0].minutes, 90, 'minutes are what the platform credited');
      assert.equal(s[0].confidence, 'exact');
      assert.ok(Math.abs(s[0].started_at - at(18, 0)) <= 5 * MIN, 'start from presence');
      assert.ok(Math.abs(s[0].ended_at - at(19, 30)) <= 5 * MIN, 'end from presence');
      const now = await h.get('/now-playing');
      assert.deepEqual(now, [], 'nothing playing any more');
      await invariants(h);
    } finally { await h.close(); }
  });

  test('presence while still playing + hourly syncs: one exact session, extended by the later report', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await oneGame(h);
      const dev = [device('XboxSeries', { id: '61', name: 'Forza Horizon 5', placement: 'Full' })];
      for (let t = at(15, 0); t <= at(16, 5); t += 5 * MIN) { clock.set(t); x.setPresence(dev); await h.poll(acc.id); }
      const live = await h.get('/now-playing');
      assert.equal(live.length, 1);
      assert.equal(live[0].ext_id, '61');
      assert.equal(live[0].title, 'Forza Horizon 5');
      x.play('61', { end: at(15, 55), minutes: 55 });
      await h.sync(acc.id); // 16:05, still playing
      for (let t = at(16, 10); t <= at(17, 40); t += 5 * MIN) { clock.set(t); x.setPresence(dev); await h.poll(acc.id); }
      clock.set(at(17, 45)); x.setPresence(null); await h.poll(acc.id);
      x.play('61', { end: at(17, 40), minutes: 105 });
      clock.set(at(17, 55));
      await h.sync(acc.id);
      const s = h.sessions(entry().id);
      assert.equal(s.length, 1, `one session, got ${s.map((z) => `${z.minutes}/${z.confidence}`).join(', ')}`);
      assert.equal(s[0].minutes, 160);
      assert.equal(s[0].confidence, 'exact');
      assert.ok(Math.abs(s[0].started_at - at(15, 0)) <= 5 * MIN);
      assert.ok(Math.abs(s[0].ended_at - at(17, 40)) <= 5 * MIN);
      await invariants(h);
    } finally { await h.close(); }
  });
});

// =====================================================================================
describe('titles without a MinutesPlayed stat (PC / Game Pass): presence-tracked', () => {
  const at = (hh, mm = 0, dayOffset = 0) => Date.UTC(2026, 9, 20 + dayOffset, hh, mm);
  const pc = (id = '71', name = 'PC Game Pass Title') => [device('WindowsOneCore', { id: '750323071', name: 'Home', placement: 'Background' }, { id, name, placement: 'Background' })];

  async function unmetered(h, shape = 'absent', { presence } = {}) {
    const x = new FakeXbl();
    x.title('71', { name: 'PC Game Pass Title', minutes: shape, lastPlayed: T0 - 5 * DAY, devices: ['PC'] });
    x.title('72', { name: 'Console Game', minutes: 2000, lastPlayed: T0 - 2 * DAY });
    const acc = await h.link(x, presence ? { presence } : {});
    await h.sync(acc.id);
    return { x, acc, entry: () => h.entry(acc.id, '71') };
  }

  for (const shape of ['absent', 'novalue']) {
    test(`MinutesPlayed ${shape === 'absent' ? 'absent (empty Hero group)' : 'present without a value'}: imported with no playtime, then each finished presence span is an exact session added to the total`, async () => {
      const h = await setup();
      try {
        const { x, acc, entry } = await unmetered(h, shape);
        assert.equal(entry().playtime_min, 0, 'no made-up total');
        assert.equal(h.sessions(entry().id, 'all').length, 0);
        const sample = (await h.account(acc.id)).missing_minutes_samples;
        assert.ok(Array.isArray(sample) && sample.some((s) => s.title_id === '71'), 'the reply outline is kept for diagnostics');
        assert.ok(!sample.some((s) => s.title_id === '72'));
        if (shape === 'novalue') assert.deepEqual(sample.find((s) => s.title_id === '71').minutes_stat?.value ?? null, null);

        await h.presenceSpan(x, acc.id, pc(), at(20, 0), at(20, 45));
        const s = h.sessions(entry().id);
        assert.equal(s.length, 1);
        assert.equal(s[0].confidence, 'exact');
        assert.ok(Math.abs(s[0].minutes - 45) <= 5, `${s[0].minutes} min for a 45-minute span`);
        assert.ok(Math.abs(s[0].started_at - at(20, 0)) <= 5 * MIN && Math.abs(s[0].ended_at - at(20, 45)) <= 5 * MIN);
        assert.equal(entry().playtime_min, s[0].minutes, 'the presence session is the title\'s total');
        assert.equal((await h.get('/stats?range=1d&estimates=exclude')).tracked_minutes, s[0].minutes);

        // the post-session sync: the platform now shows the new last-played time, still no stat
        const before = statsCalls(x, '71');
        x.title('71', { lastPlayed: at(20, 45) });
        clock.set((await h.account(acc.id)).next_sync_at);
        await h.sync(acc.id);
        assert.equal(statsCalls(x, '71'), before, 'not looked up again within the weekly recheck');
        assert.equal(h.sessions(entry().id).length, 1, 'presence already covered it: no extra session');
        assert.equal(entry().playtime_min, s[0].minutes, 'the presence total is never taken away');
        await invariants(h);
      } finally { await h.close(); }
    });
  }

  test('presence missed it (presence off): one session ending at the new last-played time, marked as an estimated length; never twice', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await unmetered(h, 'absent', { presence: 'off' });
      assert.equal((await h.account(acc.id)).presence.enabled, false);
      x.title('71', { lastPlayed: at(22, 0) });
      clock.set(at(4, 5, 1));
      await h.sync(acc.id);
      const s = h.sessions(entry().id);
      assert.equal(s.length, 1);
      assert.equal(s[0].ended_at, at(22, 0), 'ends at the last-played time');
      assert.ok(s[0].minutes >= 2 && s[0].minutes <= 360, `${s[0].minutes} min`);
      assert.equal(s[0].started_at, at(22, 0) - s[0].minutes * MIN);
      assert.match(s[0].note || '', /estimat/i, 'marked as an estimated length');
      assert.notEqual(s[0].confidence, 'exact', 'not presented as exact');
      assert.equal(entry().playtime_min, s[0].minutes);
      // the same last-played time again adds nothing
      clock.advance(DAY);
      await h.sync(acc.id);
      assert.equal(h.sessions(entry().id).length, 1);
      assert.equal(entry().playtime_min, s[0].minutes);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('the estimated length is capped by the time since the previous play', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await unmetered(h, 'absent', { presence: 'off' });
      x.title('71', { lastPlayed: at(18, 0) }); clock.set(at(18, 30)); await h.sync(acc.id);
      const first = h.sessions(entry().id);
      assert.equal(first.length, 1);
      x.title('71', { lastPlayed: at(18, 45) }); clock.set(at(19, 0)); await h.sync(acc.id);
      const s = h.sessions(entry().id);
      assert.equal(s.length, 2, 'played again 45 minutes later');
      assert.equal(s[1].ended_at, at(18, 45));
      assert.ok(s[1].minutes <= 45, `${s[1].minutes} min must fit in the 45 minutes since the previous play`);
      assert.ok(s[1].started_at >= s[0].ended_at, 'no overlap with the previous session');
      assert.equal(entry().playtime_min, s[0].minutes + s[1].minutes);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('a short replay presence missed (last played moved 20 min after the previous session) is still recorded, capped by that gap', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await unmetered(h, 'absent', { presence: 'off' });
      x.title('71', { lastPlayed: at(18, 0) }); clock.set(at(18, 10)); await h.sync(acc.id);
      x.title('71', { lastPlayed: at(18, 20) }); clock.set(at(18, 30)); await h.sync(acc.id);
      const s = h.sessions(entry().id);
      assert.equal(s.length, 2, 'the title\'s last-played time moved: it was played again');
      assert.ok(s[1].minutes >= 2 && s[1].minutes <= 20);
      assert.equal(s[1].ended_at, at(18, 20));
    } finally { await h.close(); }
  });

  test('the estimated length follows the player\'s typical (median) exactly-observed session once enough are known', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await unmetered(h);
      // five evenings seen by presence: 30, 40, 50, 60 and 70 minutes
      for (const [d, len] of [[1, 30], [2, 40], [3, 50], [4, 60], [5, 70]]) {
        await h.presenceSpan(x, acc.id, pc(), at(20, 0, d), at(20, len, d));
      }
      const exact = h.playSessions(acc.id).filter((s) => s.confidence === 'exact').map((s) => s.minutes).sort((a, b) => a - b);
      assert.equal(exact.length, 5);
      const median = exact[2];
      // then a night presence did not see (container down): the last-played time moved
      x.setPresence(null);
      x.title('71', { lastPlayed: at(23, 0, 6) });
      clock.set(at(23, 30, 6));
      await h.sync(acc.id);
      const fb = h.sessions(entry().id).filter((s) => s.confidence !== 'exact');
      assert.equal(fb.length, 1);
      assert.equal(fb[0].minutes, median, `typical session ${median} min`);
      assert.equal(fb[0].ended_at, at(23, 0, 6));
      await invariants(h);
    } finally { await h.close(); }
  });

  test('with no learned sessions yet, the estimated length is the documented default typical session (120 min)', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await unmetered(h, 'absent', { presence: 'off' });
      x.title('71', { lastPlayed: at(22, 0) });
      clock.set(at(4, 5, 1));
      await h.sync(acc.id);
      const s = h.sessions(entry().id);
      assert.equal(s.length, 1);
      assert.equal(s[0].minutes, 120);
    } finally { await h.close(); }
  });

  test('the stat appears on the weekly recheck: its first value is history minus what presence tracked - nothing counted twice, no new play', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await unmetered(h);
      await h.presenceSpan(x, acc.id, pc(), at(20, 0), at(20, 45));
      const tracked = entry().playtime_min;
      assert.ok(tracked > 0);
      // within the week: played again (last played moves) - the title is not looked up
      x.title('71', { lastPlayed: at(21, 0, 2) });
      clock.set(at(22, 0, 2));
      const c0 = statsCalls(x, '71');
      await h.sync(acc.id);
      assert.equal(statsCalls(x, '71'), c0, 'no lookup before the weekly recheck');
      const fallbackMinutes = h.sumKind(entry().id, 'play') - tracked;
      // a week later the platform reports a real total
      x.title('71', { minutes: 600, lastPlayed: at(19, 0, 8) });
      clock.set(at(20, 0, 8));
      const r = await h.sync(acc.id);
      assert.equal(statsCalls(x, '71'), c0 + 1, 'rechecked once after a week');
      const e = entry();
      assert.equal(e.playtime_min, 600, 'the platform total stands');
      assert.equal(h.sumKind(e.id, 'play'), tracked + fallbackMinutes, 'tracked play unchanged');
      assert.equal(e.baseline_min, 600 - tracked - fallbackMinutes, 'the rest is pre-tracking history');
      assert.equal(r.body.sessions_created, 0, 'no new session from the first real total');
      // from now on the title behaves like any other: deltas are sessions
      x.play('71', { end: at(21, 0, 9), minutes: 30 });
      clock.set(at(21, 30, 9));
      await h.sync(acc.id);
      assert.equal(entry().playtime_min, 630);
      assert.equal(h.sumKind(e.id, 'play'), tracked + fallbackMinutes + 30);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('the stat appears lower than what presence tracked: the tracked minutes are kept, later growth is not double counted', async () => {
    const h = await setup();
    try {
      const { x, acc, entry } = await unmetered(h);
      await h.presenceSpan(x, acc.id, pc(), at(20, 0), at(20, 45));
      const tracked = entry().playtime_min;
      x.title('71', { minutes: 20, lastPlayed: at(19, 0, 8) });
      clock.set(at(20, 0, 8));
      await h.sync(acc.id);
      assert.equal(entry().playtime_min, tracked, 'nothing tracked is lost');
      assert.equal(h.sumKind(entry().id, 'play'), tracked);
      await invariants(h, 'lower stat:');
      x.title('71', { minutes: 80, lastPlayed: at(21, 0, 9) });
      clock.set(at(21, 30, 9));
      await h.sync(acc.id);
      assert.equal(entry().playtime_min, 80, 'follows the platform once it is above what we had');
      assert.ok(h.sumKind(entry().id, 'play') <= 80);
      await invariants(h);
    } finally { await h.close(); }
  });
});

// =====================================================================================
describe('presence: console vs PC, budget, failures', () => {
  const at = (hh, mm = 0, dayOffset = 0) => Date.UTC(2026, 9, 20 + dayOffset, hh, mm);

  test('console counts foreground (Full / Fill / Snapped) titles; PC also counts library games running in the background; Home and inactive titles never', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      for (const id of ['81', '82', '83', '84', '85']) x.title(id, { name: `Game ${id}`, minutes: 100, lastPlayed: T0 - 3 * DAY });
      const acc = await h.link(x);
      await h.sync(acc.id);
      x.setPresence([
        device('Scarlett',
          { id: '750323071', name: 'Home', placement: 'Background' },
          { id: '81', name: 'Game 81', placement: 'Full' },
          { id: '82', name: 'Game 82', placement: 'Background' }, // quick-resumed game behind the dashboard
          { id: '83', name: 'Game 83', placement: 'Snapped' },
          { id: '84', name: 'Game 84', placement: 'Full', state: 'Inactive' }),
        device('WindowsOneCore',
          { id: '85', name: 'Game 85', placement: 'Background' }, // a library game running on the PC
          { id: '86', name: 'Some App', placement: 'Background' }, // not a library title
          { id: '87', name: 'New PC Game', placement: 'Full' }),
      ]);
      clock.advance(5 * MIN);
      await h.poll(acc.id);
      const now = await h.get('/now-playing');
      assert.deepEqual(now.map((p) => p.ext_id).sort(), ['81', '83', '85', '87']);
      assert.equal(now.find((p) => p.ext_id === '87').title, 'New PC Game', 'a title not yet in the library is named from presence');
      assert.ok(now.every((p) => p.platform === 'xbox'));
      const pres = (await h.account(acc.id)).presence;
      assert.equal(pres.enabled, true);
      assert.equal(pres.interval_sec, 300, 'polled every 5 minutes');
      assert.equal(pres.online, 'Online');
      assert.equal(x.count('presence'), 1, 'one request per check');
    } finally { await h.close(); }
  });

  test('a game first seen by presence becomes an exact session when the next sync adds it to the library', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('61', { name: 'Old Game', minutes: 500, lastPlayed: T0 - 9 * DAY });
      const acc = await h.link(x);
      await h.sync(acc.id);
      await h.presenceSpan(x, acc.id, [device('XboxSeries', { id: '88', name: 'Day One Game', placement: 'Full' })], at(18, 0), at(19, 0));
      x.title('88', { name: 'Day One Game', minutes: 60, lastPlayed: at(19, 0) });
      clock.set((await h.account(acc.id)).next_sync_at);
      await h.sync(acc.id);
      const e = h.entry(acc.id, '88');
      const s = h.sessions(e.id);
      assert.equal(s.length, 1);
      assert.equal(s[0].minutes, 60);
      assert.equal(s[0].confidence, 'exact');
      assert.ok(Math.abs(s[0].started_at - at(18, 0)) <= 5 * MIN);
      assert.equal(e.baseline_min, 0);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('presence pauses when the hourly budget runs low (the API reports almost nothing left)', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      library(x, 2);
      const acc = await h.link(x);
      await h.sync(acc.id);
      x.useElsewhere(x.remaining() - 2); // other tools leave 2 requests in this hour
      clock.advance(5 * MIN);
      await h.poll(acc.id); // learns from the reply's headers that the quota is nearly gone
      const n = x.count('presence');
      for (let i = 0; i < 3; i++) { clock.advance(5 * MIN); await h.poll(acc.id); }
      assert.equal(x.count('presence'), n, 'no presence requests while the budget is low');
      assert.ok(!x.calls.some((c) => c.status === 429), 'never pushed into a 429');
      // OpenXBL names no reset time; at the latest an hour after the low report presence resumes
      clock.set(T0 + 5 * MIN + HOUR + MIN);
      await h.poll(acc.id);
      assert.equal(x.count('presence'), n + 1, 'presence resumes within the hour');
    } finally { await h.close(); }
  });

  test('a failing presence check is reported on the account, not retried in a loop, and recovers', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      library(x, 2);
      const acc = await h.link(x);
      await h.sync(acc.id);
      x.failNext('presence', { status: 500 });
      clock.advance(5 * MIN);
      await h.poll(acc.id);
      assert.equal(x.count('presence'), 1, 'one request, no immediate retry');
      let p = (await h.account(acc.id)).presence;
      assert.equal(p.failures, 1);
      assert.match(p.error || '', /500/);
      clock.advance(5 * MIN);
      x.setPresence([device('Scarlett', { id: '5000', name: 'Game 0', placement: 'Full' })]);
      await h.poll(acc.id);
      p = (await h.account(acc.id)).presence;
      assert.equal(p.failures, 0);
      assert.equal(p.error, null);
      assert.equal((await h.get('/now-playing')).length, 1);
    } finally { await h.close(); }
  });

  test('every request (sync, presence, enrichment, refused ones) is counted per account and hour', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      library(x, 4);
      const acc = await h.link(x);
      await h.sync(acc.id);
      clock.advance(5 * MIN);
      await h.poll(acc.id);
      x.failNext('presence', { status: 503 });
      clock.advance(5 * MIN);
      await h.poll(acc.id);
      const hourCalls = x.calls.filter((c) => c.hour === x.hour());
      const sys = (await h.get('/system')).accounts.find((a) => a.id === acc.id);
      assert.equal(sys.api_usage_hour.calls, hourCalls.length, 'the System page counts every request');
      assert.equal(sys.api_usage_hour.errors, 1);
      assert.equal(sys.api_usage_24h.calls, hourCalls.length);
      assert.equal(sys.hourly_limit, 150);
      const s = (await h.get(`/syncs?account_id=${acc.id}`))[0];
      assert.equal(s.details.api.calls, x.calls.filter((c) => c.ep === 'titleHistory' || c.ep === 'stats').length, 'the sync records its own API calls');
    } finally { await h.close(); }
  });
});

// =====================================================================================
describe('enrichment: achievements, screenshots and clips date history once the xuid is known', () => {
  test('achievement unlocks (locked ones ignored) and capture dates anchor the history; history is dated inside that evidence', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      const lp = T0 - 3 * DAY;
      x.title('91', { name: 'Halo Infinite', minutes: 3000, lastPlayed: lp, achievements: [T0 - 100 * DAY, T0 - 90 * DAY, null, T0 - 30 * DAY] });
      x.title('92', { name: 'Hi-Fi Rush', minutes: 600, lastPlayed: T0 - 20 * DAY, achievements: [] });
      x.screenshots.push({ titleId: '91', at: T0 - 95 * DAY }, { titleId: '99999', at: T0 - 10 * DAY });
      x.gameclips.push({ titleId: '91', at: T0 - 80 * DAY });
      const acc = await h.link(x);
      await h.sync(acc.id); // enrichment runs in the background after the import (settled by the harness)
      assert.equal(x.count('screenshots'), 1);
      assert.equal(x.count('gameclips'), 1);
      const ach = x.calls.filter((c) => c.ep === 'achievements');
      assert.deepEqual(ach.map((c) => c.path).sort(), [`/api/v2/achievements/player/${x.xuid}/91`, `/api/v2/achievements/player/${x.xuid}/92`]);
      const g = (await h.get('/games?q=Halo')).items[0];
      const e = (await h.get(`/games/${g.id}`)).entries[0];
      assert.equal(e.history.enriched, true);
      assert.equal(e.history.evidence.anchors, 5, '3 unlocks + 1 screenshot + 1 clip (the locked achievement is not a date)');
      const start = Date.UTC(2026, 9, 20) - 100 * DAY;
      const est = h.sessions(h.entry(acc.id, '91').id, 'estimate');
      assert.ok(est.length > 0, 'history is charted');
      for (const s of est) {
        assert.ok(s.window_start >= start - DAY, `estimate starts ${new Date(s.window_start).toISOString()}, before the first evidence`);
        assert.ok(s.window_end <= lp + DAY, 'and never after last played');
      }
      assert.equal(h.sumKind(h.entry(acc.id, '91').id, 'estimate') + h.sumKind(h.entry(acc.id, '91').id, 'baseline'), 3000);
      const sys = (await h.get('/system')).accounts.find((a) => a.id === acc.id);
      assert.equal(sys.enrichment_pending, 0);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('the same achievements replies are kept (names, gamerscore, unlock times); a title played later is read again after its sync, nothing else', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('91', { name: 'Halo Infinite', minutes: 3000, lastPlayed: T0 - 3 * DAY, achievements: [T0 - 100 * DAY, null, T0 - 30 * DAY] });
      x.title('92', { name: 'Hi-Fi Rush', minutes: 600, lastPlayed: T0 - 20 * DAY, achievements: [] });
      const acc = await h.link(x);
      await h.sync(acc.id);
      assert.equal(x.count('achievements'), 2, 'one request per title, as enrichment always made');
      const g = (await h.get('/games?q=Halo')).items[0];
      const sum = (await h.get(`/games/${g.id}`)).achievements;
      assert.deepEqual([sum.total, sum.unlocked, sum.percent, sum.points, sum.points_total, sum.completed], [3, 2, 66.6, 20, 30, false]);
      const list = await h.get(`/games/${g.id}/achievements`);
      assert.deepEqual(list.items.map((i) => [i.name, i.unlocked, i.unlocked_at, i.points]), [
        ['Achievement 3', true, T0 - 30 * DAY, 10], ['Achievement 1', true, T0 - 100 * DAY, 10], ['Achievement 2', false, null, 10]]);
      assert.equal((await h.get(`/games/${(await h.get('/games?q=Hi-Fi')).items[0].id}`)).achievements.total, 0);

      // played: the sync after it reads that title again, and its new unlock belongs to the session
      clock.advance(2 * HOUR);
      const end = Date.now() - 5 * MIN;
      x.title('91').achievements[1] = end - 15 * MIN;
      x.play('91', { end, minutes: 60 });
      const before = x.calls.length;
      await h.sync(acc.id);
      assert.deepEqual(x.callsSince(before).filter((c) => c.ep === 'achievements').map((c) => c.titleId), ['91']);
      const it = (await h.get(`/games/${g.id}/achievements`)).items.find((i) => i.name === 'Achievement 2');
      assert.deepEqual([it.unlocked, it.session_kind, it.session?.id], [true, 'tracked', h.sessions(h.entry(acc.id, '91').id)[0].id]);
      assert.equal((await h.get(`/games/${g.id}`)).achievements.completed, true);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('no xuid yet: enrichment sends nothing; once presence reveals the xuid it runs', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl({ includeXuid: false });
      x.title('91', { name: 'Halo Infinite', minutes: 3000, lastPlayed: T0 - 3 * DAY, achievements: [T0 - 100 * DAY] });
      const acc = await h.link(x);
      await h.sync(acc.id);
      const r = await h.post(`/accounts/${acc.id}/enrich?wait=true`);
      assert.equal(r.status, 200, r.text);
      assert.equal(x.count('achievements') + x.count('screenshots') + x.count('gameclips'), 0, 'nothing to ask without the xuid');
      assert.equal((await h.get('/system')).accounts.find((a) => a.id === acc.id).enrichment_pending, 1);
      clock.advance(5 * MIN);
      await h.poll(acc.id); // the presence reply carries the xuid
      const r2 = await h.post(`/accounts/${acc.id}/enrich?wait=true`);
      assert.equal(r2.status, 200, r2.text);
      assert.equal(x.count('achievements'), 1);
      assert.match(x.calls.find((c) => c.ep === 'achievements').path, new RegExp(`/achievements/player/${x.xuid}/91$`));
      const g = (await h.get('/games?q=Halo')).items[0];
      assert.equal((await h.get(`/games/${g.id}`)).entries[0].history.evidence.anchors, 1);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('enrichment stops while more than 30% of the hour is left (achievement lookups)', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl({ limit: 20 });
      for (let i = 0; i < 6; i++) x.title(String(300 + i), { name: `T${i}`, minutes: 200, lastPlayed: T0 - (i + 2) * DAY, achievements: [T0 - 50 * DAY] });
      const acc = await h.link(x, { hourly_limit: '20' });
      await h.sync(acc.id); // 7 requests, then enrichment in the background
      assert.ok(x.remaining() >= 6, `${x.remaining()} of 20 left (30% = 6)`);
      assert.ok(x.count('achievements') >= 1, 'it did use the spare budget');
      const pending = (await h.get('/system')).accounts.find((a) => a.id === acc.id).enrichment_pending;
      assert.equal(pending, 6 - x.count('achievements'), 'the rest waits for a later hour');
      // next hour, more is done
      clock.set(x.resetAt() + MIN);
      await h.post(`/accounts/${acc.id}/enrich?wait=true`);
      assert.equal((await h.get('/system')).accounts.find((a) => a.id === acc.id).enrichment_pending, 0);
      assert.ok(x.remaining() >= 6);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('enrichment never spends the last 30% of the hourly budget (screenshots / clips included)', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl({ limit: 20 });
      for (let i = 0; i < 14; i++) x.title(String(400 + i), { name: `T${i}`, minutes: 200, lastPlayed: T0 - (i + 2) * DAY });
      const acc = await h.link(x, { hourly_limit: '20' });
      await h.sync(acc.id); // 15 requests: 5 of 20 left (25%)
      assert.equal(x.count('screenshots') + x.count('gameclips') + x.count('achievements'), 0, 'enrichment waits for an hour with more than 30% left');
      assert.ok(x.remaining() >= 5);
    } finally { await h.close(); }
  });

  test('enrichment stops at a 429 and pauses the account; titles without achievements (404) are not retried; a failing title is not retried forever', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('501', { name: 'No achievements', minutes: 300, lastPlayed: T0 - 2 * DAY, achStatus: 404 });
      x.title('502', { name: 'Broken', minutes: 280, lastPlayed: T0 - 3 * DAY, achStatus: 500 });
      x.title('503', { name: 'Fine', minutes: 260, lastPlayed: T0 - 4 * DAY, achievements: [T0 - 40 * DAY] });
      const acc = await h.link(x);
      await h.sync(acc.id); // run 1
      for (let i = 0; i < 4; i++) { clock.advance(HOUR); await h.post(`/accounts/${acc.id}/enrich?wait=true`); }
      assert.equal(x.count('achievements', (c) => c.titleId === '501'), 1, '404 = no achievements: done, not asked again');
      assert.ok(x.count('achievements', (c) => c.titleId === '502') <= 3, 'a failing title is given up');
      assert.equal(x.count('achievements', (c) => c.titleId === '503'), 1);
      assert.equal((await h.get('/system')).accounts.find((a) => a.id === acc.id).enrichment_pending, 0);

      // a 429 during enrichment: stop at once, pause the account
      const y = new FakeXbl({ key: 'xbl-key-Q' });
      for (let i = 0; i < 5; i++) y.title(String(600 + i), { name: `Q${i}`, minutes: 100 + i, lastPlayed: T0 - (i + 2) * DAY, achievements: [T0 - 60 * DAY] });
      let n = 0;
      // the 2nd achievements lookup is refused: another client spent the rest of the hour just then
      y.on.achievements = () => (++n === 2 ? y.tooMany() : null);
      const acc2 = await h.link(y, {}, 'Quota');
      await h.sync(acc2.id);
      const ach = y.calls.filter((c) => c.ep === 'achievements');
      assert.equal(ach.length, 2, 'stops at the first 429');
      assert.equal(ach[1].status, 429);
      assert.equal(y.calls.indexOf(ach[1]), y.calls.length - 1, 'nothing after it');
      assert.ok(h.svc.blockedUntil(acc2.id) >= y.resetAt(), 'account paused until the reset');
      const sys = (await h.get('/system')).accounts.find((a) => a.id === acc2.id);
      assert.equal(sys.enrichment_pending, 4, 'the refused title and the rest stay queued');
      await invariants(h);
    } finally { await h.close(); }
  });
});

// =====================================================================================
describe('credential test endpoint (POST /accounts/test) only samples', () => {
  test('a big library: a handful of requests, nothing saved, the hourly budget untouched', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      library(x, 200);
      const r = await h.post('/accounts/test', { platform: 'xbox', config: { api_key: x.key } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.ok, true);
      assert.ok(x.calls.length <= 5, `${x.calls.length} requests for a test`);
      assert.equal(r.body.api_calls, x.calls.length);
      assert.match(r.body.warning || '', /Sampled a few of 200 titles/);
      assert.ok(r.body.games > 0 && r.body.games <= 5);
      assert.deepEqual(await h.get('/accounts'), [], 'nothing saved');
      assert.equal(h.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 0);
      assert.equal(h.db.prepare('SELECT COUNT(*) n FROM api_usage').get().n, 0, 'no account budget spent');
    } finally { await h.close(); }
  });

  test('a small library is fully sampled, with dates, minutes and the presence status', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('1', { name: 'Forza Horizon 5', minutes: 600, lastPlayed: T0 - DAY });
      x.title('2', { name: 'Halo Infinite', minutes: 90, lastPlayed: T0 - 2 * DAY });
      x.setPresence([device('Scarlett', { id: '1', name: 'Forza Horizon 5', placement: 'Full' })]);
      const r = await h.post('/accounts/test', { platform: 'xbox', config: { api_key: x.key } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.games, 2);
      assert.equal(r.body.played, 2);
      assert.equal(r.body.minutes, 690);
      assert.equal(r.body.with_dates, 2);
      assert.match(r.body.presence, /playing Forza Horizon 5/);
      assert.equal(r.body.warning, null);
      assert.deepEqual(r.body.sample.sort(), ['Forza Horizon 5', 'Halo Infinite']);
    } finally { await h.close(); }
  });

  test('missing key -> 400; quota used up -> an error after one request (never 2xx with made-up data)', async () => {
    const h = await setup();
    try {
      const miss = await h.post('/accounts/test', { platform: 'xbox', config: {} });
      assert.equal(miss.status, 400);
      assert.match(miss.body.error, /OpenXBL API key/);
      const x = new FakeXbl();
      library(x, 3);
      x.exhaust();
      const r = await h.post('/accounts/test', { platform: 'xbox', config: { api_key: x.key } });
      assert.ok(r.status >= 400 && r.status !== 401, `status ${r.status}`);
      assert.match(r.body.error, /rate limit|429/i);
      assert.equal(x.calls.length, 1);
    } finally { await h.close(); }
  });

  test('an invalid key is reported as bad credentials - not as a Vestigo 401 (which the UI treats as "log in again")', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl({ key: 'the-real-key' });
      library(x, 2);
      const r = await h.post('/accounts/test', { platform: 'xbox', config: { api_key: 'typo-key' } });
      assert.ok(r.status >= 400, `status ${r.status}`);
      assert.match(r.body?.error || '', /credentials|key|401/i, 'says what is wrong');
      assert.notEqual(r.status, 401, 'the Vestigo session is fine (no password is even set); only the OpenXBL key is wrong');
    } finally { await h.close(); }
  });
});

// =====================================================================================
describe('more edge cases', () => {
  const at = (hh, mm = 0, dayOffset = 0) => Date.UTC(2026, 9, 20 + dayOffset, hh, mm);

  test('presence self-calibrates the meaning of last played: after 3 observed sessions it is confirmed as the session end', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('61', { name: 'Forza Horizon 5', minutes: 1000, lastPlayed: T0 - 5 * DAY });
      const acc = await h.link(x);
      await h.sync(acc.id);
      assert.match((await h.account(acc.id)).history_model.last_played, /session end \(declared\)/);
      for (const d of [1, 2, 3]) {
        await h.presenceSpan(x, acc.id, [device('Scarlett', { id: '61', name: 'Forza Horizon 5', placement: 'Full' })], at(18, 0, d), at(18, 30, d));
        x.play('61', { end: at(18, 30, d), minutes: 30 });
        clock.set(at(18, 50, d));
        await h.sync(acc.id);
      }
      const hm = (await h.account(acc.id)).history_model;
      assert.match(hm.last_played, /session end/);
      assert.match(hm.last_played, /calibrated from 3 observed sessions/);
      assert.equal(h.sessions(h.entry(acc.id, '61').id).filter((z) => z.confidence === 'exact').length, 3);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('two "Sync now" requests at the same moment share one run: one title-history request, nothing recorded twice', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('61', { name: 'Forza Horizon 5', minutes: 1000, lastPlayed: T0 - 5 * DAY });
      const acc = await h.link(x);
      await h.sync(acc.id);
      x.play('61', { end: at(20, 30), minutes: 90 });
      clock.set(at(21, 5));
      const before = x.count('titleHistory');
      x.on.titleHistory = async () => { await new Promise((r) => setTimeout(r, 150)); return null; };
      const [a, b] = await Promise.all([h.call('POST', `/accounts/${acc.id}/sync?wait=true`, {}), h.call('POST', `/accounts/${acc.id}/sync?wait=true`, {})]);
      await h.settle();
      assert.equal(a.status, 200, a.text);
      assert.equal(b.status, 200, b.text);
      assert.equal(a.body.sync_id, b.body.sync_id, 'one shared run');
      assert.equal(x.count('titleHistory') - before, 1);
      assert.equal(h.sumKind(h.entry(acc.id, '61').id, 'play'), 90);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('a session crossing midnight counts on both days', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('61', { name: 'Forza Horizon 5', minutes: 1000, lastPlayed: T0 - 5 * DAY });
      const acc = await h.link(x);
      await h.sync(acc.id);
      x.play('61', { end: at(1, 0, 1), minutes: 120 }); // Tue 23:00 -> Wed 01:00
      clock.set(at(4, 5, 1));
      await h.sync(acc.id);
      const st = await h.get('/stats?range=7d&estimates=exclude&group=day');
      const day = (k) => st.series.find((s) => s.key === k)?.minutes;
      assert.equal(day('2026-10-20'), 60);
      assert.equal(day('2026-10-21'), 60);
      assert.equal(st.sessions, 1);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('changing the API key keeps the library; sending the masked key back changes nothing', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl({ key: 'old-key-0001' });
      library(x, 4);
      const acc = await h.link(x);
      await h.sync(acc.id);
      const totals = h.entries(acc.id).map((e) => [e.ext_id, e.playtime_min]);
      // the UI sends the masked value back untouched
      const masked = (await h.account(acc.id)).config.api_key;
      const p1 = await h.patch(`/accounts/${acc.id}`, { config: { api_key: masked } });
      assert.equal(p1.status, 200);
      clock.advance(HOUR);
      assert.equal((await h.sync(acc.id)).status, 200, 'still syncing with the stored key');
      // a real key change
      const p2 = await h.patch(`/accounts/${acc.id}`, { config: { api_key: 'new-key-0002' } });
      assert.equal(p2.status, 200);
      assert.ok(!JSON.stringify(p2.body).includes('new-key-0002'), 'the key is never echoed');
      x.key = 'new-key-0002';
      clock.advance(HOUR);
      const r = await h.sync(acc.id);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(h.entries(acc.id).map((e) => [e.ext_id, e.playtime_min]), totals, 'same entries, same totals, no duplicates');
      assert.equal(h.playSessions(acc.id).length, 0, 'nothing re-counted as play');
      assert.equal(h.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 4);
      await invariants(h);
    } finally { await h.close(); }
  });

  test('a huge lifetime total is history with no charted day over the 10 h per-game cap, nothing after last played', async () => {
    const h = await setup();
    try {
      const x = new FakeXbl();
      x.title('99', { name: 'Minecraft', minutes: 3_000_000, lastPlayed: T0 - 3 * DAY });
      const acc = await h.link(x);
      await h.sync(acc.id);
      const e = h.entry(acc.id, '99');
      assert.equal(e.playtime_min, 3_000_000);
      assert.equal(h.sumKind(e.id, 'play'), 0);
      await h.get('/health');
      const over = h.db.prepare('SELECT day, SUM(minutes) m FROM play_days WHERE estimated = 1 GROUP BY day HAVING SUM(minutes) > 600.5').all();
      assert.deepEqual(over, [], 'no day of estimated history over 10 hours');
      assert.equal(h.sumKind(e.id, 'estimate') + h.sumKind(e.id, 'baseline'), 3_000_000, 'dated or undated, every minute is history');
      const last = h.db.prepare("SELECT MAX(window_end) t FROM sessions WHERE entry_id = ? AND kind = 'estimate'").get(e.id).t;
      assert.ok(last <= T0 - 3 * DAY + DAY, 'nothing dated after last played');
      assert.equal((await h.get('/stats/lifetime')).total_minutes, 3_000_000);
      await invariants(h);
    } finally { await h.close(); }
  });
});

// =====================================================================================
// Last on purpose: it starts the real scheduler (first tick ~5 s after start()).
describe('scheduler (real tick)', () => {
  const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

  test('the scheduler runs the hourly back-fill, and leaves a paused account and a presence-off account alone', async () => {
    const h = await setup();
    try {
      // A: a first import bigger than its plan (20/h)
      const a = new FakeXbl({ key: 'key-A', limit: 20 });
      for (let i = 0; i < 30; i++) a.title(String(1000 + i), { name: `A${i}`, minutes: 50 + i, lastPlayed: T0 - DAY - i * HOUR });
      const accA = await h.link(a, { hourly_limit: '20' }, 'A');
      await h.sync(accA.id);
      const deferredBefore = 30 - h.entries(accA.id).length;
      assert.ok(deferredBefore > 0);
      // B: syncs hourly; its quota will be used up
      const b = new FakeXbl({ key: 'key-B' });
      library(b, 2, { idBase: 8000 });
      const rb = await h.post('/accounts', { platform: 'xbox', name: 'B', config: { api_key: b.key }, schedule: { schedule_mode: 'hourly' }, sync: false });
      assert.equal(rb.status, 200, rb.text);
      await h.sync(rb.body.id);
      // C: presence off, daily
      const c = new FakeXbl({ key: 'key-C' });
      library(c, 2, { idBase: 9000 });
      const accC = await h.link(c, { presence: 'off' }, 'C');
      await h.sync(accC.id);

      // an hour later: A's back-fill is due; B's hourly sync is due too, but B just hit a 429
      clock.set((await h.account(accA.id)).next_sync_at + MIN);
      b.exhaust();
      assert.equal((await h.sync(rb.body.id)).status, 429);
      const bCalls = b.calls.length;
      const cCalls = c.calls.length;
      const aSyncs = h.db.prepare('SELECT COUNT(*) n FROM syncs WHERE account_id = ?').get(accA.id).n;

      h.svc.start();
      const deadline = performance.now() + 12_000;
      let backfill = null;
      while (performance.now() < deadline) {
        backfill = h.db.prepare("SELECT * FROM syncs WHERE account_id = ? AND id > (SELECT MAX(id) FROM syncs WHERE account_id = ? AND trigger != 'backfill') AND finished_at IS NOT NULL").get(accA.id, accA.id);
        if (backfill && a.count('presence') >= 1) break;
        await realSleep(100);
      }
      await h.settle();
      assert.ok(backfill, 'the scheduler ran a sync for A');
      assert.equal(backfill.trigger, 'backfill');
      assert.ok(h.db.prepare('SELECT COUNT(*) n FROM syncs WHERE account_id = ?').get(accA.id).n > aSyncs);
      assert.ok(30 - h.entries(accA.id).length < deferredBefore, 'deferred titles were fetched');
      assert.equal(h.playSessions(accA.id).length, 0, 'still history');
      assert.ok(a.count('presence') >= 1, 'presence is polled for a healthy account');
      assert.equal(b.calls.length, bCalls, 'the paused account gets no sync and no presence request');
      assert.equal(h.db.prepare('SELECT COUNT(*) n FROM syncs WHERE account_id = ? AND trigger != ?').get(rb.body.id, 'manual').n, 0, 'no scheduled sync for B');
      assert.equal(c.calls.length, cCalls, 'presence off: never polled; its daily sync is not due');
      await invariants(h);
    } finally {
      // stop the scheduler and the server; the in-memory database stays open for the
      // scheduler's own pending timers
      await h.settle().catch(() => {});
      h.svc.stop();
      h.instance.server.close();
      restoreFetch();
      clock.restore();
    }
  });
});
