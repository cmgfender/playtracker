// Milestones (GET /stats/milestones): the round numbers of a player's history with the day each
// was reached, and the ones coming up.
//
// Sessions are logged through the API at local wall-clock times, so the file passes in any timezone.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clock, local, startApp, guardNetwork, restoreNetwork, addGame, logSession } from './suite/helpers/sessions-stats-harness.js';
import { milestones } from '../src/services/milestones.js';

// Wednesday 2026-03-18 15:00 local
const NOW = local(2026, 3, 18, 15);

describe('milestones', () => {
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

  test('each round number with the day it was reached, newest first', async () => {
    const m = await h.get('/stats/milestones?all=true');
    assert.equal(m.day, '2026-03-18');
    assert.deepEqual(m.reached.slice(0, 7).map((x) => [x.day, x.kind, x.text]), [
      ['2026-02-08', 'games', 'Your 10th game: Quest 8'],
      ['2026-02-05', 'series_games', '5 games of the Quest series'],
      ['2026-02-03', 'games', 'Your 5th game: Quest 3'],
      ['2026-02-03', 'series_games', '3 games of the Quest series'],
      ['2026-01-10', 'game_hours', '100 hours in Big <One>'],
      ['2026-01-10', 'hours', '100 hours of play'],
      ['2026-01-10', 'days', '10 days with play'],
    ]);
    const at = (kind, value, game) => m.reached.find((x) => x.kind === kind && x.value === value && (!game || x.game_id === game))?.day;
    // Big alone: 10 h on Jan 1, 25 on Jan 3, 50 on Jan 5, 100 on Jan 10
    assert.deepEqual([10, 25, 50, 100].map((v) => at('game_hours', v, big)), ['2026-01-01', '2026-01-03', '2026-01-05', '2026-01-10']);
    // in all, with Side's six hours on Jan 3: 36 h after Jan 3, 56 after Jan 5, 106 after Jan 10
    assert.deepEqual([10, 25, 50, 100].map((v) => at('hours', v)), ['2026-01-01', '2026-01-03', '2026-01-05', '2026-01-10']);
    assert.equal(at('streak', 7), '2026-01-07');
    assert.equal(at('game_hours', 10, side), undefined, 'Side has seven hours');
    assert.deepEqual(m.counts, { games: 2, series_games: 2, hours: 4, game_hours: 4, days: 1, streak: 1 });
    assert.equal(m.total, 14);
    assert.ok(m.reached.every((x, i) => !i || m.reached[i - 1].day >= x.day), 'newest first');
    const tier = (kind, value) => m.reached.find((x) => x.kind === kind && x.value === value).tier;
    assert.deepEqual([tier('hours', 10), tier('hours', 100), tier('games', 5), tier('series_games', 5)], [1, 4, 1, 2]);
    assert.equal(m.reached.find((x) => x.kind === 'series_games').subject, 'Quest');
  });

  test('notable is measured against the career: of each kind, the three highest rungs reached', async () => {
    const m = await h.get('/stats/milestones');
    // ten hours in all and in Big are the fourth rung down: no longer listed
    assert.deepEqual([m.total, m.notable_total, m.reached.length], [14, 12, 12]);
    assert.ok(m.reached.every((x) => x.notable));
    assert.equal(m.reached.find((x) => x.value === 10 && (x.kind === 'hours' || x.kind === 'game_hours')), undefined);
    assert.ok(m.reached.some((x) => x.kind === 'hours' && x.value === 25), 'the third rung down is');
    const all = await h.get('/stats/milestones?all=true');
    assert.deepEqual(all.reached.filter((x) => !x.notable).map((x) => x.text).sort(), ['10 hours in Big <One>', '10 hours of play']);
  });

  test('what is coming up, nearest first: hours in all, the games and series still played, days, games, sessions', async () => {
    const m = await h.get('/stats/milestones');
    const by = (kind, key) => m.coming.find((x) => x.kind === kind && (!key || x.game_id === key || x.subject === key));
    // 126 h of Big + 7 of Side + 2 of the Quests = 135 of 250
    assert.deepEqual([by('hours').target, by('hours').current, by('hours').percent, by('hours').text], [250, 135, 54, '250 hours of play']);
    // Big: 126 of 250 hours; Side: 7 of 10
    assert.deepEqual([by('game_hours', big).target, by('game_hours', big).current, by('game_hours', big).percent], [250, 126, 50]);
    assert.deepEqual([by('game_hours', side).target, by('game_hours', side).current, by('game_hours', side).text], [10, 7, '10 hours in Side']);
    // 12 days in January, 8 in February, 3 in March
    assert.deepEqual([by('days').target, by('days').current, by('days').percent], [25, 23, 92]);
    assert.deepEqual([by('games').target, by('games').current, by('games').text], [25, 10, '25 games played']);
    assert.deepEqual([by('sessions').target, by('sessions').current], [50, 25]);
    assert.deepEqual([by('series_games', 'Quest').target, by('series_games', 'Quest').current, by('series_games', 'Quest').text], [10, 8, '10 games of the Quest series']);
    assert.equal(by('series_hours'), undefined, 'two hours of ten: not half way');
    // three days in a row now, towards the 14 no streak has reached (the best was 12): too far off to list
    assert.equal(by('streak'), undefined);
    assert.ok(m.coming.every((x, i) => !i || m.coming[i - 1].percent >= x.percent), 'nearest first');
    assert.ok(m.coming.every((x) => x.percent < 100));
  });

  test('a game not played for three months is not "coming up"; limit cuts the list, not the counts', async () => {
    const old = await addGame(h, 'Shelved');
    await logSession(h, old, local(2025, 10, 1, 9), 540); // nine of ten hours, in October
    const m = await h.get('/stats/milestones?limit=2&all=true');
    assert.equal(m.coming.find((x) => x.game_id === old), undefined);
    assert.equal(m.reached.length, 2);
    assert.equal(m.total, 14, 'nothing new was reached');
    assert.equal((await h.call('GET', '/stats/milestones?limit=0')).status, 200);
  });

  test('excluded play reaches nothing', async () => {
    const before_ = (await h.get('/stats/milestones')).total;
    const x = await addGame(h, 'Excluded');
    await logSession(h, x, local(2026, 3, 1, 9), 700);
    const g = await h.get(`/games/${x}`);
    await h.patch(`/entries/${g.entries[0].id}`, { excluded: true });
    const m = await h.get('/stats/milestones?all=true');
    assert.equal(m.total, before_);
    assert.equal(m.reached.find((r) => r.game_id === x), undefined);
  });
});

describe('milestones: series, genres and achievements', () => {
  let h; let g;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    g = {};
    for (const t of ['Halo 3', 'Halo Infinite', 'Reach', 'Doom', 'Quake']) g[t] = await addGame(h, t);
    // IGDB says Reach is a Halo game; the titles say the other two are; all five are shooters
    h.db.prepare("INSERT INTO game_tags(game_id, kind, name) VALUES (?, 'franchise', 'Halo')").run(g.Reach);
    for (const id of Object.values(g)) h.db.prepare("INSERT INTO game_tags(game_id, kind, name) VALUES (?, 'genre', 'Shooter')").run(id);
    await logSession(h, g['Halo 3'], local(2026, 1, 5, 8), 600);
    await logSession(h, g['Halo Infinite'], local(2026, 1, 6, 8), 600);
    await logSession(h, g.Reach, local(2026, 1, 7, 8), 600);
    await logSession(h, g.Doom, local(2026, 1, 8, 8), 300);
    await logSession(h, g.Quake, local(2026, 1, 9, 8), 300);
    // Halo 3: all ten achievements, one an hour on January 5; 100 Gamerscore each, the first one rare, the last the platinum
    const entry = (await h.get(`/games/${g['Halo 3']}`)).entries[0].id;
    const add = h.db.prepare('INSERT INTO achievements(entry_id, ach_id, name, unlocked, unlocked_at, rarity, points, grade, first_seen_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, 100, ?, 0, 0)');
    for (let i = 0; i < 10; i++) add.run(entry, `A${i}`, `Achievement ${i}`, local(2026, 1, 5, 9 + i), i === 0 ? 3 : 40, i === 9 ? 'platinum' : null);
    await h.patch(`/games/${g.Doom}`, { status: 'playing' }); // (a write through the API: cached answers are dropped)
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('a series: IGDB\'s franchise and the titles name the same one; hours and games count across its games', async () => {
    const m = await h.get('/stats/milestones?all=true');
    const of = (kind) => m.reached.filter((x) => x.kind === kind).map((x) => [x.day, x.text]);
    assert.deepEqual(of('series_hours'), [['2026-01-07', '25 hours in the Halo series'], ['2026-01-05', '10 hours in the Halo series']]);
    assert.deepEqual(of('series_games'), [['2026-01-07', '3 games of the Halo series']]);
    const next = m.coming.find((x) => x.kind === 'series_hours');
    assert.deepEqual([next.subject, next.target, next.current, next.text], ['Halo', 50, 30, '50 hours in the Halo series']);
  });

  test('a genre: hours and games of every game tagged with it', async () => {
    const m = await h.get('/stats/milestones?all=true');
    const of = (kind) => m.reached.filter((x) => x.kind === kind).map((x) => [x.day, x.text]);
    assert.deepEqual(of('genre_hours'), [['2026-01-07', '25 hours of Shooter games']]);
    assert.deepEqual(of('genre_games'), [['2026-01-09', '5 Shooter games']]);
    const next = m.coming.find((x) => x.kind === 'genre_hours');
    assert.deepEqual([next.subject, next.target, next.current], ['Shooter', 50, 40]);
  });

  test('achievements: how many, the first rare one, Gamerscore, the first completed game and platinum', async () => {
    const m = await h.get('/stats/milestones?all=true');
    const of = (kind) => m.reached.filter((x) => x.kind === kind).map((x) => [x.day, x.text]);
    assert.deepEqual(of('achievements'), [['2026-01-05', '10 achievements unlocked']]);
    assert.deepEqual(of('rare'), [['2026-01-05', 'Your first rare achievement']]);
    assert.deepEqual(of('gamerscore'), [['2026-01-05', '1,000 Gamerscore']]);
    assert.deepEqual(of('completions'), [['2026-01-05', 'Your first completed game: Halo 3']]);
    assert.deepEqual(of('platinums'), [['2026-01-05', 'Your first platinum: Halo 3']]);
    assert.equal(m.reached.find((x) => x.kind === 'completions').game_id, g['Halo 3']);
    const by = (kind) => m.coming.find((x) => x.kind === kind);
    assert.deepEqual([by('achievements').target, by('gamerscore').target, by('completions').target, by('platinums').target, by('rare').target], [50, 2500, 5, 5, 10]);
  });
});

describe('milestones: an empty library', () => {
  let h;
  before(async () => { guardNetwork(); clock.install(NOW); h = await startApp(); });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('nothing reached; the first of each kind is ahead, at 0%', () => {
    const m = milestones(h.db, { now: NOW });
    assert.deepEqual([m.total, m.reached, m.counts], [0, [], {}]);
    assert.deepEqual(m.coming.map((x) => [x.kind, x.target, x.current, x.percent]).sort(), [['achievements', 10, 0, 0], ['days', 10, 0, 0], ['games', 5, 0, 0], ['hours', 10, 0, 0], ['sessions', 50, 0, 0]]);
  });
});
