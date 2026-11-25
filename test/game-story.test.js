// A game's story (services/gamestory.js): where one game stands in a career - its place by hours, its
// share, the years it led, its place in its series - and the chapters the game page leads with.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clock, local, startApp, guardNetwork, restoreNetwork, addGame, logSession } from './suite/helpers/sessions-stats-harness.js';

const NOW = local(2026, 3, 18, 15);
const text = (parts) => parts.map((p) => (typeof p === 'string' ? p : p.t ?? p.b ?? `<${p.d}:${p.p}>`)).join('');

describe('a game\'s story', () => {
  let h; const id = {};
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    const meta = h.db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, name, release_date, fetched_at) VALUES (?, ?, 'title', ?, ?, 0)");
    let n = 1;
    const add = async (title, [y, m, d]) => { const g = await addGame(h, title); meta.run(g, n++, title, Date.UTC(y, m - 1, d, 12)); return g; };
    id.h3 = await add('Halo 3', [2007, 9, 25]);
    id.reach = await add('Halo: Reach', [2010, 9, 14]);
    id.hades = await add('Hades', [2020, 9, 17]);
    id.celeste = await add('Celeste', [2018, 1, 25]);
    id.unplayed = await add('Outer Wilds', [2019, 5, 28]);
    // Halo 3 leads 2024 (20h in three sessions over two months); Reach a little in 2024; Hades leads 2025; Celeste once, last week
    await logSession(h, id.h3, local(2024, 2, 3, 20), 600);
    await logSession(h, id.h3, local(2024, 2, 10, 20), 360);
    await logSession(h, id.h3, local(2024, 3, 2, 20), 240);
    await logSession(h, id.reach, local(2024, 5, 1, 20), 120);
    await logSession(h, id.hades, local(2025, 6, 1, 20), 500);
    await logSession(h, id.hades, local(2025, 6, 8, 20), 100);
    await logSession(h, id.celeste, local(2026, 3, 12, 20), 90);
    await h.patch(`/games/${id.h3}`, { status: 'completed' });
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });
  const story = async (g) => (await h.get(`/games/${g}`)).story;
  const chapter = (s, cid) => { const c = s.chapters.find((x) => x.id === cid); return c ? text(c.parts) : null; };

  test('the most played game: its place, its share, the year it led, its series, its sessions, where it is now', async () => {
    const s = await story(id.h3);
    assert.deepEqual([s.standing.rank, s.standing.of, s.standing.share], [1, 4, 59.7], '1,200 of 2,010 minutes');
    assert.deepEqual(s.standing.years, [{ year: 2024, rank: 1, of: 2, minutes: 1200 }].filter((y) => y.of >= 3), 'a year of two games names no place');
    assert.deepEqual(s.standing.series, { id: 'halo', name: 'Halo', rank: 1, of: 2, share: 91 });
    assert.equal(s.standing.platform, null, 'one platform in the library: no place on it');
    assert.deepEqual([s.span.first_day, s.span.last_day, s.span.first_estimated, s.span.days, s.span.months, s.span.years], ['2024-02-03', '2024-03-02', false, 5, 2, 1], 'two of the sessions ran past midnight');
    assert.deepEqual(s.span.busiest, { key: '2024-02', minutes: 960 });
    assert.deepEqual(s.chapters.map((c) => c.id), ['began', 'stands', 'played', 'now']);
    assert.equal(chapter(s, 'began'), 'You first played it on <2024-02-03:day>, 16 years after it came out.');
    assert.equal(chapter(s, 'stands'), 'It is your most played game of 4: 59.7% of all your time on record. In the Halo series it is the one you played most, 91% of your time with it.');
    assert.equal(chapter(s, 'played'), '3 sessions on record, 6.7 hours at a time across 5 days. The longest: 10 hours on <2024-02-03:day>.');
    assert.equal(chapter(s, 'now'), 'You finished it. It has been quiet since <2024-03-02:month>: 2 years.');
  });

  test('a small game, the second of its series, a game played days ago and one not played at all', async () => {
    const reach = await story(id.reach);
    assert.deepEqual([reach.standing.rank, reach.standing.series.rank, reach.standing.series.share], [3, 2, 9]);
    assert.equal(chapter(reach, 'stands'), 'It is your 3rd most played game of 4: 6% of all your time on record.', 'the last of its series: its place there is not told');
    assert.equal(chapter(reach, 'played'), null, 'one session is no pattern');
    const hades = await story(id.hades);
    assert.equal(chapter(hades, 'began'), 'You first played it on <2025-06-01:day>, 4 years after it came out.');
    assert.equal(hades.standing.series, null);
    const celeste = await story(id.celeste);
    assert.equal(chapter(celeste, 'now'), 'It is still going: you last played it on <2026-03-12:day>.');
    const none = await story(id.unplayed);
    assert.deepEqual([none.standing.rank, none.standing.share, none.chapters], [null, null, []], 'in the library, with nothing to tell yet');
  });

  test('a year with enough games names the place; a game only on the wish list has no story; an unknown game is a 404', async () => {
    // a third game in 2024 makes it a year worth a place
    const extra = await addGame(h, 'Tunic');
    await logSession(h, extra, local(2024, 7, 1, 20), 30);
    const s = await story(id.h3);
    assert.deepEqual(s.standing.years, [{ year: 2024, rank: 1, of: 3, minutes: 1200 }]);
    assert.equal(chapter(s, 'years'), 'It was your most played game of 2024. Its busiest month: <2024-02-01:month>, 16 hours.'.replace(' Its busiest month: <2024-02-01:month>, 16 hours.', ''), 'two months of play: no busiest month yet');
    const wish = await addGame(h, 'Silksong');
    await h.patch(`/games/${wish}`, { status: 'wishlist' });
    assert.equal(await story(wish), null);
    assert.equal((await h.call('GET', '/games/99999')).status, 404);
  });
});
