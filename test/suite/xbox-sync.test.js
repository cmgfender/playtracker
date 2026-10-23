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
  MIN, HOUR, DAY, T0, clock, FakeXbl, device, setup, unbalanced, badRollups, futureSessions, unexpectedHosts, HOME_IDS,
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
const playMinutes = (h, accountId) => h.playSessions(accountId).reduce((a, s) => a + s.minutes, 0);

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

  test('a title with MinutesPlayed 0 and an unchanged last-played time is not looked up again on every sync', { todo: 'APP BUG xbox-sync-1: titles whose stat is 0 are re-queried on every sync (budget waste)' }, async () => {
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

  test('a library with more never-played (0-minute) titles than one hour\'s budget still finishes its back-fill', { todo: 'APP BUG xbox-sync-1 (consequence): 0-minute titles are looked up again every hour and starve the deferred ones forever' }, async () => {
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

  test('play after tracking started stays play even when its lookup had to wait for the next hour', { todo: 'APP BUG xbox-sync-2: a new title whose stats lookup was deferred on a later sync is filed as history, not play' }, async () => {
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
