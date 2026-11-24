// Franchises: the curated list (release order, story order, collections), matching a library's games
// to it (titles that name two games told apart by IGDB's year), series that are not curated, and
// the API and game page that show them.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FRANCHISES } from '../src/data/franchises.js';
import { normalizeTitle } from '../src/services/titles.js';
import { clock, local, startApp, guardNetwork, restoreNetwork, addGame, logSession } from './suite/helpers/sessions-stats-harness.js';

const NOW = local(2026, 3, 18, 15);

describe('the curated franchises', () => {
  test('ids are unique; entries are in release order; story and collection titles name entries', () => {
    assert.ok(FRANCHISES.length >= 30, `${FRANCHISES.length} franchises`);
    assert.equal(new Set(FRANCHISES.map((f) => f.id)).size, FRANCHISES.length);
    for (const f of FRANCHISES) {
      const titles = f.entries.map((e) => e[1]);
      assert.ok(f.aliases.length && f.prefix.length, f.id);
      assert.equal(new Set(titles).size, titles.length, `${f.id}: no title twice`);
      f.entries.forEach(([y], i) => { assert.ok(Number.isInteger(y) && y >= 1980 && y <= 2026, `${f.id} ${titles[i]}: ${y}`); if (i) assert.ok(y >= f.entries[i - 1][0], `${f.id}: ${titles[i]} (${y}) is listed after ${titles[i - 1]} (${f.entries[i - 1][0]})`); });
      for (const [, t, kind = 'main', o = {}] of f.entries) {
        assert.ok(['main', 'spinoff', 'remake', 'remaster', 'collection'].includes(kind), `${f.id} ${t}: ${kind}`);
        for (const inc of o.includes || []) assert.ok(titles.includes(inc), `${f.id}: ${t} holds ${inc}, an entry`);
      }
      for (const s of f.story || []) assert.ok(titles.includes(s), `${f.id}: the story's ${s} is an entry`);
    }
  });

  test('a few release orders worth getting right', () => {
    const order = (id) => FRANCHISES.find((f) => f.id === id).entries.map((e) => e[1]);
    const before = (id, a, b) => assert.ok(order(id).indexOf(a) < order(id).indexOf(b), `${a} came out before ${b}`);
    before('halo', 'Halo Wars', 'Halo 3: ODST');
    before('halo', 'Halo: Reach', 'Halo 4');
    before('resident-evil', 'Resident Evil: Revelations', 'Resident Evil 6');
    before('super-mario', 'Super Mario Bros. 2', 'Super Mario Bros. 3');
    before('assassins-creed', "Assassin's Creed Mirage", "Assassin's Creed Shadows");
    before('call-of-duty', 'Call of Duty: Black Ops 6', 'Call of Duty: Black Ops 7');
    before('final-fantasy', 'Final Fantasy VII Remake', 'Final Fantasy XVI');
    before('metal-gear', 'Metal Gear Solid 4: Guns of the Patriots', 'Metal Gear Solid: Peace Walker');
    // the story told out of order
    const story = (id) => FRANCHISES.find((f) => f.id === id).story;
    assert.equal(story('metal-gear')[0], 'Metal Gear Solid 3: Snake Eater');
    assert.equal(story('halo')[0], 'Halo Wars');
    assert.equal(story('assassins-creed')[0], "Assassin's Creed Odyssey");
    // the remakes that share a title with the original keep apart once normalised
    assert.equal(normalizeTitle('Resident Evil 4 (2023)'), 'resident evil 4 2023');
  });
});

describe('franchises in a library', () => {
  let h; const id = {};
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    const meta = h.db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, name, release_date, fetched_at) VALUES (?, ?, 'title', ?, ?, 0)");
    const add = async (title, year, igdbName = title) => { const g = await addGame(h, title); if (year) meta.run(g, Math.floor(Math.random() * 1e6) + 1, igdbName, Date.UTC(year, 5, 1)); return g; };
    id.mcc = await add('Halo: The Master Chief Collection', 2014);
    id.h5 = await add('Halo 5: Guardians', 2015);
    id.inf = await add('Halo Infinite', 2021);
    id.doom = await add('DOOM', 2016);
    id.re4 = await add('Resident Evil 4', 2023);
    id.cod = await add('Call of Duty®', 2023, 'Call of Duty HQ');
    id.hk = await add('Hollow Knight', 2017);
    id.silk = await add('Hollow Knight: Silksong', 2025);
    // played: Infinite first, then the collection, then Halo 5
    await logSession(h, id.inf, local(2026, 1, 5, 20), 600);
    await logSession(h, id.mcc, local(2026, 2, 1, 20), 300);
    await logSession(h, id.h5, local(2026, 3, 1, 20), 120);
    await logSession(h, id.hk, local(2026, 1, 10, 20), 60);
    await h.patch(`/games/${id.inf}`, { status: 'completed' });
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('games are matched to the curated entries; IGDB\'s year tells Doom 2016 from 1993 and the RE4 remake from the original', async () => {
    const doom = await h.get('/franchises/doom');
    const at = (f, title) => f.items.find((it) => it.title === title);
    assert.equal(at(doom, 'Doom (2016)').game.id, id.doom);
    assert.equal(at(doom, 'Doom (1993)').state, 'missing');
    const re = await h.get('/franchises/resident-evil');
    assert.equal(at(re, 'Resident Evil 4 (2023)').game.id, id.re4);
    assert.equal(at(re, 'Resident Evil 4').state, 'missing');
    // a launcher IGDB knows under another name, years from the 2003 game: in the series, not that entry
    const cod = await h.get('/franchises/call-of-duty');
    assert.equal(at(cod, 'Call of Duty').state, 'missing');
    assert.equal(cod.items.find((it) => it.game?.id === id.cod).kind, 'other');
  });

  test('Halo: release order, a collection holding its games, what to play next, the order you played it in, the story order', async () => {
    const f = await h.get('/franchises/halo');
    assert.equal(f.name, 'Halo');
    assert.deepEqual(f.items.slice(0, 3).map((it) => [it.year, it.title]), [[2001, 'Halo: Combat Evolved'], [2004, 'Halo 2'], [2007, 'Halo 3']]);
    const at = (title) => f.items.find((it) => it.title === title);
    // the Master Chief Collection holds Combat Evolved to Halo 4
    assert.deepEqual(at('Halo 3').via, { game_id: id.mcc, title: 'Halo: The Master Chief Collection' });
    assert.equal(at('Halo 3').state, 'owned');
    assert.equal(at('Halo Wars').state, 'missing', 'not in the collection');
    assert.deepEqual([at('Halo Infinite').state, at('Halo 5: Guardians').state], ['finished', 'playing'], 'Halo 5: played in the last 30 days');
    assert.deepEqual(f.mainline, { total: 8, owned: 8, played: 2, finished: 1 });
    // nothing after Infinite: the closest main game before it not played yet
    assert.deepEqual([f.next.title, f.next.year, f.next.earlier, f.next.via], ['Halo 4', 2012, true, 'Halo: The Master Chief Collection']);
    assert.deepEqual(f.your_order.games.map((g) => g.id), [id.inf, id.mcc, id.h5]);
    assert.deepEqual([f.your_order.in_release_order, f.your_order.pairs], [1, 2]);
    assert.deepEqual(f.story.slice(0, 3).map((k) => f.items.find((it) => it.key === k).title), ['Halo Wars', 'Halo: Reach', 'Halo: Combat Evolved']);
    assert.equal(f.minutes, 1020);
  });

  test('the list: most played first, curated and other series; by name; a curated one you own nothing of', async () => {
    const l = await h.get('/franchises');
    assert.equal(l.items[0].id, 'halo');
    const hk = l.items.find((x) => x.name === 'Hollow Knight');
    assert.deepEqual([hk.id, hk.curated, hk.games, hk.mainline], ['s-hollow-knight', false, 2, null]);
    assert.ok(l.items.some((x) => x.id === 'doom') && l.items.some((x) => x.id === 'call-of-duty'));
    assert.equal(l.curated, l.items.filter((x) => x.curated).length);
    assert.equal((await h.get('/franchises/Hollow%20Knight')).id, 's-hollow-knight');
    assert.equal((await h.get('/franchises/Halo')).id, 'halo', 'by an alias');
    const zelda = await h.get('/franchises/zelda');
    assert.ok(zelda.items.length > 10 && zelda.items.every((it) => it.state === 'missing'));
    assert.equal(zelda.next.title, 'The Legend of Zelda');
    assert.equal((await h.call('GET', '/franchises/no-such-thing')).status, 404);
    assert.equal((await h.get('/franchises?q=hollow')).items.length, 1);
  });

  test('a game page knows its franchise, its place and the main games either side', async () => {
    const g = await h.get(`/games/${id.h5}`);
    assert.deepEqual([g.franchise.id, g.franchise.position, g.franchise.of], ['halo', 7, 8]);
    assert.deepEqual([g.franchise.prev.title, g.franchise.next.title, g.franchise.next.game_id], ['Halo 4', 'Halo Infinite', id.inf], 'main games, not the spin-off between them');
    const solo = await addGame(h, 'A Game Alone');
    assert.equal((await h.get(`/games/${solo}`)).franchise, null);
  });
});
