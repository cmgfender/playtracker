// Franchises: the curated list (release order, eras, versions, story order, collections), matching a
// library's games to it (titles that name two games told apart by IGDB's year, remasters and
// re-releases, betas, launchers), series that are not curated, and the API and game page that show them.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FRANCHISES } from '../src/data/franchises.js';
import { normalizeTitle } from '../src/services/titles.js';
import { clock, local, startApp, guardNetwork, restoreNetwork, addGame, logSession } from './suite/helpers/sessions-stats-harness.js';

const NOW = local(2026, 3, 18, 15);

describe('the curated franchises', () => {
  test('ids are unique; entries are in release order; versions, collections, eras and the story name entries', () => {
    assert.ok(FRANCHISES.length >= 50, `${FRANCHISES.length} franchises`);
    assert.equal(new Set(FRANCHISES.map((f) => f.id)).size, FRANCHISES.length);
    for (const f of FRANCHISES) {
      const titles = f.entries.map((e) => e[1]);
      assert.ok(f.aliases.length && f.prefix.length, f.id);
      assert.equal(new Set(titles).size, titles.length, `${f.id}: no title twice`);
      f.entries.forEach(([y], i) => { assert.ok(Number.isInteger(y) && y >= 1980 && y <= 2026, `${f.id} ${titles[i]}: ${y}`); if (i) assert.ok(y >= f.entries[i - 1][0], `${f.id}: ${titles[i]} (${y}) is listed after ${titles[i - 1]} (${f.entries[i - 1][0]})`); });
      for (const [, t, kind = 'main', o = {}] of f.entries) {
        assert.ok(['main', 'spinoff', 'remake', 'remaster', 'rerelease', 'collection'].includes(kind), `${f.id} ${t}: ${kind}`);
        for (const inc of o.includes || []) assert.ok(titles.includes(inc), `${f.id}: ${t} holds ${inc}, an entry`);
        // a remake, remaster or re-release says what it is a version of; nothing else does
        assert.equal(['remake', 'remaster', 'rerelease'].includes(kind), !!o.of, `${f.id} ${t}: of`);
        for (const x of [].concat(o.of || [])) assert.ok(titles.includes(x) && x !== t, `${f.id}: ${t} is a version of ${x}, an entry`);
        if (o.era) assert.ok((f.eras || []).some((e) => e[1] === o.era), `${f.id} ${t}: era ${o.era}`);
      }
      for (const s of f.story || []) assert.ok(titles.includes(s), `${f.id}: the story's ${s} is an entry`);
      // eras start at entries, in release order, with a name and what defines them
      const starts = (f.eras || []).map((e) => titles.indexOf(e[0]));
      assert.ok(starts.every((x) => x >= 0), `${f.id}: every era starts at an entry`);
      assert.deepEqual(starts, [...starts].sort((a, b) => a - b), `${f.id}: eras in release order`);
      if (starts.length) assert.equal(starts[0], 0, `${f.id}: the first era starts with the first entry`);
      for (const e of f.eras || []) assert.ok(e[1] && e[2], `${f.id}: ${e[0]} era named and described`);
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
    before('metroid', 'Metroid Prime', 'Metroid Fusion');
    before('zelda', 'The Legend of Zelda: Ocarina of Time', "The Legend of Zelda: Link's Awakening DX");
    before('pokemon', 'Pokémon Legends: Arceus', 'Pokémon Scarlet and Violet');
    // the remakes that share a title with the original keep apart once normalised
    assert.equal(normalizeTitle('Resident Evil 4 (2023)'), 'resident evil 4 2023');
    // the biggest series are here, with eras
    for (const id of ['halo', 'call-of-duty', 'grand-theft-auto', 'zelda', 'super-mario', 'pokemon', 'final-fantasy', 'resident-evil', 'assassins-creed', 'metal-gear', 'the-last-of-us', 'tekken', 'need-for-speed', 'dragon-quest', 'civilization']) assert.ok(FRANCHISES.some((f) => f.id === id), id);
    assert.ok(FRANCHISES.filter((f) => (f.eras || []).length > 1).length >= 40, 'most have eras');
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
    id.hk = await add('Zeta Quest', 2017);
    id.silk = await add('Zeta Quest: Second Light', 2025);
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
    // the 2005 game: no copy of it, but in the library as the remake
    assert.deepEqual([at(re, 'Resident Evil 4').game, at(re, 'Resident Evil 4').state, at(re, 'Resident Evil 4').via.title], [null, 'owned', 'Resident Evil 4 (2023)']);
    // a launcher IGDB knows under another name, years from the 2003 game: in the series as an app, not that entry
    const cod = await h.get('/franchises/call-of-duty');
    assert.equal(at(cod, 'Call of Duty').state, 'missing');
    assert.equal(cod.items.find((it) => it.game?.id === id.cod).kind, 'hub');
  });

  test('Halo: release order, a collection holding its games, what to play next, the order you played it in, the story order', async () => {
    const f = await h.get('/franchises/halo');
    assert.equal(f.name, 'Halo');
    assert.deepEqual(f.items.slice(0, 3).map((it) => [it.year, it.title]), [[2001, 'Halo: Combat Evolved'], [2004, 'Halo 2'], [2007, 'Halo 3']]);
    const at = (title) => f.items.find((it) => it.title === title);
    // the Master Chief Collection holds Combat Evolved to Halo 4
    assert.deepEqual([at('Halo 3').via.game_id, at('Halo 3').via.title, at('Halo 3').via.kind], [id.mcc, 'Halo: The Master Chief Collection', 'collection']);
    // Combat Evolved and Halo 2 through the anniversary remasters the collection holds
    assert.equal(at('Halo: Combat Evolved').state, 'owned');
    assert.deepEqual(at('Halo 2: Anniversary').of.map((o) => o.title), ['Halo 2']);
    assert.ok(at('Halo 2').versions.some((v) => v.title === 'Halo 2: Anniversary'));
    // eras: Bungie, 343 Industries, Halo Studios
    assert.deepEqual(f.eras.map((x) => [x.name, x.from]), [['Bungie', 2001], ['343 Industries', 2011], ['Halo Studios', 2026]]);
    assert.deepEqual([at('Halo: Reach').era, at('Halo 4').era], [0, 1]);
    assert.deepEqual([f.eras[1].main.total, f.eras[1].main.played], [3, 2], 'Halo 4, 5 and Infinite');
    assert.equal(f.your_era.name, '343 Industries');
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
    const hk = l.items.find((x) => x.name === 'Zeta Quest');
    assert.deepEqual([hk.id, hk.curated, hk.games, hk.mainline], ['s-zeta-quest', false, 2, null]);
    assert.ok(l.items.some((x) => x.id === 'doom') && l.items.some((x) => x.id === 'call-of-duty'));
    assert.equal(l.curated, l.items.filter((x) => x.curated).length);
    assert.equal((await h.get('/franchises/Zeta%20Quest')).id, 's-zeta-quest');
    assert.equal((await h.get('/franchises/Halo')).id, 'halo', 'by an alias');
    const zelda = await h.get('/franchises/zelda');
    assert.ok(zelda.items.length > 10 && zelda.items.every((it) => it.state === 'missing'));
    assert.equal(zelda.next.title, 'The Legend of Zelda');
    assert.equal((await h.call('GET', '/franchises/no-such-thing')).status, 404);
    assert.equal((await h.call('GET', '/franchises/%25')).status, 404, 'a name with a % is decoded once, not twice');
    assert.equal((await h.get('/franchises?q=zeta')).items.length, 1);
  });

  test('a game page knows its franchise, its place and the main games either side', async () => {
    const g = await h.get(`/games/${id.h5}`);
    assert.deepEqual([g.franchise.id, g.franchise.position, g.franchise.of], ['halo', 7, 8]);
    assert.deepEqual([g.franchise.prev.title, g.franchise.next.title, g.franchise.next.game_id], ['Halo 4', 'Halo Infinite', id.inf], 'main games, not the spin-off between them');
    const solo = await addGame(h, 'A Game Alone');
    assert.equal((await h.get(`/games/${solo}`)).franchise, null);
  });
});

describe('versions, betas and launchers', () => {
  let h; const id = {};
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    const meta = h.db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, name, release_date, fetched_at) VALUES (?, ?, 'title', ?, ?, 0)");
    let n = 1;
    const add = async (title, year, igdbName = title) => { const g = await addGame(h, title); if (year) meta.run(g, n++, igdbName, Date.UTC(year, 5, 1)); return g; };
    // a synced copy with a store id
    const ext = (g, platform, extId) => h.db.prepare('UPDATE entries SET platform = ?, ext_id = ? WHERE game_id = ?').run(platform, extId, g);
    id.re2r = await add('Resident Evil 2', 2019);
    id.rehd = await add('Resident Evil', 2015); // Steam sells the HD Remaster as "Resident Evil"
    id.ff7 = await add('FINAL FANTASY VII', 2013); // the 2013 PC release
    id.ff7r = await add('Final Fantasy VII Remake', 2020);
    id.mgs4 = await add('METAL GEAR SOLID 4: Guns of the Patriots - Master Collection Version', 2026);
    id.h5 = await add('Halo 5: Guardians', 2015);
    id.h5b = await add('Halo 5: Guardians Beta');
    id.hq = await add('Call of Duty®', 2003, 'Call of Duty'); // IGDB took the app for the 2003 game
    ext(id.hq, 'steam', '1938090');
    id.bf = await add('Battlefield 2042 Xbox Series X|S');
    id.ds = await add('Dark Souls III', 2016);
    await logSession(h, id.re2r, local(2026, 1, 5, 20), 600);
    await logSession(h, id.rehd, local(2026, 1, 20, 20), 300);
    await logSession(h, id.ff7, local(2025, 6, 1, 20), 900);
    await logSession(h, id.ff7r, local(2025, 8, 1, 20), 1200);
    await logSession(h, id.mgs4, local(2026, 2, 1, 20), 200);
    await logSession(h, id.h5b, local(2015, 1, 2, 20), 90);
    await logSession(h, id.hq, local(2026, 3, 1, 20), 500);
    await logSession(h, id.ds, local(2025, 1, 1, 20), 300);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });
  const at = (f, title) => f.items.find((it) => it.title === title);

  test('a remake or remaster stands for the game it remakes: Resident Evil 2 played as the 2019 remake', async () => {
    const re = await h.get('/franchises/resident-evil');
    assert.deepEqual([at(re, 'Resident Evil 2').state, at(re, 'Resident Evil 2').via.title, at(re, 'Resident Evil 2').via.kind], ['played', 'Resident Evil 2 (2019)', 'remake']);
    assert.deepEqual(at(re, 'Resident Evil 2 (2019)').of.map((o) => o.title), ['Resident Evil 2']);
    // a later release under the original's name that is a curated version: that version, and the original through it
    assert.equal(at(re, 'Resident Evil HD Remaster').game.id, id.rehd);
    assert.deepEqual([at(re, 'Resident Evil').state, at(re, 'Resident Evil').via.title], ['played', 'Resident Evil HD Remaster'], 'a remaster of the 2002 remake is a version of the 1996 game');
    assert.ok(at(re, 'Resident Evil').versions.map((v) => v.title).includes('Resident Evil (2002)'));
    // eras in release order: the remakes in the era they came out in
    assert.deepEqual([re.eras[at(re, 'Resident Evil 2').era].name, re.eras[at(re, 'Resident Evil 2 (2019)').era].name], ['Classic survival horror', 'The RE Engine era']);
    assert.equal(re.mainline.played, 2, 'Resident Evil and Resident Evil 2, each in another version');
  });

  test('a later release under the same name is a re-release of its own; a remake told in parts stands for none of the original', async () => {
    const ff = await h.get('/franchises/final-fantasy');
    const rel = ff.items.find((it) => it.game?.id === id.ff7);
    assert.deepEqual([rel.kind, rel.year, rel.of.map((o) => o.title)], ['rerelease', 2013, ['Final Fantasy VII']]);
    assert.equal(ff.eras[rel.era].name, 'The HD era', 'placed by when it came out');
    assert.deepEqual([at(ff, 'Final Fantasy VII').state, at(ff, 'Final Fantasy VII').via.game_id], ['played', id.ff7]);
    assert.equal(at(ff, 'Final Fantasy VII Remake').partial, true);
    assert.ok(!at(ff, 'Final Fantasy VII').versions.some((v) => v.title === 'Final Fantasy VII Remake'), 'the Remake project is not all of VII');
    // a "- Master Collection Version" is a version of the game it names
    const mg = await h.get('/franchises/metal-gear');
    const v = mg.items.find((it) => it.game?.id === id.mgs4);
    assert.deepEqual([v.kind, v.of[0].title, at(mg, 'Metal Gear Solid 4: Guns of the Patriots').state], ['rerelease', 'Metal Gear Solid 4: Guns of the Patriots', 'played']);
  });

  test('a beta stays with its game without counting it played; a platform build is the game; a launcher is an app', async () => {
    const halo = await h.get('/franchises/halo');
    const h5 = at(halo, 'Halo 5: Guardians');
    assert.deepEqual(h5.addons, [{ id: id.h5b, title: 'Halo 5: Guardians Beta', minutes: 90, kind: 'test' }]);
    assert.equal(h5.state, 'owned', 'the beta is not the game');
    assert.equal(halo.games, 1, 'a game of yours: the beta counts its time, not as a game');
    assert.equal(halo.minutes, 90);
    const bf = await h.get('/franchises/battlefield');
    assert.equal(at(bf, 'Battlefield 2042').game.id, id.bf);
    // the Call of Duty app, known by its Steam id although IGDB says it is the 2003 game
    const cod = await h.get('/franchises/call-of-duty');
    const hub = cod.items.find((it) => it.game?.id === id.hq);
    assert.deepEqual([hub.kind, hub.year, cod.eras[hub.era].name], ['hub', 2022, 'Warzone']);
    assert.match(hub.note, /not split by game/);
    assert.equal(at(cod, 'Call of Duty').state, 'missing');
  });

  test('what to play next in another version; the game page knows the era and what a game is a version of', async () => {
    // after Dark Souls III nothing: the closest before it, which you have in no version - also sold as Scholar of the First Sin
    const souls = await h.get('/franchises/dark-souls');
    assert.deepEqual([souls.next.title, souls.next.earlier, souls.next.owned], ['Dark Souls II', true, false]);
    assert.deepEqual(souls.next.play_as, { title: 'Dark Souls II: Scholar of the First Sin', year: 2015, kind: 'rerelease' });
    const g = await h.get(`/games/${id.re2r}`);
    assert.deepEqual([g.franchise.kind, g.franchise.version_of.map((o) => o.title), g.franchise.era.name], ['remake', ['Resident Evil 2'], 'The RE Engine era']);
    assert.deepEqual([g.franchise.prev.title, g.franchise.next.title], ['Resident Evil', 'Resident Evil 3: Nemesis'], 'either side of the game it remakes');
    const beta = await h.get(`/games/${id.h5b}`);
    assert.deepEqual([beta.franchise.addon, beta.franchise.title], ['test', 'Halo 5: Guardians']);
    const l = await h.get('/franchises');
    assert.deepEqual(l.items.find((x) => x.id === 'resident-evil').your_era.name, 'The RE Engine era');
  });
});
