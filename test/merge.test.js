// Imports assist, never replace: they join what is already here, fill gaps, and keep the
// platform's totals authoritative for synced games.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, tx } from '../src/db.js';
import { Settings } from '../src/services/settings.js';
import { applyItems, parseAccount } from '../src/services/sync.js';
import { importRows, exportChunks, parseCsv } from '../src/services/importer.js';
import { findOrCreateGame, manualEntry } from '../src/services/library.js';
import { importGameTrack } from '../src/services/gametrack.js';
import { importedAccount } from '../src/services/titles.js';
import { lifetime } from '../src/services/stats.js';

const D = 86_400_000;
const NOW = Date.now();

function setup() {
  const db = openDb(':memory:');
  return { db, settings: new Settings(db) };
}
function account(db, platform, name = platform) {
  return Number(db.prepare("INSERT INTO accounts(platform, name, config, enabled, created_at) VALUES (?, ?, '{}', 1, 0)").run(platform, name).lastInsertRowid);
}
function sync(db, settings, id, items, now = NOW) {
  const a = parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  tx(db, () => applyItems(db, a, items, { settings: settings.all(), now, initial: !a.last_sync_at }));
  db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(now, id);
}
const consistent = (db) => db.prepare('SELECT e.id FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min').all();
const game = (db, title) => db.prepare('SELECT * FROM games WHERE title = ?').get(title);

test('your status, rating, notes and exclusions are never replaced by an import', () => {
  const { db, settings } = setup();
  importRows(db, [{ title: 'Celeste', platform: 'switch', playtime_hours: 10 }], { settings: settings.all() });
  const g = game(db, 'Celeste');
  db.prepare("UPDATE games SET status = 'completed', rating = 9, notes = 'my notes' WHERE id = ?").run(g.id);
  db.prepare('UPDATE entries SET excluded = 0').run();
  const r = importRows(db, [{ title: 'Celeste', platform: 'switch', playtime_hours: 10, status: 'dropped', rating: 3, notes: 'from the file', excluded: true }], { settings: settings.all() });
  const after = game(db, 'Celeste');
  assert.equal(after.status, 'completed');
  assert.equal(after.rating, 9);
  assert.equal(after.notes, 'my notes\n\nfrom the file', 'notes are added, not replaced');
  assert.equal(db.prepare('SELECT excluded FROM entries').get().excluded, 0, 'your inclusion stands');
  assert.equal(r.entries_updated, 1);
  // again: notes not duplicated
  importRows(db, [{ title: 'Celeste', platform: 'switch', notes: 'from the file' }], { settings: settings.all() });
  assert.equal(game(db, 'Celeste').notes, 'my notes\n\nfrom the file');
  // empty fields are filled
  importRows(db, [{ title: 'Hades', platform: 'switch', playtime_hours: 1 }], { settings: settings.all() });
  importRows(db, [{ title: 'Hades', platform: 'switch', status: 'playing', rating: 8 }], { settings: settings.all() });
  assert.equal(game(db, 'Hades').status, 'playing');
  assert.equal(game(db, 'Hades').rating, 8);
});

test('a file never lowers a total; it only adds what is new', () => {
  const { db, settings } = setup();
  importRows(db, [{ title: 'Celeste', platform: 'switch', playtime_hours: 10 }], { settings: settings.all() });
  importRows(db, [{ title: 'Celeste', platform: 'switch', playtime_hours: 4 }], { settings: settings.all() });
  assert.equal(lifetime(db).total_minutes, 600);
  importRows(db, [{ title: 'Celeste', platform: 'switch', playtime_hours: 12 }], { settings: settings.all() });
  assert.equal(lifetime(db).total_minutes, 720);
  assert.deepEqual(consistent(db), []);
});

test('rows for games a synced account tracks join it: totals stay, dates and exact past sessions are added', () => {
  const { db, settings } = setup();
  const steam = account(db, 'steam');
  sync(db, settings, steam, [{ extId: '620', title: 'Portal 2', playtimeMin: 900, lastPlayedAt: NOW - 30 * D }]);
  const e0 = db.prepare('SELECT * FROM entries').get();
  assert.equal(e0.baseline_min, 900);
  const s1 = NOW - 400 * D;
  const r = importRows(db, [{
    title: 'Portal 2', platform: 'steam', playtime_hours: 20, first_played: new Date(NOW - 500 * D).toISOString(), status: 'beaten',
    sessions: [{ started_at: new Date(s1).toISOString(), minutes: 120 }, { started_at: new Date(s1 + D).toISOString(), minutes: 60 }, { started_at: new Date(NOW + D).toISOString(), minutes: 30 }],
  }], { settings: settings.all() });
  assert.equal(r.merged_synced, 1);
  assert.equal(r.entries_created, 0);
  assert.equal(r.sessions_restored, 2, 'only sessions from before tracking');
  const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(e0.id);
  assert.equal(e.playtime_min, 900, "the platform's total stands");
  assert.equal(e.baseline_min, 900 - 180, 'exact sessions replace estimated history');
  assert.equal(JSON.parse(e.hist).first_played_at, NOW - 500 * D);
  assert.equal(game(db, 'Portal 2').status, 'beaten');
  assert.equal(lifetime(db).total_minutes, 900);
  assert.deepEqual(consistent(db), []);
  // re-import: nothing changes
  importRows(db, [{ title: 'Portal 2', platform: 'steam', playtime_hours: 20, sessions: [{ started_at: new Date(s1).toISOString(), minutes: 120 }] }], { settings: settings.all() });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE kind = 'play'").get().n, 2);
  assert.deepEqual(consistent(db), []);
});

test('rows without a platform join the one synced copy when the hours fit; more hours means another copy', () => {
  const { db, settings } = setup();
  const xbox = account(db, 'xbox');
  sync(db, settings, xbox, [{ extId: '1', title: 'Halo Infinite', playtimeMin: 600 }, { extId: '2', title: 'Forza Horizon 5', playtimeMin: 100 }]);
  const r = importRows(db, [
    { title: 'Halo Infinite', playtime_hours: 8 },     // fits: an older snapshot of the same play
    { title: 'Forza Horizon 5', playtime_hours: 50 },   // far more than Xbox reports: another copy
  ], { settings: settings.all() });
  assert.equal(r.merged_synced, 1);
  assert.equal(r.entries_created, 1);
  assert.equal(lifetime(db).total_minutes, 600 + 100 + 3000);
});

test('linking an account adopts imported copies: no game twice, your sessions and decisions kept', () => {
  const { db, settings } = setup();
  const t = NOW - 100 * D;
  importRows(db, [
    { title: 'Hades', platform: 'steam', account: 'Steam', playtime_minutes: 500, sessions: [{ started_at: new Date(t).toISOString(), minutes: 100 }] },
    { title: 'Celeste', platform: 'steam', account: 'Steam', playtime_minutes: 50, excluded: true },
  ], { settings: settings.all() });
  db.prepare("UPDATE games SET status = 'completed' WHERE title = 'Hades'").run();
  const steam = account(db, 'steam', 'Steam (new)');
  sync(db, settings, steam, [{ extId: '1145360', title: 'Hades', playtimeMin: 700 }, { extId: '504230', title: 'Celeste', playtimeMin: 50 }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entries').get().n, 2, 'no second copies');
  const hades = db.prepare("SELECT e.*, g.status FROM entries e JOIN games g ON g.id = e.game_id WHERE e.title = 'Hades'").get();
  assert.equal(hades.account_id, steam);
  assert.equal(hades.playtime_min, 700);
  assert.equal(hades.status, 'completed');
  assert.equal(db.prepare("SELECT SUM(minutes) m FROM sessions WHERE entry_id = ? AND kind = 'play'").get(hades.id).m, 100, 'exact session kept');
  assert.equal(hades.baseline_min, 600);
  assert.equal(db.prepare("SELECT excluded FROM entries WHERE title = 'Celeste'").get().excluded, 1, 'your exclusion kept');
  assert.deepEqual(consistent(db), []);
});

test('titles stored by an older version are normalised again when the database opens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-norm-'));
  const file = path.join(dir, 'playtracker.db');
  let db = openDb(file);
  // what the old normalisation stored: "™" spelled "tm", letters of other scripts dropped
  const ins = db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, 0, 0)');
  for (const [title, norm] of [['ELDEN RING', 'elden ringtm'], ['ペルソナ5', '5'], ['ドラゴンクエスト5', '5'], ['Hades', 'hades']]) ins.run(title, norm);
  db.exec('PRAGMA user_version = 4');
  db.close();
  db = openDb(file);
  const settings = new Settings(db);
  importRows(db, [{ title: 'Elden Ring™', platform: 'switch', playtime_hours: 1 }, { title: 'ドラゴンクエスト5', platform: 'switch', playtime_hours: 2 }], { settings: settings.all() });
  const games = db.prepare('SELECT g.title, COUNT(e.id) n FROM games g LEFT JOIN entries e ON e.game_id = g.id GROUP BY g.id ORDER BY g.id').all().map((g) => [g.title, g.n]);
  assert.deepEqual(games, [['ELDEN RING', 1], ['ペルソナ5', 0], ['ドラゴンクエスト5', 1], ['Hades', 0]], 'each row joins its own game, none another');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file imported by an older version, imported again after the upgrade, joins its copies: nothing counted twice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ext-'));
  const file = path.join(dir, 'playtracker.db');
  const rows = [
    { title: 'ELDEN RING™', platform: 'steam', account: 'Main', playtime_minutes: 600 },
    { title: 'ペルソナ5', platform: 'switch', account: 'Main', playtime_minutes: 300 },
    { title: 'ペルソナ: 夜', platform: 'switch', account: 'Main', playtime_minutes: 60 },
    { title: 'ペルソナ: 夜', platform: 'switch', playtime_minutes: 45 },
    { title: 'Portal 2', platform: 'steam', account: 'Main', playtime_minutes: 120 },
  ];
  const gameTrack = { games: [{ uuid: 'S', title: "Marvel's Spider-Man™", owned_platform: 'PlayStation 5', hours_played: '12' }] };
  let db = openDb(file);
  importRows(db, rows, { settings: new Settings(db).all() });
  importGameTrack(db, gameTrack, { settings: new Settings(db).all() });
  // the ext_ids the old normalisation gave them: "™" spelled "tm"; a title without Latin letters
  // reduced to its digits, or (none at all) lower-cased whole
  const OLD = [
    ['steam', 'import:main:elden ring', 'import:main:elden ringtm'],
    ['switch', 'import:main:ペルソナ5', 'import:main:5'],
    ['switch', 'import:main:ペルソナ 夜', 'import:main:ペルソナ: 夜'],
    ['switch', 'import:ペルソナ 夜', 'import:ペルソナ: 夜'],
    ['psn', 'import:gametrack:marvel s spider man', 'import:gametrack:marvel s spider mantm'],
  ];
  for (const [platform, ext, old] of OLD) assert.equal(db.prepare('UPDATE entries SET ext_id = ? WHERE platform = ? AND ext_id = ?').run(old, platform, ext).changes, 1, ext);
  db.exec('PRAGMA user_version = 4');
  const before = { total: lifetime(db).total_minutes, entries: db.prepare('SELECT COUNT(*) n FROM entries').get().n };
  assert.equal(before.total, 600 + 300 + 60 + 45 + 120 + 720);
  db.close();

  db = openDb(file);
  const exts = db.prepare('SELECT platform, ext_id FROM entries').all().map((e) => `${e.platform} ${e.ext_id}`);
  for (const [platform, ext] of OLD) assert.ok(exts.includes(`${platform} ${ext}`), `${ext}: spelled as a re-import spells it`);
  const settings = new Settings(db);
  const r = importRows(db, rows, { settings: settings.all() });
  importGameTrack(db, gameTrack, { settings: settings.all() });
  assert.equal(r.entries_created, 0);
  assert.deepEqual({ total: lifetime(db).total_minutes, entries: db.prepare('SELECT COUNT(*) n FROM entries').get().n }, before, 'the same file again changes nothing');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the account an imported copy names, in ext_ids spelled now and by older versions', () => {
  for (const [ext, title, acc] of [
    ['import:portal 2', 'Portal 2', ''], ['import:main:portal 2', 'Portal 2', 'main'], ['import:gametrack:hades', 'Hades', 'gametrack'],
    ['import:main:elden ringtm', 'ELDEN RING™', 'main'], ['import:ペルソナ: 夜', 'ペルソナ: 夜', ''], ['import:main:ペルソナ: 夜', 'ペルソナ: 夜', 'main'],
    ['import:ペルソナ 夜', 'ペルソナ: 夜', ''], ['import:my: alt:ペルソナ 夜', 'ペルソナ: 夜', 'my: alt'],
  ]) assert.equal(importedAccount(ext, title), acc, ext);
});

test('two wish-listed GameTrack games kept apart (title merging off) are both listed, and the import does not fail', () => {
  const { db, settings } = setup();
  const r = importGameTrack(db, { games: [
    { uuid: 'A', title: 'Hollow Knight: Silksong', status: 'Wanted', hours_played: '0' },
    { uuid: 'B', title: 'Hollow Knight Silksong', status: 'Wanted', hours_played: '0' },
  ] }, { settings: { ...settings.all(), auto_merge_titles: false } });
  assert.equal(r.wishlist_added, 2);
  const games = db.prepare('SELECT g.title, g.status, COUNT(e.id) n FROM games g LEFT JOIN entries e ON e.game_id = g.id GROUP BY g.id ORDER BY g.id').all().map((g) => [g.title, g.status, g.n]);
  assert.deepEqual(games, [['Hollow Knight: Silksong', 'wishlist', 1], ['Hollow Knight Silksong', 'wishlist', 1]]);
});

/** A game you log by hand: sessions of the given minutes, one a day, ending `ago` days back. */
function handLogged(db, title, minutes, ago = 10) {
  const gameId = findOrCreateGame(db, { title });
  const e = manualEntry(db, gameId, NOW - 100 * D);
  minutes.forEach((m, i) => {
    const start = NOW - (ago + i) * D;
    db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at) VALUES (?, 'manual', 'play', ?, ?, ?, ?, ?, ?)").run(e.id, m, start, start + m * 60_000, start, start + m * 60_000, NOW);
  });
  db.prepare('UPDATE entries SET playtime_min = ? WHERE id = ?').run(minutes.reduce((a, m) => a + m, 0), e.id);
  return e.id;
}

test('a row with no platform joins a game you log by hand when its hours fit; more hours stay a copy of their own', () => {
  const { db, settings } = setup();
  const celeste = handLogged(db, 'Celeste', [90, 45]);
  handLogged(db, 'Hollow Knight', [120]);
  const s0 = NOW - 10 * D;
  const r = importRows(db, [
    // the same play, counted earlier: joins, adds its dates and details, nothing on top
    { title: 'Celeste', playtime_hours: 1, status: 'beaten', first_played: new Date(NOW - 50 * D).toISOString(), sessions: [{ started_at: new Date(s0 + 5 * 60_000).toISOString(), minutes: 85 }] },
    // 30 h against 2 h logged: the file can't say whether it includes yours, so nothing is absorbed
    { title: 'Hollow Knight', playtime_hours: 30 },
  ], { settings: settings.all() });
  assert.equal(r.entries_created, 1, 'only Hollow Knight gets a copy');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entries WHERE game_id = (SELECT game_id FROM entries WHERE id = ?)').get(celeste).n, 1);
  assert.equal(db.prepare('SELECT playtime_min FROM entries WHERE id = ?').get(celeste).playtime_min, 135, 'your logged total stands');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE entry_id = ? AND kind = 'play'").get(celeste).n, 2, 'a session overlapping one you logged is that one');
  assert.equal(game(db, 'Celeste').status, 'beaten');
  assert.equal(lifetime(db).total_minutes, 135 + 120 + 1800);
  assert.deepEqual(consistent(db), []);
  // a row that names a device, an account, or a file that lists hand-logged rows itself stays apart
  importRows(db, [{ title: 'Celeste', platform: 'pc', playtime_minutes: 60 }], { settings: settings.all() });
  importRows(db, [{ title: 'Celeste', account: 'Main', playtime_minutes: 60 }], { settings: settings.all() });
  importRows(db, [{ title: 'Celeste', platform: 'manual', playtime_minutes: 135 }, { title: 'Celeste', platform: 'import', playtime_minutes: 50 }], { settings: settings.all() });
  const copies = db.prepare("SELECT e.platform, e.playtime_min FROM entries e JOIN games g ON g.id = e.game_id WHERE g.title = 'Celeste' ORDER BY e.id").all().map((e) => `${e.platform} ${e.playtime_min}`);
  assert.deepEqual(copies, ['manual 135', 'pc 60', 'import 60'], 'your logged entry untouched; the rest are copies (an unnamed 50 min row joins the imported one)');
  // and again: nothing changes
  const life = lifetime(db).total_minutes;
  importRows(db, [{ title: 'Celeste', playtime_hours: 1 }, { title: 'Hollow Knight', playtime_hours: 30 }], { settings: settings.all() });
  assert.equal(lifetime(db).total_minutes, life);
  assert.deepEqual(consistent(db), []);
});

test('your history choices travel with an export: Don\'t chart, a window, a confirmed estimate - and never override a choice made here', () => {
  const a = setup();
  importRows(a.db, [
    { title: 'Undated', platform: 'switch', playtime_hours: 10 },
    { title: 'Windowed', platform: 'switch', playtime_hours: 10 },
    { title: 'Confirmed', platform: 'switch', playtime_hours: 10, first_played: new Date(NOW - 200 * D).toISOString(), last_played: new Date(NOW - 20 * D).toISOString() },
  ], { settings: a.settings.all() });
  const setHist = (title, fn) => {
    const e = a.db.prepare('SELECT e.id, e.hist FROM entries e WHERE e.title = ?').get(title);
    const h = JSON.parse(e.hist || '{}'); fn(h);
    a.db.prepare('UPDATE entries SET hist = ? WHERE id = ?').run(JSON.stringify(h), e.id);
    return e.id;
  };
  setHist('Undated', (h) => { h.mode = 'undated'; });
  setHist('Windowed', (h) => { h.manual = { start: NOW - 90 * D, end: NOW - 60 * D }; });
  const chunks = a.db.prepare("SELECT window_start s, window_end e, minutes m FROM sessions WHERE entry_id = (SELECT id FROM entries WHERE title = 'Confirmed') AND kind = 'estimate' ORDER BY window_start").all();
  assert.ok(chunks.length > 1);
  setHist('Confirmed', (h) => { h.manual = { start: chunks[0].s, end: chunks.at(-1).e, confirmed: true, chunks: chunks.map((c) => [c.s, c.e, c.m, 'history']), undated: 0 }; });
  const json = JSON.parse([...exportChunks(a.db, 'json')].join(''));
  const csv = parseCsv([...exportChunks(a.db, 'csv')].join(''));
  assert.equal(csv.find((r) => r.title === 'Undated').history_mode, 'undated');
  assert.ok(csv.find((r) => r.title === 'Windowed').history_start);

  const b = setup();
  const r = importRows(b.db, json.games, { settings: b.settings.all() });
  assert.equal(r.history_choices, 3);
  const kinds = (title) => Object.fromEntries(b.db.prepare("SELECT kind, SUM(minutes) m FROM sessions WHERE entry_id = (SELECT id FROM entries WHERE title = ?) GROUP BY kind").all(title).map((x) => [x.kind, x.m]));
  assert.deepEqual(kinds('Undated'), { baseline: 600 }, "Don't chart: none of it charted");
  const win = b.db.prepare("SELECT MIN(window_start) s, MAX(window_end) e FROM sessions WHERE entry_id = (SELECT id FROM entries WHERE title = 'Windowed') AND kind = 'estimate'").get();
  assert.ok(win.s >= NOW - 91 * D && win.e <= NOW - 59 * D, 'dated inside your window');
  const got = b.db.prepare("SELECT window_start s, window_end e, minutes m FROM sessions WHERE entry_id = (SELECT id FROM entries WHERE title = 'Confirmed') AND kind = 'estimate' ORDER BY window_start").all();
  assert.deepEqual(got, chunks, 'the confirmed estimate comes back exactly');
  // the CSV carries the same choices
  const c = setup();
  importRows(c.db, csv, { settings: c.settings.all() });
  assert.deepEqual(Object.fromEntries(c.db.prepare("SELECT kind, SUM(minutes) m FROM sessions WHERE entry_id = (SELECT id FROM entries WHERE title = 'Undated') GROUP BY kind").all().map((x) => [x.kind, x.m])), { baseline: 600 });
  // a choice made here is never replaced by the file's
  const e = b.db.prepare("SELECT id, hist FROM entries WHERE title = 'Undated'").get();
  const h = JSON.parse(e.hist); h.mode = 'auto'; h.manual = { start: NOW - 30 * D, end: NOW - 25 * D };
  b.db.prepare('UPDATE entries SET hist = ? WHERE id = ?').run(JSON.stringify(h), e.id);
  importRows(b.db, json.games, { settings: b.settings.all() });
  assert.deepEqual(JSON.parse(b.db.prepare('SELECT hist FROM entries WHERE id = ?').get(e.id).hist).manual, h.manual);
  assert.deepEqual(consistent(b.db), []);
});

test('joining hand-logged play: earlier play stays apart, a join is remembered, sessions are compared by how much they overlap', () => {
  const { db, settings } = setup();
  const celeste = handLogged(db, 'Celeste', [90, 30]);
  // the file's play ended long before the first session you logged: that is other play, kept
  handLogged(db, 'Hades', [100]);
  importRows(db, [{ title: 'Hades', playtime_hours: 1, last_played: new Date(NOW - 300 * D).toISOString() }], { settings: settings.all() });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM entries WHERE title = 'Hades'").get().n, 2);
  assert.equal(lifetime(db).total_minutes, 120 + 160);
  // joined once, then a logged session deleted and the entry excluded: the same file still joins it
  importRows(db, [{ title: 'Celeste', playtime_minutes: 150 }], { settings: settings.all() });
  assert.equal(db.prepare('SELECT playtime_min FROM entries WHERE id = ?').get(celeste).playtime_min, 150);
  const s90 = db.prepare("SELECT id FROM sessions WHERE entry_id = ? AND minutes = 90").get(celeste).id;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(s90);
  db.prepare('UPDATE entries SET playtime_min = playtime_min - 90 WHERE id = ?').run(celeste);
  importRows(db, [{ title: 'Celeste', playtime_minutes: 150 }], { settings: settings.all() });
  db.prepare('UPDATE entries SET excluded = 1 WHERE id = ?').run(celeste);
  const life = lifetime(db).total_minutes;
  importRows(db, [{ title: 'Celeste', playtime_minutes: 150 }], { settings: settings.all() });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM entries WHERE title = 'Celeste'").get().n, 1, 'never a second copy');
  assert.equal(lifetime(db).total_minutes, life, 'your exclusion stands');
  assert.deepEqual(consistent(db), []);

  // a row with sessions and no total: a session that only touches one you logged is new play
  const { db: db2, settings: s2 } = setup();
  const ori = handLogged(db2, 'Ori', [60], 5);
  const logged = db2.prepare('SELECT started_at FROM sessions WHERE entry_id = ?').get(ori).started_at;
  importRows(db2, [{ title: 'Ori', sessions: [
    { started_at: new Date(logged + 5 * 60_000).toISOString(), minutes: 55 },   // the one you logged
    { started_at: new Date(logged + 50 * 60_000).toISOString(), minutes: 120 }, // starts as it ends: new
  ] }], { settings: s2.all() });
  assert.equal(db2.prepare("SELECT COUNT(*) n FROM entries WHERE title = 'Ori'").get().n, 1);
  assert.equal(db2.prepare('SELECT playtime_min FROM entries WHERE id = ?').get(ori).playtime_min, 180, '60 logged + 120 new');
  assert.deepEqual(consistent(db2), []);
});

test("a history choice made here - chart again, reset, a cleared window - is never replaced by an older export", () => {
  const { db, settings } = setup();
  importRows(db, [{ title: 'Celeste', platform: 'switch', playtime_hours: 10, history: { mode: 'undated', start: new Date(NOW - 90 * D).toISOString(), end: new Date(NOW - 60 * D).toISOString() } }], { settings: settings.all() });
  const e = db.prepare("SELECT id, hist FROM entries WHERE title = 'Celeste'").get();
  const h = JSON.parse(e.hist);
  assert.equal(h.mode, 'undated');
  assert.ok(h.manual.start && h.manual.end, "Don't chart keeps its window");
  const file = JSON.parse([...exportChunks(db, 'json')].join('')).games;
  assert.equal(file[0].history.mode, 'undated');
  assert.ok(file[0].history.start, 'the window is exported with it');
  for (const [label, set] of [['chart again', (x) => { x.mode = 'auto'; }], ['reset', (x) => { delete x.manual; x.mode = 'auto'; }], ['cleared window', (x) => { delete x.mode; x.manual = null; }]]) {
    const cur = JSON.parse(db.prepare('SELECT hist FROM entries WHERE id = ?').get(e.id).hist);
    set(cur);
    db.prepare('UPDATE entries SET hist = ? WHERE id = ?').run(JSON.stringify(cur), e.id);
    importRows(db, file, { settings: settings.all() });
    const after = JSON.parse(db.prepare('SELECT hist FROM entries WHERE id = ?').get(e.id).hist);
    assert.equal(after.mode, cur.mode, label);
    assert.deepEqual(after.manual, cur.manual, label);
  }
});

test('timestamps no date can hold, and confirmed days that make no sense, are refused without breaking import or export', () => {
  const { db, settings } = setup();
  const r = importRows(db, [
    { title: 'Far', platform: 'switch', playtime_hours: 5, first_played: -1e20, history_start: '100000000000000000000' },
    { title: 'Nano', platform: 'switch', playtime_hours: 5, history: { start: 1700000000000000000, end: 1800000000000000000 } },
    { title: 'Bad days', platform: 'switch', playtime_minutes: 600, history: { start: '2020-01-01', end: '2020-02-01', confirmed: true, chunks: [['2020-01-01', '2020-01-02', 'Infinity'], ['2020-01-03', '2020-01-04', 600]] } },
    { title: 'Long day', platform: 'switch', playtime_minutes: 600, history: { start: '1970-01-02', end: '2020-02-01', confirmed: true, chunks: [['1970-01-02', '2020-02-01', 600], ['2027-01-01', '2027-01-02', 1]] } },
  ], { settings: settings.all() });
  assert.equal(r.entries_created, 4);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE window_end > ?").get(NOW + D).n, 0, 'nothing dated in the future');
  for (const t of ['Bad days', 'Long day']) assert.ok(!JSON.parse(db.prepare('SELECT hist FROM entries WHERE title = ?').get(t).hist).manual?.confirmed, `${t}: just the window`);
  const csv = [...exportChunks(db, 'csv')].join('');
  assert.equal(parseCsv(csv).length, 4, 'every row exported');
  assert.equal(JSON.parse([...exportChunks(db, 'json')].join('')).games.length, 4);
  assert.deepEqual(consistent(db), []);
});
