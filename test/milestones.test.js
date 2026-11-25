// Career milestones (GET /stats/milestones): the round numbers of a whole gaming life, tracked play
// and history before tracking, each dated as precisely as its evidence allows, and the ones coming up.
//
// Sessions are logged through the API at local wall-clock times, so the file passes in any timezone.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clock, local, startApp, guardNetwork, restoreNetwork, addGame, logSession } from './suite/helpers/sessions-stats-harness.js';
import { milestones, MARKS } from '../src/services/milestones.js';
import { reinferMany } from '../src/services/inference.js';
import { flushRollups } from '../src/services/rollup.js';

// Wednesday 2026-03-18 15:00 local
const NOW = local(2026, 3, 18, 15);
const find = (m, kind, value, more = {}) => m.reached.find((x) => x.kind === kind && x.value === value && Object.entries(more).every(([k, v]) => x[k] === v));

describe('milestones: tracked play', () => {
  let h; let big; let side;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    big = await addGame(h, 'Big <One>');
    side = await addGame(h, 'Side');
    // Big: ten hours a day, January 1 to 12 2026 (120 hours); then two hours on each of the last three days
    for (let d = 1; d <= 12; d++) await logSession(h, big, local(2026, 1, d, 8), 600);
    for (const d of [16, 17, 18]) await logSession(h, big, local(2026, 3, d, 8), 120);
    // Side: six hours on January 3, one more on March 17
    await logSession(h, side, local(2026, 1, 3, 20), 360);
    await logSession(h, side, local(2026, 3, 17, 20), 60);
    // eight games of one series, a quarter of an hour each on February 1 to 8: ten games in all
    for (let i = 1; i <= 8; i++) await logSession(h, await addGame(h, `Quest ${i}`), local(2026, 2, i, 12), 15);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('each round number with its day, newest first: playtime, games, a series, habits', async () => {
    const m = await h.get('/stats/milestones?all=true');
    assert.equal(m.day, '2026-03-18');
    assert.equal(m.first_day, '2026-01-01');
    const day = (kind, value, more) => find(m, kind, value, more)?.day;
    // in all: 10 h on Jan 1, 50 after Jan 5 (Side's six hours on Jan 3), 100 after Jan 10
    assert.deepEqual([10, 50, 100].map((v) => day('hours', v)), ['2026-01-01', '2026-01-05', '2026-01-10']);
    assert.equal(day('year_hours', 100, { subject: '2026' }), '2026-01-10');
    // one game: only from a hundred hours on
    assert.equal(day('game_hours', 100, { game_id: big }), '2026-01-10');
    assert.equal(m.reached.filter((x) => x.kind === 'game_hours').length, 1, 'no 10, 25 or 50 hours in a game');
    assert.equal(find(m, 'games', 1).text, 'Your first game: Big <One>');
    assert.deepEqual([day('games', 1), day('games', 10)], ['2026-01-01', '2026-02-08']);
    assert.equal(find(m, 'games', 10).text, 'Your 10th game: Quest 8');
    assert.deepEqual([day('series_games', 3, { subject: 'Quest' }), day('series_games', 5, { subject: 'Quest' })], ['2026-02-03', '2026-02-05']);
    assert.deepEqual([day('days', 10), day('streak', 7), day('long_session', 8)], ['2026-01-10', '2026-01-07', '2026-01-01']);
    assert.equal(m.reached.filter((x) => x.kind === 'long_session').length, 1, 'a ten-hour session is one milestone, the highest rung it reaches');
    // known to the day, from tracked play
    assert.ok(m.reached.every((x) => x.precision === 'day' && x.basis === 'tracked'));
    assert.ok(m.reached.every((x, i) => !i || m.reached[i - 1].day >= x.day), 'newest first');
    assert.deepEqual(Object.keys(m.categories).sort(), ['habits', 'library', 'playtime', 'series']);
    assert.ok(m.reached.every((x) => x.category && MARKS[x.kind].includes(x.value)));
    assert.deepEqual(m.years, [{ year: 2026, n: m.total }]);
  });

  test('the highlights: the three highest rungs of each kind, the highest of each subject, and career firsts', async () => {
    const m = await h.get('/stats/milestones');
    assert.ok(m.reached.every((x) => x.notable));
    assert.ok(m.notable_total < m.total);
    assert.ok(find(m, 'hours', 10) && find(m, 'hours', 50) && find(m, 'hours', 100), 'the three rungs reached of hours in all');
    assert.equal(find(m, 'days', 10).notable, true);
    assert.ok(find(m, 'games', 1), 'your first game always');
    assert.equal(find(m, 'series_games', 3), undefined, 'of a series, its highest rung');
    assert.ok(find(m, 'series_games', 5));
    const cat = await h.get('/stats/milestones?all=true&category=habits');
    assert.ok(cat.reached.length && cat.reached.every((x) => x.category === 'habits'));
    assert.equal((await h.call('GET', '/stats/milestones?category=nope')).status, 400);
  });

  test('what is coming up, nearest first', async () => {
    const m = await h.get('/stats/milestones');
    const by = (kind, key) => m.coming.find((x) => x.kind === kind && (!key || x.game_id === key || x.subject === key));
    // 126 h of Big + 7 of Side + 2 of the Quests = 135 of 250
    assert.deepEqual([by('hours').target, by('hours').current, by('hours').percent, by('hours').text], [250, 135, 54, '250 hours of play']);
    // Big: 126 of 250 hours, still played; Side's seven hours are nowhere near a hundred
    assert.deepEqual([by('game_hours', big).target, by('game_hours', big).current], [250, 126]);
    assert.equal(by('game_hours', side), undefined);
    assert.deepEqual([by('games').target, by('games').current, by('games').text], [25, 10, '25 games played']);
    assert.deepEqual([by('days').target, by('days').current], [50, 23]);
    assert.deepEqual([by('career_years').target, by('career_years').percent], [1, 20]);
    assert.ok(m.coming.every((x, i) => !i || m.coming[i - 1].percent >= x.percent), 'nearest first');
    assert.ok(m.coming.every((x) => x.percent < 100));
  });

  test('excluded play reaches nothing', async () => {
    const before_ = (await h.get('/stats/milestones?all=true')).total;
    const x = await addGame(h, 'Excluded');
    await logSession(h, x, local(2026, 3, 1, 9), 7000);
    const g = await h.get(`/games/${x}`);
    await h.patch(`/entries/${g.entries[0].id}`, { excluded: true });
    const m = await h.get('/stats/milestones?all=true');
    assert.equal(m.total, before_);
    assert.equal(m.reached.find((r) => r.game_id === x), undefined);
  });
});

describe('milestones: a career that began long before tracking', () => {
  let h; const id = {};
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    const db = h.db;
    const game = (title) => Number(db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, 0, 0)').run(title, title.toLowerCase()).lastInsertRowid);
    const history = (gid, platform, minutes, hist) => Number(db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, baseline_min, first_seen_at, hist)
      VALUES (NULL, ?, ?, ?, 'x', ?, ?, ?, ?)`).run(gid, platform, `e${gid}`, minutes, minutes, local(2026, 1, 1), JSON.stringify({ tracking_start: local(2026, 1, 1), ...hist })).lastInsertRowid);
    // 2014: a hundred hours of a 1998 game, its first played and last played dates known; two unlocks in March
    id.old = game('Old Faithful');
    const oldEntry = history(id.old, 'psn', 6000, { first_played_at: local(2014, 3, 1, 12), last_played_at: local(2014, 12, 20, 20) });
    db.prepare('UPDATE entries SET first_played_at = ? WHERE id = ?').run(local(2014, 3, 1, 12), oldEntry);
    const ach = db.prepare('INSERT INTO achievements(entry_id, ach_id, name, unlocked, unlocked_at, rarity, first_seen_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, 0, 0)');
    ach.run(oldEntry, 'a1', 'Opening Night', local(2014, 3, 2, 21), 0.6);
    ach.run(oldEntry, 'a2', 'Encore', local(2014, 3, 9, 22), 30);
    db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, name, release_date, fetched_at) VALUES (?, 1, 'title', 'Old Faithful', ?, 0)").run(id.old, Date.UTC(1998, 0, 15));
    // 500 hours of a game nothing dates: lifetime only
    id.mystery = game('Mystery');
    history(id.mystery, 'xbox', 30000, {});
    for (const e of db.prepare('SELECT id FROM entries').all()) reinferMany(db, [e.id]);
    flushRollups(db);
    // and, since tracking began, a game first played on its launch day
    id.launch = await addGame(h, 'Launch Day');
    h.db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, name, release_date, fetched_at) VALUES (?, 2, 'title', 'Launch Day', ?, 0)").run(id.launch, Date.UTC(2026, 0, 15));
    await logSession(h, id.launch, local(2026, 1, 15, 19), 120);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('history before tracking dates the career: around the month, in the year, or to the day where unlocks or the platform say so', async () => {
    const m = await h.get('/stats/milestones?all=true');
    // the first game: the platform's first played date, to the day
    const first = find(m, 'games', 1);
    assert.deepEqual([first.text, first.day, first.precision, first.basis], ['Your first game: Old Faithful', '2014-03-01', 'day', 'platform']);
    assert.equal(m.first_day, '2014-03-01');
    // hours from estimated history: not to the day
    const ten = find(m, 'hours', 10);
    assert.equal(ten.basis, 'estimated');
    assert.ok(['month', 'year'].includes(ten.precision), ten.precision);
    assert.equal(ten.day.slice(0, 4), '2014');
    const hundred = find(m, 'game_hours', 100, { game_id: id.old });
    assert.equal(hundred.day.slice(0, 4), '2014');
    assert.equal(hundred.basis, 'estimated');
    // achievements: exact
    const ach = find(m, 'achievements', 1);
    assert.deepEqual([ach.day, ach.precision, ach.basis, ach.text], ['2014-03-02', 'day', 'unlock', 'Your first achievement: Opening Night in Old Faithful']);
    assert.equal(find(m, 'ultra_rare', 1).day, '2014-03-02');
    // ten years of gaming, from that first day
    const ten_y = find(m, 'career_years', 10);
    assert.deepEqual([ten_y.day, ten_y.precision], ['2024-03-01', 'day']);
    assert.equal(find(m, 'decades', 2).subject, 'the 2020s');
    // an old game, a launch day, decades of releases
    assert.equal(find(m, 'retro', 10).title, 'Old Faithful', 'sixteen years old when first played');
    assert.equal(m.reached.filter((x) => x.kind === 'retro').length, 1);
    const launch = find(m, 'day_one', 1);
    assert.deepEqual([launch.day, launch.title], ['2026-01-15', 'Launch Day']);
    assert.match(find(m, 'release_decades', 2).text, /^Games from 2 decades: the 2020s with Launch Day$/);
    // platforms: PlayStation from 2014 on; Xbox only undated: not a platform with a first day
    assert.equal(find(m, 'platforms', 2), undefined);
  });

  test('what only undated history reaches is reached on no known day, after the dated ones', async () => {
    const m = await h.get('/stats/milestones?all=true');
    const big = find(m, 'game_hours', 500, { game_id: id.mystery });
    assert.deepEqual([big.day, big.precision, big.basis], [null, null, 'undated']);
    // 100 + 2 dated hours, 600 + 2 in all: 250 and 500 hours of play have no day
    assert.deepEqual([find(m, 'hours', 250).day, find(m, 'hours', 500).day], [null, null]);
    assert.ok(find(m, 'hours', 100).day, 'a hundred hours are dated');
    const undated = m.reached.findIndex((x) => x.day == null);
    assert.ok(m.reached.slice(undated).every((x) => x.day == null), 'undated last');
    // the highlights: Mystery's highest rung only
    const hl = await h.get('/stats/milestones');
    assert.deepEqual(hl.reached.filter((x) => x.game_id === id.mystery && x.kind === 'game_hours').map((x) => x.value), [500]);
  });
});

describe('milestones: genres, series and achievements', () => {
  let h; let g;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    g = {};
    for (const t of ['Halo 3', 'Halo Infinite', 'Reach', 'Doom', 'Quake']) g[t] = await addGame(h, t);
    // IGDB says Reach is a Halo game; the titles say the other two are; all five are shooters
    h.db.prepare("INSERT INTO game_tags(game_id, kind, name) VALUES (?, 'franchise', 'Halo')").run(g.Reach);
    for (const gid of Object.values(g)) h.db.prepare("INSERT INTO game_tags(game_id, kind, name) VALUES (?, 'genre', 'Shooter')").run(gid);
    await logSession(h, g['Halo 3'], local(2026, 1, 5, 8), 600);
    await logSession(h, g['Halo Infinite'], local(2026, 1, 6, 8), 600);
    await logSession(h, g.Reach, local(2026, 1, 7, 8), 600);
    await logSession(h, g.Doom, local(2026, 1, 8, 8), 300);
    await logSession(h, g.Quake, local(2026, 1, 9, 8), 300);
    // Halo 3: thirty achievements on January 5, 100 Gamerscore each, the first one rare, the last the platinum
    const entry = (await h.get(`/games/${g['Halo 3']}`)).entries[0].id;
    const add = h.db.prepare('INSERT INTO achievements(entry_id, ach_id, name, unlocked, unlocked_at, rarity, points, grade, first_seen_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, 100, ?, 0, 0)');
    for (let i = 0; i < 30; i++) add.run(entry, `A${i}`, `Achievement ${i}`, local(2026, 1, 5, 9) + i * 60_000, i === 0 ? 3 : 40, i === 29 ? 'platinum' : null);
    await h.patch(`/games/${g.Doom}`, { status: 'playing' }); // (a write through the API: cached answers are dropped)
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('a series: hours and games across its games', async () => {
    const m = await h.get('/stats/milestones?all=true');
    const of = (kind) => m.reached.filter((x) => x.kind === kind).map((x) => [x.day, x.text]);
    assert.deepEqual(of('series_hours'), [['2026-01-07', '25 hours in the Halo series']]);
    assert.deepEqual(of('series_games'), [['2026-01-07', '3 games of the Halo series']]);
    const next = m.coming.find((x) => x.kind === 'series_hours');
    assert.deepEqual([next.subject, next.target, next.current, next.text], ['Halo', 50, 30, '50 hours in the Halo series']);
  });

  test('a genre: hours and games of every game tagged with it', async () => {
    const m = await h.get('/stats/milestones?all=true');
    const of = (kind) => m.reached.filter((x) => x.kind === kind).map((x) => [x.day, x.text]);
    assert.deepEqual(of('genre_hours'), [['2026-01-07', '25 hours of Shooter']]);
    assert.deepEqual(of('genre_games'), [['2026-01-09', '5 Shooter games']]);
    const next = m.coming.find((x) => x.kind === 'genre_hours');
    assert.deepEqual([next.subject, next.target, next.current], ['Shooter', 50, 40]);
  });

  test('achievements: the first, how many in a day, rare ones, Gamerscore, the first completion and platinum', async () => {
    const m = await h.get('/stats/milestones?all=true');
    const of = (kind) => m.reached.filter((x) => x.kind === kind).map((x) => [x.day, x.text]);
    assert.deepEqual(of('achievements'), [['2026-01-05', 'Your first achievement: Achievement 0 in Halo 3']]);
    assert.deepEqual(of('ach_day'), [['2026-01-05', '25 achievements in one day']]);
    assert.deepEqual(of('rare'), [['2026-01-05', 'Your first rare achievement']]);
    assert.deepEqual(of('gamerscore'), [['2026-01-05', '1,000 Gamerscore']]);
    assert.deepEqual(of('completions'), [['2026-01-05', 'Your first completed game: Halo 3']]);
    assert.deepEqual(of('platinums'), [['2026-01-05', 'Your first platinum: Halo 3']]);
    assert.ok(m.reached.filter((x) => x.category === 'achievements').every((x) => x.basis === 'unlock' && x.precision === 'day'));
    const by = (kind) => m.coming.find((x) => x.kind === kind);
    assert.deepEqual([by('achievements').target, by('gamerscore').target, by('completions').target, by('platinums').target, by('rare').target], [100, 5000, 5, 5, 10]);
  });
});

describe('milestones: an empty library', () => {
  let h;
  before(async () => { guardNetwork(); clock.install(NOW); h = await startApp(); });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('nothing reached; the first of each kind is ahead, at 0%', () => {
    const m = milestones(h.db, { now: NOW });
    assert.deepEqual([m.total, m.reached, m.counts, m.first_day], [0, [], {}, null]);
    assert.deepEqual(m.coming.map((x) => [x.kind, x.target, x.current, x.percent]).sort(),
      [['achievements', 1, 0, 0], ['days', 10, 0, 0], ['games', 1, 0, 0], ['genres', 5, 0, 0], ['hours', 10, 0, 0], ['platforms', 2, 0, 0], ['series', 5, 0, 0], ['sessions', 50, 0, 0], ['year_hours', 100, 0, 0]]);
  });
});
