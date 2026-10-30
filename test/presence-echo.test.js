// Xbox services on a PC report games started from Steam too, and can keep reporting one for hours
// after it closes, or report it again later with nothing running ("Playing now: OFF, for 9h" while
// nothing ran). A run of Xbox PC sightings of a game during which Steam's presence saw that game
// played is that echo: never "playing now", never a session, never where a sync's minutes go; the
// sessions an earlier version made from one are removed. Without that evidence (the Game Pass copy
// of a game also on Steam, play on a console, no Steam presence) nothing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, tx } from '../src/db.js';
import { Settings } from '../src/services/settings.js';
import { applyItems, parseAccount, SyncService } from '../src/services/sync.js';

const MIN = 60_000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function setup({ merged = false } = {}) {
  const db = openDb(':memory:');
  const settings = new Settings(db);
  const svc = new SyncService({ db, settings, log: quiet });
  const account = (platform, state = {}) => Number(db.prepare('INSERT INTO accounts(platform, name, created_at, enabled, config, state, last_sync_at) VALUES (?, ?, 0, 1, ?, ?, ?)')
    .run(platform, platform, JSON.stringify({ api_key: 'k', presence: 'on' }), JSON.stringify(state), Date.now()).lastInsertRowid);
  const steam = account('steam');
  const xb = account('xbox', { xuid: '1', unmetered: { 1817966081: 1, 555: 1 } });
  const game = (title) => Number(db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, 0, 0)').run(title, title.toLowerCase()).lastInsertRowid);
  const entry = (acc, gameId, ext, title, meta = {}) => Number(db.prepare('INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, meta) VALUES (?, ?, ?, ?, ?, 0, 0, ?)')
    .run(acc, gameId, acc === steam ? 'steam' : 'xbox', ext, title, JSON.stringify(meta)).lastInsertRowid);
  // OFF on both (one game when merged, else two games with the same title); Halo only on Xbox
  const offGame = game('OFF');
  entry(steam, merged ? offGame : game('Off'), '3339880', 'OFF');
  const off = entry(xb, offGame, '1817966081', 'OFF', { devices: ['PC', 'XboxSeries'] });
  const halo = entry(xb, game('Halo Infinite'), '555', 'Halo Infinite', { devices: ['PC', 'XboxSeries'] });
  const A = (id) => parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  // a presence poll of each account: what it reports playing then
  const steamPoll = (now, on) => svc.applyPresence(A(steam), on ? [{ extId: '3339880', title: 'OFF' }] : [], { intervalSec: 120, now });
  const xboxPoll = (now, titles) => svc.applyPresence(A(xb), titles.map(([extId, device]) => ({ extId, title: extId === '555' ? 'Halo Infinite' : 'OFF', device })), { intervalSec: 300, now });
  const minutes = (id) => db.prepare('SELECT playtime_min m FROM entries WHERE id = ?').get(id).m;
  const sums = () => db.prepare('SELECT e.id FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min').all();
  // what Home shows as playing (nowPlaying, without its "seen in the last 20 minutes": these
  // timelines are in the past)
  const playing = () => db.prepare(`SELECT a.platform, p.title FROM presence p JOIN accounts a ON a.id = p.account_id
    WHERE p.ended_at IS NULL AND (p.session_id IS NULL OR p.session_id != 0)`).all().map((p) => `${p.platform}:${p.title}`).sort();
  return { db, svc, settings, steam, xb, off, halo, A, steamPoll, xboxPoll, minutes, sums, playing };
}

// the owner's night: Steam plays OFF 20:47-02:25; Xbox reports it on the PC from 20:48, stops at
// 02:30, then reports it again from 03:24 until the morning with nothing running
function night(s, t0) {
  let last = t0;
  for (let t = t0; t <= t0 + 12 * HOUR + 40 * MIN; t += 2 * MIN) {
    if (t <= t0 + 5 * HOUR + 38 * MIN) s.steamPoll(t, true);
    else if (t <= t0 + 5 * HOUR + 42 * MIN) s.steamPoll(t, false);
    if ((t - t0) % (10 * MIN) === 0) {
      const echo = t <= t0 + 5 * HOUR + 40 * MIN || t >= t0 + 6 * HOUR + 40 * MIN;
      s.xboxPoll(t + MIN, echo ? [['1817966081', 'WindowsOneCore']] : []);
      last = t + MIN;
    }
  }
  return last;
}

for (const merged of [false, true]) {
  test(`Xbox reporting Steam's OFF on the PC is never playing or play, in its run after Steam stopped too (${merged ? 'one game' : 'two games, same title'})`, () => {
    const s = setup({ merged });
    const t0 = Date.now() - 14 * HOUR;
    s.steamPoll(t0, true);
    s.xboxPoll(t0 + MIN, [['1817966081', 'WindowsOneCore']]);
    assert.deepEqual(s.playing(), ['steam:OFF'], 'only Steam shows as playing');
    const end = night(s, t0);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM presence WHERE account_id = ?').get(s.xb).n, 2, 'two runs of Xbox sightings');
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM presence WHERE account_id = ? AND ended_at IS NULL AND session_id = 0').get(s.xb).n, 1, 'the one still reported is marked');
    assert.equal(s.svc.soon.get(s.xb), undefined, 'an echo ending is not a session ending (no Xbox sync)');
    // a real Xbox session ending meanwhile gets its sync: the echo still reported never holds it back
    s.xboxPoll(end + 5 * MIN, [['1817966081', 'WindowsOneCore'], ['555', 'Scarlett']]);
    s.xboxPoll(end + 10 * MIN, [['1817966081', 'WindowsOneCore']]);
    assert.ok(s.svc.soonFor(s.A(s.xb), end + 10 * MIN) > end + 10 * MIN, 'the Halo session\'s sync is armed and not held back');
    s.xboxPoll(end + 15 * MIN, []);
    assert.deepEqual(s.playing(), [], 'nothing playing in the morning');
    assert.equal(s.minutes(s.off), 0, 'no session from the echo');
    // Xbox's last-played time moved with the echo: no "≈ length" session either (the title is also on consoles)
    s.svc.presenceSessions(s.xb, { fallbacks: [{ extId: '1817966081', at: end, prev: t0 - 3 * DAY }] });
    assert.equal(s.minutes(s.off), 0);
    assert.deepEqual(s.sums(), []);
  });
}

test('the Game Pass copy of a game also on Steam, not played on Steam then, still counts', () => {
  const s = setup();
  const t0 = Date.now() - 5 * HOUR;
  for (let t = t0; t <= t0 + 2 * HOUR; t += 5 * MIN) s.xboxPoll(t, [['1817966081', 'WindowsOneCore']]);
  assert.deepEqual(s.playing(), ['xbox:OFF']);
  s.xboxPoll(t0 + 2 * HOUR + 5 * MIN, []);
  assert.ok(s.minutes(s.off) >= 120, 'its presence span is its session');
  assert.ok(s.svc.soon.get(s.xb) > t0, 'and its end schedules a sync');
  // Steam played it the evening before: a different run (more than 6 hours apart)
  const s2 = setup();
  const e0 = Date.now() - 20 * HOUR;
  for (let t = e0; t <= e0 + HOUR; t += 2 * MIN) s2.steamPoll(t, true);
  s2.steamPoll(e0 + HOUR + 2 * MIN, false);
  for (let t = e0 + 8 * HOUR; t <= e0 + 9 * HOUR; t += 5 * MIN) s2.xboxPoll(t, [['1817966081', 'WindowsOneCore']]);
  s2.xboxPoll(e0 + 9 * HOUR + 5 * MIN, []);
  assert.ok(s2.minutes(s2.off) >= 60);
  assert.deepEqual(s.sums(), []); assert.deepEqual(s2.sums(), []);
});

test('the same game on a console, and PC games Steam is not playing, still show while Steam plays', () => {
  const s = setup();
  const t0 = Date.now() - 4 * HOUR;
  for (let t = t0; t <= t0 + HOUR; t += 2 * MIN) s.steamPoll(t, true);
  for (let t = t0 + MIN; t <= t0 + HOUR; t += 5 * MIN) s.xboxPoll(t, [['1817966081', 'Scarlett'], ['555', 'WindowsOneCore']]);
  assert.deepEqual(s.playing(), ['steam:OFF', 'xbox:Halo Infinite', 'xbox:OFF']);
  s.xboxPoll(t0 + HOUR + 5 * MIN, []);
  assert.ok(s.minutes(s.halo) >= 55);
  assert.ok(s.minutes(s.off) >= 55, 'console play is never an echo');
});

test("a sync's minutes for a title never land on its echo", () => {
  const s = setup();
  const t0 = Date.now() - 3 * HOUR;
  const a = () => s.A(s.xb);
  // Halo on Steam too, and metered on Xbox
  s.db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at) VALUES (?, (SELECT game_id FROM entries WHERE id = ?), 'steam', '1240440', 'Halo Infinite', 0, 0)").run(s.steam, s.halo);
  s.db.prepare('UPDATE accounts SET state = ? WHERE id = ?').run(JSON.stringify({ xuid: '1', unmetered: {} }), s.xb);
  tx(s.db, () => applyItems(s.db, a(), [{ extId: '555', title: 'Halo Infinite', playtimeMin: 500, lastPlayedAt: t0 - DAY }], { settings: s.settings.all(), now: t0 - HOUR, initial: true }));
  for (let t = t0; t <= t0 + HOUR; t += 2 * MIN) s.svc.applyPresence(s.A(s.steam), [{ extId: '1240440', title: 'Halo Infinite' }], { intervalSec: 120, now: t });
  for (let t = t0 + MIN; t <= t0 + 2 * HOUR; t += 5 * MIN) s.xboxPoll(t, [['555', 'WindowsOneCore']]);
  tx(s.db, () => applyItems(s.db, a(), [{ extId: '555', title: 'Halo Infinite', playtimeMin: 560, lastPlayedAt: t0 + HOUR }], { settings: s.settings.all(), now: t0 + 2 * HOUR }));
  assert.equal(s.db.prepare("SELECT session_id FROM presence WHERE account_id = ? AND ext_id = '555'").get(s.xb).session_id, 0, 'the echo stays unclaimed');
  assert.deepEqual(s.playing(), ['steam:Halo Infinite'], 'and hidden');
  assert.deepEqual(s.sums(), []);
});

test('on start, sessions an earlier version made from an echo are removed, open echoes hidden; other play is kept', () => {
  const s = setup();
  const t0 = Date.now() - 20 * HOUR;
  const span = (ext, device, start, end, session = null) => s.db.prepare('INSERT INTO presence(account_id, ext_id, title, started_at, last_seen_at, ended_at, device, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(s.xb, ext, ext === '555' ? 'Halo Infinite' : 'OFF', start, end ?? Date.now() - MIN, end, device, session);
  const session = (entry, start, mins, device) => {
    const id = Number(s.db.prepare(`INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, confidence, device, note, created_at)
      VALUES (?, 'presence', 'play', ?, ?, ?, ?, ?, 'exact', ?, 'From live presence', 0)`).run(entry, mins, start, start + mins * MIN, start, start + mins * MIN, device).lastInsertRowid);
    s.db.prepare('UPDATE entries SET playtime_min = playtime_min + ? WHERE id = ?').run(mins, entry);
    return id;
  };
  // Steam's evening of OFF, as its presence saw it
  s.db.prepare("INSERT INTO presence(account_id, ext_id, title, started_at, last_seen_at, ended_at) VALUES (?, '3339880', 'OFF', ?, ?, ?)").run(s.steam, t0, t0 + 338 * MIN, t0 + 339 * MIN);
  // the earlier version: the echo while Steam played (no session: Steam had one then), its return
  // after Steam stopped (a 276-minute session), and the span still open now
  span('1817966081', 'WindowsOneCore', t0 + MIN, t0 + 343 * MIN, 0);
  span('1817966081', 'WindowsOneCore', t0 + 397 * MIN, t0 + 673 * MIN, session(s.off, t0 + 397 * MIN, 276, 'WindowsOneCore'));
  span('1817966081', 'WindowsOneCore', t0 + 700 * MIN, null);
  // real play: OFF on the console that night, Halo on the PC, OFF's Game Pass copy weeks earlier
  span('1817966081', 'Scarlett', t0 + 400 * MIN, t0 + 430 * MIN, session(s.off, t0 + 400 * MIN, 30, 'Scarlett'));
  span('555', 'WindowsOneCore', t0 + 2 * HOUR, t0 + 3 * HOUR, session(s.halo, t0 + 2 * HOUR, 60, 'WindowsOneCore'));
  session(s.off, t0 - 20 * DAY, 95, 'WindowsOneCore');
  assert.deepEqual(s.svc.nowPlaying().map((p) => p.title), ['OFF']);
  assert.equal(s.svc.dropSteamEchoes(), 1);
  assert.equal(s.minutes(s.off), 30 + 95);
  assert.equal(s.minutes(s.halo), 60);
  assert.deepEqual(s.svc.nowPlaying(), []);
  assert.deepEqual(s.sums(), []);
  assert.equal(s.svc.dropSteamEchoes(), 0, 'nothing more on the next start');
});

test('diagnostics name the echo among the titles Xbox reported', async () => {
  const s = setup();
  s.steamPoll(Date.now() - 4 * MIN, true);
  const reply = { xuid: '1', state: 'Online', devices: [{ type: 'WindowsOneCore', titles: [{ id: '1817966081', name: 'OFF', placement: 'Full', state: 'Active', lastModified: '2026-10-30T03:24:00Z' }] }] };
  const prev = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([reply]), { status: 200, headers: { 'content-type': 'application/json' } });
  try { await s.svc.pollPresence(s.A(s.xb)); } finally { globalThis.fetch = prev; }
  const seen = s.svc.presenceInfo(s.xb).last_seen.titles;
  assert.equal(seen[0].skipped, 'steam echo');
  assert.equal(seen[0].modified, '2026-10-30T03:24:00Z', 'with when Xbox last changed the record');
  assert.deepEqual(s.svc.nowPlaying().map((p) => p.platform), ['steam']);
});
