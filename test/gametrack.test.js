// GameTrack export import: a ZIP of CSV tables. Unlock times date synced games, hours that no
// account here tracks become history, nothing is counted twice, re-import changes nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createApp } from '../src/server.js';
import { openDb, tx } from '../src/db.js';
import { applyItems, parseAccount } from '../src/services/sync.js';
import { readZip } from '../src/services/zip.js';
import { parseCsv } from '../src/services/importer.js';
import { importGameTrack } from '../src/services/gametrack.js';
import { storeAchievements, entrySummaries, ACH_VERSION } from '../src/services/achievements.js';
import { Settings } from '../src/services/settings.js';

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (t) => new Date(t).toISOString();
let app; let base;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** Build a ZIP (deflate) from { name: text }. */
function zip(files) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text); const data = zlib.deflateRawSync(raw); const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); central.push(ch, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

before(async () => {
  app = createApp({ dbFile: ':memory:', password: '', log: quiet, scheduler: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  // a synced Steam account with one game (history only, no dates)
  const db = app.app.db;
  db.prepare("INSERT INTO accounts(platform, name, config, enabled, created_at) VALUES ('steam', 'Steam', '{}', 1, ?)").run(NOW);
  const acc = parseAccount(db.prepare('SELECT * FROM accounts WHERE id = 1').get());
  tx(db, () => applyItems(db, acc, [{ extId: '620', title: 'Portal 2', playtimeMin: 900, lastPlayedAt: NOW - 100 * DAY }], { settings: app.app.settings.all(), now: NOW, initial: true }));
});
after(() => app.close());

const csv = (rows) => rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');

test('GameTrack ZIP: dates synced games, imports untracked hours once, fills details', async () => {
  const files = {
    'GameTrack_Export/manifest.json': '{"version":"1.0"}',
    'GameTrack_Export/games.csv': csv([
      ['uuid', 'title', 'poster_url', 'status', 'user_rating', 'hours_played', 'owned_platform', 'start_date', 'finish_date', 'added_date', 'summary'],
      ['A', 'Portal 2', 'https://img/portal.png', 'Finished', '9', '15.0', 'PC', '', '', '', 'Puzzles; portals, "science"'],
      ['B', 'Zelda: Echoes', '', 'A Now Playing', '0', '20.5', 'Switch', iso(NOW - 60 * DAY), iso(NOW - 10 * DAY), '', 'multi\nline'],
      ['C', 'Hollow Dreams', '', 'Wanted', '0', '0', '', '', '', '', ''],
      ['D', 'Shelf Game', '', 'Collection', '0', '0', 'PC', '', '', '', ''],
    ]),
    'GameTrack_Export/steam_games.csv': csv([['game_uuid', 'appid', 'name', 'playtime_forever'], ['A', '620', '', '900']]),
    'GameTrack_Export/steam_achievements.csv': csv([['steam_game_appid', 'name', 'achieved', 'unlock_time'],
      ['620', 'a', 'true', iso(NOW - 300 * DAY)], ['620', 'b', 'true', iso(NOW - 290 * DAY)], ['620', 'c', 'false', '']]),
    'GameTrack_Export/playthroughs.csv': csv([['uuid', 'game_uuid', 'date_started', 'date_finished', 'duration'], ['P1', 'B', iso(NOW - 55 * DAY), '', '0']]),
    'GameTrack_Export/lists.csv': csv([['uuid', 'list_name', 'list_type'], ['L1', 'Wish List', 'Wish List']]),
    'GameTrack_Export/game_lists.csv': csv([['game_uuid', 'list_uuid'], ['C', 'L1']]),
  };
  const buf = zip(files);
  assert.equal(readZip(buf).size, 7);
  const send = () => fetch(`${base}/import/gametrack`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: buf });
  const lifetime = async () => (await (await fetch(`${base}/stats/lifetime`)).json()).total_minutes;
  const before_ = await lifetime();
  const r = await send();
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.anchors, 2, 'two unlocked Steam achievements');
  assert.equal(j.anchored_entries, 1);
  assert.equal(j.imported_titles, 1, 'only the Switch game');
  assert.equal(j.wishlist_added, 1);
  assert.equal(j.skipped_no_playtime, 1);
  assert.equal(await lifetime(), before_ + 1230, 'Portal 2 not counted twice; Zelda 20.5 h added');
  const db = app.app.db;
  const portal = db.prepare("SELECT g.status, g.rating, g.cover_url, e.hist FROM entries e JOIN games g ON g.id = e.game_id WHERE e.ext_id = '620'").get();
  assert.equal(portal.status, 'beaten');
  assert.equal(portal.rating, 9);
  assert.equal(JSON.parse(portal.hist).anchors.length, 2);
  // the achievements themselves: Portal 2's three, under GameTrack's names until Steam reads them
  assert.deepEqual([j.achievements_imported, j.achievements_matched, j.achievement_entries], [3, 0, 1]);
  assert.deepEqual(db.prepare("SELECT a.ach_id, a.unlocked, a.source FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.ext_id = '620' ORDER BY a.sort").all().map((x) => ({ ...x })),
    [{ ach_id: 'a', unlocked: 1, source: 'gametrack' }, { ach_id: 'b', unlocked: 1, source: 'gametrack' }, { ach_id: 'c', unlocked: 0, source: 'gametrack' }]);
  const zelda =db.prepare("SELECT e.platform, e.playtime_min, e.hist, g.status FROM entries e JOIN games g ON g.id = e.game_id WHERE g.title = 'Zelda: Echoes'").get();
  assert.equal(zelda.platform, 'switch');
  assert.equal(zelda.status, 'playing');
  const h = JSON.parse(zelda.hist);
  assert.ok(Math.abs(h.first_played_at - (NOW - 60 * DAY)) < 1000 && Math.abs(h.last_played_at - (NOW - 10 * DAY)) < 1000, 'dated from GameTrack');
  assert.equal(db.prepare("SELECT status FROM games WHERE title = 'Hollow Dreams'").get().status, 'wishlist');
  // again: nothing changes
  const r2 = await (await send()).json();
  assert.equal(r2.import?.entries_created ?? 0, 0);
  assert.deepEqual([r2.achievements_imported, r2.achievements_matched, r2.achievements_updated], [0, 3, 0]);
  assert.equal(await lifetime(), before_ + 1230);
  // not a zip
  assert.equal((await fetch(`${base}/import/gametrack`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: 'hello' })).status, 400);
});

// =====================================================================================
// GameTrack's achievements / trophies: stored with what the platforms read, never twice
// =====================================================================================
const ago = (d) => NOW - d * DAY;
const xboxTime = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$10000Z'); // Xbox writes 7 fraction digits
const table = (rows) => parseCsv(csv(rows), { commaOnly: true });

/** A library synced from Steam, Xbox and PlayStation; Steam and PlayStation achievements already read. */
function library() {
  const db = openDb(':memory:');
  const settings = new Settings(db).all();
  const entries = {};
  for (const [platform, ext, title, minutes, last] of [['steam', '620', 'Portal 2', 900, ago(100)], ['xbox', '2043073184', 'Halo Infinite', 720, ago(20)], ['psn', 'CUSA00207', 'Bloodborne', 3030, ago(700)]]) {
    const id = Number(db.prepare("INSERT INTO accounts(platform, name, config, enabled, created_at) VALUES (?, ?, '{}', 1, 0)").run(platform, platform).lastInsertRowid);
    const acc = parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
    tx(db, () => applyItems(db, acc, [{ extId: ext, title, playtimeMin: minutes, lastPlayedAt: last }], { settings, now: NOW, initial: true }));
    entries[platform] = db.prepare('SELECT id FROM entries WHERE account_id = ? AND ext_id = ?').get(id, ext).id;
  }
  const read = (entryId, items, opts) => { storeAchievements(db, entryId, items, opts); db.prepare('UPDATE entries SET ach_v = ?, ach_at = ? WHERE id = ?').run(ACH_VERSION, NOW, entryId); };
  read(entries.steam, [
    { id: 'ACH_A', name: 'Alpha', icon_url: 'https://steam/a.png', rarity: 40, unlocked: false },
    { id: 'ACH_B', name: 'Beta', icon_url: 'https://steam/b.png', rarity: 10, unlocked: true, unlocked_at: ago(50) },
  ]);
  read(entries.psn, [
    { id: 'NPWR08661_00:0', name: 'Platinum', grade: 'platinum', rarity: 1, unlocked: false },
    { id: 'NPWR08661_00:1', name: 'Hunter', grade: 'bronze', rarity: 60, unlocked: true, unlocked_at: null }, // earned at a time Sony does not say
  ]);
  return { db, settings, entries, read };
}

function gameTrackAchievementTables() {
  return {
    games: table([
      ['uuid', 'title', 'hours_played', 'owned_platform'],
      ['A', 'Portal 2', '15', 'PC'], ['F', 'Halo Infinite', '12', 'Xbox Series X'], ['E', 'Bloodborne', '50.5', 'PS4'],
      ['K', 'Celeste', '10', 'PC'], ['G', 'Ghost Story', '10', 'PS5'], ['X', 'Forza Rally', '0', 'Xbox One'],
    ]),
    steam_games: table([['game_uuid', 'appid', 'name', 'playtime_forever'], ['A', '620', 'Portal 2', '900'], ['K', '504230', 'Celeste', '600']]),
    steam_achievements: table([
      ['steam_game_appid', 'name', 'achieved', 'unlock_time', 'description', 'some_new_column'],
      ['620', 'ACH_A', 'true', iso(ago(300)), 'Do the first thing', 'x'], // Steam's apiname
      ['620', 'Beta', 'true', iso(ago(290)), '', 'x'], // the display name
      ['620', 'Gamma', 'false', '', '', 'x'], // Steam does not list it
      ['504230', 'C1', 'true', iso(ago(30)), 'Climb', ''], ['504230', 'C2', 'false', '', '', ''],
    ]),
    xbox_games: table([['game_uuid', 'title_id', 'modern_title_id', 'name'], ['F', '2043073184', '', 'Halo Infinite'], ['X', '999', '', 'Forza Rally']]),
    xbox_achievements: table([
      ['xbox_game_title_id', 'name', 'progress_state', 'time_unlocked', 'gamerscore'],
      ['2043073184', 'Welcome', 'Achieved', xboxTime(ago(30)), '10'], ['2043073184', 'Finisher', 'NotStarted', '', '50'],
      ['2043073184', 'Renamed Since', 'Achieved', xboxTime(ago(40)), '5'],
      ['999', 'Speed', 'Achieved', xboxTime(ago(5)), '20'], // a title nothing here has
    ]),
    playstation_games: table([
      ['game_uuid', 'np_communication_id', 'title_id', 'name', 'play_duration', 'play_count'],
      ['E', 'NPWR08661_00', 'CUSA00207', 'Bloodborne', '50.5', '40'], ['G', 'NPWR99999_00', 'PPSA01234', 'Ghost Story', '10', '3'],
    ]),
    game_trophies: table([
      ['playstation_game_npid', 'trophy_id', 'name', 'earned', 'earn_date', 'trophy_type'],
      ['NPWR08661_00', '1', 'Hunter', 'true', iso(ago(880)), 'bronze'], ['NPWR08661_00', '0', 'Platinum', 'false', '', 'platinum'],
      ['NPWR99999_00', '0', 'Ghost Platinum', 'false', '', 'platinum'], ['NPWR99999_00', '3', 'Boo', 'true', iso(ago(3)), 'bronze'],
    ]),
  };
}

const rowsOf = (db, entryId) => db.prepare('SELECT ach_id, name, description, icon_url, unlocked, unlocked_at, rarity, points, grade, source FROM achievements WHERE entry_id = ? ORDER BY sort, id').all(entryId).map((r) => ({ ...r }));
const everything = (db) => ({
  achievements: db.prepare('SELECT * FROM achievements ORDER BY id').all().map((r) => ({ ...r })),
  entries: db.prepare("SELECT id, playtime_min, baseline_min, ach_v, ach_at, ach_total, json_extract(hist, '$.anchors') anchors FROM entries ORDER BY id").all().map((r) => ({ ...r })),
  // (re-dating history makes its estimates anew: their minutes per entry are what must not move)
  sessions: db.prepare('SELECT entry_id, kind, SUM(minutes) m FROM sessions GROUP BY entry_id, kind ORDER BY entry_id, kind').all().map((r) => ({ ...r })),
});

test('GameTrack achievements land on the right entries per platform, fill gaps in what the platform read, and import once', () => {
  const { db, settings, entries } = library();
  const tables = gameTrackAchievementTables();
  const r = importGameTrack(db, tables, { settings, now: NOW });
  const imported = (platform, title) => db.prepare("SELECT id FROM entries WHERE account_id IS NULL AND platform = ? AND title = ?").get(platform, title)?.id;
  const celeste = imported('steam', 'Celeste');
  const ghost = imported('psn', 'Ghost Story');
  assert.ok(celeste && ghost, 'titles no account tracks were imported as history');
  assert.deepEqual(
    [r.achievements_imported, r.achievements_matched, r.achievements_updated, r.achievements_unmatched, r.achievement_entries],
    [2 + 3 + 2, 2 + 2, 2, 1 + 1, 5],
    'new: Celeste 2, Halo 3, Ghost Story 2; known: Portal 2 and Bloodborne 2 each, 2 of them added to; not stored: Gamma (Steam lists Portal 2 without it), Speed (no entry)',
  );

  // Steam: the apiname in GameTrack's name column, or the display name; Steam's rarity and icons stand
  assert.deepEqual(rowsOf(db, entries.steam), [
    { ach_id: 'ACH_A', name: 'Alpha', description: 'Do the first thing', icon_url: 'https://steam/a.png', unlocked: 1, unlocked_at: Date.parse(iso(ago(300))), rarity: 40, points: null, grade: null, source: null },
    { ach_id: 'ACH_B', name: 'Beta', description: null, icon_url: 'https://steam/b.png', unlocked: 1, unlocked_at: ago(50), rarity: 10, points: null, grade: null, source: null },
  ], "GameTrack's unlock fills a locked one; Steam's own unlock time wins; nothing Steam doesn't list is added");
  // PlayStation, by trophy set: the earned time Sony did not give comes from GameTrack
  assert.deepEqual(rowsOf(db, entries.psn).map((x) => [x.ach_id, x.unlocked, x.unlocked_at, x.rarity, x.source]), [
    ['NPWR08661_00:0', 0, null, 1, null], ['NPWR08661_00:1', 1, Date.parse(iso(ago(880))), 60, null]]);
  // a title no account reads yet: GameTrack's rows (Xbox: no ids in the table - ids of their own)
  assert.deepEqual(rowsOf(db, entries.xbox).map((x) => [x.ach_id, x.name, x.unlocked, x.points, x.source]), [
    ['gt:welcome', 'Welcome', 1, 10, 'gametrack'], ['gt:finisher', 'Finisher', 0, 50, 'gametrack'], ['gt:renamed since', 'Renamed Since', 1, 5, 'gametrack']]);
  // titles imported as history get theirs, under the platforms' ids
  assert.deepEqual(rowsOf(db, celeste).map((x) => [x.ach_id, x.unlocked, x.description]), [['C1', 1, 'Climb'], ['C2', 0, null]]);
  assert.deepEqual(rowsOf(db, ghost).map((x) => [x.ach_id, x.name, x.grade, x.unlocked]), [['NPWR99999_00:0', 'Ghost Platinum', 'platinum', 0], ['NPWR99999_00:3', 'Boo', 'bronze', 1]]);
  const sums = entrySummaries(db, db.prepare('SELECT * FROM entries WHERE id IN (?, ?)').all(ghost, entries.xbox));
  assert.deepEqual([sums.get(ghost).total, sums.get(ghost).unlocked, sums.get(ghost).completed], [2, 1, false]);
  assert.deepEqual([sums.get(entries.xbox).total, sums.get(entries.xbox).points, sums.get(entries.xbox).points_total], [3, 15, 65]);
  // only achievements: totals as without them
  assert.deepEqual(db.prepare('SELECT title, playtime_min FROM entries ORDER BY id').all().map((x) => [x.title, x.playtime_min]),
    [['Portal 2', 900], ['Halo Infinite', 720], ['Bloodborne', 3030], ['Celeste', 600], ['Ghost Story', 600]]);
  assert.deepEqual(db.prepare('SELECT e.id FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min').all(), []);

  // the same export again changes nothing
  const snap = everything(db);
  const r2 = importGameTrack(db, gameTrackAchievementTables(), { settings, now: NOW + DAY });
  assert.deepEqual([r2.achievements_imported, r2.achievements_updated, r2.achievements_matched], [0, 0, 2 + 2 + 2 + 3 + 2]);
  assert.deepEqual(everything(db), snap);
});

test('GameTrack first, the platform read later: one row per achievement, the platform wins, unlocks are kept', () => {
  const { db, settings, entries, read } = library();
  importGameTrack(db, gameTrackAchievementTables(), { settings, now: NOW });
  // Xbox reads Halo: its own ids, rarity, and Welcome locked (a glitchy reply) - GameTrack's unlock stays
  read(entries.xbox, [
    { id: '1', name: 'Welcome', rarity: 30, points: 10, icon_url: 'https://xbox/1.png', unlocked: false },
    { id: '2', name: 'FINISHER', rarity: 2.5, points: 50, unlocked: true, unlocked_at: ago(1) },
    { id: '3', name: 'Secret Ending', rarity: 0.4, points: 100, unlocked: false },
  ], { complete: true });
  assert.deepEqual(rowsOf(db, entries.xbox).map((x) => [x.ach_id, x.name, x.unlocked, x.unlocked_at, x.rarity, x.icon_url, x.source]), [
    ['1', 'Welcome', 1, Date.parse(xboxTime(ago(30)).replace(/(\.\d{3})\d+/, '$1')), 30, 'https://xbox/1.png', null],
    ['2', 'FINISHER', 1, ago(1), 2.5, null, null],
    ['3', 'Secret Ending', 0, null, 0.4, null, null],
  ], 'renamed to the platform ids (same row), what only GameTrack listed is dropped by a complete list');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM achievements WHERE ach_id LIKE 'gt:%'").get().n, 0);
  // the same read again, and GameTrack again: nothing changes, nothing is duplicated
  const snap = everything(db);
  storeAchievements(db, entries.xbox, [{ id: '1', name: 'Welcome', rarity: 30, points: 10, icon_url: 'https://xbox/1.png', unlocked: false }], { complete: false });
  const r = importGameTrack(db, gameTrackAchievementTables(), { settings, now: NOW + DAY });
  assert.deepEqual(everything(db), snap);
  assert.equal(r.achievements_imported, 0);
  assert.equal(r.achievements_unmatched, 1 + 1 + 1, 'Gamma, Speed and Renamed Since: their titles are listed by the platform without them, or not here');
  // a PlayStation read of one trophy set leaves rows of another set alone
  const ghost = db.prepare("SELECT id FROM entries WHERE platform = 'psn' AND title = 'Ghost Story'").get().id;
  db.prepare("UPDATE achievements SET ach_id = 'NPWR99999_00:gt:boo', source = 'gametrack' WHERE entry_id = ? AND ach_id = 'NPWR99999_00:3'").run(ghost);
  storeAchievements(db, ghost, [{ id: 'NPWR11111_00:0', name: 'Other Set', unlocked: false }], { complete: true });
  assert.deepEqual(rowsOf(db, ghost).map((x) => x.ach_id).sort(), ['NPWR11111_00:0', 'NPWR99999_00:0', 'NPWR99999_00:gt:boo']);
  storeAchievements(db, ghost, [{ id: 'NPWR99999_00:0', name: 'Ghost Platinum', unlocked: false }, { id: 'NPWR99999_00:3', name: 'Boo', unlocked: false, rarity: 12 }], { complete: true });
  assert.deepEqual(rowsOf(db, ghost).filter((x) => x.ach_id.startsWith('NPWR99999_00')).map((x) => [x.ach_id, x.unlocked, x.rarity, x.source]),
    [['NPWR99999_00:0', 0, null, null], ['NPWR99999_00:3', 1, 12, null]]);
});

test('GameTrack achievement tables are read defensively: other column names, epoch times, missing tables, rows without ids or names', () => {
  const { db, settings, entries } = library();
  db.prepare('DELETE FROM achievements').run(); // nothing read by the platforms yet
  const r = importGameTrack(db, {
    games: table([['uuid', 'title', 'hours_played', 'owned_platform'], ['A', 'Portal 2', '15', 'PC'], ['F', 'Halo Infinite', '12', 'Xbox']]),
    steam_games: table([['game_uuid', 'appid'], ['A', '620']]),
    steam_achievements: table([
      ['steam_game_appid', 'apiName', 'displayName', 'achieved', 'unlockTime', 'percent'],
      ['620', 'ACH_C', 'Charlie', '1', String(Math.floor(ago(12) / 1000)), '3.5'], // epoch seconds
      ['620', '', '', '1', String(Math.floor(ago(12) / 1000)), ''], // nothing to know it by
    ]),
    xbox_games: table([['game_uuid', 'title_id'], ['F', '2043073184']]),
    xbox_achievements: table([['xbox_game_title_id', 'achievement_id', 'name', 'time_unlocked'], ['2043073184', '7', 'Seven', xboxTime(ago(2))], ['2043073184', '8', 'Eight', '']]),
  }, { settings, now: NOW });
  assert.equal(r.achievements_unmatched, 0);
  assert.deepEqual(rowsOf(db, entries.steam).map((x) => [x.ach_id, x.name, x.unlocked, x.unlocked_at, x.rarity]), [['ACH_C', 'Charlie', 1, Math.floor(ago(12) / 1000) * 1000, 3.5]], 'apiName / displayName columns, an epoch-seconds unlock time; a row with neither id nor name is skipped');
  assert.deepEqual(rowsOf(db, entries.xbox).map((x) => [x.ach_id, x.unlocked, x.unlocked_at != null]), [['7', 1, true], ['8', 0, false]], "Xbox's own ids when the table has them");
  // no achievement tables at all: nothing to do
  const none = importGameTrack(db, { games: table([['uuid', 'title'], ['Z', 'Nothing']]) }, { settings, now: NOW });
  assert.deepEqual([none.achievements_imported, none.achievements_matched, none.achievements_unmatched], [0, 0, 0]);
});

// GameTrack 7: a Switch game is found by Nintendo's title id (GameTrack names it as IGDB does,
// Nintendo as it sells it, and owned_platform can be wrong), the diary's sessions date history, and
// Xbox achievements carry Xbox's own ids.
function switchLibrary({ nintendo = true } = {}) {
  const db = openDb(':memory:');
  const settings = new Settings(db).all();
  if (nintendo) {
    db.prepare("INSERT INTO accounts(platform, name, config, enabled, created_at) VALUES ('nintendo', 'Nintendo', '{}', 1, 0)").run();
    const acc = parseAccount(db.prepare('SELECT * FROM accounts WHERE id = 1').get());
    tx(db, () => applyItems(db, acc, [
      { extId: '010019A01E2F2000', title: 'Metroid Prime 4: Beyond – Nintendo Switch 2 Edition', playtimeMin: 400, lastPlayedAt: ago(3) },
      { extId: '010089C01E9CA000', title: 'SteamWorld Heist II', playtimeMin: 42, lastPlayedAt: ago(30) },
    ], { settings, now: NOW, initial: true }));
  }
  return { db, settings };
}
const switchTables = () => {
  const t = (rows) => parseCsv(csv(rows), { commaOnly: true });
  return {
    games: t([['uuid', 'title', 'status', 'user_rating', 'hours_played', 'owned_platform', 'start_date', 'finish_date', 'added_date'],
      ['M', 'Metroid Prime 4: Beyond', 'Finished', '9', '6.666666666666667', 'Switch 2', '', '', ''],
      ['S', 'SteamWorld Heist II', '', '0', '0.7', 'Series X', '', '', '']]), // GameTrack says Series X: Nintendo's history says otherwise
    nintendo_games: t([['game_uuid', 'title_id', 'product_id', 'name', 'platform', 'image_url', 'total_played_minutes', 'total_played_days', 'first_played_at', 'last_played'],
      ['M', '010019a01e2f2000', '', 'Metroid Prime 4: Beyond – Nintendo Switch 2 Edition', 'Switch 2', '', '400', '5', iso(ago(20)), iso(ago(3))],
      ['S', '010089c01e9ca000', '', 'SteamWorld Heist II', 'Switch', '', '42', '2', iso(ago(40)), iso(ago(30))]]),
    diary: t([['uuid', 'game_uuid', 'kind', 'date', 'hours_played', 'source'],
      ['d1', 'M', 'session', iso(ago(10) + 3_600_000), '2.5', 'nintendo'],
      ['d2', 'M', 'session', iso(ago(4) + 3_600_000), '1.0', 'nintendo'],
      ['d3', 'M', 'finished', iso(ago(3)), '6.6', 'status']]), // not a session: not evidence of a day played
  };
};

test('GameTrack Switch games: matched by Nintendo title id, never counted twice, dated by the diary; details filled', () => {
  const { db, settings } = switchLibrary();
  const r = importGameTrack(db, switchTables(), { settings, now: NOW });
  assert.equal(r.skipped_synced, 2, 'both are counted by the Nintendo account here');
  assert.deepEqual([r.imported_titles, r.hours_added], [0, []]);
  assert.deepEqual(db.prepare('SELECT title, playtime_min FROM entries ORDER BY id').all().map((x) => [x.title, x.playtime_min]),
    [['Metroid Prime 4: Beyond – Nintendo Switch 2 Edition', 400], ['SteamWorld Heist II', 42]], 'no hours added, no entry made');
  const metroid = db.prepare("SELECT e.hist, g.status, g.rating FROM entries e JOIN games g ON g.id = e.game_id WHERE e.ext_id = '010019A01E2F2000'").get();
  assert.deepEqual([metroid.status, metroid.rating], ['beaten', 9], 'found by its id, under another name');
  assert.deepEqual(JSON.parse(metroid.hist).anchors, [ago(10) + 3_600_000, ago(4) + 3_600_000], "the diary's two sessions, not its 'finished' note");
});

test('GameTrack Switch games with no Nintendo account here: Nintendo\'s minutes and dates as GameTrack read them; a second import adds nothing', () => {
  const { db, settings } = switchLibrary({ nintendo: false });
  const r = importGameTrack(db, switchTables(), { settings, now: NOW });
  assert.deepEqual(r.hours_added, [{ title: 'Metroid Prime 4: Beyond', platform: 'switch', minutes: 400 }, { title: 'SteamWorld Heist II', platform: 'switch', minutes: 42 }],
    "Nintendo's minutes (not GameTrack's rounded hours), on Switch (not the Series X GameTrack says)");
  const heist = db.prepare("SELECT platform, playtime_min, hist FROM entries WHERE title = 'SteamWorld Heist II'").get();
  assert.equal(heist.platform, 'switch');
  assert.equal(heist.playtime_min, 42);
  const again = importGameTrack(db, switchTables(), { settings, now: NOW + DAY });
  assert.deepEqual([again.imported_titles, again.hours_added, again.already_imported], [0, [], 2]);
  assert.equal(db.prepare('SELECT SUM(playtime_min) n FROM entries').get().n, 442);
});

test('GameTrack Xbox achievements under the "id" column keep Xbox\'s own ids, so a later Xbox read updates them', () => {
  const { db, settings, entries } = library();
  const t = (rows) => parseCsv(csv(rows), { commaOnly: true });
  importGameTrack(db, {
    games: t([['uuid', 'title', 'hours_played', 'owned_platform'], ['H', 'Halo Infinite', '12', 'XSX']]),
    xbox_games: t([['game_uuid', 'title_id', 'modern_title_id', 'name'], ['H', '2043073184', '2043073184', 'Halo Infinite']]),
    xbox_achievements: t([['xbox_game_title_id', 'id', 'name', 'description', 'score', 'progress_state', 'time_unlocked'],
      ['2043073184', '9', 'Welcome', 'Start', '10', 'Achieved', iso(ago(5))], ['2043073184', '26', 'Finisher', 'Finish', '50', 'NotStarted', '']]),
  }, { settings, now: NOW });
  assert.deepEqual(rowsOf(db, entries.xbox).map((x) => [x.ach_id, x.name, x.unlocked]), [['9', 'Welcome', 1], ['26', 'Finisher', 0]]);
});

test('a rarity of 0 is not known (GameTrack writes it for Xbox 360 achievements): it is no rare unlock', () => {
  const { db, settings, entries } = library();
  const t = (rows) => parseCsv(csv(rows), { commaOnly: true });
  importGameTrack(db, {
    games: t([['uuid', 'title', 'hours_played', 'owned_platform'], ['H', 'Halo Infinite', '12', 'XSX']]),
    xbox_games: t([['game_uuid', 'title_id', 'modern_title_id', 'name'], ['H', '2043073184', '2043073184', 'Halo Infinite']]),
    xbox_achievements: t([['xbox_game_title_id', 'id', 'name', 'score', 'progress_state', 'time_unlocked', 'rarity'],
      ['2043073184', '1', 'Unknown Rarity', '10', 'Achieved', iso(ago(5)), '0'], ['2043073184', '2', 'Truly Rare', '10', 'Achieved', iso(ago(4)), '0.4']]),
  }, { settings, now: NOW });
  assert.deepEqual(db.prepare('SELECT name, rarity FROM achievements WHERE entry_id = ? ORDER BY ach_id').all(entries.xbox).map((r) => [r.name, r.rarity]),
    [['Unknown Rarity', null], ['Truly Rare', 0.4]]);
});

test('GameTrack\'s "Wanted" on a game played since is no wish: the status is left as it was', () => {
  const { db, settings, entries } = library();
  const t = (rows) => parseCsv(csv(rows), { commaOnly: true });
  importGameTrack(db, {
    games: t([['uuid', 'title', 'status', 'hours_played', 'owned_platform'], ['P', 'Portal 2', 'Wanted', '15', 'PC'], ['W', 'Not Yet Bought', 'Wanted', '0', 'PC']]),
    steam_games: t([['game_uuid', 'appid', 'name', 'playtime_forever'], ['P', '620', 'Portal 2', '900']]),
  }, { settings, now: NOW });
  const status = (title) => db.prepare('SELECT status FROM games WHERE title = ?').get(title)?.status;
  assert.equal(status('Portal 2'), 'unset', '15 hours played: not on a wish list');
  assert.equal(status('Not Yet Bought'), 'wishlist');
  assert.ok(entries.steam);
});

test('GameTrack\'s "Wanted" on a game an account here already holds is no wish either (owned, never started)', () => {
  const { db, settings } = library();
  const t = (rows) => parseCsv(csv(rows), { commaOnly: true });
  db.prepare('UPDATE entries SET playtime_min = 0 WHERE ext_id = ?').run('620'); // in the Steam library, no time yet
  importGameTrack(db, {
    games: t([['uuid', 'title', 'status', 'hours_played', 'owned_platform'], ['P', 'Portal 2', 'Wanted', '0', 'PC']]),
    steam_games: t([['game_uuid', 'appid', 'name', 'playtime_forever'], ['P', '620', 'Portal 2', '0']]),
  }, { settings, now: NOW });
  assert.equal(db.prepare("SELECT status FROM games WHERE title = 'Portal 2'").get().status, 'unset');
});

test('GameTrack\'s IGDB ids: taken for games the import brings and where IGDB found nothing; never over a Steam-id or hand-made match', () => {
  const { db, settings } = library();
  const t = (rows) => parseCsv(csv(rows), { commaOnly: true });
  const gameId = (title) => db.prepare('SELECT id FROM games WHERE title = ?').get(title).id;
  const meta = (title) => db.prepare('SELECT igdb_id, matched_by, locked, fetched_at, name FROM game_meta WHERE game_id = ?').get(gameId(title)) || null;
  const setMeta = (title, igdbId, by, locked = 0) => db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, locked, name, fetched_at, tries) VALUES (?, ?, ?, ?, 'Old', ?, 1)").run(gameId(title), igdbId, by, locked, NOW);
  setMeta('Portal 2', 72, 'steam');          // matched by its Steam id: stays
  setMeta('Halo Infinite', null, 'none');    // IGDB found nothing by the title: GameTrack's id fills in
  setMeta('Bloodborne', 7334, 'manual', 1);  // set by hand: stays
  const tables = {
    games: t([['uuid', 'igdb_id', 'title', 'status', 'hours_played', 'owned_platform'],
      ['P', '999', 'Portal 2', '', '15', 'PC'], ['H', '103281', 'Halo Infinite', '', '12', 'XSX'], ['B', '111', 'Bloodborne', '', '50', 'PS4'],
      ['F', '92550', 'Fable', 'Wanted', '0', 'Series X'], ['M', '314272', 'Masters of Albion', '', '0.5', 'PC'], ['N', '', 'No Id Game', 'Wanted', '0', 'PC'], ['Z', 'abc', 'Bad Id Game', 'Wanted', '0', 'PC']]),
    steam_games: t([['game_uuid', 'appid', 'name', 'playtime_forever'], ['P', '620', 'Portal 2', '900']]),
    xbox_games: t([['game_uuid', 'title_id', 'modern_title_id', 'name'], ['H', '2043073184', '2043073184', 'Halo Infinite']]),
    playstation_games: t([['game_uuid', 'title_id', 'np_communication_id', 'name', 'play_duration'], ['B', 'CUSA00207', 'NPWR08661_00', 'Bloodborne', '50']]),
  };
  const r = importGameTrack(db, tables, { settings, now: NOW });
  assert.equal(r.matches, 3, 'Halo Infinite, Fable, Masters of Albion');
  assert.deepEqual([meta('Portal 2').igdb_id, meta('Portal 2').matched_by], [72, 'steam']);
  assert.deepEqual([meta('Bloodborne').igdb_id, meta('Bloodborne').matched_by], [7334, 'manual']);
  // details wait for the next IGDB pass (fetched_at 0), and nothing stale is kept meanwhile
  assert.deepEqual({ ...meta('Halo Infinite') }, { igdb_id: 103281, matched_by: 'import', locked: 0, fetched_at: 0, name: null });
  assert.deepEqual([meta('Fable').igdb_id, meta('Fable').matched_by], [92550, 'import'], 'the game picked in GameTrack, not what its title alone finds');
  assert.deepEqual([meta('Masters of Albion').igdb_id, meta('Masters of Albion').matched_by], [314272, 'import']);
  assert.equal(meta('No Id Game'), null);
  assert.equal(meta('Bad Id Game'), null);
  // a title match on a game the import itself brought gives way to the id picked in GameTrack...
  db.prepare("UPDATE game_meta SET igdb_id = 521, matched_by = 'title', name = 'Fable', fetched_at = ? WHERE game_id = ?").run(NOW, gameId('Fable'));
  // ...but not on a game an account tracks (GameTrack matched those by title too)
  db.prepare("UPDATE game_meta SET igdb_id = 5, matched_by = 'title', name = 'Halo Infinite', fetched_at = ? WHERE game_id = ?").run(NOW, gameId('Halo Infinite'));
  const again = importGameTrack(db, tables, { settings, now: NOW });
  assert.equal(again.matches, 1);
  assert.equal(meta('Fable').igdb_id, 92550);
  assert.equal(meta('Halo Infinite').igdb_id, 5);
  // a third import has nothing left to change
  assert.equal(importGameTrack(db, tables, { settings, now: NOW }).matches, 0);
});
