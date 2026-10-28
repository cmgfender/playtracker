// IGDB metadata against a fake IGDB (and Twitch token endpoint) on 127.0.0.1: matching by Steam
// app id, by title (alternative names, main games before DLC), no match, details and tags,
// covers only where missing, the token kept and renewed, matches by hand, merges, and the
// endpoints built on it (stats by tag, pace, library filter and sort). Secrets never reach the
// browser.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { Igdb, pickMatch, tagsOf } from '../src/services/igdb.js';
import { flushRollups } from '../src/services/rollup.js';
import { mergeGames } from '../src/services/library.js';

const MIN = 60_000;
const DAY = 86_400_000;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------- the fake IGDB
const CATALOG = [
  {
    id: 1942, name: 'The Witcher 3: Wild Hunt', slug: 'the-witcher-3-wild-hunt', url: 'https://www.igdb.com/games/the-witcher-3-wild-hunt', category: 0, platforms: [6, 48, 49],
    first_release_date: 1431993600, total_rating: 92.34, total_rating_count: 2100, summary: 'A monster hunter.', cover: { id: 1, image_id: 'cow3' },
    genres: [{ id: 12, name: 'Role-playing (RPG)' }, { id: 31, name: 'Adventure' }], themes: [{ id: 1, name: 'Action' }, { id: 17, name: 'Fantasy' }],
    game_modes: [{ id: 1, name: 'Single player' }], player_perspectives: [{ id: 2, name: 'Third person' }], franchises: [{ id: 5, name: 'The Witcher' }],
    involved_companies: [{ id: 1, developer: true, publisher: false, company: { id: 908, name: 'CD Projekt RED' } }, { id: 2, developer: false, publisher: true, company: { id: 99, name: 'CD Projekt' } }],
  },
  {
    id: 113112, name: 'Hades', category: 0, platforms: [6, 130, 48], first_release_date: 1600300800, total_rating: 93, total_rating_count: 900, cover: { id: 2, image_id: 'cohades' },
    genres: [{ id: 25, name: "Hack and slash/Beat 'em up" }, { id: 32, name: 'Indie' }], game_modes: [{ id: 1, name: 'Single player' }],
  },
  { id: 999001, name: 'Hades', category: 1, platforms: [6], total_rating_count: 3 }, // a DLC of the same name
  { id: 113113, name: 'Hades II', category: 0, platforms: [6], total_rating_count: 100 },
  {
    id: 25076, name: 'Wolfenstein II: The New Colossus', category: 0, platforms: [6, 48], alternative_names: [{ id: 1, name: 'Wolfenstein 2' }], first_release_date: 1508803200,
    genres: [{ id: 5, name: 'Shooter' }], game_modes: [{ id: 1, name: 'Single player' }], player_perspectives: [{ id: 1, name: 'First person' }],
  },
  { id: 777, name: 'My Thing', category: 0 },
];
const STEAM = { 292030: 1942 };
const TTB = { 1942: { id: 1, game_id: 1942, hastily: 51 * 3600, normally: 104 * 3600, completely: 173 * 3600, count: 400 } };

function fakeIgdb() {
  const calls = { token: 0, games: 0, multiquery: 0, external_games: 0, ttb: 0, unauthorized: 0 };
  let token = 'tok-1';
  let reject = 0; // reject this many API calls with 401 (an expired token)
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/oauth2/token') {
        calls.token++;
        if (u.searchParams.get('client_secret') !== 'shh') return send(400, { status: 400, message: 'invalid client secret' });
        token = `tok-${calls.token}`;
        return send(200, { access_token: token, expires_in: 5_000_000, token_type: 'bearer' });
      }
      if (req.headers['client-id'] !== 'cid' || req.headers.authorization !== `Bearer ${token}` || reject > 0) { reject = Math.max(0, reject - 1); calls.unauthorized++; return send(401, { message: 'Authorization Failure' }); }
      const ids = (re) => [...(body.match(re)?.[1] || '').matchAll(/"?([^",()\s]+)"?/g)].map((m) => m[1]);
      if (u.pathname === '/v4/external_games') {
        calls.external_games++;
        const uids = ids(/uid = \(([^)]*)\)/);
        return send(200, uids.flatMap((x) => (STEAM[x] ? [{ id: Number(x) + 5, uid: x, game: STEAM[x], category: 1 }, { id: 1, uid: x, game: 5, category: 5 }] : [])));
      }
      if (u.pathname === '/v4/games') {
        calls.games++;
        const want = ids(/id = \(([^)]*)\)/).map(Number);
        return send(200, CATALOG.filter((g) => want.includes(g.id)));
      }
      if (u.pathname === '/v4/game_time_to_beats') {
        calls.ttb++;
        const want = ids(/game_id = \(([^)]*)\)/).map(Number);
        return send(200, want.map((id) => TTB[id]).filter(Boolean));
      }
      if (u.pathname === '/v4/multiquery') {
        calls.multiquery++;
        const out = [...body.matchAll(/query games "(q\d+)" \{[^}]*search "((?:[^"\\]|\\.)*)";[^}]*\};/g)].map(([, name, q]) => {
          const words = q.toLowerCase().split(/\W+/).filter(Boolean);
          return { name, result: CATALOG.filter((g) => words.some((w) => g.name.toLowerCase().includes(w)) || (g.alternative_names || []).some((a) => a.name.toLowerCase() === q.toLowerCase())) };
        });
        return send(200, out);
      }
      send(404, { message: 'no such endpoint' });
    });
  });
  return { server, calls, expire: (n = 1) => { reject = n; } };
}

describe('IGDB metadata', () => {
  let fake; let base; let app; let close; let igdb; let srv; let api;
  const ids = {};
  before(async () => {
    fake = fakeIgdb();
    await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${fake.server.address().port}`;
    ({ app, close, server: srv } = createApp({ dbFile: ':memory:', password: '', scheduler: false, log: quiet }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${srv.address().port}/api/v1`;
    api = async (p, opts = {}) => { const r = await fetch(origin + p, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined }); return { status: r.status, body: await r.json() }; };
    igdb = new Igdb({ db: app.db, settings: app.settings, log: quiet, api: `${base}/v4`, tokenUrl: `${base}/oauth2/token`, spacing: 0 });
    app.igdb = igdb;
    const db = app.db;
    const game = (title, cover = null) => Number(db.prepare('INSERT INTO games(title, norm_title, cover_url, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run(title, title.toLowerCase(), cover).lastInsertRowid);
    const entry = (g, platform, ext) => Number(db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at) VALUES (NULL, ?, ?, ?, 'x', 0, 0)").run(g, platform, ext).lastInsertRowid);
    const ins = db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at) VALUES (?, 'manual', 'play', ?, ?, ?, ?, ?, ?)");
    const play = (e, start, minutes) => { ins.run(e, minutes, start, start + minutes * MIN, start, start + minutes * MIN, start + minutes * MIN); db.prepare('UPDATE entries SET playtime_min = playtime_min + ? WHERE id = ?').run(minutes, e); };
    const t0 = new Date(); t0.setHours(12, 0, 0, 0);
    ids.witcher = game('The Witcher 3: Wild Hunt', 'https://cdn.example/w3.jpg');
    play(entry(ids.witcher, 'steam', '292030'), t0.getTime() - 3 * DAY, 300);
    ids.hades = game('Hades');
    play(entry(ids.hades, 'psn', 'CUSA12345_00'), t0.getTime() - 2 * DAY, 120);
    ids.wolf = game('Wolfenstein 2');
    play(entry(ids.wolf, 'xbox', '1234'), t0.getTime() - DAY, 60);
    ids.home = game('My Homebrew Thing');
    play(entry(ids.home, 'manual', 'm1'), t0.getTime() - DAY, 30);
    db.prepare("UPDATE games SET status = 'completed' WHERE id = ?").run(ids.witcher);
    flushRollups(db);
  });
  after(() => { close(); fake.server.close(); });

  test('without credentials nothing runs, and IGDB shows as not set up', async () => {
    assert.equal(igdb.configured(), false);
    assert.equal(await igdb.run(), null);
    const s = (await api('/igdb/status')).body;
    assert.equal(s.configured, false);
    assert.equal(s.coverage.pending, 4);
    assert.equal((await api('/igdb/run', { method: 'POST' })).status, 409);
    assert.equal((await api('/games/1')).body.meta, null);
  });

  test('a wrong secret is reported plainly; the settings never send the secret back', async () => {
    let r = await api('/settings', { method: 'PUT', body: { igdb_client_id: 'cid', igdb_client_secret: 'wrong' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.igdb_client_secret, undefined);
    assert.equal(r.body.igdb_secret_set, true);
    r = await api('/igdb/test', { method: 'POST' });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /Twitch refused the IGDB client id \/ secret/);
    await api('/settings', { method: 'PUT', body: { igdb_client_secret: 'shh' } });
    assert.equal((await api('/igdb/test', { method: 'POST' })).status, 200);
    assert.equal(app.settings.public().igdb_token, undefined);
  });

  test('a pass matches by Steam id and by title, takes the main game, leaves a non-match alone', async () => {
    const c = await igdb.run();
    assert.deepEqual([c.looked, c.matched, c.by_steam, c.by_title, c.none], [4, 3, 1, 2, 1]);
    const meta = (id) => app.db.prepare('SELECT igdb_id, matched_by FROM game_meta WHERE game_id = ?').get(id);
    assert.deepEqual({ ...meta(ids.witcher) }, { igdb_id: 1942, matched_by: 'steam' });
    assert.deepEqual({ ...meta(ids.hades) }, { igdb_id: 113112, matched_by: 'title' }, 'the main game, not the DLC or the sequel');
    assert.deepEqual({ ...meta(ids.wolf) }, { igdb_id: 25076, matched_by: 'title' }, 'by its alternative name');
    assert.deepEqual({ ...meta(ids.home) }, { igdb_id: null, matched_by: 'none' });
    assert.equal(fake.calls.external_games, 1);
    assert.equal(fake.calls.multiquery, 1, 'three title searches in one request');

    const g = (await api(`/games/${ids.witcher}`)).body;
    assert.deepEqual(g.meta.genres, ['Adventure', 'Role-playing (RPG)']);
    assert.deepEqual(g.meta.developers, ['CD Projekt RED']);
    assert.deepEqual(g.meta.publishers, ['CD Projekt']);
    assert.deepEqual(g.meta.franchises, ['The Witcher']);
    assert.deepEqual(g.meta.time_to_beat, { main: 51 * 60, extra: 104 * 60, complete: 173 * 60 });
    assert.equal(g.meta.release_date, 1431993600 * 1000);
    assert.equal(g.meta.rating, 92.3);
    assert.equal(g.cover_url, 'https://cdn.example/w3.jpg', 'its own cover stays');
    assert.equal((await api(`/games/${ids.hades}`)).body.cover_url, 'https://images.igdb.com/igdb/image/upload/t_cover_big/cohades.jpg', 'a cover where there was none');
  });

  test('the next pass has nothing to do; a non-match is tried again two weeks later; details refresh after 30 days', async () => {
    assert.equal((await igdb.run()).looked, 0);
    const later = Date.now() + 15 * DAY;
    assert.deepEqual(igdb.candidates(10, later).map((x) => x.id), [ids.home]);
    assert.equal(igdb.candidates(10, Date.now() + 31 * DAY).length, 4);
  });

  test('the token is kept between requests and renewed when IGDB rejects it', async () => {
    const before = fake.calls.token;
    await igdb.query('games', 'fields name; limit 1;');
    assert.equal(fake.calls.token, before, 'kept');
    fake.expire(1);
    const r = await igdb.query('games', 'fields name; where id = (1942); limit 1;');
    assert.equal(r[0].id, 1942);
    assert.equal(fake.calls.token, before + 1, 'renewed once');
  });

  test('stats by genre, pace, the library filtered by tag and sorted by release', async () => {
    const t = (await api('/stats/tags?kind=genre&range=30d')).body;
    assert.deepEqual(t.items.map((x) => [x.name, x.minutes, x.games]), [['Adventure', 300, 1], ['Role-playing (RPG)', 300, 1], ["Hack and slash/Beat 'em up", 120, 1], ['Indie', 120, 1], ['Shooter', 60, 1]]);
    assert.deepEqual(t.coverage, { games: 4, matched_games: 3, minutes: 510, matched_minutes: 480, untagged_minutes: 0 });
    assert.equal(t.items[0].finished, 1);
    assert.equal(t.series.length, 5);
    assert.equal(t.series[0].values.reduce((a, b) => a + b, 0), 300);
    assert.equal((await api('/stats/tags?kind=nope')).status, 400);
    const pace = (await api('/stats/pace')).body;
    assert.equal(pace.games, 1);
    assert.equal(pace.items[0].ratio, Math.round((300 / (51 * 60)) * 100) / 100);
    const shooters = (await api('/games?tag=genre:Shooter')).body;
    assert.deepEqual(shooters.items.map((x) => x.id), [ids.wolf]);
    assert.equal((await api('/games?tag=genre:Shooter,mode:Single%20player')).body.total, 1);
    assert.equal((await api('/games?tag=bad')).status, 400);
    const released = (await api('/games?sort=released')).body.items.map((x) => x.id);
    assert.deepEqual(released, [ids.hades, ids.wolf, ids.witcher, ids.home], 'newest release first, games without a date last');
  });

  test('a match by hand is kept; forgetting one matches it again', async () => {
    let r = await api(`/games/${ids.home}/meta`, { method: 'PUT', body: { igdb_id: 777 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'My Thing');
    assert.equal(r.body.matched_by, 'manual');
    assert.equal(r.body.locked, true);
    assert.equal(igdb.candidates(10, Date.now() + 15 * DAY).some((x) => x.id === ids.home), false, 'never re-matched on its own');
    r = await api(`/games/${ids.hades}/meta`, { method: 'PUT', body: { igdb_id: null } });
    assert.equal(r.body.igdb_id, null);
    assert.equal((await api(`/games/${ids.hades}`)).body.meta.genres.length, 0);
    assert.equal((await api(`/games/${ids.hades}/meta`, { method: 'PUT', body: { igdb_id: 'x' } })).status, 400);
    await api(`/games/${ids.hades}/meta`, { method: 'DELETE' });
    await igdb.run();
    assert.equal((await api(`/games/${ids.hades}`)).body.meta.igdb_id, 113112, 'matched again');
    const found = (await api('/igdb/search?q=Hades')).body;
    assert.ok(found.some((x) => x.id === 113112 && x.year === 2020 && x.main));
    assert.ok(found.some((x) => x.id === 999001 && !x.main));
  });

  test('merging keeps the metadata when the target has none', () => {
    const db = app.db;
    const extra = Number(db.prepare("INSERT INTO games(title, norm_title, created_at, updated_at) VALUES ('Witcher copy', 'witcher copy', 0, 0)").run().lastInsertRowid);
    db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at) VALUES (NULL, ?, 'manual', 'm9', 'x', 0, 0)").run(extra);
    mergeGames(db, extra, [ids.witcher]);
    assert.equal(db.prepare('SELECT igdb_id FROM game_meta WHERE game_id = ?').get(extra).igdb_id, 1942);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM game_tags WHERE game_id = ? AND kind = 'genre'").get(extra).n >= 2);
    ids.witcher = extra;
  });

  test('diagnostics show IGDB without its secrets', async () => {
    const sys = (await api('/system')).body;
    assert.equal(sys.igdb.configured, true);
    assert.equal(sys.igdb.coverage.matched, 4);
    assert.doesNotMatch(JSON.stringify(sys), /shh|tok-/);
  });
});

describe('pickMatch and tagsOf', () => {
  test('the same title once normalized, or an alternative name; never a different game', () => {
    const c = [{ id: 1, name: 'Hades II', category: 0 }, { id: 2, name: 'HADES', category: 0, platforms: [6] }, { id: 3, name: 'Hades', category: 1 }];
    assert.equal(pickMatch('Hades', c, ['steam']).id, 2);
    assert.equal(pickMatch('Hades™', c).id, 2);
    assert.equal(pickMatch('Hades: Battle Out of Hell', c), null);
    assert.equal(pickMatch('Doom', [{ id: 9, name: 'DOOM Eternal' }]), null);
    assert.equal(pickMatch('', c), null);
    // a newer IGDB names the field game_type
    assert.equal(pickMatch('Hades', [{ id: 3, name: 'Hades', game_type: 1 }, { id: 4, name: 'Hades', game_type: { id: 0 } }]).id, 4);
    // platforms owned here break a tie between two main games of the same name
    assert.equal(pickMatch('Prey', [{ id: 10, name: 'Prey', category: 0, platforms: [6] }, { id: 11, name: 'Prey', category: 0, platforms: [48] }], ['psn']).id, 11);
  });
  test('tags from a record, missing parts empty', () => {
    const t = tagsOf(CATALOG[0]);
    assert.deepEqual(t.developer, ['CD Projekt RED']);
    assert.deepEqual(t.perspective, ['Third person']);
    assert.deepEqual(tagsOf({ id: 1 }), { genre: [], theme: [], mode: [], perspective: [], franchise: [], developer: [], publisher: [] });
  });
});
