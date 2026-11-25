// One game, two releases: Ocarina of Time played on the N64 in 1998 and its 2026 remake on Switch 2
// are kept together as one game (the library merges them by title), and the series, the game page and
// the console generations still count each release played, with its own time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { tx } from '../src/db.js';
import { applyItems, parseAccount } from '../src/services/sync.js';
import { hardwareYears, entryYear, partsOf } from '../src/services/franchises/parts.js';
import { libraryGames } from '../src/services/franchises/library.js';

const DAY = 86_400_000;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('the hardware a game was played on says when it can have come out', () => {
  assert.deepEqual(hardwareYears('BEE'), [2025, null], 'Switch 2');
  assert.deepEqual(hardwareYears('HAC'), [2017, null], 'Switch');
  assert.deepEqual(hardwareYears('HAC+BEE'), [2017, null], 'played on both: a Switch game');
  assert.deepEqual(hardwareYears('N64'), [1996, 2002]);
  assert.deepEqual(hardwareYears('Nintendo 64'), [1996, 2002]);
  assert.deepEqual(hardwareYears('Wii U'), [2012, 2017]);
  assert.deepEqual(hardwareYears('Wii'), [2006, 2013]);
  assert.deepEqual(hardwareYears('Game Boy Advance'), [2001, 2008]);
  assert.deepEqual(hardwareYears('PS2'), [2000, 2013]);
  assert.deepEqual(hardwareYears('Xbox 360'), [2005, 2016]);
  assert.equal(hardwareYears('PC'), null);
  assert.equal(hardwareYears(''), null);
  // an entry's release year: the game's, within what its hardware and its first play allow
  const at = (y, m = 6) => new Date(y, m, 1).getTime();
  assert.equal(entryYear({ hardware: 'BEE', first_played_at: at(2026) }, 1998), 2025, 'a Switch 2 copy is no 1998 release');
  assert.equal(entryYear({ hardware: 'N64', manual_start: at(1998, 11) }, 2026), 1998, 'played on the N64 in 1998: not the 2026 remake');
  assert.equal(entryYear({ hardware: null, first_tracked_at: at(2019) }, 2023), 2019, 'not after it was first played');
  assert.equal(entryYear({ hardware: null }, 2016), 2016, 'nothing known: the game\'s year');
  assert.equal(entryYear({ hardware: 'BEE', first_played_at: at(2020) }, 1998), 2025, 'a first play before the hardware existed is not believed');
});

test('Ocarina of Time on the N64 and its Switch 2 remake, one game: both releases counted, each with its time', async () => {
  const { app, server, close } = createApp({ dbFile: ':memory:', password: '', log: quiet, scheduler: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    const db = app.db; const now = Date.now();
    // the remake, synced from Nintendo (played on Switch 2, recently)
    db.prepare("INSERT INTO accounts(platform, name, config, enabled, created_at) VALUES ('nintendo', 'Nintendo', '{}', 1, 0)").run();
    const acc = parseAccount(db.prepare('SELECT * FROM accounts WHERE id = 1').get());
    tx(db, () => applyItems(db, acc, [{ extId: '0400486024DEC000', title: 'The Legend of Zelda: Ocarina of Time', playtimeMin: 871, firstPlayedAt: now - 20 * DAY, lastPlayedAt: now - 2 * DAY, meta: { device: 'BEE', played_days: 7 } }],
      { settings: app.settings.all(), now, initial: true }));
    // the original, added by hand: 100 hours on the N64 over 1999 - the library puts it with the remake (same title)
    const added = await post('/games', { title: 'The Legend of Zelda: Ocarina of Time', played_on: 'N64', status: 'completed',
      history: { minutes: 6000, first_played_at: '1999-01-01T12:00:00', last_played_at: '1999-12-31T20:00:00', coarse: true } });
    assert.equal(added.entries.length, 2, 'one game, two entries');
    const gid = added.id;

    // the series: the original played (100h, finished), the remake played (its own 14h, being played)
    const z = await get('/franchises/zelda');
    const item = (t) => z.items.find((it) => it.title === t);
    const orig = item('The Legend of Zelda: Ocarina of Time'); const remake = item('The Legend of Zelda: Ocarina of Time (2026)');
    assert.deepEqual([orig.state, orig.game.id, orig.game.minutes], ['finished', gid, 6000]);
    assert.deepEqual([remake.state, remake.game.id, remake.game.minutes], ['playing', gid, 871]);
    assert.equal(item('The Legend of Zelda: Ocarina of Time 3D').state, 'missing', 'the 3DS remake: not this game');
    assert.equal(z.minutes, 6871, 'the series counts the game once');
    assert.equal(z.games, 2, 'as two releases');

    // the game page: which release each entry is
    const g = await get(`/games/${gid}`);
    assert.deepEqual(g.franchise.parts.map((p) => [p.title, p.year, p.kind, p.minutes, p.main]),
      [['The Legend of Zelda: Ocarina of Time', 1998, 'main', 6000, true], ['The Legend of Zelda: Ocarina of Time (2026)', 2026, 'remake', 871, false]]);
    const entryOf = (platform) => g.entries.find((e) => e.platform === platform).id;
    assert.deepEqual(g.franchise.parts.map((p) => p.entries), [[entryOf('manual')], [entryOf('nintendo')]]);
    assert.equal(g.franchise.title, 'The Legend of Zelda: Ocarina of Time', 'the release the game is speaks for it');

    // console generations: the original in the N64 era with its 100 hours, the remake in today's with its own
    const gen = async (id) => (await get(`/legends/generation/${id}`)).games.filter((x) => x.id === gid).map((x) => x.minutes);
    assert.deepEqual(await gen('gen5'), [6000]);
    assert.deepEqual(await gen('gen9'), [871]);
  } finally { close(); }
});

test('the same game on Steam and on Xbox is one release: never told in parts', () => {
  const g = { id: 1, title: 'Halo Infinite', release_year: 2021, state: 'played', ids: [], entries: [
    { id: 1, platform: 'steam', ext_id: '1240440', title: 'Halo Infinite', minutes: 300, hardware: null, first_day: '2022-01-01', last_day: '2022-02-01' },
    { id: 2, platform: 'xbox', ext_id: '2043073184', title: 'Halo Infinite', minutes: 700, hardware: null, first_day: '2021-12-08', last_day: '2023-01-01' }] };
  assert.equal(partsOf(g), null);
});

test('a library of games of one entry each is placed as before (no entries are read for them)', () => {
  const { app, close } = createApp({ dbFile: ':memory:', password: '', log: quiet, scheduler: false });
  try {
    app.db.prepare("INSERT INTO games(title, norm_title, created_at, updated_at) VALUES ('Hades', 'hades', 0, 0)").run();
    app.db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, last_synced_at) VALUES (NULL, 1, 'manual', 'x', 'Hades', 60, 0, 0)").run();
    assert.equal(libraryGames(app.db, Date.now())[0].entries, undefined);
  } finally { close(); }
});

test("a series' app (the Battlefield app on Xbox) is dated by the years it holds, not by what IGDB matched its bare name to", async () => {
  const { app, server, close } = createApp({ dbFile: ':memory:', password: '', log: quiet, scheduler: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const db = app.db; const now = Date.now();
    db.prepare("INSERT INTO accounts(platform, name, config, enabled, created_at) VALUES ('xbox', 'Xbox', '{}', 1, 0)").run();
    const acc = parseAccount(db.prepare('SELECT * FROM accounts WHERE id = 1').get());
    tx(db, () => applyItems(db, acc, [{ extId: '1840884885', title: 'Battlefield™', playtimeMin: 1075, lastPlayedAt: now - 30 * DAY }], { settings: app.settings.all(), now, initial: true }));
    const gid = db.prepare('SELECT game_id FROM entries').get().game_id;
    // IGDB matched the bare name to a 1997 "Battlefield"
    db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, name, release_date, fetched_at) VALUES (?, 290355, 'title', 'Battlefield', ?, 0)").run(gid, Date.UTC(1997, 11, 31));
    db.prepare("INSERT INTO game_tags(game_id, kind, name) VALUES (?, 'platform', 'PC (Microsoft Windows)'), (?, 'developer', 'Someone Else')").run(gid, gid);
    const home = await (await fetch(`${base}/legends`)).json();
    const inGen = (id) => home.generations.find((g) => g.id === id)?.games || 0;
    assert.equal(inGen('gen5'), 0, 'not in the PlayStation and N64 era');
    assert.equal(inGen('gen9'), 1, 'with the series\' games of 2025 on');
    const ea = await (await fetch(`${base}/legends/maker/ea`)).json();
    assert.deepEqual(ea.games.map((x) => x.id), [gid], "EA's, as the series is - not IGDB's 1997 developer's");
  } finally { close(); }
});

test('a game only on your wish list is wanted, not owned; an unreleased game sharing an old one\'s name is a new game', async () => {
  const { app, server, close } = createApp({ dbFile: ':memory:', password: '', log: quiet, scheduler: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const get = async (p) => (await fetch(base + p)).json();
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    const db = app.db;
    const lost = await post('/games', { title: 'Fable: The Lost Chapters' });
    const iii = await post('/games', { title: 'Fable III', status: 'wishlist' });
    const reboot = await post('/games', { title: 'Fable', status: 'wishlist', merge: false });
    // IGDB: the reboot comes out next year
    db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, name, release_date, fetched_at) VALUES (?, 92550, 'title', 'Fable', ?, 0)").run(reboot.id, Date.UTC(new Date().getFullYear() + 1, 1, 23));
    const f = await get('/franchises/fable');
    const at = (t) => f.items.find((it) => it.title === t);
    assert.equal(at('Fable III').state, 'wanted', 'on the wish list');
    assert.equal(at('Fable: The Lost Chapters').game.id, lost.id);
    assert.deepEqual([f.mainline.owned, f.mainline.played], [1, 0], 'Fable (through The Lost Chapters) is yours; Fable III only wanted');
    assert.equal(at('Fable Anniversary').state, 'missing', 'the unreleased reboot is not the 2014 remaster');
    const rb = f.items.find((it) => it.game?.id === reboot.id);
    assert.deepEqual([rb.kind, rb.state], ['other', 'wanted'], 'a new game in the series, wanted');
    // and no part of your career
    const career = await get('/legends/career/all');
    assert.ok(!career.games.some((x) => x.id === iii.id || x.id === reboot.id));
  } finally { close(); }
});
