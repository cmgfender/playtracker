// GameTrack export import: a ZIP of CSV tables. Unlock times date synced games, hours that no
// account here tracks become history, nothing is counted twice, re-import changes nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createApp } from '../src/server.js';
import { tx } from '../src/db.js';
import { applyItems, parseAccount } from '../src/services/sync.js';
import { readZip } from '../src/services/zip.js';

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
  const zelda = db.prepare("SELECT e.platform, e.playtime_min, e.hist, g.status FROM entries e JOIN games g ON g.id = e.game_id WHERE g.title = 'Zelda: Echoes'").get();
  assert.equal(zelda.platform, 'switch');
  assert.equal(zelda.status, 'playing');
  const h = JSON.parse(zelda.hist);
  assert.ok(Math.abs(h.first_played_at - (NOW - 60 * DAY)) < 1000 && Math.abs(h.last_played_at - (NOW - 10 * DAY)) < 1000, 'dated from GameTrack');
  assert.equal(db.prepare("SELECT status FROM games WHERE title = 'Hollow Dreams'").get().status, 'wishlist');
  // again: nothing changes
  const r2 = await (await send()).json();
  assert.equal(r2.import?.entries_created ?? 0, 0);
  assert.equal(await lifetime(), before_ + 1230);
  // not a zip
  assert.equal((await fetch(`${base}/import/gametrack`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: 'hello' })).status, 400);
});
