// Legends: the stories in a career - series, makers, console generations, trends, platforms and eras
// of your own. The curated data (generations, makers, trends), who belongs where, the chapters, and
// the API with eras you add yourself.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FRANCHISES } from '../src/data/franchises.js';
import { GENERATIONS } from '../src/data/legends/generations.js';
import { MAKERS } from '../src/data/legends/makers.js';
import { TRENDS } from '../src/data/legends/trends.js';
import { generationOf, makersOf, trendsOf } from '../src/services/legends/catalog.js';
import { hrs } from '../src/services/legends/story.js';
import { clock, local, startApp, guardNetwork, restoreNetwork, addGame, logSession } from './suite/helpers/sessions-stats-harness.js';

const NOW = local(2026, 3, 18, 15);
const at = (y, m, d) => new Date(y, m - 1, d).getTime();
const text = (parts) => parts.map((p) => (typeof p === 'string' ? p : p.t ?? p.b ?? `<${p.d}:${p.p}>`)).join('');

describe('the curated side of Legends', () => {
  test('makers and trends name curated series; generations are in order; ids are unique', () => {
    const ids = new Set(FRANCHISES.map((f) => f.id));
    for (const m of MAKERS) {
      assert.ok(m.id && m.name && m.igdb.length, m.id);
      for (const f of m.franchises) assert.ok(ids.has(Array.isArray(f) ? f[0] : f), `${m.id}: ${f} is a curated series`);
    }
    for (const t of TRENDS) {
      assert.ok(t.id && t.name && t.tagline && Number.isInteger(t.from) && (t.to === null || t.to >= t.from), t.id);
      for (const f of t.franchises || []) assert.ok(ids.has(f), `${t.id}: ${f} is a curated series`);
      assert.ok((t.franchises || []).length + (t.titles || []).length + (t.prefixes || []).length >= 3, `${t.id} has members`);
    }
    for (const list of [MAKERS, TRENDS, GENERATIONS]) assert.equal(new Set(list.map((x) => x.id)).size, list.length);
    assert.deepEqual(GENERATIONS.map((g) => g.from), [...GENERATIONS.map((g) => g.from)].sort());
    assert.ok(MAKERS.length >= 30 && TRENDS.length >= 20);
    for (const id of ['nintendo', 'blizzard', 'bioware', 'rockstar', 'xbox', 'playstation']) assert.ok(MAKERS.some((m) => m.id === id), id);
  });

  test('a game is of the generation it came out in, unless it came out only on another one\'s consoles', () => {
    assert.equal(generationOf(at(2007, 9, 25), []).id, 'gen7');
    assert.equal(generationOf(at(2013, 9, 17), ['PlayStation 3', 'Xbox 360', 'PlayStation 4', 'PC (Microsoft Windows)']).id, 'gen7', 'by its date: later ports do not move it');
    assert.equal(generationOf(at(1999, 12, 29), ['Dreamcast']).id, 'gen6', 'a Dreamcast game from before the PlayStation 2');
    assert.equal(generationOf(at(2023, 2, 10), ['PlayStation 4', 'PlayStation 5']).id, 'gen9');
    assert.equal(generationOf(at(2020, 9, 17), ['PC (Microsoft Windows)']).id, 'gen8', 'a PC game: by its date');
    assert.equal(generationOf(null, ['Xbox 360']), null);
  });

  test('makers by IGDB\'s companies, else by the series and its years; trends by series, title and prefix', () => {
    const ids = (l) => l.map((x) => x.id).sort();
    assert.deepEqual(ids(makersOf('zelda', [])), ['nintendo']);
    assert.deepEqual(ids(makersOf(null, ['Nintendo EPD', 'Bungie'])), ['bungie', 'nintendo']);
    // a series that changed hands: by the year, and IGDB's word over the year
    assert.deepEqual(ids(makersOf('baldurs-gate', [], 2000)), ['bioware']);
    assert.deepEqual(ids(makersOf('baldurs-gate', [], 2023)), ['larian']);
    assert.deepEqual(ids(makersOf('baldurs-gate', ['Larian Studios'], 2023)), ['larian']);
    assert.deepEqual(ids(makersOf('halo', [], 2007)), ['bungie', 'xbox']);
    assert.deepEqual(ids(makersOf('halo', [], 2021)), ['xbox']);
    const tr = (...a) => trendsOf(...a).map((t) => t.id);
    assert.ok(tr('Halo 3', 'halo').includes('space-marines'));
    assert.ok(tr('Warhammer 40,000: Space Marine 2', null).includes('space-marines'));
    assert.ok(tr('Call of Duty®: WWII', 'call-of-duty', 'Call of Duty: WWII').includes('ww2-shooters'), 'by the curated entry it is');
    assert.ok(!tr('Call of Duty: Black Ops 6', 'call-of-duty', 'Call of Duty: Black Ops 6').includes('ww2-shooters'));
    assert.deepEqual(tr('A Game Of Its Own', null), []);
  });

  test('hours in prose', () => {
    assert.deepEqual([hrs(35), hrs(60), hrs(270), hrs(74400)], ['35 minutes', '1 hour', '4.5 hours', '1,240 hours']);
  });
});

describe('legends in a library', () => {
  let h; const id = {};
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    const meta = h.db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, name, release_date, fetched_at) VALUES (?, ?, 'title', ?, ?, 0)");
    const tag = h.db.prepare('INSERT INTO game_tags(game_id, kind, name) VALUES (?, ?, ?)');
    let n = 1;
    const add = async (title, [y, m], tags = {}) => {
      const g = await addGame(h, title);
      meta.run(g, n++, title, Date.UTC(y, m - 1, 15));
      for (const [kind, names] of Object.entries(tags)) for (const name of names) tag.run(g, kind, name);
      return g;
    };
    id.h3 = await add('Halo 3', [2007, 9], { developer: ['Bungie'], publisher: ['Microsoft Game Studios'], platform: ['Xbox 360'] });
    id.gears = await add('Gears of War 2', [2008, 11], { platform: ['Xbox 360'] });
    id.inf = await add('Halo Infinite', [2021, 12], { developer: ['343 Industries'], platform: ['Xbox Series X|S', 'Xbox One', 'PC (Microsoft Windows)'] });
    id.botw = await add('The Legend of Zelda: Breath of the Wild', [2017, 3], { platform: ['Nintendo Switch', 'Wii U'] });
    id.bastion = await add('Bastion', [2011, 7], { developer: ['Supergiant Games'] });
    id.transistor = await add('Transistor', [2014, 5], { developer: ['Supergiant Games'] });
    id.hades = await add('Hades', [2020, 9], { developer: ['Supergiant Games'] });
    id.alone = await add('A Game Of Its Own', [2019, 1]);
    // college, 2011-2014: Halo 3 and Gears; then a long break; Halo 3 again in 2020; the rest lately
    await logSession(h, id.h3, local(2011, 10, 1, 20), 600);
    await logSession(h, id.h3, local(2012, 2, 10, 20), 300);
    await logSession(h, id.gears, local(2012, 3, 5, 20), 240);
    await logSession(h, id.bastion, local(2013, 6, 1, 20), 120);
    await logSession(h, id.h3, local(2020, 5, 1, 20), 100);
    await logSession(h, id.botw, local(2025, 1, 10, 20), 900);
    await logSession(h, id.hades, local(2025, 6, 1, 20), 500);
    await logSession(h, id.inf, local(2026, 3, 10, 20), 200);
    await logSession(h, id.transistor, local(2026, 3, 12, 20), 60);
    await h.patch(`/games/${id.botw}`, { status: 'completed' });
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });
  const chapter = (l, cid) => { const c = l.chapters.find((x) => x.id === cid); return c ? text(c.parts) : null; };

  test('the page: series, makers, generations, trends and platforms found in the library', async () => {
    const l = await h.get('/legends');
    assert.deepEqual([l.career.games, l.career.minutes, l.career.from, l.career.to], [8, 3020, 2011, 2026]);
    assert.deepEqual(l.eras, []);
    assert.deepEqual(l.series.map((s) => s.id).slice(0, 2), ['halo', 'zelda']);
    const halo = l.series[0];
    assert.deepEqual([halo.kind, halo.games, halo.minutes, halo.from, halo.to], ['series', 2, 1200, 2011, 2026]);
    // makers: curated (Halo and Gears are Xbox's, Zelda Nintendo's), Bungie by IGDB, and a studio found in IGDB's developers
    const maker = (mid) => l.makers.find((m) => m.id === mid);
    assert.deepEqual([maker('xbox').games, maker('xbox').minutes], [3, 1440]);
    assert.deepEqual([maker('nintendo').games, maker('bungie').games], [1, 1]);
    assert.deepEqual([maker('studio-supergiant-games').name, maker('studio-supergiant-games').games, maker('studio-supergiant-games').minutes], ['Supergiant Games', 3, 680]);
    assert.equal(l.makers[0].id, 'xbox', 'most played first');
    // generations oldest first, each game in the one it came out in
    assert.deepEqual(l.generations.map((g) => [g.id, g.games]), [['gen7', 3], ['gen8', 4], ['gen9', 1]]);
    assert.equal(l.generations[0].tagline, 'Xbox 360 · PS3 · Wii');
    const marines = l.trends.find((t) => t.id === 'space-marines');
    assert.deepEqual([marines.games, marines.minutes, marines.peak], [3, 1440, { from: 2001, to: 2013 }]);
    assert.ok(!l.trends.some((t) => t.games < 2), 'a trend needs two games');
    assert.deepEqual(l.platforms.map((p) => [p.id, p.games]), [['manual', 8]]);
  });

  test('a series tells its story and brings its timeline', async () => {
    const l = await h.get('/legends/series/halo');
    assert.deepEqual([l.kind, l.name, l.totals.games, l.totals.minutes, l.totals.first_day, l.totals.active_years], ['series', 'Halo', 2, 1200, '2011-10-01', 4]);
    assert.deepEqual(l.chapters.map((c) => c.id), ['began', 'peak', 'defined', 'reach', 'place', 'break', 'now']);
    assert.equal(chapter(l, 'began'), 'The series began in 2001. You arrived on <2011-10-01:day> with Halo 3, 10 years in.');
    assert.equal(chapter(l, 'peak'), 'Your biggest year was 2011: 600 minutes'.replace('600 minutes', '10 hours') + ', 50% of the time that has a date. Halo 3 led it.');
    assert.equal(chapter(l, 'defined'), 'Halo 3 is the heart of it: 1,000 minutes'.replace('1,000 minutes', '17 hours') + ', 83% of the total. Then Halo Infinite (3.3 hours).');
    assert.match(chapter(l, 'place'), /^You have played 2 of its 8 main games, in one version or another\. The era you know best: Bungie \(17 hours\)\. Next in line: /);
    assert.equal(chapter(l, 'break'), '7 years without it, from 2012 to 2020. Then you came back.');
    assert.equal(chapter(l, 'now'), 'It is still going: you last played Halo Infinite on <2026-03-10:day>.');
    // every year from the first to the last, the game that led each
    assert.deepEqual(l.years.map((y) => y.year), Array.from({ length: 16 }, (_, i) => 2011 + i));
    assert.deepEqual([l.years[0].minutes, l.years[0].top.title, l.years[2].minutes, l.years[2].top], [600, 'Halo 3', 0, null]);
    assert.deepEqual(l.games.map((g) => [g.title, g.minutes]), [['Halo 3', 1000], ['Halo Infinite', 200]]);
    assert.ok(l.series_detail.items.length > 10 && l.series_detail.eras.length === 3, 'the franchise timeline comes with it');
    // parts: text, games, dates and figures
    for (const c of l.chapters) for (const p of c.parts) assert.ok(typeof p === 'string' || (p.g && p.t) || (p.d && p.p) || p.b, JSON.stringify(p));
    assert.equal((await h.get('/legends/series/Halo')).id, 'halo', 'by its name');
  });

  test('a generation: in its day and after; a trend; a maker; a platform; the career', async () => {
    const g = await h.get('/legends/generation/gen7');
    assert.equal(g.name, 'The Xbox 360, PS3 and Wii era');
    assert.equal(chapter(g, 'began'), 'It ran from <2005-11-22:month> to <2013-11-15:month>. 3 games of it are in your library. The first you played: Halo 3, on <2011-10-01:day>.');
    assert.equal(chapter(g, 'after'), 'Of the 23 hours you can put a date on, nearly all was played in its day: you were there.', '100 of 1,360 minutes came after 2013');
    assert.match(chapter(g, 'reach'), /^3 games, all of them played\. They span 2 series, Halo \(17 hours\) and Gears of War \(4 hours\) most of all\./);
    assert.deepEqual(g.generation, { short: 'Xbox 360 · PS3 · Wii', from_day: '2005-11-22', to_day: '2013-11-15' });
    const t = await h.get('/legends/trend/space-marines');
    assert.equal(chapter(t, 'began'), 'It was at its height from 2001 to 2013. Your way in: Halo 3, on <2011-10-01:day>.');
    assert.match(chapter(t, 'after'), /79% was played in its day, the rest after 2013\./);
    const m = await h.get('/legends/maker/studio-supergiant-games');
    assert.deepEqual([m.name, m.totals.games, chapter(m, 'began')], ['Supergiant Games', 3, 'Your first Supergiant Games game on record: Bastion, on <2013-06-01:day>.']);
    const p = await h.get('/legends/platform/manual');
    assert.equal(p.totals.games, 8);
    const c = await h.get('/legends/career/all');
    assert.deepEqual([c.name, c.totals.games, c.totals.played, c.totals.finished, c.totals.minutes], ['Your career', 8, 7, 1, 3020]);
    assert.equal(chapter(c, 'reach'), '8 games in all, 7 played, 1 finished. They span 3 series, Halo (20 hours) and The Legend of Zelda (15 hours) most of all.');
    for (const [path, status] of [['/legends/trend/nope', 404], ['/legends/maker/nope', 404], ['/legends/generation/gen1', 404], ['/legends/series/no-such', 404], ['/legends/era/9', 404], ['/legends/bogus/x', 400]]) assert.equal((await h.call('GET', path)).status, status, path);
  });

  test('findings for Insights: what stands out in a range, told in parts, the most telling first', async () => {
    const f = await h.get('/stats/findings?range=all');
    assert.deepEqual(f.range, { from: '2011-10-01', to: '2026-03-18', label: 'All time' });
    const by = Object.fromEntries(f.findings.map((x) => [x.id, text(x.parts)]));
    assert.equal(by.concentration, 'Halo 3 alone is 33% of it; your top three make 79%.');
    assert.equal(by.series, 'Halo is 40% of it, across 2 games.');
    assert.equal(by.finish, 'You started 7 games in all and finished 1: 1 in 7.');
    assert.match(by.lag, /^On average you get to a game [\d.]+ years after it came out\. The oldest thing here: Halo 3 \(2007\)\.$/);
    assert.deepEqual(f.findings.map((x) => x.score), [...f.findings.map((x) => x.score)].sort((a, b) => b - a), 'the most telling first');
    const series = f.findings.find((x) => x.id === 'series').parts[0];
    assert.deepEqual(series, { l: '/legend/series/halo', t: 'Halo' }, 'a series is a link to its legend');
    for (const x of f.findings) { assert.ok(x.title && x.parts.length); for (const p of x.parts) assert.ok(typeof p === 'string' || (p.g && p.t) || (p.d && p.p) || p.b || (p.l && p.t), JSON.stringify(p)); }
    // a range: what was new in it, what you already knew
    const y = await h.get('/stats/findings?range=year:2025');
    assert.equal(Object.fromEntries(y.findings.map((x) => [x.id, text(x.parts)])).known, undefined, 'two games: too few to say');
    assert.deepEqual((await h.get('/stats/findings?range=year:2001')).findings, [], 'nothing played: nothing found');
    assert.equal((await h.get('/stats/findings?range=all&limit=2')).findings.length, 2);
  });

  test('eras of your own: added, told as what you played then, changed and removed', async () => {
    const e = await h.post('/legends/eras', { name: '  College ', from: '2011', to: '2014-05', note: 'Dorm room, shared 360' });
    assert.deepEqual(e, { id: 1, name: 'College', from: '2011-01-01', to: '2014-05-31', note: 'Dorm room, shared 360' });
    const now_ = await h.post('/legends/eras', { name: 'These days', from: '2025-01-01' });
    assert.deepEqual([now_.id, now_.to], [2, null]);
    const l = await h.get('/legends');
    assert.deepEqual(l.eras.map((x) => [x.kind, x.id, x.name, x.games, x.minutes, x.from, x.to]), [['era', '1', 'College', 3, 1260, 2011, 2013], ['era', '2', 'These days', 4, 1660, 2025, 2026]]);
    // what was unlocked in an era is counted on its card too (often all an older console left of it)
    for (const x of l.eras) assert.ok(Number.isInteger(x.unlocks) && Number.isInteger(x.unlock_games) && x.unlock_games <= x.unlocks, JSON.stringify(x));
    const s = await h.get('/legends/era/1');
    assert.deepEqual([s.name, s.tagline, s.window, s.totals.games, s.totals.minutes], ['College', 'Dorm room, shared 360', { from: '2011-01-01', to: '2014-05-31' }, 3, 1260]);
    assert.deepEqual(s.chapters.map((c) => c.id), ['began', 'peak', 'defined', 'reach', 'new', 'now']);
    assert.equal(chapter(s, 'began'), '<2011-01-01:month> to <2014-05-31:month>: 3.5 years. It opens with Halo 3.');
    assert.equal(chapter(s, 'defined'), 'Halo 3 is the heart of it: 15 hours, 71% of the total. Then Gears of War 2 (4 hours) and Bastion (2 hours).');
    assert.match(chapter(s, 'new'), /^3 games you had never played before start here, Halo 3 and Gears of War 2 among them\. It comes to 0\.1 hours a week, against /);
    assert.equal(chapter(s, 'now'), 'It closed in <2014-05-31:month>. Halo 3 came with you: you have played it since.');
    assert.equal(s.months, null, 'longer than three years: by year');
    assert.deepEqual(s.years.map((y) => [y.year, y.minutes]), [[2011, 600], [2012, 540], [2013, 120]]);
    assert.ok(Array.isArray(s.milestones), 'the badges earned in it');
    // an era still going is told by the month, up to today
    const t = await h.get('/legends/era/2');
    assert.deepEqual([t.window.to, t.months.length, t.months[0].key, chapter(t, 'now')], ['2026-03-18', 15, '2025-01', 'It is still going: you last played Transistor on <2026-03-12:day>.']);
    // changed
    assert.deepEqual(await h.patch('/legends/eras/1', { name: 'University', to: '2012' }), { id: 1, name: 'University', from: '2011-01-01', to: '2012-12-31', note: 'Dorm room, shared 360' });
    assert.equal((await h.get('/legends/era/1')).totals.minutes, 1140);
    // refused
    for (const body of [{ from: '2011' }, { name: 'X' }, { name: 'X', from: 'last year' }, { name: 'X', from: '2012', to: '2011' }, { name: 'X', from: '2012-13' }, { name: 'x'.repeat(61), from: '2012' }]) {
      assert.equal((await h.call('POST', '/legends/eras', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await h.call('PATCH', '/legends/eras/99', { name: 'X' })).status, 404);
    // removed: your play is untouched, the settings do not carry the eras
    assert.deepEqual(await h.del('/legends/eras/1'), { ok: true });
    assert.deepEqual((await h.get('/legends')).eras.map((x) => x.name), ['These days']);
    assert.equal((await h.call('DELETE', '/legends/eras/1')).status, 404);
    assert.equal((await h.get('/settings')).legend_eras, undefined);
    assert.equal((await h.get('/legends/career/all')).totals.minutes, 3020);
  });
});
