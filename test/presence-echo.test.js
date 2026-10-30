// Xbox services on a PC report games started from Steam too, and can keep reporting them for hours
// after they close ("Playing now: OFF, for 9h" while nothing ran). For games in a Steam library
// whose live presence is on, that echo is not play: not shown as playing, never a session, and the
// sessions an earlier version recorded from it are removed. Console play and accounts without
// Steam presence are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Settings } from '../src/services/settings.js';
import { parseAccount, SyncService } from '../src/services/sync.js';
import { xbox } from '../src/providers/xbox.js';

const MIN = 60_000; const HOUR = 60 * MIN;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function setup({ steamPresence = 'on' } = {}) {
  const db = openDb(':memory:');
  const settings = new Settings(db);
  const svc = new SyncService({ db, settings, log: quiet });
  const account = (platform, config, state = {}) => Number(db.prepare('INSERT INTO accounts(platform, name, created_at, enabled, config, state, last_sync_at) VALUES (?, ?, 0, 1, ?, ?, ?)')
    .run(platform, platform, JSON.stringify(config), JSON.stringify(state), Date.now()).lastInsertRowid);
  const steam = account('steam', { api_key: 'k', steam_id: '76561190000000001', presence: steamPresence });
  const xb = account('xbox', { api_key: 'k', presence: 'on' }, { xuid: '1', unmetered: { 1817966081: 1, 555: 1 } });
  const game = (title) => Number(db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, 0, 0)').run(title, title.toLowerCase()).lastInsertRowid);
  const entry = (acc, gameId, ext, title, meta = {}) => Number(db.prepare('INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, meta) VALUES (?, ?, ?, ?, ?, 0, 0, ?)')
    .run(acc, gameId, acc === steam ? 'steam' : 'xbox', ext, title, JSON.stringify(meta)).lastInsertRowid);
  // OFF on both, as separate games (titles alike, not merged); Halo only on Xbox
  const off = entry(xb, game('OFF'), '1817966081', 'OFF', { devices: ['PC'] });
  entry(steam, game('Off'), '3339880', 'OFF');
  const halo = entry(xb, game('Halo Infinite'), '555', 'Halo Infinite', { devices: ['PC', 'XboxSeries'] });
  // on both too, but Xbox reports its playtime (its total already includes what presence recorded)
  const tape = entry(xb, game('Tape to Tape'), '777', 'Tape to Tape', { devices: ['PC'] });
  entry(steam, game('Tape to Tape'), '2286390', 'Tape to Tape');
  const A = (id) => parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  const minutes = (id) => db.prepare('SELECT playtime_min m FROM entries WHERE id = ?').get(id).m;
  const sums = () => db.prepare('SELECT e.id FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min').all();
  return { db, svc, steam, xb, off, halo, tape, A, minutes, sums };
}

const report = (titles) => [{ xuid: '1', state: 'Online', devices: titles }];

test('a Steam game Xbox reports running on a PC is not playing; the same game on a console, and PC games Steam lacks, are', async () => {
  const { svc, xb, A } = setup();
  const payload = report([
    { type: 'WindowsOneCore', titles: [{ id: '1817966081', name: 'OFF', placement: 'Full', state: 'Active', lastModified: '2026-10-30T03:21:00Z' }, { id: '555', name: 'Halo Infinite', placement: 'Full', state: 'Active' }, { id: '999', name: 'Off', placement: 'Full', state: 'Active' }] },
    { type: 'Scarlett', titles: [{ id: '1817966081', name: 'OFF', placement: 'Full', state: 'Active' }] },
  ]);
  const r = await xbox.presence(A(xb), { ...svc.ctxFor(A(xb)), http: async () => payload, remainingBudget: () => 100 });
  assert.deepEqual(r.playing.map((p) => `${p.extId}@${p.device}`), ['555@WindowsOneCore', '1817966081@Scarlett']);
  assert.deepEqual(r.seen.map((x) => x.skipped || 'kept'), ['steam', 'kept', 'steam', 'kept'], 'a title not in the Xbox library is matched by its name');
  assert.equal(r.seen[0].modified, '2026-10-30T03:21:00Z', 'diagnostics keep when Xbox last changed the record');
});

test('spans and estimated sessions of a Steam game on an Xbox PC never become sessions', () => {
  const { db, svc, xb, off, halo, minutes, sums } = setup();
  const t0 = Date.now() - 12 * HOUR;
  const span = (ext, title, device, start, mins) => db.prepare('INSERT INTO presence(account_id, ext_id, title, started_at, last_seen_at, ended_at, device) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(xb, ext, title, start, start + mins * MIN, start + mins * MIN, device);
  span('1817966081', 'OFF', 'WindowsOneCore', t0, 546); // the echo: 9 hours
  span('1817966081', 'OFF', 'Scarlett', t0 + 2 * HOUR, 30); // on the console: real
  span('555', 'Halo Infinite', 'WindowsOneCore', t0, 60); // a PC game Steam lacks: real
  svc.presenceSessions(xb);
  assert.equal(minutes(off), 30);
  assert.equal(minutes(halo), 60);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM presence WHERE session_id = 0').get().n, 1, 'the echo is marked handled');
  // played (a new last-played time) with presence missing it: a PC-only title Steam has is not estimated
  const at = Date.now() - HOUR;
  svc.presenceSessions(xb, { fallbacks: [{ extId: '1817966081', at, prev: at - 3 * 86_400_000 }, { extId: '555', at, prev: at - 3 * 86_400_000 }] });
  assert.equal(minutes(off), 30);
  assert.ok(minutes(halo) > 60, 'the console-and-PC title still gets its estimated session');
  assert.deepEqual(sums(), []);
});

test('on start, echo sessions an earlier version recorded are removed and an open echo span is closed', () => {
  const { db, svc, xb, off, halo, tape, minutes, sums } = setup();
  const t0 = Date.now() - 20 * HOUR;
  const session = (entry, mins, device, start, note = 'From live presence') => {
    const id = Number(db.prepare(`INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, confidence, device, note, created_at)
      VALUES (?, 'presence', 'play', ?, ?, ?, ?, ?, 'exact', ?, ?, 0)`).run(entry, mins, start, start + mins * MIN, start, start + mins * MIN, device, note).lastInsertRowid);
    db.prepare('UPDATE entries SET playtime_min = playtime_min + ? WHERE id = ?').run(mins, entry);
    db.prepare('INSERT INTO presence(account_id, ext_id, title, started_at, last_seen_at, ended_at, device, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(xb, db.prepare('SELECT ext_id FROM entries WHERE id = ?').get(entry).ext_id, 'x', start, start + mins * MIN, start + mins * MIN, device, id);
  };
  session(off, 412, 'WindowsOneCore', t0);
  session(off, 25, 'Scarlett', t0 + 8 * HOUR);
  session(halo, 50, 'WindowsOneCore', t0);
  session(tape, 40, 'WindowsOneCore', t0);
  db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, confidence, note, created_at) VALUES (?, 'sync', 'play', 120, ?, ?, ?, ?, 'pinned', 'Length estimated: the platform reports no playtime', 0)")
    .run(off, t0, t0 + 2 * HOUR, t0, t0 + 2 * HOUR);
  db.prepare('UPDATE entries SET playtime_min = playtime_min + 120 WHERE id = ?').run(off);
  // and the span showing as "Playing now" right now
  db.prepare("INSERT INTO presence(account_id, ext_id, title, started_at, last_seen_at, device) VALUES (?, '1817966081', 'OFF', ?, ?, 'WindowsOneCore')").run(xb, Date.now() - 9 * HOUR, Date.now() - MIN);
  assert.equal(svc.nowPlaying().length, 1);
  assert.equal(svc.dropSteamEchoes(), 2);
  assert.equal(minutes(off), 25, 'the console session stays');
  assert.equal(minutes(halo), 50);
  assert.equal(minutes(tape), 40, 'a title with a playtime stat keeps its sessions');
  assert.deepEqual(svc.nowPlaying(), []);
  assert.deepEqual(sums(), []);
  assert.equal(svc.dropSteamEchoes(), 0, 'nothing more on the next start');
});

test('without Steam presence, Xbox PC presence still counts as before', async () => {
  const { svc, xb, A } = setup({ steamPresence: 'off' });
  const payload = report([{ type: 'WindowsOneCore', titles: [{ id: '1817966081', name: 'OFF', placement: 'Full', state: 'Active' }] }]);
  const r = await xbox.presence(A(xb), { ...svc.ctxFor(A(xb)), http: async () => payload, remainingBudget: () => 100 });
  assert.deepEqual(r.playing.map((p) => p.extId), ['1817966081']);
});
