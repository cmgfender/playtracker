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
import { importRows } from '../src/services/importer.js';
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
