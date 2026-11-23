// Speed guards for the facts of the day, the forecast and the Insights answers they share. On a
// moderately large library: every answer computed afresh stays inside a generous budget; what
// two requests of one page both need is worked out once; and the short cuts (the longest
// session from the minutes index, the most played game of a year from a pass per year, rows
// shared between sections) give exactly what the plain queries give.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { facts, withFacts } from '../src/services/facts.js';
import { finishForecast, backlogReality } from '../src/services/forecast.js';
import { records, recordBasics, sessionLengths, playStyle, tagStats, timeline, yearOverYear, libraryOverview, punchcard } from '../src/services/insights.js';

const MIN = 60_000;
const DAY = 86_400_000;
const GAMES = 600;
const SESSIONS = 30_000;
const YEARS = 4;
// per answer computed afresh; a few tens of milliseconds on a laptop, so a slow runner has room
const BUDGET = Number(process.env.SPEED_BUDGET_MS || 2500);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

let inst; let db; let touch; let forecastGame;
const now = Date.now();

before(() => {
  inst = createApp({ dbFile: ':memory:', password: '', scheduler: false, log: quiet });
  db = inst.app.db;
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const plats = ['steam', 'xbox', 'psn'];
  const statuses = ['unset', 'backlog', 'playing', 'paused', 'completed', 'beaten', 'dropped', 'unset'];
  db.exec('BEGIN');
  const gIns = db.prepare('INSERT INTO games(title, norm_title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const eIns = db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at) VALUES (NULL, ?, ?, ?, 'x', 0, ?)");
  const mIns = db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, ttb_main, fetched_at) VALUES (?, ?, 'title', ?, 0)");
  const tIns = db.prepare("INSERT INTO game_tags(game_id, kind, name) VALUES (?, ?, ?)");
  const sIns = db.prepare('INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const entries = [];
  for (let i = 0; i < GAMES; i++) {
    const gid = Number(gIns.run(`Game ${i}`, `game ${i}`, statuses[i % 8], now - YEARS * 365 * DAY, now).lastInsertRowid);
    entries.push({ id: Number(eIns.run(gid, plats[i % 3], `g${i}`, now - YEARS * 365 * DAY).lastInsertRowid), game: gid, platform: plats[i % 3] });
    if (i % 4) mIns.run(gid, 1000 + i, 300 + Math.floor(rnd() * 3000));
    if (i % 4) for (const [kind, n] of [['genre', 7], ['franchise', 40], ['developer', 25]]) tIns.run(gid, kind, `${kind} ${i % n}`);
  }
  for (let i = 0; i < SESSIONS; i++) {
    // a few games take most of the play; a session in six only has a sync window, one in fifty is history
    const e = entries[Math.floor(rnd() ** 2.5 * entries.length)];
    const end = now - Math.floor(rnd() * YEARS * 365 * DAY) - 5 * MIN;
    const m = 5 + Math.floor(rnd() * 200);
    if (i % 50 === 0) sIns.run(e.id, 'inferred', 'estimate', m * 4, end - 40 * DAY, end, null, null, end);
    else if (i % 6 === 0) sIns.run(e.id, 'sync', 'play', m, end - 8 * 3600_000, end, null, null, end);
    else sIns.run(e.id, 'presence', 'play', m, null, null, end - m * MIN, end, end);
  }
  // the six hundred longest sessions of all are three years old and on one platform: a range
  // or a platform without them has to be scanned for its own longest
  const old = entries.filter((e) => e.platform === 'psn');
  for (let i = 0; i < 600; i++) {
    const end = now - (1100 + (i % 200)) * DAY - i * MIN;
    const m = 900 + (i % 37) * 10;
    sIns.run(old[i % old.length].id, 'presence', 'play', m, null, null, end - m * MIN, end, end);
  }
  db.exec('UPDATE entries SET playtime_min = (SELECT COALESCE(SUM(minutes), 0) FROM sessions s WHERE s.entry_id = entries.id)');
  db.exec('COMMIT');
  inst.app.rebuildRollups();
  touch = db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('speed_tick', ?)");
  // a game still being played, with a typical time: the forecast does all of its work
  forecastGame = db.prepare(`SELECT g.id FROM games g JOIN game_meta m ON m.game_id = g.id WHERE g.status = 'playing' AND m.ttb_main > 0
    ORDER BY (SELECT MAX(day) FROM play_days p WHERE p.game_id = g.id AND p.estimated = 0) DESC LIMIT 1`).get().id;
});
after(() => inst?.close());

/** A write: every cached answer is dropped, the next call computes afresh. */
let tick = 0;
const cold = () => touch.run(String(++tick));
/** How many statements `fn` prepares (a cached answer prepares none). */
function prepared(fn) {
  const real = db.prepare;
  let n = 0;
  db.prepare = (...a) => { n++; return real.apply(db, a); };
  try { fn(); } finally { db.prepare = real; }
  return n;
}

test('seeded: 600 games, 30,000 sessions over four years', () => {
  assert.equal(db.prepare('SELECT COUNT(*) n FROM games').get().n, GAMES);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, SESSIONS + 600);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM play_days').get().n > SESSIONS);
});

test('facts, the forecast, the backlog and every Insights answer stay inside the budget when computed afresh', (t) => {
  const top = db.prepare('SELECT game_id FROM play_days WHERE estimated = 0 GROUP BY game_id ORDER BY SUM(minutes) DESC LIMIT 1').get().game_id;
  const calls = {
    'facts': () => facts(db, { limit: 4 }),
    'weekly summary with facts': () => withFacts(db, {}, 'text'),
    'forecast': () => finishForecast(db, forecastGame),
    'backlog': () => backlogReality(db),
    'records, all time': () => records(db, { range: 'all' }),
    'records, a year': () => records(db, { range: '365d' }),
    'records of a game': () => records(db, { range: 'all', gameId: top }),
    'records of a game, a month': () => records(db, { range: '30d', gameId: top }),
    'session lengths, a year': () => sessionLengths(db, { range: '365d' }),
    'session lengths of a game': () => sessionLengths(db, { range: '365d', gameId: top }),
    'play style': () => playStyle(db, { range: '365d' }),
    'genres, all time': () => tagStats(db, { kind: 'genre', range: 'all' }),
    'timeline, all time': () => timeline(db, { range: 'all' }),
    'year over year': () => yearOverYear(db, {}),
    'library': () => libraryOverview(db),
    'punchcard, all time': () => punchcard(db, { range: 'all' }),
  };
  const took = {};
  for (const [name, fn] of Object.entries(calls)) {
    fn(); // statements compiled, pages read
    cold();
    const t0 = performance.now();
    const out = fn();
    took[name] = Math.round(performance.now() - t0);
    assert.ok(out, name);
    assert.ok(took[name] < BUDGET, `${name}: ${took[name]} ms (budget ${BUDGET} ms)`);
  }
  t.diagnostic(`cold, ms: ${JSON.stringify(took)}`);
  assert.equal(finishForecast(db, forecastGame).available, true, 'the forecast had a game to work on');
  assert.ok(facts(db).facts.length > 0, 'and there were facts to say');
});

test('the facts of the day are worked out once, whatever the limit asked for', () => {
  cold();
  const four = facts(db, { limit: 4 });
  // Home asks for four, the weekly summary on the same page reads six
  let six;
  assert.equal(prepared(() => { six = facts(db, { limit: 6 }); }), 0, 'the second limit ran no query');
  assert.deepEqual(six.facts.slice(0, 4), four.facts);
  assert.deepEqual(six.on_this_day, four.on_this_day);
  assert.equal(prepared(() => withFacts(db, {}, 'text')), 0, 'nor did the weekly summary');
  assert.equal(facts(db, { limit: 4 }), four, 'and the same limit is the same answer');
  cold();
  assert.notEqual(facts(db, { limit: 4 }), four, 'a write drops all of it');
});

test('the records the facts read are those of the Records section, without its pass over every game', () => {
  for (const weekStartsOn of [1, 0]) {
    cold();
    let basics;
    const light = prepared(() => { basics = recordBasics(db, { weekStartsOn }); });
    let full;
    const rest = prepared(() => { full = records(db, { range: 'all', weekStartsOn }); });
    assert.deepEqual(basics.longest_session, full.longest_session);
    assert.deepEqual(basics.biggest_day, full.biggest_day);
    assert.deepEqual(basics.best_week, full.best_week);
    assert.deepEqual(basics.highlights, full.highlights.filter((h) => ['favorite_weekday', 'time_of_day'].includes(h.id)));
    assert.equal(basics.highlights.length, 2);
    assert.ok(full.most_played && full.most_played_by.items.length >= YEARS, 'the section itself still names the most played');
    // the section builds on what the facts computed: it only adds its own queries
    assert.ok(light > 0 && rest > 0);
    cold();
    assert.ok(prepared(() => records(db, { range: 'all', weekStartsOn })) > rest, 'alone it computes the days too');
  }
});

test('the longest session of a range is the one a scan of the range finds, the first on a tie', () => {
  const all = db.prepare(`SELECT s.id, s.minutes, s.sort_time t, e.platform, e.game_id FROM sessions s JOIN entries e ON e.id = s.entry_id
    WHERE s.kind = 'play' AND s.minutes > 0 AND e.excluded = 0`).all();
  const scan = (from, to, keep) => {
    let best = null;
    for (const s of all) {
      if (s.t < from || s.t > to || !keep(s)) continue;
      if (!best || s.minutes > best.minutes || (s.minutes === best.minutes && (s.t < best.t || (s.t === best.t && s.id < best.id)))) best = s;
    }
    return best;
  };
  const games = db.prepare('SELECT game_id FROM play_days WHERE estimated = 0 GROUP BY game_id ORDER BY SUM(minutes) DESC LIMIT 3').all().map((x) => x.game_id);
  let checked = 0; let scanned = 0;
  for (const range of ['all', '2000d', '365d', '200d', '121d', '120d', '30d', '7d']) {
    for (const [opts, keep] of [[{}, () => true], [{ platform: 'steam' }, (s) => s.platform === 'steam'], [{ platform: 'psn' }, (s) => s.platform === 'psn'],
      ...games.map((id) => [{ gameId: id }, (s) => s.game_id === id])]) {
      cold();
      const r = records(db, { range, ...opts });
      const want = scan(r.range.from, r.range.to, keep);
      assert.equal(r.longest_session?.session_id ?? null, want?.id ?? null, `records ${range} ${JSON.stringify(opts)}`);
      assert.equal(r.longest_session?.minutes ?? null, want?.minutes ?? null);
      const l = sessionLengths(db, { range, ...opts });
      const wantL = scan(l.range.from, l.range.to, keep);
      assert.equal(l.longest?.session_id ?? null, wantL?.id ?? null, `session lengths ${range} ${JSON.stringify(opts)}`);
      checked++;
      if (want && want.minutes < 900) scanned++;
    }
  }
  assert.ok(checked >= 40);
  assert.ok(scanned >= 10, 'ranges without any of the longest sessions of all were among them');
});

test('the most played game of every year is what one grouped query says', () => {
  for (const [opts, where, args] of [[{}, '', []], [{ estimates: 'exclude' }, 'AND estimated = 0', []], [{ platform: 'xbox' }, 'AND platform = ?', ['xbox']]]) {
    for (const range of ['all', '3650d', '1000d']) {
      cold();
      const r = records(db, { range, ...opts });
      const [from, to] = [new Date(r.range.from), new Date(r.range.to)].map((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      const rows = db.prepare(`SELECT game_id, substr(day, 1, 4) k, SUM(minutes) m FROM play_days WHERE excluded = 0 ${where} AND day >= ? AND day <= ? GROUP BY game_id, k`).all(...args, from, to);
      const lead = new Map();
      for (const x of rows) { const b = lead.get(x.k); if (!b || x.m > b.m || (x.m === b.m && x.game_id < b.game_id)) lead.set(x.k, x); }
      const want = [...lead.values()].filter((x) => x.m >= 0.5).sort((a, b) => (a.k < b.k ? -1 : 1)).map((x) => [x.k, x.game_id, Math.round(x.m)]);
      assert.equal(r.most_played_by.group, 'year');
      assert.deepEqual(r.most_played_by.items.map((x) => [x.key, x.game_id, x.minutes]), want, `${range} ${JSON.stringify(opts)}`);
      const total = new Map();
      for (const x of rows) total.set(x.game_id, (total.get(x.game_id) || 0) + x.m);
      const top = [...total.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      assert.equal(r.most_played.game_id, top[0]);
      assert.equal(r.games_played, total.size);
    }
  }
});

test('sections that read the same rows give together what each gives alone', () => {
  // (one `now` for all of them: the answers carry the end of their range)
  const asked = [
    () => tagStats(db, { kind: 'genre', range: '365d', limit: 10, now }), () => tagStats(db, { kind: 'franchise', range: '365d', limit: 6, now }), () => tagStats(db, { kind: 'developer', range: '365d', limit: 6, now }),
    () => tagStats(db, { kind: 'genre', range: 'all', now }), () => tagStats(db, { kind: 'developer', range: 'all', platform: 'steam', now }),
    () => timeline(db, { range: '365d', now }), () => records(db, { range: '365d', now }), () => timeline(db, { range: 'year', group: 'month', now }), () => records(db, { range: 'year', now }),
  ];
  const alone = asked.map((fn) => { cold(); return JSON.stringify(fn()); });
  cold();
  const together = asked.map((fn) => JSON.stringify(fn()));
  assert.deepEqual(together, alone);
  // and the second kind of tag reads neither the days nor the totals again
  cold();
  const first = prepared(asked[0]);
  const second = prepared(asked[1]);
  assert.ok(second < first, `franchises after genres: ${second} statements, genres: ${first}`);
  assert.ok(JSON.parse(alone[0]).items.length > 0 && JSON.parse(alone[0]).series[0].values.some((v) => v > 0), 'there were tags and minutes to share');
});
