// "What should I play?" (GET /suggest, /suggest/feedback): each mode ranks the expected game of a
// small hand-built library first, the reasons carry the right numbers, the time fit follows the
// minutes given, "Not now" / "Never" are respected and expire, a seed makes picks repeatable,
// hidden / excluded / wishlist / finished games are never suggested, and a generated library of
// 1,500 games answers within a time budget.
//
// The fixture is written straight into the database, so every number below can be worked out by
// hand. Times are local wall-clock times, so the file passes in any timezone.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clock, local, startApp, guardNetwork, restoreNetwork, MIN, DAY } from './suite/helpers/sessions-stats-harness.js';
import { flushRollups } from '../src/services/rollup.js';
import { timeFit, span, MODES } from '../src/services/suggest.js';

// Wednesday 2026-03-18 15:00 local
const NOW = local(2026, 3, 18, 15);
const at = (daysAgo, hour = 20) => { const d = new Date(NOW); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d.getTime(); };

function writer(db) {
  const game = (title, { status = 'unset', hidden = 0, favorite = 0, rating = null } = {}) => Number(db.prepare('INSERT INTO games(title, norm_title, status, hidden, favorite, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(title, title.toLowerCase(), status, hidden, favorite, rating, local(2025, 1, 1), local(2025, 1, 1)).lastInsertRowid);
  const entry = (gameId, platform, { excluded = 0, hist = {}, lastPlayed = null } = {}) => Number(db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, excluded, hist, last_played_at)
    VALUES (NULL, ?, ?, ?, 'x', 0, ?, ?, ?, ?)`).run(gameId, platform, `ext-${gameId}-${platform}`, local(2025, 1, 1), excluded, JSON.stringify(hist), lastPlayed).lastInsertRowid);
  const ins = db.prepare('INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const bump = db.prepare('UPDATE entries SET playtime_min = playtime_min + ? WHERE id = ?');
  return {
    game, entry,
    /** exact tracked sessions of `minutes`, one ending at 20:00 on each of the days ago given */
    play: (e, minutes, daysAgo) => { for (const d of daysAgo) { const end = at(d); ins.run(e, 'manual', 'play', minutes, end - minutes * MIN, end, end - minutes * MIN, end, end); bump.run(minutes, e); } },
    baseline: (e, minutes) => { ins.run(e, 'inferred', 'baseline', minutes, null, null, null, null, 0); bump.run(minutes, e); },
    achievements: (e, unlocked, total) => {
      const a = db.prepare('INSERT INTO achievements(entry_id, ach_id, unlocked, unlocked_at, first_seen_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)');
      for (let i = 0; i < total; i++) a.run(e, `a${i}`, i < unlocked ? 1 : 0, i < unlocked ? local(2025, 6, 1) : null);
    },
  };
}

describe('what should I play? on a hand-built library', () => {
  let h; let g;
  const pick = (q) => h.get(`/suggest?${new URLSearchParams({ seed: '1', ...q })}`);
  const first = async (q) => (await pick(q)).picks[0];
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    const w = writer(h.db);
    g = {
      pocket: w.game('Pocket', { status: 'backlog' }), // short sessions a month or more ago
      current: w.game('Current', { status: 'playing' }), // played every few days, yesterday too
      epic: w.game('Paused Epic', { status: 'paused' }), // 10h in 60 days, nothing in the last 2 weeks
      almost: w.game('Almost', {}), // 19 of 20 achievements
      flame: w.game('Old Flame', { favorite: 1 }), // 40h, untouched for 2 years
      fresh: w.game('Fresh', { status: 'backlog' }), // never played, in the backlog since Sep 2024
      blank: w.game('Blank', {}), // never played, no status
      // never suggested
      hidden: w.game('Hidden Gem', { status: 'playing', hidden: 1, favorite: 1 }),
      wish: w.game('Wished', { status: 'wishlist', favorite: 1 }),
      done: w.game('Done', { status: 'completed' }),
      quit: w.game('Quit', { status: 'dropped' }),
      double: w.game('Double', { status: 'playing', favorite: 1 }),
      beaten: w.game('Beaten', { status: 'beaten' }), // 30 of 40 achievements: only when chasing completion
    };
    const e = {
      pocket: w.entry(g.pocket, 'steam'), current: w.entry(g.current, 'xbox'), epic: w.entry(g.epic, 'psn'), almost: w.entry(g.almost, 'steam'),
      flame: w.entry(g.flame, 'steam', { lastPlayed: local(2024, 3, 1, 12) }), fresh: w.entry(g.fresh, 'xbox', { hist: { date_added: local(2024, 9, 1) } }), blank: w.entry(g.blank, 'psn'),
      hidden: w.entry(g.hidden, 'steam'), wish: w.entry(g.wish, 'steam'), done: w.entry(g.done, 'steam'), quit: w.entry(g.quit, 'xbox'),
      double: w.entry(g.double, 'steam', { excluded: 1 }), beaten: w.entry(g.beaten, 'psn'),
    };
    w.play(e.pocket, 12, [30]); w.play(e.pocket, 13, [35, 40]); w.play(e.pocket, 15, [45]); // median 13, 53 minutes
    w.play(e.current, 90, [1, 4, 7]); // 270 in 14 days, 90 in the last 3
    w.play(e.epic, 120, [20, 25, 30, 35, 40]); // 600 in 60 days
    w.play(e.almost, 200, [70, 80, 90, 100, 110]); // long sessions: not a quick fix
    w.achievements(e.almost, 19, 20);
    w.baseline(e.flame, 2400);
    w.play(e.hidden, 15, [2, 5, 9]);
    w.play(e.wish, 15, [20]);
    w.play(e.done, 60, [3, 6]); w.achievements(e.done, 10, 20);
    w.play(e.quit, 30, [16]);
    w.play(e.double, 15, [2, 5, 9]);
    w.play(e.beaten, 60, [100, 120]); w.achievements(e.beaten, 30, 40);
    h.db.prepare('UPDATE games SET created_at = ? WHERE id = ?').run(local(2026, 2, 1), g.blank); // added six weeks ago
    flushRollups(h.db);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  const NEVER = () => [g.hidden, g.wish, g.done, g.quit, g.double];

  test('each mode ranks the expected game first, with reasons that carry its numbers', async () => {
    const cases = [
      [{ mode: 'quick', minutes: '15' }, 'Pocket', 'fit', 'Sessions here run about 13m, fits in 15m', 13],
      [{ mode: 'keep', minutes: '120' }, 'Current', 'recent', '4h 30m in the last 2 weeks, last played yesterday', 270],
      [{ mode: 'finish', minutes: '60' }, 'Almost', 'finish', '95% of achievements, 1 left', 95],
      [{ mode: 'new', minutes: '60' }, 'Fresh', 'fresh', 'Never played, in your backlog for 18 months', 0],
      [{ mode: 'rediscover', minutes: '60' }, 'Old Flame', 'dusty', '40h played, untouched for 2 years', 747],
      [{ mode: 'auto', minutes: '120' }, 'Paused Epic', 'momentum', '10h in the last 60 days, nothing in the last 2 weeks', 600],
    ];
    for (const [q, title, id, text, value] of cases) {
      const r = await pick(q);
      const p = r.picks[0];
      assert.equal(p.title, title, `${q.mode}: ${r.picks.map((x) => `${x.title} ${x.score}`).join(', ')}`);
      assert.equal(r.mode, q.mode);
      assert.equal(r.mode_label, MODES[q.mode].label);
      assert.equal(p.mode_match, true, `${q.mode}: ${title} has what the mode looks for`);
      const reason = p.reasons.find((x) => x.id === id);
      assert.ok(reason, `${q.mode}: ${title} reasons ${JSON.stringify(p.reasons)}`);
      assert.equal(reason.text, text);
      assert.equal(reason.value, value);
      if (q.mode !== 'auto') assert.equal(p.reasons[0].id, id, `${q.mode}: the mode's own reason comes first`);
      assert.ok(p.reasons.length >= 1 && p.reasons.length <= 4);
      assert.equal(r.picks.length, 3, `${q.mode}: a main pick and two alternates`);
      assert.ok(r.picks.every((x) => x.score >= 0 && x.score <= 100));
    }
    // the other reasons: favorite, status, beaten with achievements left, typical session from the player
    const flame = await first({ mode: 'rediscover', minutes: '60' });
    assert.deepEqual(flame.reasons.find((x) => x.id === 'favorite'), { id: 'favorite', text: 'One of your favorites', value: 1 });
    assert.equal(flame.typical_session_source, 'overall', 'no sessions of its own: the player\'s median');
    assert.equal(flame.last_played_at, local(2024, 3, 1, 12));
    assert.equal(flame.achievements, null);
    const almost = await first({ mode: 'finish', minutes: '60' });
    assert.deepEqual(almost.achievements, { unlocked: 19, total: 20, percent: 95 });
    assert.equal(almost.typical_session_minutes, 200);
    assert.equal(almost.typical_session_source, 'game');
    assert.deepEqual(almost.platforms, ['steam']);
    const epic = await first({ mode: 'auto', minutes: '120' });
    assert.deepEqual(epic.reasons.find((x) => x.id === 'status'), { id: 'status', text: 'Marked Paused', value: 'paused' });
  });

  test('time fit: the typical session (median of the game, else the player\'s) against the minutes given', async () => {
    assert.equal(timeFit(13, 15), 1);
    assert.equal(timeFit(30, 30), 1);
    assert.equal(timeFit(33, 30), 0.9, '15% over still fits');
    assert.equal(timeFit(120, 30), 0, 'four times as long does not');
    assert.ok(timeFit(5, 120) < timeFit(60, 120), 'much shorter than the time is a weaker fit');
    assert.equal(timeFit(150, 0, true), 1);
    assert.equal(span(9), '9 days');
    assert.equal(span(400), '13 months');
    assert.equal(span(747), '2 years');

    const q15 = await pick({ mode: 'quick', minutes: '15' });
    assert.equal(q15.minutes, 15);
    const q120 = await pick({ mode: 'quick', minutes: '120' });
    assert.notEqual(q120.picks[0].title, 'Pocket', '13-minute sessions are not the best use of two hours');
    assert.equal(q120.picks[0].title, 'Paused Epic');
    assert.equal(q120.picks[0].typical_session_minutes, 120);
    assert.equal(q120.picks[0].reasons[0].text, 'Sessions here run about 2h, fits in 2h');
    // a 2h game in a 30-minute slot says so
    const epic = (await pick({ mode: 'auto', minutes: '30', count: '10' })).picks.find((x) => x.title === 'Paused Epic');
    assert.deepEqual(epic.reasons.at(-1), { id: 'fit_long', text: 'Sessions here usually run 2h, longer than 30m', value: 120 });
    // quick fix without minutes assumes 30; any other mode leaves the fit out
    assert.equal((await pick({ mode: 'quick' })).minutes, 30);
    const any = await pick({ mode: 'auto' });
    assert.equal(any.minutes, null);
    assert.ok(any.picks.every((p) => !p.reasons.some((x) => x.id === 'fit' || x.id === 'fit_long')));
    // a long session
    const long = await pick({ mode: 'auto', minutes: 'long', count: '10' });
    assert.equal(long.minutes, 240);
    assert.equal(long.long, true);
    assert.equal(long.picks.find((x) => x.title === 'Paused Epic').reasons.find((x) => x.id === 'fit').text, 'Sessions here run about 2h, good for a long session');
    // the player's median over every tracked session of counted entries (26 of them: the 13th is 60, the 14th 90)
    assert.equal(any.typical_session_minutes, 75);
  });

  test('never suggested: hidden, every entry excluded, wishlist, completed, dropped; beaten only when chasing completion', async () => {
    const seen = new Set();
    for (const mode of Object.keys(MODES)) {
      for (const minutes of ['15', '60', 'long', '']) {
        for (let seed = 0; seed < 6; seed++) {
          const r = await h.get(`/suggest?${new URLSearchParams({ mode, minutes, seed: String(seed), count: '10' })}`);
          for (const p of r.picks) seen.add(p.game_id);
          assert.deepEqual(r.excluded_counts, { hidden: 1, excluded: 1, wishlist: 1, completed: 1, dropped: 1, beaten: 1, never: 0, snoozed: 0, platform: 0, shown: 0, just_played: mode === 'keep' ? 0 : 1 }, `${mode} ${minutes}`);
          assert.equal(r.considered + Object.values(r.excluded_counts).reduce((a, b) => a + b, 0), 13, 'every game counted once');
        }
      }
    }
    for (const id of [...NEVER(), g.beaten]) assert.ok(!seen.has(id), `game ${id} never suggested`);
    const chase = await pick({ mode: 'finish', minutes: 'long', chase: 'true', count: '10' });
    assert.equal(chase.chase, true);
    assert.equal(chase.excluded_counts.beaten, 0);
    const b = chase.picks.find((p) => p.game_id === g.beaten);
    assert.ok(b, 'a beaten game with achievements left, when chasing completion');
    assert.equal(b.reasons[0].text, 'Beaten, 10 achievements left (75%)');
    assert.equal(chase.picks[0].title, 'Almost', 'with time for its long sessions, 95% comes first');
    assert.equal((await first({ mode: 'finish', minutes: '60', chase: 'true' })).title, 'Beaten', 'in an hour: the beaten game, whose sessions fit');
  });

  test('variety: the game played most in the last 3 days is left for "Keep going"', async () => {
    for (const mode of ['auto', 'quick', 'finish', 'surprise']) {
      const r = await pick({ mode, minutes: '60', count: '10' });
      assert.ok(!r.picks.some((p) => p.title === 'Current'), mode);
      assert.equal(r.excluded_counts.just_played, 1);
    }
    assert.equal((await first({ mode: 'keep', minutes: '60' })).title, 'Current');
  });

  test('platform filter', async () => {
    const r = await pick({ mode: 'auto', minutes: '60', platform: 'xbox', count: '10' });
    assert.deepEqual(r.picks.map((p) => p.title), ['Fresh'], 'Current (xbox) is the one just played, Quit is dropped');
    assert.equal(r.platform, 'xbox');
    assert.equal(r.excluded_counts.platform, 5);
    const two = await pick({ mode: 'auto', minutes: '60', platform: 'xbox,psn', count: '10' });
    assert.deepEqual(two.picks.map((p) => p.title).sort(), ['Blank', 'Fresh', 'Paused Epic']);
    assert.match(r.note, /cannot see what is installed/);
  });

  test('deterministic for the same inputs and seed; pick again (seed + 1, exclude) never repeats', async () => {
    for (const mode of Object.keys(MODES)) {
      const q = { mode, minutes: '60', seed: '42' };
      assert.deepEqual(await pick(q), await pick(q), `${mode}: same answer`);
    }
    // surprise me: the seed changes the draw, always among real candidates
    const firsts = new Set();
    for (let seed = 0; seed < 30; seed++) firsts.add((await first({ mode: 'surprise', minutes: '60', seed: String(seed) })).title);
    assert.ok(firsts.size >= 2, `surprise draws vary with the seed: ${[...firsts]}`);
    // rerolls until every candidate has been shown
    const shown = [];
    for (let seed = 1; ; seed++) {
      const r = await pick({ mode: 'auto', minutes: '60', seed: String(seed), exclude: shown.join(',') });
      if (!r.picks.length) break;
      for (const p of r.picks) { assert.ok(!shown.includes(p.game_id), `${p.title} shown twice`); shown.push(p.game_id); }
      assert.equal(r.excluded_counts.shown, shown.length - r.picks.length);
      assert.ok(seed < 10);
    }
    assert.equal(shown.length, 6, 'all six candidates, each once');
  });

  test('Not now snoozes for N days, Never excludes; both listed, undone with reset, snoozes expire', async () => {
    assert.equal((await first({ mode: 'quick', minutes: '15' })).title, 'Pocket');
    const s = await h.post('/suggest/feedback', { game_id: g.pocket, action: 'snooze', days: 3 });
    assert.deepEqual(s, { ok: true, game_id: g.pocket, action: 'snooze', until: NOW + 3 * DAY });
    let r = await pick({ mode: 'quick', minutes: '15', count: '10' });
    assert.ok(!r.picks.some((p) => p.title === 'Pocket'), 'snoozed');
    assert.equal(r.excluded_counts.snoozed, 1);
    await h.post('/suggest/feedback', { game_id: g.fresh, action: 'never' });
    r = await pick({ mode: 'new', minutes: '60', count: '10' });
    assert.ok(!r.picks.some((p) => p.title === 'Fresh'));
    assert.equal(r.picks[0].title, 'Blank');
    assert.equal(r.excluded_counts.never, 1);
    const list = await h.get('/suggest/feedback');
    assert.equal(list.snoozed, 1);
    assert.equal(list.never, 1);
    assert.deepEqual(list.items.map((x) => [x.title, x.action, x.until]).sort(), [['Fresh', 'never', null], ['Pocket', 'snooze', NOW + 3 * DAY]]);
    // the snooze ends on its own
    clock.advance(3 * DAY - MIN);
    assert.ok(!(await pick({ mode: 'quick', minutes: '15', count: '10' })).picks.some((p) => p.title === 'Pocket'), 'still snoozed a minute before');
    clock.advance(2 * MIN);
    assert.equal((await first({ mode: 'quick', minutes: '15' })).title, 'Pocket', 'back after 3 days');
    assert.deepEqual((await h.get('/suggest/feedback')).items.map((x) => x.title), ['Fresh'], 'an expired snooze is not listed');
    // never lasts until reset
    clock.advance(400 * DAY);
    assert.ok(!(await pick({ mode: 'new', minutes: '60', count: '10' })).picks.some((p) => p.title === 'Fresh'));
    await h.post('/suggest/feedback', { game_id: g.fresh, action: 'reset' });
    assert.deepEqual((await h.get('/suggest/feedback')).items, []);
    clock.set(NOW);
    assert.equal((await first({ mode: 'new', minutes: '60' })).title, 'Fresh', 'reset: suggested again');
    // a snooze is replaced by a new choice, and default days are 7
    const d = await h.post('/suggest/feedback', { game_id: g.blank, action: 'snooze' });
    assert.equal(d.until, NOW + 7 * DAY);
    assert.equal((await h.post('/suggest/feedback', { game_id: g.blank, action: 'never' })).until, null);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM suggest_feedback WHERE game_id = ?').get(g.blank).n, 1);
    await h.post('/suggest/feedback', { game_id: g.blank, action: 'reset' });
  });

  test('feedback follows a game into a merge, and is dropped with the game', async () => {
    const w = writer(h.db);
    const a = w.game('Merge A'); const b = w.game('Merge B');
    w.entry(a, 'steam'); w.entry(b, 'xbox');
    await h.post('/suggest/feedback', { game_id: b, action: 'never' });
    await h.post(`/games/${a}/merge`, { source_ids: [b] });
    assert.deepEqual((await h.get('/suggest/feedback')).items.map((x) => [x.game_id, x.action]), [[a, 'never']]);
    await h.del(`/games/${a}`);
    assert.deepEqual((await h.get('/suggest/feedback')).items, []);
  });

  test('bad input is refused with a reason', async () => {
    for (const [q, msg] of [[{ mode: 'party' }, /mode must be one of/], [{ minutes: '2' }, /minutes must be/], [{ minutes: 'soon' }, /minutes must be/]]) {
      const r = await h.call('GET', `/suggest?${new URLSearchParams(q)}`);
      assert.equal(r.status, 400);
      assert.match(r.body.error, msg);
    }
    for (const [body, status] of [[{ game_id: 999999, action: 'never' }, 404], [{ game_id: g.blank, action: 'later' }, 400], [{ game_id: g.blank, action: 'snooze', days: 0 }, 400], [{ game_id: g.blank, action: 'snooze', days: 400 }, 400], [{ action: 'never' }, 404]]) {
      assert.equal((await h.call('POST', '/suggest/feedback', body)).status, status, JSON.stringify(body));
    }
    assert.equal((await pick({ count: '50' })).picks.length, 6, 'count is capped (10) and limited by the candidates');
  });

  test('documented in the OpenAPI document (stable for the mobile apps)', async () => {
    const doc = await h.get('/api/openapi.json');
    const get = doc.paths['/api/v1/suggest'].get;
    assert.equal(get.tags[0], 'suggest');
    for (const q of ['minutes', 'mode', 'platform', 'count', 'seed', 'exclude', 'chase']) assert.ok(get.parameters.some((x) => x.name === q && x.description), `?${q}`);
    for (const f of ['picks', 'game_id', 'reasons', 'typical_session_minutes', 'last_played_at', 'achievements', 'considered', 'excluded_counts', 'mode_match']) assert.ok(get.responses[200].description.includes(f), `documents ${f}`);
    assert.ok(doc.paths['/api/v1/suggest/feedback'].get.responses[200].description.includes('until'));
    assert.match(doc.paths['/api/v1/suggest/feedback'].post.requestBody.content['application/json'].schema.description, /snooze \| never \| reset/);
  });
});

describe('what should I play? on a large library (1,500 games, 50,000 sessions)', () => {
  const GAMES = 1500;
  const SESSIONS = 50_000;
  const BUDGET = Number(process.env.SUGGEST_BUDGET_MS || 1500);
  let h;
  before(async () => {
    guardNetwork();
    clock.install(NOW);
    h = await startApp();
    const db = h.db;
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    db.exec('BEGIN');
    const plats = ['steam', 'xbox', 'psn'];
    const statuses = ['unset', 'backlog', 'playing', 'paused', 'completed', 'beaten', 'dropped', 'wishlist'];
    const gIns = db.prepare('INSERT INTO games(title, norm_title, status, hidden, favorite, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const eIns = db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, hist, last_played_at) VALUES (NULL, ?, ?, ?, 'x', 0, ?, ?, ?)");
    const sIns = db.prepare('INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const aIns = db.prepare('INSERT INTO achievements(entry_id, ach_id, unlocked, unlocked_at, first_seen_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)');
    const entries = [];
    for (let i = 0; i < GAMES; i++) {
      const gid = Number(gIns.run(`Game ${i}`, `game ${i}`, statuses[i % 8], i % 50 === 0 ? 1 : 0, i % 37 === 0 ? 1 : 0, i % 5 === 0 ? (i % 11) : null, NOW - 4 * 365 * DAY, NOW).lastInsertRowid);
      const hist = i % 4 === 0 ? JSON.stringify({ date_added: NOW - Math.floor(rnd() * 3000) * DAY }) : '{}';
      const eid = Number(eIns.run(gid, plats[i % 3], `g${i}`, NOW - 3 * 365 * DAY, hist, i % 3 === 0 ? NOW - Math.floor(rnd() * 2000) * DAY : null).lastInsertRowid);
      entries.push(eid);
      if (i % 2 === 0) for (let a = 0; a < 20; a++) aIns.run(eid, `a${a}`, rnd() < 0.6 ? 1 : 0, NOW - Math.floor(rnd() * 1000) * DAY);
    }
    for (let i = 0; i < SESSIONS; i++) {
      const e = entries[Math.floor(rnd() ** 2 * entries.length)];
      const end = NOW - Math.floor(rnd() * 3 * 365 * DAY);
      const m = 5 + Math.floor(rnd() * 240);
      if (i % 3 === 0) sIns.run(e, 'sync', 'play', m, end - DAY, end, null, null, end);
      else sIns.run(e, 'sync', 'play', m, end - m * MIN, end, end - m * MIN, end, end);
    }
    db.exec('UPDATE entries SET playtime_min = (SELECT COALESCE(SUM(minutes), 0) FROM sessions s WHERE s.entry_id = entries.id)');
    db.exec('COMMIT');
    flushRollups(db);
  });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('every mode answers within the budget; later answers reuse the aggregates', async () => {
    let t = performance.now();
    const cold = await h.get('/suggest?mode=auto&minutes=60&seed=1');
    const coldMs = performance.now() - t;
    assert.ok(coldMs < BUDGET, `cold ${Math.round(coldMs)}ms (budget ${BUDGET}ms)`);
    assert.equal(cold.picks.length, 3);
    assert.equal(cold.considered + Object.values(cold.excluded_counts).reduce((a, b) => a + b, 0), GAMES);
    for (const mode of Object.keys(MODES)) {
      for (const minutes of ['15', '120', 'long']) {
        t = performance.now();
        const r = await h.get(`/suggest?mode=${mode}&minutes=${minutes}&seed=3&count=10`);
        const ms = performance.now() - t;
        assert.ok(ms < 250, `${mode} ${minutes}: ${Math.round(ms)}ms warm`);
        assert.equal(r.picks.length, 10);
        assert.ok(r.picks.every((p) => !['completed', 'dropped', 'wishlist', 'beaten'].includes(p.status) && p.reasons.length), mode);
      }
    }
    // a write drops the cached aggregates: a snoozed game leaves the picks at once
    await h.post('/suggest/feedback', { game_id: cold.picks[0].game_id, action: 'snooze', days: 1 });
    t = performance.now();
    const after_ = await h.get('/suggest?mode=auto&minutes=60&seed=1');
    assert.ok(performance.now() - t < BUDGET);
    assert.ok(!after_.picks.some((p) => p.game_id === cold.picks[0].game_id));
    assert.deepEqual(after_.picks.slice(0, 2).map((p) => p.game_id), cold.picks.slice(1, 3).map((p) => p.game_id), 'the rest move up');
  });
});
