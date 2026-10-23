// Library area: games and entries API, merge/split/move/delete, auto-grouping and the
// Duplicates feature. Black-box through the HTTP API; expectations come from README.md,
// docs/PLATFORMS.md and the API route summaries, never from the implementation.
//
// Run: node --disable-warning=ExperimentalWarning --test test/suite/library.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, installFetchMock, steamApiMock, sleep, MIN, DAY } from './helpers/library-harness.js';

// every time in this file is relative to one captured instant
const NOW = Date.now();
const iso = (t) => new Date(t).toISOString();
const sec = (t) => Math.floor(t / 1000);
const ids = (items) => items.map((x) => x.id);
const pairOf = (suggestions, a, b) => suggestions.find((s) => {
  const g = s.games.map((x) => x.id).sort((x, y) => x - y);
  return g[0] === Math.min(a, b) && g[1] === Math.max(a, b);
});

function assertConsistent(t, label = '') {
  assert.deepEqual(t.sessionSumViolations(), [], `${label} every entry's sessions must add up to its playtime`);
  assert.deepEqual(t.orphans(), { entries: 0, sessions: 0, play_days: 0, empty_games: 0 }, `${label} no orphaned rows / empty games`);
}

// =====================================================================================
describe('manual games: create', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(() => t.close());

  test('a new manual game has one manual entry, no playtime, and appears in the library', async () => {
    const g = await t.createGame('Celeste');
    assert.ok(Number.isInteger(g.id) && g.id > 0);
    assert.equal(g.title, 'Celeste');
    assert.equal(g.minutes, 0);
    assert.equal(g.favorite, false);
    assert.equal(g.hidden, false);
    assert.equal(g.entries.length, 1);
    assert.equal(g.entries[0].platform, 'manual');
    assert.equal(g.entries[0].account_id, null);
    assert.equal(g.entries[0].playtime_min, 0);
    assert.equal(g.entries[0].excluded, false);
    assert.deepEqual(g.platforms, ['manual']);
    assert.equal(g.summary.total_minutes, 0);
    assert.equal(g.summary.sessions, 0);
    const l = await t.list();
    assert.deepEqual(ids(l.items), [g.id]);
    assert.equal(l.total, 1);
    assert.equal((await t.get(`/games/${g.id}`)).status, 200);
    assertConsistent(t);
  });

  test('title is required: missing, empty and whitespace-only titles are rejected with 400 and nothing is created', async () => {
    const before_ = (await t.list()).total;
    for (const body of [{}, { title: '' }, { title: '   ' }, { title: null }, { cover_url: 'https://x/y.jpg' }]) {
      const r = await t.post('/games', body);
      assert.equal(r.status, 400, `body ${JSON.stringify(body)}`);
      assert.ok(r.data && typeof r.data.error === 'string' && r.data.error.length > 0, 'a readable error message');
    }
    assert.equal((await t.list()).total, before_);
  });

  test('a malformed JSON body is rejected with 400 and nothing is created', async () => {
    const before_ = (await t.list()).total;
    const r = await t.call('/games', { method: 'POST', body: '{"title": "Broken', raw: true });
    assert.equal(r.status, 400);
    assert.equal((await t.list()).total, before_);
  });

  test('surrounding whitespace is trimmed from the title', async () => {
    const g = await t.createGame('   Outer Wilds   ');
    assert.equal(g.title, 'Outer Wilds');
    assert.ok((await t.titles('q=outer')).includes('Outer Wilds'));
  });

  test('a valid status and cover given at creation are stored', async () => {
    const g = await t.createGame('Tunic', { status: 'backlog', cover_url: 'https://img.example/tunic.jpg' });
    assert.equal(g.status, 'backlog');
    assert.equal(g.cover_url, 'https://img.example/tunic.jpg');
    const d = await t.game(g.id);
    assert.equal(d.status, 'backlog');
    assert.deepEqual(ids((await t.list('status=backlog')).items), [g.id]);
  });

  test('an unknown status at creation is never stored', async () => {
    const r = await t.post('/games', { title: 'Inside', status: 'nope' });
    assert.ok(r.status === 400 || (r.status === 200 && r.data.status !== 'nope'), `got ${r.status} ${r.data?.status}`);
    if (r.status === 200) assert.equal((await t.list('status=nope')).total, 0);
  });

  test('adding a title that already exists joins the existing game instead of duplicating it', async () => {
    const a = await t.createGame('Hollow Knight');
    const count = (await t.list()).total;
    const b = await t.createGame('Hollow Knight');
    assert.equal(b.id, a.id);
    assert.equal((await t.list()).total, count);
    assert.equal(b.entries.length, 1, 'no second manual entry for the same game');
  });

  test('merge:false forces a separate game with the same title', async () => {
    const a = await t.createGame('Doom');
    const b = await t.createGame('Doom', { merge: false });
    assert.notEqual(a.id, b.id);
    const doom = (await t.list('q=doom')).items;
    assert.equal(doom.length, 2);
    assertConsistent(t);
  });

  test('non-ASCII titles round-trip exactly and a very long title never causes a server error', async () => {
    const g = await t.createGame('Pokémon Legends: Arceus');
    assert.equal((await t.game(g.id)).title, 'Pokémon Legends: Arceus');
    assert.ok((await t.titles(`q=${encodeURIComponent('Pokémon')}`)).includes('Pokémon Legends: Arceus'));
    const long = 'Long '.repeat(1000).trim();
    const r = await t.post('/games', { title: long });
    assert.ok(r.status === 200 || r.status === 400, `status ${r.status}`);
    if (r.status === 200) assert.ok(r.data.title.length > 0);
  });

  test('a non-string title (object) is rejected instead of being stored as text', { todo: 'APP BUG library-6: POST /games stores an object title as "[object Object]"' }, async () => {
    const r = await t.post('/games', { title: { name: 'Hades' } });
    assert.equal(r.status, 400);
    assert.equal((await t.list(`q=${encodeURIComponent('[object')}`)).total, 0);
  });
});

// =====================================================================================
describe('library listing: sorting, filters, totals and paging', () => {
  let t; const G = {};
  before(async () => {
    t = await startApp();
    // distinct "added" times: create one game at a time
    G.alpha = (await t.createGame('Alpha Centauri', { status: 'completed' })).id;
    await t.patch(`/games/${G.alpha}`, { rating: 6 });
    await t.logSession(G.alpha, 300, NOW - 20 * DAY);
    await sleep(5);
    G.baldur = (await t.createGame("Baldur's Gate 3", { status: 'playing' })).id;
    await t.patch(`/games/${G.baldur}`, { rating: 10, favorite: true });
    await t.logSession(G.baldur, 840, NOW - 30 * DAY);
    await t.logSession(G.baldur, 60, NOW - DAY);
    await sleep(5);
    G.celeste = (await t.createGame('celeste', { status: 'beaten' })).id;
    await t.logSession(G.celeste, 120, NOW - 3 * DAY);
    await sleep(5);
    G.dead = (await t.createGame('Dead Cells', { status: 'backlog' })).id;
    await sleep(5);
    G.factorio = (await t.createGame('Factorio')).id;
    await t.logSession(G.factorio, 50, NOW - 2 * DAY);
    await t.patch(`/games/${G.factorio}`, { hidden: true });
    await sleep(5);
    await t.importGames([
      { title: 'Elden Ring', platform: 'psn', playtime_minutes: 600, last_played: iso(NOW - 40 * DAY) },
      { title: 'Grim Fandango', platform: 'switch', playtime_minutes: 200 },
    ]);
    const all = (await t.list('hidden=true&limit=100')).items;
    G.elden = all.find((g) => g.title === 'Elden Ring').id;
    G.grim = all.find((g) => g.title === 'Grim Fandango').id;
    await t.patch(`/games/${G.elden}`, { rating: 8 });
  });
  after(() => t.close());

  const VISIBLE = 6; // Factorio is hidden
  const order = async (qs) => ids((await t.list(qs)).items);

  test('the default listing hides hidden games and reports totals of what matches', async () => {
    const l = await t.list();
    assert.equal(l.total, VISIBLE);
    assert.equal(l.items.length, VISIBLE);
    assert.ok(!ids(l.items).includes(G.factorio));
    assert.equal(l.total_minutes, 300 + 900 + 120 + 0 + 600 + 200);
    assert.equal(l.max_minutes, 900);
    assertConsistent(t);
  });

  test('per-game list fields: minutes, recent minutes, last played, platforms, flags', async () => {
    const b = (await t.list()).items.find((g) => g.id === G.baldur);
    assert.equal(b.minutes, 900);
    assert.equal(b.recent_minutes, 60, 'only the session within the last 14 days is recent');
    assert.equal(b.last_played_at, NOW - DAY + 60 * MIN, 'last played = end of the latest session');
    assert.equal(b.favorite, true);
    assert.equal(b.rating, 10);
    assert.equal(b.status, 'playing');
    assert.deepEqual(b.platforms, ['manual']);
    assert.equal(b.entry_count, 1);
    const a = (await t.list()).items.find((g) => g.id === G.alpha);
    assert.equal(a.recent_minutes, 0, 'a session 20 days ago is not recent');
    const e = (await t.list()).items.find((g) => g.id === G.elden);
    assert.deepEqual(e.platforms, ['psn']);
    assert.equal(e.minutes, 600);
  });

  test('sort=title is alphabetical and case-insensitive', async () => {
    assert.deepEqual(await order('sort=title'), [G.alpha, G.baldur, G.celeste, G.dead, G.elden, G.grim]);
  });

  test('sort=playtime puts the most played first', async () => {
    assert.deepEqual(await order('sort=playtime'), [G.baldur, G.elden, G.alpha, G.grim, G.celeste, G.dead]);
  });

  test('sort=rating puts the best rated first and unrated games last', async () => {
    const o = await order('sort=rating');
    assert.deepEqual(o.slice(0, 3), [G.baldur, G.elden, G.alpha]);
    assert.deepEqual(new Set(o.slice(3)), new Set([G.celeste, G.dead, G.grim]));
  });

  test('sort=recent puts the most recently played first and never-dated games last', async () => {
    const o = await order('sort=recent');
    assert.deepEqual(o.slice(0, 4), [G.baldur, G.celeste, G.alpha, G.elden]);
    assert.deepEqual(new Set(o.slice(4)), new Set([G.grim, G.dead]));
  });

  test('sort=trending ranks by minutes played in the last 14 days', async () => {
    const items = (await t.list('sort=trending')).items;
    assert.deepEqual(ids(items).slice(0, 2), [G.celeste, G.baldur]);
    for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].recent_minutes >= items[i].recent_minutes, 'recent minutes never increase down the list');
    assert.equal(items.find((g) => g.id === G.celeste).recent_minutes, 120);
  });

  test('sort=added puts the newest additions first', async () => {
    const items = (await t.list('sort=added')).items;
    for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].created_at >= items[i].created_at, 'created_at never increases down the list');
    const pos = (id) => ids(items).indexOf(id);
    assert.ok(pos(G.dead) < pos(G.celeste) && pos(G.celeste) < pos(G.baldur) && pos(G.baldur) < pos(G.alpha));
    assert.equal(ids(items).at(-1), G.alpha, 'the first game added is last');
  });

  test('without ?sort the configured default library sort applies; an unknown sort falls back cleanly', async () => {
    assert.deepEqual(await order(''), await order('sort=recent'), 'default setting is "recent"');
    const s = await t.put('/settings', { default_library_sort: 'title' });
    assert.equal(s.status, 200);
    assert.deepEqual(await order(''), await order('sort=title'));
    const bad = await t.get('/games?sort=' + encodeURIComponent('title; DROP TABLE games'));
    assert.equal(bad.status, 200);
    assert.deepEqual(new Set(ids(bad.data.items)), new Set(await order('sort=title')));
    assert.equal((await t.list()).total, VISIBLE, 'library intact');
    await t.put('/settings', { default_library_sort: 'recent' });
  });

  test('status filter, single and comma list', async () => {
    assert.deepEqual(await order('status=completed'), [G.alpha]);
    assert.deepEqual(new Set(await order('status=beaten,backlog')), new Set([G.celeste, G.dead]));
    assert.deepEqual(await order('status=dropped'), []);
  });

  test('platform filter, single and comma list', async () => {
    assert.deepEqual(await order('platform=psn'), [G.elden]);
    assert.deepEqual(new Set(await order('platform=psn,switch')), new Set([G.elden, G.grim]));
    assert.deepEqual(new Set(await order('platform=manual')), new Set([G.alpha, G.baldur, G.celeste, G.dead]));
    assert.deepEqual(await order('platform=xbox'), []);
  });

  test('played=true / played=false split the library by whether it has playtime', async () => {
    assert.deepEqual(new Set(await order('played=true')), new Set([G.alpha, G.baldur, G.celeste, G.elden, G.grim]));
    assert.deepEqual(await order('played=false'), [G.dead]);
  });

  test('favorite filter and combined filters', async () => {
    assert.deepEqual(await order('favorite=true'), [G.baldur]);
    assert.deepEqual(await order('favorite=true&status=playing'), [G.baldur]);
    assert.deepEqual(await order('favorite=true&status=completed'), []);
    assert.deepEqual(await order('played=true&platform=manual&status=beaten'), [G.celeste]);
  });

  test('hidden filter: excluded by default, hidden=true includes, hidden=only shows just hidden games', async () => {
    const all = await t.list('hidden=true');
    assert.equal(all.total, VISIBLE + 1);
    assert.ok(ids(all.items).includes(G.factorio));
    assert.deepEqual(await order('hidden=only'), [G.factorio]);
    assert.equal((await t.game(G.factorio)).hidden, true, 'a hidden game is still reachable directly');
  });

  test('recent=true lists games played in the last 14 days', async () => {
    assert.deepEqual(new Set(await order('recent=true')), new Set([G.baldur, G.celeste]));
    assert.deepEqual(new Set(await order('recent=true&hidden=true')), new Set([G.baldur, G.celeste, G.factorio]));
  });

  test('search is a case-insensitive substring match and respects other filters', async () => {
    assert.deepEqual(await order('q=CELESTE'), [G.celeste]);
    assert.deepEqual(await order('q=gate'), [G.baldur]);
    assert.deepEqual(await order(`q=${encodeURIComponent("baldur's")}`), [G.baldur]);
    const none = await t.list('q=zzzz-no-such-game');
    assert.equal(none.total, 0);
    assert.equal(none.total_minutes, 0);
    assert.deepEqual(none.items, []);
    assert.deepEqual(await order('q=factorio'), [], 'hidden games stay hidden in search');
    assert.deepEqual(await order('q=factorio&hidden=true'), [G.factorio]);
    assert.deepEqual(await order('q=e&status=completed'), [G.alpha]);
  });

  test('totals describe the whole filtered set, not just the page', async () => {
    const p = await t.list('limit=2');
    assert.equal(p.items.length, 2);
    assert.equal(p.total, VISIBLE);
    assert.equal(p.total_minutes, 2120);
    const f = await t.list('platform=psn,switch&limit=1');
    assert.equal(f.total, 2);
    assert.equal(f.total_minutes, 800);
    assert.equal(f.max_minutes, 600);
  });

  for (const sort of ['recent', 'playtime', 'title', 'added', 'rating', 'trending']) {
    test(`paging with sort=${sort} returns every game exactly once, in the same order as one big page`, async () => {
      const full = await order(`sort=${sort}&limit=100`);
      assert.equal(full.length, VISIBLE);
      const paged = [];
      for (let off = 0; off < VISIBLE + 2; off += 2) {
        const p = await t.list(`sort=${sort}&limit=2&offset=${off}`);
        assert.equal(p.total, VISIBLE);
        assert.equal(p.offset, off);
        paged.push(...ids(p.items));
      }
      assert.deepEqual(paged, full);
    });
  }

  test('paging edge cases: offset past the end, zero/negative/garbage/huge limits never error', async () => {
    const past = await t.list('offset=1000');
    assert.deepEqual(past.items, []);
    assert.equal(past.total, VISIBLE);
    for (const lim of ['0', '-1', 'abc', '999999', '1.5']) {
      const r = await t.get(`/games?limit=${lim}`);
      assert.equal(r.status, 200, `limit=${lim}`);
      assert.ok(Array.isArray(r.data.items));
      assert.ok(r.data.items.length <= Math.max(VISIBLE, 0));
      assert.equal(r.data.total, VISIBLE);
    }
    assert.equal((await t.list('limit=abc')).items.length, VISIBLE, 'garbage limit falls back to a normal page');
    assert.equal((await t.list('limit=999999')).items.length, VISIBLE);
    const neg = await t.get('/games?offset=-5');
    assert.equal(neg.status, 200);
    assert.equal(neg.data.items.length, VISIBLE);
  });

  test('game detail: entries, sessions newest first and a summary that adds up', async () => {
    const d = await t.game(G.baldur);
    assert.equal(d.id, G.baldur);
    assert.equal(d.summary.total_minutes, 900);
    assert.equal(d.summary.tracked_minutes, 900);
    assert.equal(d.summary.sessions, 2);
    assert.equal(d.summary.avg_session_minutes, 450);
    assert.equal(d.summary.longest_session_minutes, 840);
    assert.equal(d.summary.tracked_minutes + d.summary.estimated_minutes + d.summary.baseline_minutes, d.summary.total_minutes);
    assert.deepEqual(d.sessions.map((s) => s.minutes), [60, 840], 'newest session first');
    assert.equal(d.sessions[0].started_at, NOW - DAY);
    assert.equal(d.sessions[0].ended_at, NOW - DAY + 60 * MIN);
    assert.equal(d.entries.length, 1);
  });

  test('game detail of imported history: total is history, none of it is tracked play', async () => {
    const d = await t.game(G.elden);
    assert.equal(d.summary.total_minutes, 600);
    assert.equal(d.summary.tracked_minutes, 0);
    assert.equal(d.summary.sessions, 0, 'history never counts as sessions');
    assert.equal(d.summary.estimated_minutes + d.summary.baseline_minutes, 600);
    assert.equal(d.entries[0].platform, 'psn');
    assert.equal(d.entries[0].history?.minutes, 600);
  });

  test('game detail of an unknown or malformed id is a 404', async () => {
    for (const id of ['999999', 'abc', '0', '-1']) {
      const r = await t.get(`/games/${id}`);
      assert.equal(r.status, 404, `id ${id}`);
      assert.ok(r.data.error);
    }
  });
});

// =====================================================================================
// The 14-day "recent" window (recent=true, trending, recent_minutes) is about local days, so
// run it in a DST-observing zone, a far-east zone and UTC. Margins (12 vs 16 days) keep the
// test stable even if local midnight passes while it runs.
for (const tz of ['America/New_York', 'Pacific/Auckland', 'UTC']) {
  describe(`recent / trending window in ${tz}`, () => {
    let t; let prevTz; const G = {};
    const localAt = (daysAgo, h, m = 0) => { const d = new Date(NOW); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, h, m).getTime(); };
    before(async () => {
      prevTz = process.env.TZ;
      process.env.TZ = tz;
      t = await startApp();
      G.inside = (await t.createGame('Inside Window')).id;
      await t.logSession(G.inside, 60, localAt(12, 12));
      G.outside = (await t.createGame('Outside Window')).id;
      await t.logSession(G.outside, 500, localAt(16, 12));
      G.midnight = (await t.createGame('Past Midnight')).id;
      await t.logSession(G.midnight, 60, localAt(2, 23, 30)); // 23:30 -> 00:30 next day
    });
    after(() => {
      t.close();
      if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
    });

    test('recent=true lists only games played within the last 14 days', async () => {
      assert.deepEqual(new Set(ids((await t.list('recent=true')).items)), new Set([G.inside, G.midnight]));
    });

    test('recent minutes count every minute inside the window, including a session crossing midnight', async () => {
      const items = (await t.list('sort=trending')).items;
      const by = Object.fromEntries(items.map((g) => [g.id, g]));
      assert.equal(by[G.inside].recent_minutes, 60);
      assert.equal(by[G.midnight].recent_minutes, 60);
      assert.equal(by[G.outside].recent_minutes, 0);
      assert.equal(ids(items).at(-1), G.outside, 'more total minutes never beat recent play in trending');
      assert.equal(by[G.midnight].last_played_at, localAt(2, 23, 30) + 60 * MIN);
    });

    test('sort=recent follows the last session end', async () => {
      assert.deepEqual(ids((await t.list('sort=recent')).items), [G.midnight, G.inside, G.outside]);
      assertConsistent(t);
    });
  });
}

// =====================================================================================
describe('search edge cases', () => {
  let t;
  before(async () => {
    t = await startApp();
    for (const title of ['100% Orange Juice', 'Hades', 'Celeste', 'The Witcher 3: Wild Hunt']) await t.createGame(title);
  });
  after(() => t.close());

  test('ordinary searches match substrings only', async () => {
    assert.deepEqual(await t.titles('q=witcher'), ['The Witcher 3: Wild Hunt']);
    assert.deepEqual(await t.titles('q=100'), ['100% Orange Juice']);
    assert.deepEqual(await t.titles('q=xyz'), []);
  });

  test('"%" and "_" in a search are literal characters, not wildcards', { todo: 'APP BUG library-3: search passes q into LIKE unescaped, so "%" or "_" match every game' }, async () => {
    assert.deepEqual(await t.titles(`q=${encodeURIComponent('%')}`), ['100% Orange Juice']);
    assert.deepEqual(await t.titles(`q=${encodeURIComponent('_')}`), []);
  });
});

// =====================================================================================
describe('updating a game', () => {
  let t; let id;
  before(async () => {
    t = await startApp();
    id = (await t.createGame('Outer Wilds')).id;
    await t.createGame('Other Game');
  });
  after(() => t.close());

  test('every documented status is accepted, persisted and filterable', async () => {
    for (const status of ['playing', 'backlog', 'beaten', 'completed', 'dropped']) {
      const r = await t.patch(`/games/${id}`, { status });
      assert.equal(r.status, 200, status);
      assert.equal(r.data.status, status);
      assert.equal((await t.game(id)).status, status);
      assert.deepEqual(ids((await t.list(`status=${status}`)).items), [id]);
    }
  });

  test('an invalid status is rejected with 400 and leaves the game unchanged', async () => {
    await t.patch(`/games/${id}`, { status: 'completed' });
    for (const status of ['nope', '', 'COMPLETED ', 42, null]) {
      const r = await t.patch(`/games/${id}`, { status });
      assert.equal(r.status, 400, `status ${JSON.stringify(status)}`);
    }
    assert.equal((await t.game(id)).status, 'completed');
  });

  test('rating: set, partial update keeps other fields, null clears', async () => {
    await t.patch(`/games/${id}`, { notes: 'keep me', status: 'beaten' });
    let r = await t.patch(`/games/${id}`, { rating: 8 });
    assert.equal(r.status, 200);
    assert.equal(r.data.rating, 8);
    assert.equal(r.data.notes, 'keep me', 'fields not in the body are untouched');
    assert.equal(r.data.status, 'beaten');
    r = await t.patch(`/games/${id}`, { rating: null });
    assert.equal(r.data.rating, null);
  });

  test('ratings outside 0..10 are never stored', async () => {
    for (const rating of [15, -3, 1e9]) {
      const r = await t.patch(`/games/${id}`, { rating });
      assert.ok(r.status === 400 || r.status === 200, `rating ${rating}: ${r.status}`);
      const g = await t.game(id);
      assert.ok(g.rating === null || (g.rating >= 0 && g.rating <= 10), `rating ${rating} stored as ${g.rating}`);
    }
  });

  test('a non-numeric rating never wipes the existing rating', { todo: 'APP BUG library-4: PATCH rating "abc" turns into NaN and silently clears the stored rating' }, async () => {
    await t.patch(`/games/${id}`, { rating: 8 });
    const r = await t.patch(`/games/${id}`, { rating: 'abc' });
    assert.ok(r.status === 400 || r.status === 200);
    assert.equal((await t.game(id)).rating, 8);
  });

  test('notes: set, then clear', async () => {
    let r = await t.patch(`/games/${id}`, { notes: 'Finished the Eye. Line 2 ✓' });
    assert.equal(r.data.notes, 'Finished the Eye. Line 2 ✓');
    assert.equal((await t.game(id)).notes, 'Finished the Eye. Line 2 ✓');
    r = await t.patch(`/games/${id}`, { notes: '' });
    assert.ok(r.data.notes === null || r.data.notes === '');
  });

  test('favorite toggles and drives the favorite filter', async () => {
    let r = await t.patch(`/games/${id}`, { favorite: true });
    assert.equal(r.data.favorite, true);
    assert.deepEqual(ids((await t.list('favorite=true')).items), [id]);
    r = await t.patch(`/games/${id}`, { favorite: false });
    assert.equal(r.data.favorite, false);
    assert.deepEqual((await t.list('favorite=true')).items, []);
  });

  test('hidden removes the game from the library listing but not from the database', async () => {
    const r = await t.patch(`/games/${id}`, { hidden: true });
    assert.equal(r.data.hidden, true);
    assert.ok(!ids((await t.list()).items).includes(id));
    assert.deepEqual(ids((await t.list('hidden=only')).items), [id]);
    assert.equal((await t.get(`/games/${id}`)).status, 200);
    await t.patch(`/games/${id}`, { hidden: false });
    assert.ok(ids((await t.list()).items).includes(id));
  });

  test('cover: set and clear', async () => {
    let r = await t.patch(`/games/${id}`, { cover_url: 'https://img.example/ow.png' });
    assert.equal(r.data.cover_url, 'https://img.example/ow.png');
    assert.equal((await t.list()).items.find((g) => g.id === id).cover_url, 'https://img.example/ow.png');
    r = await t.patch(`/games/${id}`, { cover_url: '' });
    assert.equal(r.data.cover_url, null);
  });

  test('renaming changes the title everywhere, including search', async () => {
    const r = await t.patch(`/games/${id}`, { title: 'Outer Wilds: Echoes of the Eye' });
    assert.equal(r.status, 200);
    assert.equal((await t.game(id)).title, 'Outer Wilds: Echoes of the Eye');
    assert.deepEqual(ids((await t.list('q=echoes')).items), [id]);
    await t.patch(`/games/${id}`, { title: 'Outer Wilds' });
    assert.deepEqual(ids((await t.list('q=echoes')).items), []);
  });

  test('an empty body changes nothing; an unknown game is a 404', async () => {
    const before_ = await t.game(id);
    const r = await t.patch(`/games/${id}`, {});
    assert.equal(r.status, 200);
    for (const k of ['title', 'status', 'rating', 'notes', 'favorite', 'hidden', 'cover_url']) assert.deepEqual(r.data[k], before_[k], k);
    assert.equal((await t.patch('/games/999999', { status: 'playing' })).status, 404);
    assert.equal((await t.patch('/games/abc', { status: 'playing' })).status, 404);
  });

  test('renaming to an empty title is rejected and keeps the old title', { todo: 'APP BUG library-5: PATCH title "" (or null) silently renames the game to "Untitled"' }, async () => {
    for (const title of ['', '   ', null]) {
      const r = await t.patch(`/games/${id}`, { title });
      assert.ok(r.status === 400 || r.status === 200);
      assert.equal((await t.game(id)).title, 'Outer Wilds', `title ${JSON.stringify(title)}`);
    }
  });
});

// =====================================================================================
describe('excluding entries and its effect on totals', () => {
  let t; let acc; let hades; let celeste; let custom; let manual;
  before(async () => {
    t = await startApp();
    await t.put('/settings', { max_overage_minutes: 120 });
    acc = await t.customAccount('Switch');
    await t.report(acc.id, [{ id: 'hades', title: 'Hades', playtime_minutes: 600 }]);
    hades = (await t.list('q=hades')).items[0].id;
    await t.logSession(hades, 90, NOW - 2 * DAY);
    celeste = (await t.createGame('Celeste')).id;
    await t.logSession(celeste, 45, NOW - DAY);
    const d = await t.game(hades);
    custom = d.entries.find((e) => e.platform === 'custom');
    manual = d.entries.find((e) => e.platform === 'manual');
  });
  after(() => t.close());

  const tracked = async () => (await t.get('/stats?range=30d&estimates=exclude')).data.total_minutes;

  test('baseline: a game with a synced and a manual entry counts both', async () => {
    const d = await t.game(hades);
    assert.equal(d.entries.length, 2);
    assert.equal(d.minutes, 690);
    assert.equal(d.summary.total_minutes, 690);
    assert.equal((await t.lifetime()).total_minutes, 735);
    assert.equal(await tracked(), 135);
    assert.deepEqual(ids((await t.list(`account_id=${acc.id}`)).items), [hades]);
    assertConsistent(t);
  });

  test('excluding an entry removes it from game, library, lifetime, stats and session lists, without losing data', async () => {
    const r = await t.patch(`/entries/${manual.id}`, { excluded: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.id, hades, 'responds with the game');
    assert.equal(r.data.entries.find((e) => e.id === manual.id).excluded, true);
    assert.equal(r.data.entries.find((e) => e.id === manual.id).playtime_min, 90, 'the entry keeps its playtime');
    const d = await t.game(hades);
    assert.equal(d.minutes, 600);
    assert.equal(d.summary.total_minutes, 600);
    assert.equal(d.summary.tracked_minutes, 0);
    assert.equal(d.summary.sessions, 0);
    assert.equal((await t.list()).items.find((g) => g.id === hades).minutes, 600);
    assert.equal((await t.list()).total_minutes, 645);
    assert.equal((await t.lifetime()).total_minutes, 645);
    assert.equal(await tracked(), 45);
    const sess = (await t.get(`/sessions?game_id=${hades}`)).data;
    assert.equal(sess.total, 0, 'excluded sessions are not listed by default');
    const withEx = (await t.get(`/sessions?game_id=${hades}&include_excluded=true`)).data;
    assert.equal(withEx.total, 1);
    assert.equal(withEx.items[0].minutes, 90);
    assertConsistent(t);
  });

  test('re-including the entry restores every total exactly', async () => {
    await t.patch(`/entries/${manual.id}`, { excluded: false });
    assert.equal((await t.game(hades)).minutes, 690);
    assert.equal((await t.lifetime()).total_minutes, 735);
    assert.equal(await tracked(), 135);
    assert.equal((await t.get(`/sessions?game_id=${hades}`)).data.total, 1);
  });

  test('excluding a synced entry drops it from the account and platform totals', async () => {
    await t.patch(`/entries/${custom.id}`, { excluded: true });
    const accRow = (await t.get('/accounts')).data.find((a) => a.id === acc.id);
    assert.equal(accRow.minutes, 0);
    const plat = (await t.lifetime()).platforms.find((p) => p.platform === 'custom');
    assert.ok(!plat || plat.minutes === 0);
    assert.equal((await t.lifetime()).total_minutes, 135);
    assert.equal((await t.game(hades)).minutes, 90);
  });

  test('an exclusion survives the next sync: new play on that entry is not counted either', async () => {
    const res = await t.report(acc.id, [{ id: 'hades', title: 'Hades', playtime_minutes: 645 }]);
    assert.equal(res.minutes_added, 45);
    const d = await t.game(hades);
    assert.equal(d.entries.find((e) => e.id === custom.id).excluded, true);
    assert.equal(d.entries.find((e) => e.id === custom.id).playtime_min, 645);
    assert.equal(d.minutes, 90);
    assert.equal((await t.lifetime()).total_minutes, 135);
    assert.equal(await tracked(), 135, 'the new 45-minute session belongs to an excluded entry');
    await t.patch(`/entries/${custom.id}`, { excluded: false });
    assert.equal((await t.lifetime()).total_minutes, 780);
    assert.equal(await tracked(), 180);
    assertConsistent(t);
  });

  test('excluding every entry of a game makes it unplayed but keeps it in the library', async () => {
    await t.patch(`/entries/${(await t.game(celeste)).entries[0].id}`, { excluded: true });
    const l = await t.list();
    assert.ok(ids(l.items).includes(celeste));
    assert.equal(l.items.find((g) => g.id === celeste).minutes, 0);
    assert.ok(ids((await t.list('played=false')).items).includes(celeste));
    assert.ok(!ids((await t.list('played=true')).items).includes(celeste));
    await t.patch(`/entries/${(await t.game(celeste)).entries[0].id}`, { excluded: false });
    assert.ok(ids((await t.list('played=true')).items).includes(celeste));
  });

  test('excluding an unknown entry is a 404', async () => {
    assert.equal((await t.patch('/entries/999999', { excluded: true })).status, 404);
    assert.equal((await t.patch('/entries/abc', { excluded: true })).status, 404);
  });

  test('the string "false" never excludes an entry or hides a game', { todo: 'APP BUG library-7: boolean fields use JS truthiness, so "false" (or "0") excludes the entry / hides the game' }, async () => {
    const lifetime0 = (await t.lifetime()).total_minutes;
    const r = await t.patch(`/entries/${manual.id}`, { excluded: 'false' });
    assert.ok(r.status === 400 || r.status === 200);
    const excluded = (await t.game(hades)).entries.find((e) => e.id === manual.id).excluded;
    await t.patch(`/entries/${manual.id}`, { excluded: false }); // restore for the assertions below
    assert.equal(excluded, false, 'excluded: "false" must not exclude');
    assert.equal((await t.lifetime()).total_minutes, lifetime0);
    const h = await t.patch(`/games/${celeste}`, { hidden: 'false' });
    assert.ok(h.status === 400 || h.status === 200);
    const hidden = (await t.game(celeste)).hidden;
    await t.patch(`/games/${celeste}`, { hidden: false });
    assert.equal(hidden, false, 'hidden: "false" must not hide');
  });
});

// =====================================================================================
describe('merging games', () => {
  let t;
  before(async () => {
    t = await startApp();
    await t.put('/settings', { max_overage_minutes: 120 });
  });
  after(() => t.close());

  test('merging moves all play into the target, deletes the source and keeps every total', async () => {
    const a = await t.createGame('Hades', { status: 'completed' });
    await t.patch(`/games/${a.id}`, { rating: 9, notes: 'Platinum' });
    await t.logSession(a.id, 60, NOW - 3 * DAY);
    const b = await t.createGame('Hades: Battle Out of Hell', { cover_url: 'https://img.example/hades.jpg' });
    assert.notEqual(a.id, b.id, 'two separate games before the merge');
    await t.patch(`/games/${b.id}`, { favorite: true, notes: 'Switch copy' });
    await t.logSession(b.id, 30, NOW - 2 * DAY);
    const life0 = await t.lifetime();
    const games0 = (await t.list()).total;

    const r = await t.post(`/games/${a.id}/merge`, { source_ids: [b.id] });
    assert.equal(r.status, 200);
    assert.equal(r.data.id, a.id);
    assert.equal(r.data.minutes, 90);
    assert.equal((await t.get(`/games/${b.id}`)).status, 404, 'the source game is gone');
    assert.equal((await t.list()).total, games0 - 1);

    const d = await t.game(a.id);
    assert.equal(d.title, 'Hades', 'target keeps its title');
    assert.equal(d.summary.total_minutes, 90);
    assert.equal(d.summary.sessions, 2);
    assert.deepEqual(d.sessions.map((s) => s.minutes).sort((x, y) => x - y), [30, 60]);
    const life1 = await t.lifetime();
    assert.equal(life1.total_minutes, life0.total_minutes, 'nothing lost or counted twice');
    assert.equal(life1.tracked_minutes, life0.tracked_minutes);
    assert.equal(life1.sessions, life0.sessions);
    const st = (await t.get(`/stats?range=30d&game_id=${a.id}&estimates=exclude`)).data;
    assert.equal(st.total_minutes, 90, 'per-game stats follow the merge');
    assertConsistent(t);
  });

  test('merging keeps your organisation: target values win, gaps are filled from the source, notes and favorites are not lost', async () => {
    const d = (await t.list('q=hades')).items;
    assert.equal(d.length, 1);
    const g = await t.game(d[0].id);
    assert.equal(g.status, 'completed');
    assert.equal(g.rating, 9);
    assert.equal(g.favorite, true, 'favorite from the source is kept');
    assert.equal(g.cover_url, 'https://img.example/hades.jpg', 'missing cover filled from the source');
    assert.ok(g.notes.includes('Platinum') && g.notes.includes('Switch copy'), `notes: ${g.notes}`);
  });

  test('a target without a status or rating takes the source\'s', async () => {
    const a = await t.createGame('Tunic');
    const b = await t.createGame('Tunic (Switch copy)', { status: 'beaten', merge: false });
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.status, 'beaten', 'precondition: the target has no status of its own yet');
    assert.equal(a.rating, null, 'precondition: the target is unrated');
    await t.patch(`/games/${b.id}`, { rating: 7 });
    const r = await t.post(`/games/${a.id}/merge`, { source_ids: [b.id] });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'beaten');
    assert.equal(r.data.rating, 7);
  });

  test('several sources can be merged in one call', async () => {
    const target = await t.createGame('Persona 5 Royal');
    const srcs = [];
    for (const [i, title] of ['Persona 5 Royal (Steam copy)', 'P5R', 'Persona5 Royal'].entries()) {
      const g = await t.createGame(title, { merge: false });
      assert.notEqual(g.id, target.id);
      await t.logSession(g.id, 10 * (i + 1), NOW - (i + 1) * DAY);
      srcs.push(g.id);
    }
    await t.logSession(target.id, 100, NOW - 5 * DAY);
    const life0 = (await t.lifetime()).total_minutes;
    const r = await t.post(`/games/${target.id}/merge`, { source_ids: srcs });
    assert.equal(r.status, 200);
    assert.equal(r.data.minutes, 160);
    for (const s of srcs) assert.equal((await t.get(`/games/${s}`)).status, 404);
    assert.equal((await t.lifetime()).total_minutes, life0);
    assert.equal((await t.game(target.id)).summary.sessions, 4);
    assertConsistent(t);
  });

  test('invalid merges are rejected cleanly and change nothing', async () => {
    const a = await t.createGame('Inside');
    const b = await t.createGame('Limbo');
    const life0 = await t.lifetime();
    for (const body of [{}, { source_ids: [] }, { source_ids: [0] }]) {
      const r = await t.post(`/games/${a.id}/merge`, body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal((await t.post(`/games/${a.id}/merge`, { source_ids: String(b.id) })).status, 400, 'source_ids must be an array');
    assert.equal((await t.post('/games/999999/merge', { source_ids: [b.id] })).status, 404, 'unknown target');
    assert.equal((await t.get(`/games/${b.id}`)).status, 200, 'source untouched after a failed merge');
    const self = await t.post(`/games/${a.id}/merge`, { source_ids: [a.id] });
    assert.ok(self.status === 200 || self.status === 400);
    assert.equal((await t.get(`/games/${a.id}`)).status, 200, 'merging a game into itself never deletes it');
    const ghost = await t.post(`/games/${a.id}/merge`, { source_ids: [999999] });
    assert.ok(ghost.status < 500, `unknown source: ${ghost.status}`);
    assert.equal((await t.get(`/games/${a.id}`)).status, 200);
    assert.deepEqual(await t.lifetime(), life0);
  });

  test('merged synced entries stay merged across later syncs, and new play lands in the merged game', async () => {
    const acc1 = await t.customAccount('Steam Deck sheet');
    const acc2 = await t.customAccount('Switch sheet');
    await t.report(acc1.id, [{ id: 'itb', title: 'Into the Breach', playtime_minutes: 600 }]);
    await t.report(acc2.id, [{ id: 'itb-ae', title: 'Into the Breach: Advanced Edition', playtime_minutes: 300 }]);
    const found = (await t.list('q=breach')).items;
    assert.equal(found.length, 2, 'different titles are not auto-grouped');
    const target = found.find((g) => g.title === 'Into the Breach').id;
    const source = found.find((g) => g.title !== 'Into the Breach').id;
    const sug = pairOf((await t.dupes()).suggestions, target, source);
    assert.ok(sug, 'the pair is offered as a merge suggestion');

    const r = await t.post(`/games/${target}/merge`, { source_ids: [source] });
    assert.equal(r.status, 200);
    assert.equal(r.data.minutes, 900);
    assert.ok(!pairOf((await t.dupes()).suggestions, target, source), 'suggestion gone after merging');

    const res = await t.report(acc2.id, [{ id: 'itb-ae', title: 'Into the Breach: Advanced Edition', playtime_minutes: 345 }]);
    assert.equal(res.minutes_added, 45);
    const after_ = (await t.list('q=breach')).items;
    assert.deepEqual(ids(after_), [target], 'no separate game re-appears after the sync');
    const d = await t.game(target);
    assert.equal(d.minutes, 945);
    assert.equal(d.summary.tracked_minutes, 45);
    assert.equal(d.entries.length, 2);
    await t.report(acc1.id, [{ id: 'itb', title: 'Into the Breach', playtime_minutes: 630 }]);
    assert.equal((await t.game(target)).minutes, 975);
    assert.equal((await t.list('q=breach')).total, 1);
    assertConsistent(t);
  });

  test('merging never changes what is counted, even when one game has an excluded manual entry', { todo: 'APP BUG library-1: mergeGames folds all manual entries into the lowest-id one and ignores its excluded flag, so counted minutes become excluded (or vice versa)' }, async () => {
    const a = await t.createGame('Alpha Protocol');
    await t.logSession(a.id, 60, NOW - 3 * DAY);
    await t.patch(`/entries/${a.entries[0].id}`, { excluded: true }); // e.g. it duplicated another source
    const b = await t.createGame('Alpha Protocol (Retail)', { merge: false });
    await t.logSession(b.id, 30, NOW - 2 * DAY);
    const life0 = (await t.lifetime()).total_minutes;
    const counted0 = t.countedMinutes();
    const r = await t.post(`/games/${b.id}/merge`, { source_ids: [a.id] });
    assert.equal(r.status, 200);
    assert.equal(t.countedMinutes(), counted0, 'counted minutes unchanged by the merge');
    assert.equal((await t.lifetime()).total_minutes, life0, 'lifetime total unchanged by the merge');
    assert.equal(r.data.minutes, 30, 'the target still counts its own 30 minutes and not the excluded 60');
  });

  test('minutes you excluded stay excluded after merging that game into another', { todo: 'APP BUG library-1: the reverse direction - an excluded manual entry is folded into a counted one, so excluded (double-counted) minutes are counted again' }, async () => {
    const a = await t.createGame('Counted Game');
    await t.logSession(a.id, 30, NOW - DAY);
    const b = await t.createGame('Excluded Copy');
    await t.logSession(b.id, 60, NOW - 2 * DAY);
    await t.patch(`/entries/${b.entries[0].id}`, { excluded: true });
    const counted0 = t.countedMinutes();
    const r = await t.post(`/games/${a.id}/merge`, { source_ids: [b.id] });
    assert.equal(r.status, 200);
    assert.equal(r.data.minutes, 30, 'the excluded 60 minutes must not be counted');
    assert.equal(t.countedMinutes(), counted0);
  });
});

// =====================================================================================
describe('splitting and moving entries', () => {
  let t; let acc1; let acc2; let doom;
  before(async () => {
    t = await startApp();
    await t.put('/settings', { max_overage_minutes: 120 });
    acc1 = await t.customAccount('PC');
    acc2 = await t.customAccount('Console');
    await t.report(acc1.id, [{ id: 'doom-1993', title: 'DOOM', playtime_minutes: 600 }]);
    await t.report(acc2.id, [{ id: 'doom-2016', title: 'Doom', playtime_minutes: 300 }]);
    doom = (await t.list('q=doom')).items;
  });
  after(() => t.close());

  test('the same title from two accounts was grouped into one game', async () => {
    assert.equal(doom.length, 1);
    assert.equal(doom[0].entry_count, 2);
    assert.equal(doom[0].minutes, 900);
  });

  test('splitting an entry detaches it into its own game without changing any total', async () => {
    const life0 = (await t.lifetime()).total_minutes;
    const g = await t.game(doom[0].id);
    const e2 = g.entries.find((e) => e.account_id === acc2.id);
    const r = await t.post(`/entries/${e2.id}/split`);
    assert.equal(r.status, 200);
    assert.notEqual(r.data.id, doom[0].id, 'a new game');
    assert.equal(r.data.title, 'Doom', 'named after the entry');
    assert.deepEqual(r.data.entries.map((e) => e.id), [e2.id]);
    assert.equal(r.data.minutes, 300);
    const orig = await t.game(doom[0].id);
    assert.equal(orig.entries.length, 1);
    assert.equal(orig.minutes, 600);
    assert.equal((await t.list('q=doom')).total, 2);
    assert.equal((await t.lifetime()).total_minutes, life0);
    assertConsistent(t);
  });

  test('a split survives later syncs of both accounts', async () => {
    await t.report(acc2.id, [{ id: 'doom-2016', title: 'Doom', playtime_minutes: 330 }]);
    await t.report(acc1.id, [{ id: 'doom-1993', title: 'DOOM', playtime_minutes: 620 }]);
    const games = (await t.list('q=doom&sort=playtime')).items;
    assert.equal(games.length, 2, 'not re-grouped, no third game');
    assert.equal(games[0].id, doom[0].id);
    assert.equal(games[0].minutes, 620);
    assert.equal(games[0].entry_count, 1);
    assert.equal(games[1].minutes, 330);
    assert.equal(games[1].entry_count, 1);
    assertConsistent(t);
  });

  test('splitting the only entry of a game is a no-op; an unknown entry is a 404', async () => {
    const g = await t.game(doom[0].id);
    const count = (await t.list()).total;
    const r = await t.post(`/entries/${g.entries[0].id}/split`);
    assert.equal(r.status, 200);
    assert.equal(r.data.id, doom[0].id);
    assert.equal((await t.list()).total, count);
    assert.equal((await t.post('/entries/999999/split')).status, 404);
  });

  test('per-game stats follow a split entry', async () => {
    const p = await t.createGame('Portal');
    await t.logSession(p.id, 40, NOW - 2 * DAY);
    await t.importGames([{ title: 'Portal', platform: 'pc', playtime_minutes: 100 }]);
    const g = await t.game(p.id);
    assert.equal(g.entries.length, 2, 'import joined the existing game');
    const man = g.entries.find((e) => e.platform === 'manual');
    const s = await t.post(`/entries/${man.id}/split`);
    const statsOf = async (id) => (await t.get(`/stats?range=30d&game_id=${id}&estimates=exclude`)).data.total_minutes;
    assert.equal(await statsOf(s.data.id), 40);
    assert.equal(await statsOf(p.id), 0);
    assert.equal((await t.game(s.data.id)).summary.tracked_minutes, 40);
    assertConsistent(t);
  });

  test('moving an entry to another game keeps totals and removes the emptied game', async () => {
    const a = await t.createGame('Spelunky');
    await t.logSession(a.id, 25, NOW - DAY);
    const b = await t.createGame('Spelunky Classic HD', { merge: false });
    const life0 = (await t.lifetime()).total_minutes;
    const r = await t.post(`/entries/${a.entries[0].id}/move`, { game_id: b.id });
    assert.equal(r.status, 200);
    assert.equal(r.data.id, b.id);
    assert.equal(r.data.minutes, 25);
    assert.equal((await t.get(`/games/${a.id}`)).status, 404, 'the emptied game is removed');
    assert.equal((await t.lifetime()).total_minutes, life0);
    assertConsistent(t);
  });

  test('moving with an unknown entry or target is a 404 and changes nothing', async () => {
    const g = (await t.list('q=spelunky')).items[0];
    const before_ = await t.game(g.id);
    const e = before_.entries[0];
    const life0 = (await t.lifetime()).total_minutes;
    assert.equal((await t.post('/entries/999999/move', { game_id: g.id })).status, 404);
    assert.equal((await t.post(`/entries/${e.id}/move`, { game_id: 999999 })).status, 404);
    const missing = await t.post(`/entries/${e.id}/move`, {});
    assert.ok(missing.status >= 400 && missing.status < 500, `missing game_id: ${missing.status}`);
    const after_ = await t.game(g.id);
    assert.deepEqual(after_.entries.map((x) => x.id), before_.entries.map((x) => x.id));
    assert.equal(after_.minutes, before_.minutes);
    assert.equal((await t.lifetime()).total_minutes, life0);
  });
});

// =====================================================================================
describe('deleting games', () => {
  let t; let acc;
  before(async () => {
    t = await startApp();
    acc = await t.customAccount('Handheld');
    await t.report(acc.id, [{ id: 'ff7', title: 'Final Fantasy VII', playtime_minutes: 500 }]);
  });
  after(() => t.close());

  test('deleting a manual game removes it with all its sessions and its share of every total', async () => {
    const keep = await t.createGame('Keep Me');
    await t.logSession(keep.id, 15, NOW - DAY);
    const g = await t.createGame('Delete Me');
    await t.logSession(g.id, 70, NOW - 2 * DAY);
    await t.logSession(g.id, 20, NOW - DAY);
    const life0 = (await t.lifetime()).total_minutes;
    const tracked0 = (await t.get('/stats?range=30d&estimates=exclude')).data.total_minutes;
    const r = await t.del(`/games/${g.id}`);
    assert.equal(r.status, 200);
    assert.equal((await t.get(`/games/${g.id}`)).status, 404);
    assert.equal((await t.lifetime()).total_minutes, life0 - 90);
    assert.equal((await t.get('/stats?range=30d&estimates=exclude')).data.total_minutes, tracked0 - 90);
    assert.equal((await t.get(`/sessions?game_id=${g.id}&include_excluded=true`)).data.total, 0);
    assert.equal((await t.game(keep.id)).minutes, 15, 'other games untouched');
    assertConsistent(t);
  });

  test('a re-added title after deletion starts from zero (no leftovers)', async () => {
    const g = await t.createGame('Delete Me');
    assert.equal(g.minutes, 0);
    assert.equal(g.summary.sessions, 0);
  });

  test('a game from a synced account is protected (409) unless forced', async () => {
    const ff = (await t.list('q=final')).items[0];
    const r = await t.del(`/games/${ff.id}`);
    assert.equal(r.status, 409);
    assert.ok(r.data.error);
    assert.equal((await t.get(`/games/${ff.id}`)).status, 200);
    assert.equal((await t.game(ff.id)).minutes, 500);
    const f = await t.del(`/games/${ff.id}?force=true`);
    assert.equal(f.status, 200);
    assert.equal((await t.get(`/games/${ff.id}`)).status, 404);
    assert.equal((await t.get('/accounts')).data.find((a) => a.id === acc.id).minutes, 0);
    assertConsistent(t);
  });

  test('deleting an unknown game never errors and never touches other games', async () => {
    const count = (await t.list()).total;
    const life0 = (await t.lifetime()).total_minutes;
    const r = await t.del('/games/999999');
    assert.ok(r.status === 200 || r.status === 404, `status ${r.status}`);
    assert.equal((await t.list()).total, count);
    assert.equal((await t.lifetime()).total_minutes, life0);
  });
});

// =====================================================================================
describe('auto-grouping the same title across platforms', () => {
  let t; let a1; let a2;
  before(async () => {
    t = await startApp();
    a1 = await t.customAccount('Steam sheet');
    a2 = await t.customAccount('PS5 sheet');
  });
  after(() => t.close());

  test('platform tags and letter case are ignored: one game, every entry, summed minutes', async () => {
    await t.report(a1.id, [{ id: 'er', title: 'ELDEN RING', playtime_minutes: 600 }]);
    await t.report(a2.id, [{ id: 'er-ps5', title: 'ELDEN RING (PS5)', playtime_minutes: 1200 }]);
    const m = await t.createGame('Elden Ring');
    await t.logSession(m.id, 30, NOW - DAY);
    const found = (await t.list('q=elden')).items;
    assert.equal(found.length, 1);
    assert.equal(found[0].id, m.id, 'the manual add joined the grouped game');
    assert.equal(found[0].entry_count, 3);
    assert.equal(found[0].minutes, 1830);
    assert.deepEqual(new Set(found[0].platforms), new Set(['custom', 'manual']));
    assertConsistent(t);
  });

  test('edition suffixes are ignored (GOTY, Deluxe Edition)', async () => {
    await t.importGames([
      { title: 'The Witcher 3', platform: 'switch', playtime_minutes: 100 },
      { title: 'Witcher 3 – GOTY Edition', platform: 'pc', playtime_minutes: 2000 },
      { title: 'DOOM Eternal', platform: 'pc', playtime_minutes: 50 },
      { title: 'DOOM Eternal Deluxe Edition', platform: 'xbox', playtime_minutes: 70 },
    ]);
    const w = (await t.list('q=witcher')).items;
    assert.equal(w.length, 1);
    assert.equal(w[0].minutes, 2100);
    assert.deepEqual(new Set(w[0].platforms), new Set(['switch', 'pc']));
    const d = (await t.list('q=eternal')).items;
    assert.equal(d.length, 1);
    assert.equal(d[0].minutes, 120);
  });

  test('sequels are never grouped', async () => {
    const pairs = [['Hades', 'Hades II'], ['Civilization V', 'Civilization VI'], ['Resident Evil 2', 'Resident Evil 3'], ['Portal', 'Portal 2']];
    for (const [x, y] of pairs) {
      const gx = await t.createGame(x);
      const gy = await t.createGame(y);
      assert.notEqual(gx.id, gy.id, `${x} vs ${y}`);
    }
  });

  test('multi=true lists exactly the games with several entries', async () => {
    const multi = (await t.list('multi=true')).items.map((g) => g.title).sort();
    assert.deepEqual(multi, ['DOOM Eternal', 'ELDEN RING', 'The Witcher 3'].sort());
  });

  test('with auto-grouping turned off, a new entry with an existing title becomes its own game', async () => {
    assert.equal((await t.put('/settings', { auto_merge_titles: false })).status, 200);
    await t.report(a1.id, [{ id: 'hades', title: 'Hades', playtime_minutes: 40 }]);
    assert.equal((await t.list('q=hades&sort=title')).items.filter((g) => g.title === 'Hades').length, 2);
    await t.put('/settings', { auto_merge_titles: true });
    await t.report(a2.id, [{ id: 'hades-ps', title: 'Hades', playtime_minutes: 45 }]);
    assert.equal((await t.list('q=hades')).items.filter((g) => g.title === 'Hades').length, 2, 'turned back on: joins an existing game, adds no third one');
  });

  test('a merge-locked game does not absorb new entries with the same title', async () => {
    const c = await t.createGame('Celeste');
    const r = await t.patch(`/games/${c.id}`, { merge_locked: true });
    assert.equal(r.data.merge_locked, true);
    await t.report(a2.id, [{ id: 'celeste', title: 'Celeste', playtime_minutes: 90 }]);
    const cs = (await t.list('q=celeste')).items;
    assert.equal(cs.length, 2);
    assert.equal((await t.game(c.id)).entries.length, 1);
    assertConsistent(t);
  });
});

// =====================================================================================
describe('a live Steam account (mocked Web API) next to other sources', () => {
  let t; let restore; let mock; let steam1; let steam2; let ps;
  const S1 = '76561198000000001';
  const S2 = '76561198000000002';
  before(async () => {
    mock = steamApiMock({
      [S1]: () => [
        { appid: 1245620, name: 'ELDEN RING', playtime_forever: 600, playtime_2weeks: 0, rtime_last_played: sec(NOW - 40 * DAY), has_community_visible_stats: true },
        { appid: 1145360, name: 'Hades', playtime_forever: 900, playtime_2weeks: 0, rtime_last_played: sec(NOW - 60 * DAY) },
        { appid: 413150, name: 'Stardew Valley', playtime_forever: 300, playtime_2weeks: 0, rtime_last_played: sec(NOW - 90 * DAY) },
      ],
      [S2]: () => [
        { appid: 413150, name: 'Stardew Valley', playtime_forever: 300, playtime_2weeks: 0, rtime_last_played: sec(NOW - 90 * DAY) },
      ],
    });
    restore = installFetchMock(mock.handler);
    t = await startApp();
    // an old spreadsheet first, then the live account (the README's double-counting example)
    await t.importGames([{ title: 'Hades', platform: 'pc', playtime_minutes: 900 }]);
    for (const [name, sid] of [['Steam', S1], ['Steam (family)', S2]]) {
      const a = await t.post('/accounts', { platform: 'steam', name, config: { api_key: 'TESTKEY0001', steam_id: sid }, sync: false });
      assert.equal(a.status, 200);
      const s = await t.post(`/accounts/${a.data.id}/sync?wait=true`);
      assert.equal(s.status, 200, JSON.stringify(s.data));
      assert.equal(s.data.initial, true);
      await t.post(`/accounts/${a.data.id}/enrich?wait=true`); // let background enrichment finish
      if (sid === S1) steam1 = a.data; else steam2 = a.data;
    }
    ps = await t.customAccount('PS5 sheet');
    await t.report(ps.id, [{ id: 'er', title: 'ELDEN RING (PS5)', playtime_minutes: 1200 }]);
  });
  after(() => { t?.close(); restore?.(); });

  test('only the mocked Steam hosts were called', () => {
    assert.ok(mock.hits.some((p) => p.includes('GetOwnedGames')));
    for (const h of mock.hits) assert.match(h, /^(api|store)\.steampowered\.com\//, h);
  });

  test('Steam and PlayStation copies of ELDEN RING are one game with both platforms', async () => {
    const er = (await t.list('q=elden')).items;
    assert.equal(er.length, 1);
    assert.equal(er[0].minutes, 1800);
    assert.deepEqual(new Set(er[0].platforms), new Set(['steam', 'custom']));
    const d = await t.dupes();
    const cp = d.cross_platform.find((x) => x.game.id === er[0].id);
    assert.ok(cp, 'listed as owned on multiple platforms');
    assert.deepEqual(new Set(cp.platforms), new Set(['steam', 'custom']));
    assert.ok(!d.double_counted.some((x) => x.game.id === er[0].id), 'different totals on two platforms are real, separate play');
  });

  test('spreadsheet + live Steam account with the same hours is flagged, and the import is the one to exclude', async () => {
    const hades = (await t.list('q=hades')).items[0];
    assert.equal(hades.entry_count, 2);
    const d = await t.dupes();
    const flag = d.double_counted.find((x) => x.game.id === hades.id);
    assert.ok(flag, 'flagged as double counted');
    const imp = flag.entries.find((e) => e.account_id == null);
    const live = flag.entries.find((e) => e.account_id === steam1.id);
    assert.ok(imp && live);
    assert.equal(flag.suggest_exclude, imp.id, 'suggest excluding the spreadsheet, not the live account');
  });

  test('two Steam accounts reporting the same game are flagged as tracked twice', async () => {
    const sv = (await t.list('q=stardew')).items[0];
    const flag = (await t.dupes()).double_counted.find((x) => x.game.id === sv.id);
    assert.ok(flag);
    assert.deepEqual(new Set(flag.entries.map((e) => e.account_id)), new Set([steam1.id, steam2.id]));
    assert.ok(flag.entries.map((e) => e.id).includes(flag.suggest_exclude));
  });

  test('excluding each suggested entry counts every game once and clears the flags', async () => {
    assert.equal((await t.lifetime()).total_minutes, 900 + 600 + 900 + 300 + 300 + 1200);
    for (const x of (await t.dupes()).double_counted) {
      assert.equal((await t.patch(`/entries/${x.suggest_exclude}`, { excluded: true })).status, 200);
    }
    const d = await t.dupes();
    assert.equal(d.counts.double_counted, 0);
    assert.equal((await t.lifetime()).total_minutes, 1800 + 900 + 300, 'ELDEN RING on two platforms + Hades once + Stardew once');
    const cp = d.cross_platform.find((x) => x.game.title === 'Hades');
    assert.ok(cp.entries.some((e) => e.excluded), 'the excluded entry is still shown, marked excluded');
    assertConsistent(t);
  });
});

// =====================================================================================
describe('duplicates on an empty library', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(() => t.close());
  test('nothing to suggest, nothing double counted, nothing cross-platform', async () => {
    const d = await t.dupes();
    assert.deepEqual(d.counts, { suggestions: 0, double_counted: 0, cross_platform: 0 });
    assert.deepEqual(d.suggestions, []);
    assert.deepEqual(d.double_counted, []);
    assert.deepEqual(d.cross_platform, []);
  });
});

// =====================================================================================
describe('duplicates: merge suggestions', () => {
  let t; const G = {};
  const REAL = [
    ["Assassin's Creed Valhalla", 'Assassins Creed Valhalla'],
    ['Spider-Man', 'Spiderman'],
    ['Hollow Knight', 'Hollow Knight: Voidheart Edition'],
    ['Into the Breach', 'Into the Breach: Advanced Edition'],
  ];
  const SEQUELS = [
    ['Civilization V', 'Civilization VI'], ['Resident Evil 2', 'Resident Evil 3'], ['Hades', 'Hades II'],
    ['Portal', 'Portal 2'], ['Left 4 Dead', 'Left 4 Dead 2'], ['Forza Horizon 4', 'Forza Horizon 5'],
    ['Dark Souls II', 'Dark Souls III'], ['Mass Effect', 'Mass Effect 2'], ['Batman: Arkham City', 'Batman: Arkham Knight'],
  ];
  before(async () => {
    t = await startApp();
    let i = 0;
    for (const [x, y] of [...REAL, ...SEQUELS]) {
      for (const title of [x, y]) {
        const g = await t.createGame(title);
        await t.logSession(g.id, 10 + (i++ % 7) * 5, NOW - (1 + (i % 9)) * DAY);
        G[title] = g.id;
      }
    }
  });
  after(() => t.close());

  test('obvious real duplicates are suggested for merging', async () => {
    const d = await t.dupes();
    for (const [x, y] of REAL) {
      assert.notEqual(G[x], G[y], `${x} / ${y} are separate games before merging`);
      assert.ok(pairOf(d.suggestions, G[x], G[y]), `${x} <> ${y} should be suggested`);
    }
  });

  test('sequels are not suggested', async () => {
    const d = await t.dupes('threshold=0.8');
    for (const [x, y] of SEQUELS) {
      assert.notEqual(G[x], G[y], `${x} / ${y} must not be grouped`);
      assert.ok(!pairOf(d.suggestions, G[x], G[y]), `${x} <> ${y} must not be suggested`);
    }
  });

  test('suggestion shape: stable key, score in (0, 1], both games with their minutes and platforms, strongest first', async () => {
    const d = await t.dupes();
    assert.equal(d.counts.suggestions, d.suggestions.length);
    assert.ok(d.suggestions.length >= REAL.length);
    const keys = new Set();
    for (const s of d.suggestions) {
      assert.equal(typeof s.key, 'string');
      assert.ok(!keys.has(s.key), 'keys are unique');
      keys.add(s.key);
      assert.ok(s.score > 0 && s.score <= 1);
      assert.equal(s.games.length, 2);
      assert.notEqual(s.games[0].id, s.games[1].id);
      for (const g of s.games) {
        assert.equal(typeof g.title, 'string');
        assert.equal(g.minutes, (await t.game(g.id)).minutes);
        assert.deepEqual(g.platforms, ['manual']);
      }
    }
    for (let i = 1; i < d.suggestions.length; i++) assert.ok(d.suggestions[i - 1].score >= d.suggestions[i].score);
    assert.equal((await t.dupes()).suggestions[0].key, d.suggestions[0].key, 'keys are stable between calls');
  });

  test('threshold narrows or widens the suggestions', async () => {
    const def = await t.dupes();
    const strict = await t.dupes('threshold=0.99');
    assert.ok(strict.suggestions.every((s) => s.score >= 0.99));
    assert.ok(strict.counts.suggestions <= def.counts.suggestions);
    const loose = await t.dupes('threshold=0.5');
    for (const s of def.suggestions) assert.ok(loose.suggestions.some((x) => x.key === s.key), 'a lower threshold never drops a pair');
    assert.equal((await t.get('/duplicates?threshold=abc')).status, 200, 'garbage threshold falls back');
  });

  test('limit caps each list but not the counts; summary=true returns counts only', async () => {
    const full = await t.dupes();
    const one = await t.dupes('limit=1');
    assert.ok(one.suggestions.length <= 1);
    assert.deepEqual(one.counts, full.counts);
    const sum = await t.dupes('summary=true');
    assert.deepEqual(Object.keys(sum), ['counts']);
    assert.deepEqual(sum.counts, full.counts);
  });

  test('dismissing a suggestion hides only that pair, is idempotent, and can be reset', async () => {
    const d0 = await t.dupes();
    const s = pairOf(d0.suggestions, G['Spider-Man'], G.Spiderman);
    assert.equal((await t.post('/duplicates/dismiss', { key: s.key })).status, 200);
    const d1 = await t.dupes();
    assert.ok(!pairOf(d1.suggestions, G['Spider-Man'], G.Spiderman));
    assert.equal(d1.counts.suggestions, d0.counts.suggestions - 1);
    assert.ok(pairOf(d1.suggestions, G['Hollow Knight'], G['Hollow Knight: Voidheart Edition']), 'other suggestions unaffected');
    assert.equal((await t.post('/duplicates/dismiss', { key: s.key })).status, 200, 'dismissing twice is fine');
    assert.equal((await t.dupes()).counts.suggestions, d0.counts.suggestions - 1);
    assert.equal((await t.get(`/games/${G.Spiderman}`)).status, 200, 'dismissing never deletes anything');
    assert.equal((await t.del('/duplicates/dismissed')).status, 200);
    assert.ok(pairOf((await t.dupes()).suggestions, G['Spider-Man'], G.Spiderman), 'back after reset');
  });

  test('dismiss needs a key', async () => {
    for (const body of [{}, { key: '' }, { key: null }]) assert.equal((await t.post('/duplicates/dismiss', body)).status, 400);
  });

  test('merging from a suggestion: pair disappears, minutes add up, nothing else changes', async () => {
    const d0 = await t.dupes();
    const s = pairOf(d0.suggestions, G['Hollow Knight'], G['Hollow Knight: Voidheart Edition']);
    const [x, y] = s.games;
    const [target, source] = y.minutes > x.minutes ? [y, x] : [x, y]; // like the Duplicates page
    const life0 = (await t.lifetime()).total_minutes;
    const r = await t.post(`/games/${target.id}/merge`, { source_ids: [source.id] });
    assert.equal(r.status, 200);
    assert.equal(r.data.minutes, x.minutes + y.minutes);
    const d1 = await t.dupes();
    assert.ok(!d1.suggestions.some((z) => z.key === s.key));
    assert.ok(!d1.suggestions.some((z) => z.games.some((g) => g.id === source.id)), 'the merged-away game is never suggested again');
    assert.equal(d1.counts.suggestions, d0.counts.suggestions - 1);
    assert.equal((await t.lifetime()).total_minutes, life0);
    assertConsistent(t);
  });

  test('publisher-prefixed store titles are suggested ("Sid Meier\'s …", "Tom Clancy\'s …")', async () => {
    const civ = await t.createGame("Sid Meier's Civilization V");
    const r6a = await t.createGame("Tom Clancy's Rainbow Six Siege");
    const r6b = await t.createGame('Rainbow Six Siege');
    const d = await t.dupes();
    assert.ok(!pairOf(d.suggestions, civ.id, G['Civilization VI']), 'still never the sequel');
    assert.ok(pairOf(d.suggestions, civ.id, G['Civilization V']), "Sid Meier's Civilization V <> Civilization V");
    assert.ok(pairOf(d.suggestions, r6a.id, r6b.id), "Tom Clancy's Rainbow Six Siege <> Rainbow Six Siege");
  });
});

// =====================================================================================
describe('duplicates: double counting and cross-platform info', () => {
  let t; let fam1; let fam2; let sheet;
  before(async () => {
    t = await startApp();
    fam1 = await t.customAccount('Family A');
    fam2 = await t.customAccount('Family B');
    sheet = await t.customAccount('Live tracker');
    await t.report(fam1.id, [{ id: 'sv', title: 'Stardew Valley', playtime_minutes: 300 }]);
    await t.report(fam2.id, [{ id: 'sv2', title: 'Stardew Valley', playtime_minutes: 300 }]);
    await t.importGames([
      { title: 'Celeste', platform: 'switch', playtime_minutes: 1200 },
      { title: 'Hades', platform: 'switch', playtime_minutes: 100 },
    ]);
    await t.report(sheet.id, [{ id: 'celeste', title: 'Celeste', playtime_minutes: 1205 }, { id: 'hades', title: 'Hades', playtime_minutes: 600 }]);
  });
  after(() => t.close());

  const flagFor = async (title) => {
    const g = (await t.list(`q=${encodeURIComponent(title)}`)).items.find((x) => x.title === title);
    return { g, flag: (await t.dupes()).double_counted.find((x) => x.game.id === g.id) };
  };

  test('the same game tracked by two accounts on one platform is flagged', async () => {
    const { g, flag } = await flagFor('Stardew Valley');
    assert.equal(g.entry_count, 2);
    assert.ok(flag, 'flagged');
    assert.equal(typeof flag.reason, 'string');
    assert.deepEqual(new Set(flag.entries.map((e) => e.account_id)), new Set([fam1.id, fam2.id]));
    assert.ok(flag.entries.map((e) => e.id).includes(flag.suggest_exclude));
  });

  test('an imported spreadsheet and a live account reporting near-identical totals are flagged; the import is suggested for exclusion', async () => {
    const { flag } = await flagFor('Celeste');
    assert.ok(flag);
    const imp = flag.entries.find((e) => e.account_id == null);
    assert.equal(imp.platform, 'switch');
    assert.equal(flag.suggest_exclude, imp.id);
  });

  test('genuinely different playtime on two platforms is cross-platform, not double counting', async () => {
    const { g, flag } = await flagFor('Hades');
    assert.equal(flag, undefined);
    const cp = (await t.dupes()).cross_platform.find((x) => x.game.id === g.id);
    assert.ok(cp);
    assert.deepEqual(new Set(cp.platforms), new Set(['switch', 'custom']));
    assert.deepEqual(cp.entries.map((e) => e.playtime_min).sort((a, b) => a - b), [100, 600]);
    assert.equal(g.minutes, 700, 'both copies count');
  });

  test('every game with several entries is listed as cross-platform info with its entries', async () => {
    const d = await t.dupes();
    assert.equal(d.counts.cross_platform, d.cross_platform.length);
    assert.deepEqual(new Set(d.cross_platform.map((x) => x.game.title)), new Set(['Stardew Valley', 'Celeste', 'Hades']));
    for (const x of d.cross_platform) {
      const g = await t.game(x.game.id);
      assert.deepEqual(new Set(x.entries.map((e) => e.id)), new Set(g.entries.map((e) => e.id)));
    }
  });

  test('dismissing a double-counting flag hides it until reset; totals are untouched', async () => {
    const { flag } = await flagFor('Stardew Valley');
    const life0 = (await t.lifetime()).total_minutes;
    assert.equal((await t.post('/duplicates/dismiss', { key: flag.key })).status, 200);
    assert.ok(!(await t.dupes()).double_counted.some((x) => x.key === flag.key));
    assert.equal((await t.lifetime()).total_minutes, life0);
    await t.del('/duplicates/dismissed');
    assert.ok((await t.dupes()).double_counted.some((x) => x.key === flag.key));
  });

  test('excluding the suggested entry resolves the flag and the game is counted once', async () => {
    const before_ = (await t.lifetime()).total_minutes;
    assert.equal(before_, 300 + 300 + 1200 + 100 + 1205 + 600);
    for (const title of ['Stardew Valley', 'Celeste']) {
      const { flag } = await flagFor(title);
      await t.patch(`/entries/${flag.suggest_exclude}`, { excluded: true });
    }
    const d = await t.dupes();
    assert.equal(d.counts.double_counted, 0);
    assert.equal((await t.lifetime()).total_minutes, 300 + 1205 + 700);
    assert.equal((await t.list('q=celeste')).items[0].minutes, 1205, 'the live account\'s total stands');
    assertConsistent(t);
  });
});

// =====================================================================================
describe('entries: pushing a new lifetime total', () => {
  let t; let g; let entry;
  before(async () => {
    t = await startApp();
    await t.put('/settings', { max_overage_minutes: 120 });
    g = await t.createGame('Balatro');
    entry = g.entries[0];
  });
  after(() => t.close());

  test('a higher total on a manual entry becomes one session of the difference', async () => {
    const r = await t.post(`/entries/${entry.id}/playtime`, { playtime_minutes: 90 });
    assert.equal(r.status, 200);
    const d = await t.game(g.id);
    assert.equal(d.minutes, 90);
    assert.equal(d.summary.sessions, 1);
    assert.equal(d.summary.tracked_minutes, 90);
    const r2 = await t.post(`/entries/${entry.id}/playtime`, { playtime_minutes: 150 });
    assert.equal(r2.status, 200);
    const d2 = await t.game(g.id);
    assert.equal(d2.minutes, 150);
    assert.equal(d2.summary.sessions, 2);
    assert.equal(d2.summary.longest_session_minutes, 90);
    assertConsistent(t);
  });

  test('the same total again records nothing new', async () => {
    await t.post(`/entries/${entry.id}/playtime`, { playtime_minutes: 150 });
    const d = await t.game(g.id);
    assert.equal(d.minutes, 150);
    assert.equal(d.summary.sessions, 2);
  });

  test('missing, negative or non-numeric totals are rejected and change nothing; unknown entry is a 404', async () => {
    for (const body of [{}, { playtime_minutes: -5 }, { playtime_minutes: 'lots' }, { playtime_minutes: null }]) {
      assert.equal((await t.post(`/entries/${entry.id}/playtime`, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await t.game(g.id)).minutes, 150);
    assert.equal((await t.post('/entries/999999/playtime', { playtime_minutes: 10 })).status, 404);
  });

  test('a total pushed for a synced entry goes through the account like a report', async () => {
    const acc = await t.customAccount('Deck');
    await t.report(acc.id, [{ id: 'blt', title: 'Balatro', playtime_minutes: 500 }]);
    const e = (await t.game(g.id)).entries.find((x) => x.account_id === acc.id);
    assert.ok(e, 'the synced copy joined the same game');
    const r = await t.post(`/entries/${e.id}/playtime`, { playtime_minutes: 545 });
    assert.equal(r.status, 200);
    const d = await t.game(g.id);
    assert.equal(d.entries.find((x) => x.id === e.id).playtime_min, 545);
    assert.equal(d.minutes, 150 + 545);
    assertConsistent(t);
  });

  test('a lower total keeps the game total and its sessions in agreement', { todo: 'APP BUG library-8: a lower total on a local entry lowers playtime_min but keeps the sessions, so tracked minutes exceed the game total' }, async () => {
    const r = await t.post(`/entries/${entry.id}/playtime`, { playtime_minutes: 60 });
    assert.ok(r.status === 200 || r.status === 400);
    const d = await t.game(g.id);
    assert.ok(d.summary.tracked_minutes + d.summary.estimated_minutes + d.summary.baseline_minutes === d.summary.total_minutes,
      `total ${d.summary.total_minutes} vs tracked ${d.summary.tracked_minutes}`);
    assert.deepEqual(t.sessionSumViolations(), []);
  });
});

// =====================================================================================
describe('access control on library endpoints', () => {
  let t; let gameId;
  before(async () => {
    t = await startApp({ password: 'correct horse battery staple' });
  });
  after(() => t.close());

  test('without logging in, every library read and write is refused and nothing changes', async () => {
    assert.equal((await t.get('/games')).status, 401);
    assert.equal((await t.post('/games', { title: 'Sneaky' })).status, 401);
    assert.equal((await t.get('/games/1')).status, 401);
    assert.equal((await t.patch('/games/1', { status: 'dropped' })).status, 401);
    assert.equal((await t.del('/games/1?force=true')).status, 401);
    assert.equal((await t.post('/games/1/merge', { source_ids: [2] })).status, 401);
    assert.equal((await t.patch('/entries/1', { excluded: true })).status, 401);
    assert.equal((await t.get('/duplicates')).status, 401);
    assert.equal((await t.post('/duplicates/dismiss', { key: 'merge:1:2' })).status, 401);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM games').get().n, 0);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM dismissed_duplicates').get().n, 0);
  });

  test('a wrong token is refused; a real API token works', async () => {
    assert.equal((await t.call('/games', { headers: { Authorization: 'Bearer pt_not_a_real_token' } })).status, 401);
    const login = await fetch(`${t.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const tok = await t.call('/tokens', { method: 'POST', body: { name: 'suite' }, headers: { Cookie: cookie } });
    assert.equal(tok.status, 200);
    const auth = { Authorization: `Bearer ${tok.data.token}` };
    const created = await t.call('/games', { method: 'POST', body: { title: 'Allowed' }, headers: auth });
    assert.equal(created.status, 200);
    gameId = created.data.id;
    assert.equal((await t.call('/games', { headers: auth })).data.total, 1);
    assert.equal((await t.call(`/games/${gameId}`, { headers: { Cookie: cookie } })).status, 200, 'cookie session works too');
  });

  test('a browser write from a foreign origin is blocked', async () => {
    const login = await fetch(`${t.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const r = await t.call(`/games/${gameId}`, { method: 'PATCH', body: { status: 'dropped' }, headers: { Cookie: cookie, Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    const ok = await t.call(`/games/${gameId}`, { headers: { Cookie: cookie } });
    assert.notEqual(ok.data.status, 'dropped');
  });
});
