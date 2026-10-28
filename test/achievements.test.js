import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { parseSteamAchievements } from '../src/providers/steam.js';
import { parseXboxAchievements, findUnlockTimes, pagingOf, ACH_PAGES } from '../src/providers/xbox.js';
import { parsePsnTrophies, earnedTimes } from '../src/providers/psn.js';
import { storeAchievements, entrySummaries, combineSummaries, ownersOf, sessionAchievements, summaryOf, ACH_SLACK, ACH_VERSION } from '../src/services/achievements.js';
import { importGameTrack } from '../src/services/gametrack.js';
import { flushRollups } from '../src/services/rollup.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// =====================================================================================
// parsing: each platform's reply shapes
// =====================================================================================
describe('parsing platform replies', () => {
  test('Steam: player list + schema + rarity merge; hidden, locked and time-less unlocks; names from l=english without a schema', () => {
    const player = { playerstats: { success: true, achievements: [
      { apiname: 'WIN', achieved: 1, unlocktime: 1_700_000_000, name: 'Winner', description: 'Win a game' },
      { apiname: 'SECRET', achieved: 0, unlocktime: 0, name: 'Secret', description: '' },
      { apiname: 'OLD', achieved: 1, unlocktime: 0, name: 'Old one', description: 'From before unlock times' },
      { apiname: 'NEW', achieved: 0, unlocktime: 0, name: 'New one' }, // not in the (older) schema
    ] } };
    const schema = { game: { availableGameStats: { achievements: [
      { name: 'WIN', displayName: 'Winner!', hidden: 0, description: 'Win one game', icon: 'https://cdn/win.jpg', icongray: 'https://cdn/win_gray.jpg' },
      { name: 'SECRET', displayName: 'Secret', hidden: 1, description: '', icon: 'https://cdn/s.jpg', icongray: 'https://cdn/s_gray.jpg' },
      { name: 'OLD', displayName: 'Old one', hidden: 0, icon: 'https://cdn/o.jpg' },
    ] } } };
    const rarity = { achievementpercentages: { achievements: [{ name: 'WIN', percent: '45.678' }, { name: 'SECRET', percent: 1.2 }, { name: 'OLD', percent: 'n/a' }] } };
    const items = parseSteamAchievements(player, schema, rarity);
    assert.deepEqual(items.map((i) => i.id), ['WIN', 'SECRET', 'OLD', 'NEW'], "the schema's order, then what it doesn't know");
    const [win, secret, old, fresh] = items;
    assert.deepEqual(win, { id: 'WIN', name: 'Winner', description: 'Win a game', icon_url: 'https://cdn/win.jpg', icon_locked_url: 'https://cdn/win_gray.jpg', unlocked: true, unlocked_at: 1_700_000_000_000, rarity: 45.68, points: null, grade: null, hidden: false, group: null, sort: 0 });
    assert.equal(secret.unlocked, false);
    assert.equal(secret.unlocked_at, null);
    assert.equal(secret.hidden, true);
    assert.equal(secret.description, null, 'empty text is no description');
    assert.equal(secret.rarity, 1.2);
    assert.equal(old.unlocked, true);
    assert.equal(old.unlocked_at, null, 'unlocked, at a time Steam does not know');
    assert.equal(old.rarity, null);
    assert.equal(fresh.name, 'New one');
    assert.equal(fresh.hidden, null);
    // no schema (lookup failed): names and descriptions from the player's English list
    const bare = parseSteamAchievements(player);
    assert.equal(bare[0].name, 'Winner');
    assert.equal(bare[0].icon_url, null);
    assert.equal(bare[0].hidden, null);
    // a reply without English texts: the schema's names
    assert.equal(parseSteamAchievements({ playerstats: { achievements: [{ apiname: 'WIN', achieved: 1, unlocktime: 1 }] } }, schema)[0].name, 'Winner!');
    // a game with stats but without achievements
    assert.deepEqual(parseSteamAchievements({ playerstats: { success: true } }), []);
  });

  test('Xbox: modern shape in an OpenXBL envelope - gamerscore, rarity, icons, secret, in-progress is locked', () => {
    const LOCKED = '0001-01-01T00:00:00.0000000Z';
    const reply = { content: { achievements: [
      { id: '1', name: 'Welcome', description: 'Start the game', lockedDescription: 'Start it', progressState: 'Achieved', progression: { requirements: [], timeUnlocked: '2026-01-02T03:04:05.1230000Z' },
        mediaAssets: [{ name: 'tile.png', type: 'Tile', url: 'https://img/tile.png' }, { name: 'icon.png', type: 'Icon', url: 'https://img/1.png' }], isSecret: false,
        rewards: [{ value: '10', type: 'Gamerscore', valueType: 'Int' }], rarity: { currentCategory: 'Common', currentPercentage: 78.4 } },
      { id: '2', name: 'Halfway', description: '', lockedDescription: 'Get halfway', progressState: 'InProgress', progression: { requirements: [{ current: '5', target: '10' }], timeUnlocked: LOCKED },
        mediaAssets: [], isSecret: true, rewards: [{ value: '50', type: 'Gamerscore' }], rarity: { currentCategory: 'Rare', currentPercentage: 3.5 } },
      { id: '3', name: 'Locked', progressState: 'NotStarted', progression: { timeUnlocked: LOCKED }, rewards: [{ type: 'Art', value: 'x' }] },
    ], pagingInfo: { continuationToken: null, totalRecords: 3 } }, code: 200 };
    const items = parseXboxAchievements(reply, '219630713');
    assert.deepEqual(items.map((i) => [i.id, i.unlocked, i.points, i.rarity, i.hidden]), [['1', true, 10, 78.4, false], ['2', false, 50, 3.5, true], ['3', false, null, null, null]]);
    assert.equal(items[0].unlocked_at, Date.parse('2026-01-02T03:04:05.123Z'));
    assert.equal(items[0].icon_url, 'https://img/1.png', 'the icon, not the tile');
    assert.equal(items[1].unlocked_at, null, 'in progress is not unlocked');
    assert.equal(items[1].description, 'Get halfway');
    // the anchors history dating uses are read from the very same reply
    assert.deepEqual(findUnlockTimes(reply), [Date.parse('2026-01-02T03:04:05.123Z')]);
  });

  test('Xbox 360 shape: unlocked flag, gamerscore, secret, icon from the title and image ids', () => {
    const reply = { achievements: [
      { id: 1, titleId: 1297287142, name: 'Map Master', sequence: 1, unlocked: true, unlockedOnline: true, isSecret: false, gamerscore: 20, imageId: 3, description: 'Explore the map', lockedDescription: 'Explore', timeUnlocked: '2011-05-06T07:08:09.0000000Z' },
      { id: 2, titleId: 1297287142, name: 'Hidden', unlocked: false, isSecret: true, gamerscore: 30, imageId: 17, description: '', lockedDescription: 'Secret achievement', timeUnlocked: '0001-01-01T00:00:00Z' },
      { id: 3, name: 'Offline unlock', unlocked: true, gamerscore: 5, imageId: 255, timeUnlocked: '0001-01-01T00:00:00Z' },
    ], pagingInfo: { continuationToken: null, totalRecords: 3 } };
    const items = parseXboxAchievements(reply, '1297287142');
    assert.deepEqual(items.map((i) => [i.id, i.unlocked, i.points, i.hidden]), [['1', true, 20, false], ['2', false, 30, true], ['3', true, 5, null]]);
    assert.equal(items[0].unlocked_at, Date.parse('2011-05-06T07:08:09Z'));
    assert.equal(items[0].icon_url, 'https://image.xboxlive.com/global/t.4d5307e6/ach/0/3');
    assert.equal(items[1].icon_url, 'https://image.xboxlive.com/global/t.4d5307e6/ach/0/11');
    assert.equal(items[2].icon_url, 'https://image.xboxlive.com/global/t.4d5307e6/ach/0/ff', 'the entry\'s title id when the row has none');
    assert.equal(items[1].description, 'Secret achievement');
    assert.equal(items[2].unlocked_at, null, 'unlocked without a usable time');
    assert.deepEqual(findUnlockTimes(reply), [Date.parse('2011-05-06T07:08:09Z')]);
    assert.deepEqual(parseXboxAchievements({ content: { achievements: [] }, code: 200 }), []);
    assert.deepEqual(parseXboxAchievements(null), []);
  });

  test('PlayStation: earned list + trophy list merge; grades, % of players, groups, hidden; ids carry the trophy set', () => {
    const earned = { trophies: [
      { trophyId: 0, trophyHidden: false, earned: true, earnedDateTime: '2025-03-01T20:00:00Z', trophyType: 'platinum', trophyRare: 0, trophyEarnedRate: '1.5' },
      { trophyId: 1, trophyHidden: false, earned: true, earnedDateTime: '2025-02-01T20:00:00Z', trophyType: 'gold', trophyRare: 1, trophyEarnedRate: '9.9' },
      { trophyId: 2, trophyHidden: true, earned: false, trophyType: 'bronze', trophyRare: 3, trophyEarnedRate: '60.2' },
    ] };
    const list = { trophies: [
      { trophyId: 0, trophyHidden: false, trophyType: 'platinum', trophyName: 'All of it', trophyDetail: 'Every trophy', trophyIconUrl: 'https://psn/0.png', trophyGroupId: 'default' },
      { trophyId: 1, trophyHidden: false, trophyType: 'gold', trophyName: 'Boss', trophyDetail: 'Beat the boss', trophyIconUrl: 'https://psn/1.png', trophyGroupId: 'default' },
      { trophyId: 2, trophyHidden: true, trophyType: 'bronze', trophyName: 'Hidden one', trophyDetail: 'Something', trophyIconUrl: 'https://psn/2.png', trophyGroupId: 'default' },
      { trophyId: 3, trophyHidden: false, trophyType: 'silver', trophyName: 'DLC', trophyDetail: 'Play the DLC', trophyIconUrl: 'https://psn/3.png', trophyGroupId: '001' },
    ] };
    const items = parsePsnTrophies(earned, list, 'NPWR12345_00');
    assert.deepEqual(items.map((i) => [i.id, i.grade, i.unlocked, i.rarity, i.group, i.hidden]), [
      ['NPWR12345_00:0', 'platinum', true, 1.5, 'default', false], ['NPWR12345_00:1', 'gold', true, 9.9, 'default', false],
      ['NPWR12345_00:2', 'bronze', false, 60.2, 'default', true], ['NPWR12345_00:3', 'silver', false, null, '001', false],
    ]);
    assert.equal(items[0].name, 'All of it');
    assert.equal(items[0].icon_url, 'https://psn/0.png');
    assert.equal(items[0].unlocked_at, Date.parse('2025-03-01T20:00:00Z'));
    assert.equal(items[2].unlocked_at, null);
    // without the set's own list: grades and rarity from the earned list, no names
    const bare = parsePsnTrophies(earned, null, 'NPWR12345_00', 10_000);
    assert.equal(bare.length, 3);
    assert.equal(bare[1].name, null);
    assert.equal(bare[1].grade, 'gold');
    assert.equal(bare[0].sort, 10_000, 'a second set sorts after the first');
    assert.deepEqual(earnedTimes(earned), [Date.parse('2025-03-01T20:00:00Z'), Date.parse('2025-02-01T20:00:00Z')]);
  });
});

// =====================================================================================
// storage, summaries and which session an unlock belongs to
// =====================================================================================
function libraryDb() {
  const db = openDb(':memory:');
  const acc = Number(db.prepare("INSERT INTO accounts(platform, name, created_at) VALUES ('steam', 'S', 0)").run().lastInsertRowid);
  const game = (title) => Number(db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, 0, 0)').run(title, title.toLowerCase()).lastInsertRowid);
  const entry = (title, platform = 'steam', { minutes = 600, excluded = 0 } = {}) => Number(db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, excluded)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)`).run(acc, game(title), platform, title, title, minutes, excluded).lastInsertRowid);
  return { db, acc, entry };
}
const rowsOf = (db, entryId) => db.prepare('SELECT * FROM achievements WHERE entry_id = ? ORDER BY ach_id').all(entryId).map((r) => ({ ...r }));

describe('storing achievements', () => {
  test('upsert: a re-read changes nothing; locked -> unlocked updates; an unlock is never taken back; one row per (entry, id)', () => {
    const { db, entry } = libraryDb();
    const e = entry('Hades');
    const items = [
      { id: 'A', name: 'First', unlocked: true, unlocked_at: Date.UTC(2026, 0, 5), rarity: 50 },
      { id: 'B', name: 'Second', unlocked: false, rarity: 10 },
      { id: 'C', name: 'Third', unlocked: false },
    ];
    assert.deepEqual(storeAchievements(db, e, items, { now: 1000 }), { added: 3, updated: 0, newly_unlocked: 0 });
    const first = rowsOf(db, e);
    assert.deepEqual(storeAchievements(db, e, items, { now: 2000 }), { added: 0, updated: 0, newly_unlocked: 0 }, 're-reading the same reply');
    assert.deepEqual(rowsOf(db, e), first, 'not even updated_at moves');
    // B unlocked during play, rarity drifted
    const later = [items[0], { ...items[1], unlocked: true, unlocked_at: Date.UTC(2026, 1, 1), rarity: 9.5 }, items[2]];
    assert.deepEqual(storeAchievements(db, e, later, { now: 3000 }), { added: 0, updated: 1, newly_unlocked: 1 });
    const b = rowsOf(db, e).find((r) => r.ach_id === 'B');
    assert.equal(b.unlocked, 1);
    assert.equal(b.unlocked_at, Date.UTC(2026, 1, 1));
    assert.equal(b.rarity, 9.5);
    assert.equal(b.updated_at, 3000);
    assert.equal(b.first_seen_at, 1000);
    // a glitchy reply saying locked (and naming nothing) keeps what is known
    storeAchievements(db, e, [{ id: 'B', unlocked: false }, { id: 'A', name: null, unlocked: false }], { now: 4000 });
    assert.deepEqual(rowsOf(db, e).map((r) => [r.ach_id, r.name, r.unlocked, r.unlocked_at]), [['A', 'First', 1, Date.UTC(2026, 0, 5)], ['B', 'Second', 1, Date.UTC(2026, 1, 1)], ['C', 'Third', 0, null]]);
    // repeated ids in one reply, rows without an id, odd values
    assert.deepEqual(storeAchievements(db, e, [{ id: 'D', unlocked: true, unlocked_at: '0001-01-01T00:00:00Z', rarity: 'x', points: -5, grade: 'Diamond' }, { id: 'D', name: 'dup' }, { name: 'no id' }], { now: 5000 }), { added: 1, updated: 0, newly_unlocked: 0 });
    const d = rowsOf(db, e).find((r) => r.ach_id === 'D');
    assert.deepEqual([d.unlocked, d.unlocked_at, d.rarity, d.points, d.grade], [1, null, null, null, null]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM achievements').get().n, 4);
    // never sessions, totals or history
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
    assert.equal(db.prepare('SELECT playtime_min FROM entries WHERE id = ?').get(e).playtime_min, 600);
    // deleting the entry deletes its achievements
    db.prepare('DELETE FROM entries WHERE id = ?').run(e);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM achievements').get().n, 0);
  });

  test('summaries: progress, gamerscore, trophy grades; 100% and the platinum count as completed', () => {
    const { db, entry } = libraryDb();
    const steam = entry('Celeste');
    const xbox = entry('Halo', 'xbox');
    const psn = entry('Astro', 'psn');
    const never = entry('Unread');
    const t = (d) => Date.UTC(2026, 2, d, 20);
    storeAchievements(db, steam, [{ id: 'a', unlocked: true, unlocked_at: t(1) }, { id: 'b', unlocked: true, unlocked_at: t(3) }, { id: 'c' }]);
    storeAchievements(db, xbox, [{ id: '1', unlocked: true, unlocked_at: t(2), points: 10 }, { id: '2', unlocked: true, unlocked_at: t(4), points: 40 }]);
    storeAchievements(db, psn, [
      { id: 'N:0', grade: 'platinum', unlocked: true, unlocked_at: t(10) }, { id: 'N:1', grade: 'gold', unlocked: true, unlocked_at: t(9) },
      { id: 'N:2', grade: 'bronze', unlocked: true, unlocked_at: t(8) }, { id: 'N:3', grade: 'silver', group: '001' }, // DLC, not needed for the platinum
    ]);
    db.prepare('UPDATE entries SET ach_v = ?, ach_at = 123 WHERE id IN (?, ?, ?)').run(ACH_VERSION, steam, xbox, psn);
    const ent = db.prepare('SELECT * FROM entries').all();
    const s = entrySummaries(db, ent);
    assert.deepEqual(s.get(steam), { total: 3, unlocked: 2, percent: 66.6, points: null, points_total: null, grades: null, last_unlocked_at: t(3), completed: false, completed_at: null, fetched_at: 123 });
    assert.deepEqual(s.get(xbox), { total: 2, unlocked: 2, percent: 100, points: 50, points_total: 50, grades: null, last_unlocked_at: t(4), completed: true, completed_at: t(4), fetched_at: 123 });
    assert.deepEqual(s.get(psn), { total: 4, unlocked: 3, percent: 75, points: null, points_total: null, grades: { platinum: 1, gold: 1, silver: 0, bronze: 1 }, last_unlocked_at: t(10), completed: true, completed_at: t(10), fetched_at: 123 });
    assert.equal(s.get(never), null, 'never read: no summary');
    // read, and the game has none
    db.prepare('UPDATE entries SET ach_v = ? WHERE id = ?').run(ACH_VERSION, never);
    assert.equal(entrySummaries(db, db.prepare('SELECT * FROM entries WHERE id = ?').all(never)).get(never).total, 0);
    // completing the last one: completed at that moment
    storeAchievements(db, steam, [{ id: 'c', unlocked: true, unlocked_at: t(20) }]);
    assert.deepEqual(entrySummaries(db, ent).get(steam).completed_at, t(20));
    // a game's summary: its entries together, completed when one is
    const g = combineSummaries([s.get(steam), s.get(xbox), null]);
    assert.deepEqual(g, { total: 5, unlocked: 4, percent: 80, points: 50, points_total: 50, grades: null, last_unlocked_at: t(4), completed: true, completed_at: t(4), fetched_at: 123 });
    assert.equal(combineSummaries([null, null]), null);
  });
});

describe('the session an unlock belongs to (by time, when read)', () => {
  // entry with: an exact tracked session, a sync-window session overlapping it, a dated history
  // estimate, a session dropped from stats (baseline)
  const day = Date.UTC(2026, 4, 10);
  let db; let e; let ids;
  const at = (h, m = 0) => day + h * HOUR + m * MIN;
  before(() => {
    const lib = libraryDb();
    db = lib.db;
    e = lib.entry('Timed');
    const ins = db.prepare(`INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
    ids = {
      exact: Number(ins.run(e, 'sync', 'play', 60, at(10), at(11), at(10), at(11), 'exact').lastInsertRowid),
      window: Number(ins.run(e, 'sync', 'play', 120, at(9), at(23), null, null, 'window').lastInsertRowid),
      history: Number(ins.run(e, 'inferred', 'estimate', 300, day - 10 * DAY, day - 9 * DAY - 1, null, null, 'medium').lastInsertRowid),
      dropped: Number(ins.run(e, 'sync', 'baseline', 45, day + 3 * DAY, day + 3 * DAY + HOUR, day + 3 * DAY, day + 3 * DAY + HOUR, null).lastInsertRowid),
    };
    flushRollups(db);
    storeAchievements(db, e, [
      { id: 'during', unlocked: true, unlocked_at: at(10, 30) },
      { id: 'slack', unlocked: true, unlocked_at: at(11) + ACH_SLACK - MIN }, // stamped a little after the end
      { id: 'window', unlocked: true, unlocked_at: at(15) },
      { id: 'past-slack', unlocked: true, unlocked_at: at(11) + ACH_SLACK + MIN }, // the window holds it, the exact one no more
      { id: 'history', unlocked: true, unlocked_at: day - 10 * DAY + 5 * HOUR },
      { id: 'dropped', unlocked: true, unlocked_at: day + 3 * DAY + 30 * MIN },
      { id: 'nowhere', unlocked: true, unlocked_at: day - 100 * DAY },
      { id: 'no-time', unlocked: true },
      { id: 'locked' },
    ]);
  });

  test('tracked play (exact times first, a little slack after the end), else the history estimate, else none', () => {
    const rows = db.prepare('SELECT * FROM achievements WHERE entry_id = ?').all(e);
    const owners = ownersOf(db, rows);
    const of = (id) => { const o = owners.get(rows.find((r) => r.ach_id === id).id); return o ? [o.kind, o.session.id, o.session.precise] : null; };
    assert.deepEqual(of('during'), ['tracked', ids.exact, true], 'the exact session, not the sync window around it');
    assert.deepEqual(of('slack'), ['tracked', ids.exact, true], 'within the slack after the end');
    assert.deepEqual(of('window'), ['tracked', ids.window, false]);
    assert.deepEqual(of('past-slack'), ['tracked', ids.window, false], 'beyond the slack: no longer the exact session');
    assert.deepEqual(of('history'), ['history', ids.history, false]);
    assert.equal(of('dropped'), null, 'a session dropped from stats is not play');
    assert.equal(of('nowhere'), null);
    assert.equal(of('no-time'), null);
    assert.equal(of('locked'), null);
    const exact = owners.get(rows.find((r) => r.ach_id === 'during').id).session;
    assert.deepEqual(exact, { id: ids.exact, started_at: at(10), ended_at: at(11), precise: true });
    // sessions are edited: the attachment follows (nothing stored)
    db.prepare('UPDATE sessions SET started_at = ?, window_start = ? WHERE id = ?').run(at(10, 40), at(10, 40), ids.exact);
    assert.deepEqual(ownersOf(db, rows).get(rows.find((r) => r.ach_id === 'during').id).session.id, ids.window);
    db.prepare('UPDATE sessions SET started_at = ?, window_start = ? WHERE id = ?').run(at(10), at(10), ids.exact);
  });

  test('a page of sessions: counts and the first few per session, in unlock order', () => {
    const page = db.prepare('SELECT * FROM sessions WHERE entry_id = ?').all(e);
    const m = sessionAchievements(db, page, { limit: 1 });
    assert.deepEqual([...m.keys()].sort(), [ids.exact, ids.window, ids.history].sort());
    assert.equal(m.get(ids.exact).count, 2);
    assert.deepEqual(m.get(ids.exact).items.map((i) => i.id), ['during'], 'the first one only (limit 1)');
    assert.equal(m.get(ids.window).count, 2);
    assert.equal(m.get(ids.history).count, 1);
    assert.equal(m.get(ids.dropped), undefined);
    assert.deepEqual(Object.keys(m.get(ids.exact).items[0]).sort(), ['entry_id', 'grade', 'icon_url', 'id', 'name', 'points', 'rarity', 'unlocked_at']);
    // a page holding only one session still resolves ownership against all of them
    const only = sessionAchievements(db, page.filter((s) => s.id === ids.window), { limit: null });
    assert.deepEqual(only.get(ids.window).items.map((i) => i.id), ['past-slack', 'window'], 'in unlock order');
  });
});

// =====================================================================================
// end to end: fake platform APIs, real syncs and enrichment through the app
// =====================================================================================
const realFetch = globalThis.fetch;
const realNow = Date.now;
const T0 = Date.UTC(2026, 9, 20, 14, 5); // 55 minutes before an hour turns
const clock = { t: T0 };
const STEAMID = '76561198000000042';
const XUID = '2533274800000042';
const jsonRes = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const net = []; // every request to a platform: { host, path, params, at }
const sent = (re) => net.filter((c) => re.test(c.path)).length;

const fake = {
  steam: { games: new Map(), player: new Map(), schema: new Map(), rarity: new Map() },
  xbox: { limit: 150, spent: new Map(), titles: new Map(), ach: new Map() },
  psn: { titles: [], sets: new Map(), earned: new Map(), lists: new Map() },
};
const xboxHour = () => Math.floor(clock.t / HOUR);
const xboxRemaining = () => fake.xbox.limit - (fake.xbox.spent.get(xboxHour()) || 0);

async function platforms(url, opts = {}) {
  const u = new URL(url);
  if (u.hostname === '127.0.0.1') return realFetch(url, opts);
  clock.t += 3300; // every request takes a moment (the app's spacers wait on Date.now)
  const p = u.pathname;
  const q = Object.fromEntries(u.searchParams);
  net.push({ host: u.host, path: p, params: q, at: clock.t });
  if (u.host === 'api.steampowered.com') {
    const s = fake.steam;
    if (p.includes('GetPlayerSummaries')) return jsonRes({ response: { players: [{ steamid: STEAMID, personaname: 'Tester', communityvisibilitystate: 3, timecreated: Math.floor((T0 - 3000 * DAY) / 1000) }] } });
    if (p.includes('GetOwnedGames')) return jsonRes({ response: { game_count: s.games.size, games: [...s.games.values()] } });
    if (p.includes('GetPlayerAchievements')) {
      const list = s.player.get(q.appid);
      if (!list) return jsonRes({ playerstats: { error: 'Requested app has no stats', success: false } }, 400);
      // names and descriptions come with l=english only
      const english = q.l === 'english';
      return jsonRes({ playerstats: { steamID: STEAMID, success: true, ...(list.length ? { achievements: list.map(({ name, description, ...a }) => (english ? { ...a, name, description } : a)) } : {}) } });
    }
    if (p.includes('GetSchemaForGame')) {
      const list = s.schema.get(q.appid);
      return jsonRes({ game: list ? { gameName: 'x', gameVersion: '1', availableGameStats: { achievements: list } } : {} });
    }
    if (p.includes('GetGlobalAchievementPercentagesForApp')) {
      const list = s.rarity.get(q.gameid);
      return list ? jsonRes({ achievementpercentages: { achievements: list } }) : jsonRes({ error: 'no stats' }, 403);
    }
    if (p.includes('IStoreBrowseService/GetItems')) return jsonRes({ response: { store_items: [] } });
  }
  if (u.host === 'store.steampowered.com') return jsonRes({ [q.appids]: { success: false } });
  if (u.host === 'xbl.io') {
    const x = fake.xbox;
    const spent = x.spent.get(xboxHour()) || 0;
    if (spent >= x.limit) return jsonRes({ code: 'RATE_LIMIT_EXCEEDED', resetAt: new Date((xboxHour() + 1) * HOUR).toISOString() }, 429, { 'x-ratelimit-limit': String(x.limit), 'x-ratelimit-remaining': '0' });
    x.spent.set(xboxHour(), spent + 1);
    const h = { 'x-ratelimit-limit': String(x.limit), 'x-ratelimit-remaining': String(xboxRemaining()) };
    if (p === '/api/v2/player/titleHistory') {
      return jsonRes({ content: { xuid: XUID, titles: [...x.titles.values()].map((t) => ({ titleId: t.id, name: t.name, type: 'Game', devices: ['XboxSeries'], titleHistory: { lastTimePlayed: new Date(t.lastPlayed).toISOString() } })) }, code: 200 }, 200, h);
    }
    if (p.startsWith('/api/v2/achievements/stats/')) return jsonRes({ statlistscollection: [{ stats: [{ name: 'MinutesPlayed', value: String(x.titles.get(p.split('/').pop())?.minutes ?? 0) }] }] }, 200, h);
    if (p.startsWith('/api/v2/achievements/player/')) {
      const a = x.ach.get(p.split('/').pop());
      if (typeof a === 'function') { const v = a(q); return typeof v === 'number' ? jsonRes({ error: 'x' }, v, h) : jsonRes(v, 200, h); } // a list in pages (by continuationToken)
      return typeof a === 'number' ? jsonRes({ error: 'x' }, a, h) : jsonRes(a ?? { content: { achievements: [] }, code: 200 }, 200, h);
    }
    if (p.startsWith('/api/v2/dvr/')) return jsonRes({ values: [] }, 200, h);
    if (p === '/api/v2/presence') return jsonRes([{ xuid: XUID, state: 'Offline' }], 200, h);
  }
  if (u.host === 'ca.account.sony.com') {
    if (p.endsWith('/authorize')) return new Response(null, { status: 302, headers: { location: 'com.scee.psxandroid.scecompcall://redirect/?code=v3.x' } });
    const claims = Buffer.from(JSON.stringify({ sub: '42' })).toString('base64url');
    return jsonRes({ access_token: `a.${claims}.b`, expires_in: 36000, refresh_token: 'r', refresh_token_expires_in: 5_184_000 });
  }
  if (u.host === 'm.np.playstation.com') {
    const s = fake.psn;
    if (p.endsWith('/gamelist/v2/users/me/titles')) return jsonRes({ titles: s.titles, totalItemCount: s.titles.length });
    if (p.endsWith('/trophyTitles')) return jsonRes({ titles: q.npTitleIds.split(',').map((id) => ({ npTitleId: id, trophyTitles: s.sets.get(id) || [] })) });
    let m = /^\/api\/trophy\/v1\/users\/me\/npCommunicationIds\/([^/]+)\/trophyGroups\/all\/trophies$/.exec(p);
    if (m) return s.earned.has(m[1]) ? jsonRes({ trophies: s.earned.get(m[1]) }) : jsonRes({ error: 'not found' }, 404);
    m = /^\/api\/trophy\/v1\/npCommunicationIds\/([^/]+)\/trophyGroups\/all\/trophies$/.exec(p);
    if (m) return s.lists.has(m[1]) ? jsonRes({ trophies: s.lists.get(m[1]) }) : jsonRes({ error: 'not found' }, 404);
    if (p.includes('basicPresences')) return jsonRes({ basicPresence: { availability: 'unavailable' } });
  }
  return jsonRes({ error: `unmocked ${url}` }, 404);
}

/** An app on its own database, talked to over HTTP, with the platforms faked. */
async function startApp({ dbFile = ':memory:' } = {}) {
  const logs = [];
  const log = { info() {}, debug() {}, warn: (m) => logs.push(['warn', String(m)]), error: (m) => logs.push(['error', String(m)]) };
  const inst = createApp({ dbFile, password: '', log, scheduler: false });
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${inst.server.address().port}`;
  const call = async (method, p, body) => {
    const r = await realFetch(base + (p.startsWith('/api') ? p : `/api/v1${p}`), { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const get = async (p) => { const r = await call('GET', p); assert.equal(r.status, 200, `GET ${p}: ${JSON.stringify(r.body)}`); return r.body; };
  const t = {
    inst, db: inst.app.db, svc: inst.app.sync, logs, call, get,
    post: async (p, b = {}) => { const r = await call('POST', p, b); assert.equal(r.status, 200, `POST ${p}: ${JSON.stringify(r.body)}`); return r.body; },
    async link(platform, config, name = platform) { return t.post('/accounts', { platform, name, config: { presence: 'off', ...config }, sync: false }); },
    /** Sync now, then let background enrichment (and the achievements it reads) finish. */
    async sync(id) { const r = await t.post(`/accounts/${id}/sync?wait=true`); await t.settle(); return r; },
    async settle() { for (let i = 0; i < 10 && (t.svc.running.size || t.svc.enriching.size); i++) await Promise.allSettled([...t.svc.running.values(), ...t.svc.enriching.values()]); },
    entry: (acc, ext) => t.db.prepare('SELECT * FROM entries WHERE account_id = ? AND ext_id = ?').get(acc, String(ext)),
    hist: (acc, ext) => JSON.parse(t.entry(acc, ext).hist || '{}'),
    estimates: (entryId) => t.db.prepare("SELECT id, minutes, window_start, window_end FROM sessions WHERE entry_id = ? AND kind = 'estimate' ORDER BY id").all(entryId).map((r) => ({ ...r })),
    /** Entries whose sessions do not add up to their total (must stay empty). */
    unbalanced: () => t.db.prepare('SELECT e.id FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min').all(),
    close: async () => { await t.settle(); inst.close(); },
  };
  return t;
}

/** Each unlock's session (from the API) checked against the database: the right kind holds its time. */
function checkOwners(t, list) {
  for (const it of list.items) {
    if (!it.unlocked || it.unlocked_at == null) { assert.equal(it.session, null, `${it.id}: no time, no session`); continue; }
    const holding = (kind, slack) => t.db.prepare(`SELECT id FROM sessions WHERE entry_id = ? AND kind = ? AND COALESCE(started_at, window_start) <= ?
      AND COALESCE(ended_at, window_end) + ? >= ?`).all(it.entry_id, kind, it.unlocked_at, slack, it.unlocked_at).map((r) => r.id);
    const tracked = holding('play', ACH_SLACK);
    const history = holding('estimate', 0);
    if (tracked.length) assert.ok(it.session_kind === 'tracked' && tracked.includes(it.session.id), `${it.id}: belongs to tracked play`);
    else if (history.length) assert.ok(it.session_kind === 'history' && history.includes(it.session.id), `${it.id}: belongs to the history estimate holding it`);
    else assert.deepEqual([it.session, it.session_kind], [null, null], `${it.id}: no session holds it`);
  }
}

before(() => { globalThis.fetch = platforms; Date.now = () => clock.t; });
after(() => { globalThis.fetch = realFetch; Date.now = realNow; });

const ago = (d) => T0 - d * DAY;
const unix = (ms) => Math.floor(ms / 1000);
/** A Steam library: one game with achievements, one without stats, one with stats but none, one never played. */
function steamWorld() {
  const s = fake.steam;
  for (const m of Object.values(s)) m.clear();
  s.games.set(100, { appid: 100, name: 'Space Game', playtime_forever: 600, rtime_last_played: unix(ago(5)), has_community_visible_stats: true });
  s.games.set(200, { appid: 200, name: 'No Stats Game', playtime_forever: 300, rtime_last_played: unix(ago(50)), has_community_visible_stats: true });
  s.games.set(300, { appid: 300, name: 'Stats But None', playtime_forever: 100, rtime_last_played: unix(ago(80)), has_community_visible_stats: true });
  s.games.set(400, { appid: 400, name: 'Never Played', playtime_forever: 0, rtime_last_played: 0, has_community_visible_stats: true });
  s.player.set('100', [
    { apiname: 'A', achieved: 1, unlocktime: unix(ago(20)), name: 'Alpha', description: 'First' },
    { apiname: 'B', achieved: 1, unlocktime: unix(ago(8)), name: 'Beta', description: 'Second' },
    { apiname: 'C', achieved: 1, unlocktime: 0, name: 'Gamma', description: 'From before unlock times' },
    { apiname: 'D', achieved: 0, unlocktime: 0, name: 'Delta', description: 'Secret' },
    { apiname: 'E', achieved: 0, unlocktime: 0, name: 'Epsilon', description: 'Later' },
  ]);
  s.player.set('300', []);
  s.player.set('400', [{ apiname: 'X', achieved: 0, unlocktime: 0, name: 'X', description: '' }]);
  s.schema.set('100', ['A', 'B', 'C', 'D', 'E'].map((n) => ({ name: n, displayName: `${n} title`, hidden: n === 'D' ? 1 : 0, description: '', icon: `https://cdn/${n}.jpg`, icongray: `https://cdn/${n}_gray.jpg` })));
  s.rarity.set('100', [{ name: 'A', percent: 80.5 }, { name: 'B', percent: '12.25' }, { name: 'C', percent: 3 }, { name: 'D', percent: 0.9 }, { name: 'E', percent: 1.5 }]);
}

describe('Steam: achievements read with history enrichment, and again after play', () => {
  let t; let acc; let game;
  const counts = () => ({ player: sent(/GetPlayerAchievements/), schema: sent(/GetSchemaForGame/), rarity: sent(/GetGlobalAchievementPercentagesForApp/), store: sent(/appdetails/) });
  before(async () => {
    clock.t = T0;
    steamWorld();
    net.length = 0;
    t = await startApp();
    acc = (await t.link('steam', { api_key: 'steam-key', steam_id: STEAMID })).id;
    await t.sync(acc);
    game = (await t.get('/games?q=Space')).items[0];
  });
  after(() => t.close());

  test('the enrichment requests read them (English names), the schema once per app (icons, hidden), rarity; games without stats quietly have none', async () => {
    const c = counts();
    assert.equal(c.player, 3, 'one per title with history (the unplayed one is not asked)');
    assert.ok(net.filter((x) => /GetPlayerAchievements/.test(x.path)).every((x) => x.params.l === 'english'));
    assert.equal(c.schema, 1, 'only for the game that has achievements');
    assert.equal(c.rarity, 1);
    const detail = await t.get(`/games/${game.id}`);
    const sum = { total: 5, unlocked: 3, percent: 60, points: null, points_total: null, grades: null, last_unlocked_at: unix(ago(8)) * 1000, completed: false, completed_at: null };
    const { fetched_at, ...entrySum } = detail.entries[0].achievements;
    assert.deepEqual(entrySum, sum);
    assert.ok(fetched_at > T0, 'when Steam was read');
    const { fetched_at: f2, ...gameSum } = detail.achievements;
    assert.deepEqual(gameSum, sum);
    const none = await t.get(`/games/${(await t.get('/games?q=No%20Stats')).items[0].id}`);
    assert.equal(none.achievements.total, 0, 'read: the game has none');
    assert.equal((await t.get(`/games/${(await t.get('/games?q=Stats%20But')).items[0].id}`)).achievements.total, 0);
    assert.equal((await t.get(`/games/${(await t.get('/games?q=Never')).items[0].id}`)).achievements, null, 'never played: never read');
    // (requests take virtual time here: the API's slow-request notes are expected)
    assert.deepEqual(t.logs.filter(([, m]) => !/Slow request/.test(m)), [], 'no stats / no rarity is not a warning');
    const diag = (await t.get('/system')).accounts.find((a) => a.id === acc).achievements;
    assert.deepEqual({ titles: diag.titles, done: diag.done, pending: diag.pending, refresh_due: diag.refresh_due, achievements: diag.achievements, unlocked: diag.unlocked },
      { titles: 3, done: 3, pending: 0, refresh_due: 0, achievements: 5, unlocked: 3 });
  });

  test('the full list: unlocked newest first (time-less after them), then locked in the platform order; each with the session it belongs to', async () => {
    const list = await t.get(`/games/${game.id}/achievements`);
    assert.equal(list.game_id, game.id);
    assert.equal(list.total, 5);
    assert.deepEqual(list.items.map((i) => i.id), ['B', 'A', 'C', 'D', 'E']);
    const b = list.items[0];
    assert.deepEqual(Object.keys(b).sort(), ['description', 'entry_id', 'grade', 'group', 'hidden', 'icon_locked_url', 'icon_url', 'id', 'name', 'platform', 'points', 'rarity', 'session', 'session_kind', 'unlocked', 'unlocked_at']);
    assert.deepEqual([b.name, b.description, b.icon_url, b.icon_locked_url, b.rarity, b.platform, b.hidden], ['Beta', 'Second', 'https://cdn/B.jpg', 'https://cdn/B_gray.jpg', 12.25, 'steam', false]);
    assert.equal(list.items.find((i) => i.id === 'D').hidden, true);
    checkOwners(t, list);
    assert.ok(list.items.some((i) => i.session_kind === 'history'), 'pre-tracking unlocks belong to the dated history');
    assert.equal(list.entries.length, 1);
    assert.equal(list.entries[0].achievements.total, 5);
    // filters
    assert.deepEqual((await t.get(`/games/${game.id}/achievements?state=locked`)).items.map((i) => i.id), ['D', 'E']);
    assert.equal((await t.get(`/games/${game.id}/achievements?state=unlocked&entry_id=${list.entries[0].entry_id}`)).total, 3);
    assert.equal((await t.call('GET', `/games/${game.id}/achievements?state=maybe`)).status, 400);
    assert.equal((await t.call('GET', '/games/999999/achievements')).status, 404);
    assert.equal((await t.call('GET', `/games/${game.id}/achievements?entry_id=999999`)).status, 404);
  });

  test('the history is dated from exactly the unlock times it always used', () => {
    assert.deepEqual(t.hist(acc, 100).anchors, [unix(ago(20)) * 1000, unix(ago(8)) * 1000], 'achieved with a time; locked and time-less ones are not dates');
    assert.equal(t.hist(acc, 200).anchors, undefined);
    assert.equal(t.hist(acc, 300).anchors, undefined);
  });

  test('after new play the title is read again: its unlocks belong to the tracked session; history, totals and the schema are left alone', async () => {
    const e = t.entry(acc, 100);
    const before_ = { est: t.estimates(e.id), anchors: t.hist(acc, 100).anchors, c: counts() };
    // an hour of play seen by presence, two unlocks: during it, and stamped 4 minutes after it ended
    const start = T0 + HOUR;
    const end = start + HOUR;
    const s = t.svc;
    s.applyPresence(s.account(acc), [{ extId: '100', title: 'Space Game' }], { intervalSec: 120, now: start });
    s.applyPresence(s.account(acc), [{ extId: '100', title: 'Space Game' }], { intervalSec: 120, now: end - MIN });
    s.applyPresence(s.account(acc), [], { intervalSec: 120, now: end });
    clock.t = end + 5 * MIN;
    Object.assign(fake.steam.games.get(100), { playtime_forever: 660, playtime_2weeks: 60, rtime_last_played: unix(start) });
    const list = fake.steam.player.get('100');
    Object.assign(list[3], { achieved: 1, unlocktime: unix(start + 30 * MIN) });
    Object.assign(list[4], { achieved: 1, unlocktime: unix(end + 4 * MIN) });
    const r = await t.sync(acc);
    assert.equal(r.sessions_created, 1);
    const c = counts();
    assert.equal(c.player - before_.c.player, 1, 'only the played title is read again');
    assert.equal(c.schema, before_.c.schema, 'the stored rows have the schema already');
    assert.equal(c.rarity, before_.c.rarity, 'rarity is cached for a day');
    assert.equal(c.store, before_.c.store, 'no history requests');
    const play = t.db.prepare("SELECT * FROM sessions WHERE entry_id = ? AND kind = 'play'").get(e.id);
    const items = (await t.get(`/games/${game.id}/achievements`)).items;
    for (const id of ['D', 'E']) {
      const it = items.find((i) => i.id === id);
      assert.deepEqual([it.session_kind, it.session.id, it.session.precise], ['tracked', play.id, true], `${id} belongs to the session`);
    }
    assert.deepEqual(items.slice(0, 2).map((i) => i.id), ['E', 'D'], 'newest first');
    // the sessions list and the session itself carry them
    const page = await t.get(`/sessions?game_id=${game.id}`);
    assert.deepEqual(page.items[0].achievements, { count: 2, items: ['D', 'E'].map((id) => {
      const it = items.find((i) => i.id === id);
      return { id, entry_id: e.id, name: it.name, icon_url: it.icon_url, rarity: it.rarity, points: null, grade: null, unlocked_at: it.unlocked_at };
    }) });
    assert.equal((await t.get(`/sessions/${play.id}`)).achievements.count, 2);
    assert.deepEqual((await t.get('/sessions?kind=baseline')).items.map((x) => x.achievements), (await t.get('/sessions?kind=baseline')).items.map(() => ({ count: 0, items: [] })));
    // separate data: history, anchors and totals untouched; sessions still add up
    assert.deepEqual(t.estimates(e.id), before_.est);
    assert.deepEqual(t.hist(acc, 100).anchors, before_.anchors);
    assert.equal(t.entry(acc, 100).playtime_min, 660);
    assert.deepEqual(t.unbalanced(), []);
    const sum = (await t.get(`/games/${game.id}`)).achievements;
    assert.deepEqual([sum.unlocked, sum.percent, sum.completed, sum.completed_at], [5, 100, true, unix(end + 4 * MIN) * 1000], '100%: completed with the last unlock');
  });

  test('nothing due: no request; a re-read of the same reply changes nothing', async () => {
    const rows = () => t.db.prepare('SELECT * FROM achievements ORDER BY id').all().map((r) => ({ ...r }));
    const snap = rows();
    const n = sent(/GetPlayerAchievements/);
    const r = await t.post(`/accounts/${acc}/enrich?wait=true`);
    assert.equal(r.achievements.read, 0);
    assert.equal(sent(/GetPlayerAchievements/), n, 'nothing played since the last read');
    t.db.prepare('UPDATE entries SET ach_at = 0 WHERE account_id = ? AND ext_id = ?').run(acc, '100'); // as if played since
    const r2 = await t.post(`/accounts/${acc}/enrich?wait=true`);
    assert.equal(r2.achievements.read, 1);
    assert.equal(sent(/GetPlayerAchievements/), n + 1);
    assert.deepEqual(rows(), snap, 'same reply: not one row changed');
  });

  test('another account owning the same game shares the cached schema and rarity', async () => {
    const c = counts();
    const other = (await t.link('steam', { api_key: 'steam-key-2', steam_id: STEAMID }, 'Second')).id;
    await t.sync(other);
    assert.equal(counts().player - c.player, 3);
    assert.equal(counts().schema, c.schema, 'schema cached per app');
    assert.equal(counts().rarity, c.rarity);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.account_id = ? AND a.icon_url IS NOT NULL').get(other).n, 5);
    await t.call('DELETE', `/accounts/${other}`);
  });

  test('the JSON export carries them; an import ignores them safely (a fresh instance, and the same one again)', async () => {
    const r = await realFetch(`http://127.0.0.1:${t.inst.server.address().port}/api/v1/export`);
    const doc = await r.json();
    const space = doc.games.find((g) => g.title === 'Space Game');
    assert.deepEqual(space.achievements.map((a) => a.id), ['A', 'B', 'C', 'D', 'E']);
    assert.deepEqual(space.achievements[0], { id: 'A', name: 'Alpha', unlocked: true, unlocked_at: new Date(unix(ago(20)) * 1000).toISOString(), rarity: 80.5 });
    assert.equal(doc.games.find((g) => g.title === 'No Stats Game').achievements, undefined, 'only on entries that have some');
    const csv = await (await realFetch(`http://127.0.0.1:${t.inst.server.address().port}/api/v1/export?format=csv`)).text();
    assert.ok(!/achiev/i.test(csv.split('\n')[0]), 'CSV columns unchanged');
    const fresh = await startApp();
    try {
      const res = await fresh.post('/import', doc);
      assert.ok(res.games >= 4);
      assert.equal(fresh.db.prepare('SELECT COUNT(*) n FROM achievements').get().n, 0, 'not imported');
      assert.equal((await fresh.get('/stats/lifetime')).total_minutes, (await t.get('/stats/lifetime')).total_minutes);
    } finally { await fresh.close(); }
    const rows = t.db.prepare('SELECT * FROM achievements ORDER BY id').all().map((x) => ({ ...x }));
    const life = await t.get('/stats/lifetime');
    await t.post('/import', doc);
    assert.deepEqual(t.db.prepare('SELECT * FROM achievements ORDER BY id').all().map((x) => ({ ...x })), rows);
    assert.deepEqual(await t.get('/stats/lifetime'), life);
  });
});

const LOCKED = '0001-01-01T00:00:00.0000000Z';
const xblTime = (ms) => new Date(ms).toISOString().replace('Z', '0000Z');
/** An achievements/player reply in the modern shape: [{ id, at (ms | null), gs, rarity }]. */
const modernReply = (list) => ({ content: { achievements: list.map((a) => ({
  id: String(a.id), name: `Achievement ${a.id}`, description: `Do thing ${a.id}`, lockedDescription: '', progressState: a.at ? 'Achieved' : 'NotStarted',
  progression: { requirements: [], timeUnlocked: a.at ? xblTime(a.at) : LOCKED }, mediaAssets: [{ name: 'icon', type: 'Icon', url: `https://xbox.img/${a.id}.png` }],
  isSecret: false, rewards: [{ value: String(a.gs ?? 10), type: 'Gamerscore' }], rarity: { currentCategory: 'Rare', currentPercentage: a.rarity ?? 5 },
})), pagingInfo: { continuationToken: null, totalRecords: list.length } }, code: 200 });
const reply360 = (titleId, list) => ({ achievements: list.map((a) => ({
  id: a.id, titleId: Number(titleId), name: `Classic ${a.id}`, unlocked: !!a.at, isSecret: !!a.secret, gamerscore: a.gs, imageId: a.id + 100,
  description: `Classic thing ${a.id}`, lockedDescription: 'Locked', timeUnlocked: a.at ? xblTime(a.at) : LOCKED,
})), pagingInfo: { continuationToken: null } });
function xboxWorld(limit = 150) {
  const x = fake.xbox;
  x.limit = limit;
  for (const m of [x.spent, x.titles, x.ach]) m.clear();
}
const usedThisHour = (t, acc, calls) => {
  const hour = Math.floor(clock.t / HOUR);
  fake.xbox.spent.set(hour, calls); // another tool using the same key
  t.db.prepare('INSERT INTO api_usage(account_id, hour, calls) VALUES (?, ?, ?) ON CONFLICT(account_id, hour) DO UPDATE SET calls = excluded.calls').run(acc, hour, calls);
};

describe('Xbox: the enrichment request carries the achievements; reads after play and the back-fill stay inside the hourly budget', () => {
  let t; let acc;
  const achCalls = () => sent(/\/achievements\/player\//);
  before(async () => {
    clock.t = T0;
    xboxWorld();
    net.length = 0;
    const x = fake.xbox;
    x.titles.set('1001', { id: '1001', name: 'Modern Game', minutes: 500, lastPlayed: ago(2) });
    x.titles.set('1002', { id: '1002', name: 'Classic 360', minutes: 300, lastPlayed: ago(30) });
    x.titles.set('1003', { id: '1003', name: 'No Achievements', minutes: 200, lastPlayed: ago(60) });
    x.ach.set('1001', modernReply([{ id: 1, at: ago(10), gs: 10, rarity: 60 }, { id: 2, at: ago(9), gs: 50, rarity: 2.5 }, { id: 3, at: null, gs: 40, rarity: 1 }]));
    x.ach.set('1002', reply360('1002', [{ id: 1, at: ago(400), gs: 20 }, { id: 2, at: null, gs: 30, secret: true }]));
    x.ach.set('1003', 404);
    t = await startApp();
    acc = (await t.link('xbox', { api_key: 'xbl-key' })).id;
    await t.sync(acc);
  });
  after(() => t.close());

  test('one achievements request per title, as enrichment always made; gamerscore, rarity, 360 titles; a title without achievements is read as none', async () => {
    assert.deepEqual(net.filter((c) => /\/achievements\/player\//.test(c.path)).map((c) => c.path.split('/').pop()).sort(), ['1001', '1002', '1003']);
    const gameOf = async (q) => t.get(`/games/${(await t.get(`/games?q=${encodeURIComponent(q)}`)).items[0].id}`);
    const modern = (await gameOf('Modern Game')).achievements;
    assert.deepEqual([modern.total, modern.unlocked, modern.percent, modern.points, modern.points_total, modern.completed], [3, 2, 66.6, 60, 100, false]);
    const classic = await gameOf('Classic 360');
    assert.deepEqual([classic.achievements.total, classic.achievements.points, classic.achievements.points_total], [2, 20, 50]);
    const items = (await t.get(`/games/${classic.id}/achievements`)).items;
    assert.deepEqual(items.map((i) => [i.id, i.unlocked, i.points, i.hidden, i.icon_url]), [
      ['1', true, 20, false, 'https://image.xboxlive.com/global/t.3ea/ach/0/65'], ['2', false, 30, true, 'https://image.xboxlive.com/global/t.3ea/ach/0/66']]);
    assert.equal((await gameOf('No Achievements')).achievements.total, 0);
    // history is dated from what findUnlockTimes always read from these replies
    for (const id of ['1001', '1002']) assert.deepEqual(t.hist(acc, id).anchors, [...new Set(findUnlockTimes(fake.xbox.ach.get(id)))].sort((a, b) => a - b), id);
  });

  test('a title played since it was read is read again after the sync - only while more than 30% of the hour is left', async () => {
    const x = fake.xbox;
    clock.t = T0 + 2 * HOUR;
    const end = clock.t - 5 * MIN;
    x.titles.get('1001').minutes += 45;
    x.titles.get('1001').lastPlayed = end;
    x.ach.set('1001', modernReply([{ id: 1, at: ago(10), gs: 10, rarity: 60 }, { id: 2, at: ago(9), gs: 50, rarity: 2.5 }, { id: 3, at: end - 10 * MIN, gs: 40, rarity: 1 }]));
    const n = achCalls();
    const r = await t.sync(acc);
    assert.equal(r.sessions_created, 1);
    assert.equal(achCalls() - n, 1, 'one request: the played title');
    const game = (await t.get('/games?q=Modern')).items[0];
    const it = (await t.get(`/games/${game.id}/achievements`)).items.find((i) => i.id === '3');
    const play = t.db.prepare("SELECT id FROM sessions WHERE entry_id = ? AND kind = 'play'").get(t.entry(acc, '1001').id);
    assert.deepEqual([it.unlocked, it.session_kind, it.session.id], [true, 'tracked', play.id]);
    assert.equal((await t.get(`/games/${game.id}`)).achievements.completed, true);

    // played again, but other tools left only the reserve of this hour: it waits
    clock.t = T0 + 4 * HOUR;
    x.titles.get('1001').minutes += 30;
    x.titles.get('1001').lastPlayed = clock.t - 2 * MIN;
    usedThisHour(t, acc, 150 - 45 - 2); // the sync itself spends 2 more
    const m = achCalls();
    await t.sync(acc);
    assert.equal(achCalls(), m, 'no request into the 30% reserve');
    assert.ok(xboxRemaining() >= 45 - 2);
    let diag = (await t.get('/system')).accounts.find((a) => a.id === acc).achievements;
    assert.equal(diag.refresh_due, 1, 'waiting to be read again');
    // the next hour it is read
    clock.t = (Math.floor(clock.t / HOUR) + 1) * HOUR + 3 * MIN;
    const e = await t.post(`/accounts/${acc}/enrich?wait=true`);
    assert.equal(e.achievements.read, 1);
    diag = (await t.get('/system')).accounts.find((a) => a.id === acc).achievements;
    assert.equal(diag.refresh_due, 0);
    assert.deepEqual(t.unbalanced(), []);
  });

  test('a played title whose read keeps failing is given up after 3 tries, until it is played again', async () => {
    const x = fake.xbox;
    clock.t = (Math.floor(clock.t / HOUR) + 1) * HOUR + 5 * MIN;
    x.titles.get('1002').minutes += 20;
    x.titles.get('1002').lastPlayed = clock.t - 3 * MIN;
    x.ach.set('1002', 500);
    const tries = () => net.filter((c) => /\/achievements\/player\/.*\/1002$/.test(c.path)).length;
    const n = tries();
    await t.sync(acc); // the read after the sync: 1st try
    for (let i = 0; i < 4; i++) await t.post(`/accounts/${acc}/enrich?wait=true`);
    assert.equal(tries() - n, 3, 'three tries, then it waits for the next play');
    assert.equal((await t.get('/system')).accounts.find((a) => a.id === acc).achievements.refresh_due, 0);
    x.ach.set('1002', reply360('1002', [{ id: 1, at: ago(400), gs: 20 }, { id: 2, at: null, gs: 30, secret: true }]));
  });

  test('back-fill of a library enriched before achievements were kept: a quarter of the hourly limit per hour, never into the reserve, until done', async () => {
    xboxWorld(40);
    clock.t = T0 + 10 * HOUR;
    const x = fake.xbox;
    for (let i = 0; i < 20; i++) {
      const id = String(2000 + i);
      x.titles.set(id, { id, name: `Backlog ${i}`, minutes: 100 + i, lastPlayed: ago(10 + i) });
      x.ach.set(id, modernReply([{ id: 1, at: ago(40 + i), gs: 15 }, { id: 2, at: null, gs: 5 }]));
    }
    const b = await startApp();
    try {
      const id = (await b.link('xbox', { api_key: 'xbl-key-2', hourly_limit: '40' })).id;
      await b.sync(id);
      // as the previous version left it: enriched, nothing kept
      b.db.prepare('UPDATE entries SET enriched_at = COALESCE(enriched_at, ?), ach_v = 0, ach_at = NULL WHERE account_id = ?').run(clock.t, id);
      b.db.prepare('DELETE FROM achievements').run();
      const progress = async () => (await b.get('/system')).accounts.find((a) => a.id === id).achievements;
      assert.deepEqual([(await progress()).pending, (await progress()).done], [20, 0]);
      const reserve = Math.ceil(40 * 0.3);
      const share = Math.ceil(40 * 0.25);
      const dvr = sent(/\/dvr\//);
      const anchors = b.db.prepare('SELECT id, hist FROM entries WHERE account_id = ? ORDER BY id').all(id).map((r) => ({ ...r }));
      let left = 20;
      for (let hour = 0; left > 0; hour++) {
        assert.ok(hour < 3, 'done within a few hours');
        clock.t = (Math.floor(clock.t / HOUR) + 1) * HOUR + MIN;
        const n = achCalls();
        const r = await b.post(`/accounts/${id}/enrich?wait=true`);
        await b.post(`/accounts/${id}/enrich?wait=true`); // again in the same hour: its share is spent
        const spent = achCalls() - n;
        assert.equal(spent, Math.min(share, left), `hour ${hour}: ${spent} back-fill requests`);
        assert.ok(xboxRemaining() >= reserve, `hour ${hour}: ${xboxRemaining()} left, the reserve is ${reserve}`);
        left -= spent;
        assert.equal(r.achievements.backfilled, spent);
        assert.equal(r.achievements.pending, left);
        if (left) assert.ok(r.achievements.retry_in > 0 && r.achievements.retry_in <= HOUR + 2 * MIN, 'goes on in the next hour');
        else assert.equal(r.achievements.retry_in, null);
        assert.deepEqual([(await progress()).pending, (await progress()).done], [left, 20 - left]);
      }
      assert.equal(b.db.prepare('SELECT COUNT(*) n FROM achievements').get().n, 40);
      // the history was not touched: nothing enriched again, the same evidence
      assert.equal(sent(/\/dvr\//), dvr);
      assert.deepEqual(b.db.prepare('SELECT id, hist FROM entries WHERE account_id = ? ORDER BY id').all(id).map((r) => ({ ...r })), anchors);
    } finally { await b.close(); }
  });
});

/**
 * A title whose list comes in pages: lists[i] is page i ([{ id, at, gs }], as modernReply);
 * tokens[i] the continuationToken page i names (default p1, p2, ...; none on the last page).
 */
const pagedReply = (lists, { total = lists.flat().length, tokens = lists.map((_, i) => (i < lists.length - 1 ? `p${i + 1}` : null)) } = {}) => (q) => {
  const i = q.continuationToken ? Number(/^p(\d+)$/.exec(q.continuationToken)?.[1]) : 0;
  const r = modernReply(lists[i] || []);
  r.content.pagingInfo = { continuationToken: tokens[i] ?? null, totalRecords: total };
  return r;
};
const pageCalls = (id) => net.filter((c) => c.path.endsWith(`/achievements/player/${XUID}/${id}`)).map((c) => c.params.continuationToken ?? null);

describe('Xbox: long achievement lists are read page by page, inside the hourly budget', () => {
  test('pagingInfo in either reply shape; progress counts what the platform says the title has', () => {
    assert.deepEqual(pagingOf({ content: { achievements: [], pagingInfo: { continuationToken: 'abc', totalRecords: 120 } }, code: 200 }), { token: 'abc', total: 120 });
    assert.deepEqual(pagingOf({ achievements: [], pagingInfo: { continuationToken: null } }), { token: null, total: null }, 'Xbox 360 lists page the same way');
    assert.deepEqual(pagingOf({ achievements: [], pagingInfo: { continuationToken: '', totalRecords: '7' } }), { token: null, total: 7 });
    assert.deepEqual(pagingOf(null), { token: null, total: null });
    const s = summaryOf({ total: 32, unlocked: 32, last_unlocked_at: 5 }, null, 50);
    assert.deepEqual([s.total, s.unlocked, s.percent, s.completed, s.completed_at], [50, 32, 64, false, null], 'a list read in part is not 100%');
    assert.equal(summaryOf({ total: 3, unlocked: 3, last_unlocked_at: 5 }, null, 2).completed, true, 'a total below what is stored counts what is stored');
  });

  test('every page is read and merged in order; a repeated token ends the list; totals use totalRecords', async () => {
    clock.t = T0 + 30 * HOUR;
    xboxWorld();
    net.length = 0;
    const x = fake.xbox;
    x.titles.set('3001', { id: '3001', name: 'Long List', minutes: 900, lastPlayed: ago(3) });
    x.titles.set('3002', { id: '3002', name: 'Looping Pages', minutes: 400, lastPlayed: ago(4) });
    const long = [[{ id: 1, at: ago(30) }, { id: 2, at: ago(29) }], [{ id: 3, at: ago(20) }, { id: 4, at: null }], [{ id: 5, at: ago(10) }, { id: 6, at: null }]];
    x.ach.set('3001', pagedReply(long));
    x.ach.set('3002', pagedReply([[{ id: 1, at: ago(40) }, { id: 2, at: null }], [{ id: 3, at: ago(35) }, { id: 4, at: null }]], { total: 6, tokens: ['p1', 'p1'] }));
    const t = await startApp();
    try {
      const acc = (await t.link('xbox', { api_key: 'xbl-paged' })).id;
      await t.sync(acc);
      assert.deepEqual(pageCalls('3001'), [null, 'p1', 'p2'], 'three requests, each naming the token of the page before');
      const rows = (id) => t.db.prepare('SELECT ach_id, unlocked, sort FROM achievements WHERE entry_id = ? ORDER BY sort').all(t.entry(acc, id).id).map((r) => [r.ach_id, r.unlocked, r.sort]);
      assert.deepEqual(rows('3001'), [['1', 1, 0], ['2', 1, 1], ['3', 1, 2], ['4', 0, 3], ['5', 1, 4], ['6', 0, 5]]);
      const gameOf = async (q) => t.get(`/games/${(await t.get(`/games?q=${encodeURIComponent(q)}`)).items[0].id}`);
      const a = (await gameOf('Long List')).achievements;
      assert.deepEqual([a.total, a.unlocked, a.completed], [6, 4, false]);
      assert.deepEqual(t.hist(acc, '3001').anchors, [ago(30), ago(29), ago(20), ago(10)], 'every page dates the history');
      // the second page names the token of the first again: no third request, the list ends there
      assert.deepEqual(pageCalls('3002'), [null, 'p1']);
      assert.equal(rows('3002').length, 4);
      const b = (await gameOf('Looping Pages')).achievements;
      assert.deepEqual([b.total, b.unlocked, b.percent], [6, 2, 33.3], 'what the platform says it has, not the 4 read');
      assert.deepEqual([t.entry(acc, '3001').ach_v, t.entry(acc, '3002').ach_v, t.entry(acc, '3001').ach_total], [ACH_VERSION, ACH_VERSION, 6]);
      assert.deepEqual(JSON.parse(t.db.prepare('SELECT state FROM accounts WHERE id = ?').get(acc).state).ach_pages ?? {}, {}, 'nothing left to read on');
      const n = sent(/\/achievements\/player\//);
      await t.post(`/accounts/${acc}/enrich?wait=true`);
      assert.equal(sent(/\/achievements\/player\//), n, 'read for good: not asked again');
    } finally { await t.close(); }
  });

  test('the budget running out mid-title keeps what was read, never dips into the reserve, and goes on from that page later - no duplicates', async () => {
    clock.t = T0 + 40 * HOUR + 2 * MIN;
    xboxWorld();
    net.length = 0;
    const x = fake.xbox;
    x.titles.set('3003', { id: '3003', name: 'Cut Short', minutes: 600, lastPlayed: ago(6) });
    const pages = [[{ id: 1, at: ago(60) }, { id: 2, at: ago(50) }], [{ id: 3, at: ago(40) }, { id: 4, at: ago(30) }], [{ id: 5, at: ago(20) }, { id: 6, at: null }]];
    x.ach.set('3003', pagedReply(pages));
    const reserve = Math.ceil(150 * 0.3);
    const t = await startApp();
    try {
      const acc = (await t.link('xbox', { api_key: 'xbl-budget' })).id;
      // other tools left 50 of the hour: the sync takes 2, the capture lists 2, the first page 1 - then only the reserve is left
      usedThisHour(t, acc, 150 - 50);
      await t.sync(acc);
      assert.deepEqual(pageCalls('3003'), [null], 'one page, then the reserve stops it');
      assert.ok(xboxRemaining() >= reserve, `${xboxRemaining()} left, the reserve is ${reserve}`);
      const entry = () => t.entry(acc, '3003');
      const ids = () => t.db.prepare('SELECT ach_id FROM achievements WHERE entry_id = ? ORDER BY sort').all(entry().id).map((r) => r.ach_id);
      assert.deepEqual(ids(), ['1', '2'], 'what was read is kept');
      const game = (await t.get('/games?q=Cut')).items[0];
      let s = (await t.get(`/games/${game.id}`)).achievements;
      assert.deepEqual([s.total, s.unlocked, s.percent, s.completed], [6, 2, 33.3, false], 'not shown as complete');
      assert.equal(entry().enriched_at, null, 'its history waits for the rest of the list');
      assert.equal(entry().ach_v, 0, 'not read for good');
      assert.equal(JSON.parse(t.db.prepare('SELECT state FROM accounts WHERE id = ?').get(acc).state).ach_pages['3003'].token, 'p1');

      // the next hour it goes on from the page where it stopped
      clock.t = (Math.floor(clock.t / HOUR) + 1) * HOUR + 3 * MIN;
      await t.post(`/accounts/${acc}/enrich?wait=true`);
      assert.deepEqual(pageCalls('3003'), [null, 'p1', 'p2'], 'the first page is not read again');
      assert.deepEqual(ids(), ['1', '2', '3', '4', '5', '6']);
      assert.equal(t.db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT ach_id) d FROM achievements').get().n, 6);
      s = (await t.get(`/games/${game.id}`)).achievements;
      assert.deepEqual([s.total, s.unlocked, s.completed], [6, 5, false]);
      assert.ok(entry().enriched_at != null);
      assert.equal(entry().ach_v, ACH_VERSION);
      assert.deepEqual(t.hist(acc, '3003').anchors, [ago(60), ago(50), ago(40), ago(30), ago(20)], 'the history is dated from every page');
      assert.deepEqual(JSON.parse(t.db.prepare('SELECT state FROM accounts WHERE id = ?').get(acc).state).ach_pages, {});

      // played again, and again cut short after its first page: it stays due, then goes on
      clock.t = (Math.floor(clock.t / HOUR) + 1) * HOUR + 5 * MIN;
      x.titles.get('3003').minutes += 40;
      x.titles.get('3003').lastPlayed = clock.t - 2 * MIN;
      pages[2][1].at = clock.t - 10 * MIN; // the last one, unlocked just now
      usedThisHour(t, acc, 150 - 48); // the sync takes 2, the first page 1
      await t.sync(acc);
      assert.deepEqual(pageCalls('3003').slice(3), [null]);
      assert.ok(xboxRemaining() >= reserve);
      const due = async () => (await t.get('/system')).accounts.find((a) => a.id === acc).achievements.refresh_due;
      assert.equal(await due(), 1, 'still to be read on');
      clock.t = (Math.floor(clock.t / HOUR) + 1) * HOUR + 3 * MIN;
      const r = await t.post(`/accounts/${acc}/enrich?wait=true`);
      assert.deepEqual(pageCalls('3003').slice(3), [null, 'p1', 'p2']);
      assert.equal(r.achievements.read, 1);
      assert.equal(await due(), 0);
      s = (await t.get(`/games/${game.id}`)).achievements;
      assert.deepEqual([s.total, s.unlocked, s.completed], [6, 6, true]);
      assert.equal(t.db.prepare('SELECT COUNT(*) n FROM achievements').get().n, 6, 'no duplicates');
      const play = t.db.prepare("SELECT id FROM sessions WHERE entry_id = ? AND kind = 'play'").get(entry().id);
      const six = (await t.get(`/games/${game.id}/achievements`)).items.find((i) => i.id === '6');
      assert.deepEqual([six.session_kind, six.session?.id], ['tracked', play.id]);
      assert.deepEqual(t.unbalanced(), []);
    } finally { await t.close(); }
  });

  test('a page to go on from that keeps failing is a failed attempt: given up after 3, what was read stays', async () => {
    clock.t = T0 + 50 * HOUR + 2 * MIN;
    xboxWorld();
    net.length = 0;
    fake.xbox.titles.set('3005', { id: '3005', name: 'Broken Page', minutes: 300, lastPlayed: ago(7) });
    const list = pagedReply([[{ id: 1, at: ago(70) }, { id: 2, at: null }], [{ id: 3, at: ago(60) }, { id: 4, at: null }]]);
    fake.xbox.ach.set('3005', (q) => (q.continuationToken ? 500 : list(q)));
    const t = await startApp();
    try {
      const acc = (await t.link('xbox', { api_key: 'xbl-broken' })).id;
      usedThisHour(t, acc, 150 - 50);
      await t.sync(acc);
      assert.deepEqual(pageCalls('3005'), [null]);
      for (let i = 0; i < 4; i++) {
        clock.t = (Math.floor(clock.t / HOUR) + 1) * HOUR + 3 * MIN;
        await t.post(`/accounts/${acc}/enrich?wait=true`);
      }
      assert.deepEqual(pageCalls('3005'), [null, 'p1', 'p1', 'p1'], 'three tries, then it is given up');
      const e = t.entry(acc, '3005');
      assert.ok(e.enriched_at != null);
      assert.equal(e.ach_v, ACH_VERSION);
      assert.deepEqual([t.db.prepare('SELECT COUNT(*) n FROM achievements WHERE entry_id = ?').get(e.id).n, e.ach_total], [2, 4], 'the first page is kept; progress still counts all 4');
    } finally { await t.close(); }
  });

  test('a page cap ends a list that never stops naming new pages', async () => {
    clock.t = T0 + 60 * HOUR;
    xboxWorld();
    net.length = 0;
    fake.xbox.titles.set('3004', { id: '3004', name: 'Endless', minutes: 100, lastPlayed: ago(8) });
    fake.xbox.ach.set('3004', (q) => {
      const i = q.continuationToken ? Number(q.continuationToken.slice(1)) : 0;
      const r = modernReply([{ id: i + 1, at: null }]);
      r.content.pagingInfo = { continuationToken: `p${i + 1}`, totalRecords: 1000 };
      return r;
    });
    const t = await startApp();
    try {
      const acc = (await t.link('xbox', { api_key: 'xbl-endless' })).id;
      await t.sync(acc);
      assert.equal(pageCalls('3004').length, ACH_PAGES);
      assert.equal(t.entry(acc, '3004').ach_v, ACH_VERSION, 'taken as read');
      assert.equal((await t.get(`/games/${(await t.get('/games?q=Endless')).items[0].id}`)).achievements.total, 1000);
    } finally { await t.close(); }
  });
});

// =====================================================================================
// GameTrack's achievements, then the platform
// =====================================================================================
describe('GameTrack first, Steam linked later', () => {
  test('the imported copy\'s achievements join the synced entry; Steam\'s read keeps one row each, its data wins, unlocks stay', async () => {
    clock.t = T0 + 80 * HOUR;
    steamWorld();
    net.length = 0;
    const t = await startApp();
    try {
      const r = importGameTrack(t.db, {
        games: [{ uuid: 'S', title: 'Space Game', hours_played: '10', owned_platform: 'PC' }],
        steam_games: [{ game_uuid: 'S', appid: '100', name: 'Space Game', playtime_forever: '600' }],
        steam_achievements: [
          { steam_game_appid: '100', name: 'A', achieved: 'true', unlock_time: iso(ago(21)) }, // Steam's apiname
          { steam_game_appid: '100', name: 'Epsilon', achieved: 'true', unlock_time: iso(ago(4)) }, // its display name; Steam says locked
          { steam_game_appid: '100', name: 'Delta', achieved: 'false', unlock_time: '' },
          { steam_game_appid: '100', name: 'Zeta', achieved: 'true', unlock_time: iso(ago(6)) }, // Steam does not list it
        ],
      }, { settings: t.inst.app.settings.all(), now: clock.t });
      assert.deepEqual([r.imported_titles, r.achievements_imported], [1, 4]);
      const acc = (await t.link('steam', { api_key: 'steam-key', steam_id: STEAMID })).id;
      await t.sync(acc);
      const e = t.entry(acc, '100');
      assert.equal(t.db.prepare('SELECT COUNT(*) n FROM entries WHERE game_id = ?').get(e.game_id).n, 1, 'one copy: the synced entry adopted the import');
      const rows = t.db.prepare('SELECT ach_id, name, unlocked, unlocked_at, rarity, icon_url, source FROM achievements WHERE entry_id = ? ORDER BY sort').all(e.id).map((x) => ({ ...x }));
      assert.deepEqual(rows.map((x) => [x.ach_id, x.name, x.unlocked, x.unlocked_at, x.rarity, x.source]), [
        ['A', 'Alpha', 1, unix(ago(20)) * 1000, 80.5, null], // Steam's time wins
        ['B', 'Beta', 1, unix(ago(8)) * 1000, 12.25, null],
        ['C', 'Gamma', 1, null, 3, null],
        ['D', 'Delta', 0, null, 0.9, null],
        ['E', 'Epsilon', 1, ago(4), 1.5, null], // GameTrack's unlock is kept
      ]);
      assert.ok(rows.every((x) => x.icon_url), 'icons from the schema (what GameTrack listed counts as not known)');
      assert.equal(t.db.prepare('SELECT COUNT(*) n FROM achievements').get().n, 5, 'nothing twice, nothing left on the adopted copy');
      assert.deepEqual([(await t.get(`/games/${e.game_id}`)).achievements.total, (await t.get(`/games/${e.game_id}`)).achievements.unlocked], [5, 4]);
      // GameTrack again: nothing changes
      const snap = t.db.prepare('SELECT * FROM achievements ORDER BY id').all().map((x) => ({ ...x }));
      const again = importGameTrack(t.db, {
        games: [{ uuid: 'S', title: 'Space Game', hours_played: '10', owned_platform: 'PC' }],
        steam_games: [{ game_uuid: 'S', appid: '100', name: 'Space Game', playtime_forever: '600' }],
        steam_achievements: [{ steam_game_appid: '100', name: 'Epsilon', achieved: 'true', unlock_time: iso(ago(4)) }, { steam_game_appid: '100', name: 'Zeta', achieved: 'true', unlock_time: iso(ago(6)) }],
      }, { settings: t.inst.app.settings.all(), now: clock.t });
      assert.deepEqual([again.achievements_imported, again.achievements_matched, again.achievements_updated, again.achievements_unmatched], [0, 1, 0, 1]);
      assert.deepEqual(t.db.prepare('SELECT * FROM achievements ORDER BY id').all().map((x) => ({ ...x })), snap);
      assert.deepEqual(t.unbalanced(), []);
    } finally { await t.close(); }
  });
});

function psnWorld() {
  const s = fake.psn;
  s.titles = [];
  for (const m of [s.sets, s.earned, s.lists]) m.clear();
}
const iso = (ms) => new Date(ms).toISOString();
const psnGame = (id, name, minutes, { first, last, count }) => ({
  titleId: id, name, category: 'ps5_native_game', imageUrl: `https://psn.img/${id}.png`, playDuration: `PT${Math.floor(minutes / 60)}H${minutes % 60}M`,
  firstPlayedDateTime: iso(first), lastPlayedDateTime: iso(last), playCount: count, concept: { id: Number(id.replace(/\D/g, '')) },
});
const earnedTrophy = (id, type, at, rate) => ({ trophyId: id, trophyHidden: false, earned: at != null, ...(at != null ? { earnedDateTime: iso(at) } : {}), trophyType: type, trophyRare: 2, trophyEarnedRate: String(rate) });
const listTrophy = (id, type, group = 'default') => ({ trophyId: id, trophyHidden: false, trophyType: type, trophyName: `Trophy ${id}`, trophyDetail: `Detail ${id}`, trophyIconUrl: `https://psn.img/t/${id}.png`, trophyGroupId: group });

describe('PlayStation: earned trophies + the trophy list; grades and the platinum', () => {
  let t; let acc; let game;
  const counts = () => ({ titles: sent(/\/trophyTitles$/), earned: sent(/\/users\/me\/npCommunicationIds\//), list: sent(/^\/api\/trophy\/v1\/npCommunicationIds\//) });
  before(async () => {
    clock.t = T0;
    psnWorld();
    net.length = 0;
    const s = fake.psn;
    s.titles.push(psnGame('PPSA00001_00', 'Trophy Game', 600, { first: ago(100), last: ago(5), count: 10 }), psnGame('PPSA00002_00', 'No Trophy Set', 100, { first: ago(60), last: ago(50), count: 2 }));
    s.sets.set('PPSA00001_00', [{ npCommunicationId: 'NPWR00001_00', npServiceName: 'trophy2' }]);
    s.earned.set('NPWR00001_00', [earnedTrophy(0, 'platinum', ago(30), 1.5), earnedTrophy(1, 'gold', ago(40), 9.9), earnedTrophy(2, 'bronze', null, 60)]);
    s.lists.set('NPWR00001_00', [listTrophy(0, 'platinum'), listTrophy(1, 'gold'), listTrophy(2, 'bronze'), listTrophy(3, 'silver', '001')]);
    t = await startApp();
    acc = (await t.link('psn', { npsso: 'npsso' })).id;
    await t.sync(acc);
    game = (await t.get('/games?q=Trophy%20Game')).items[0];
  });
  after(() => t.close());

  test('read during enrichment: names from the trophy list (one request per set), grades, % of players; the platinum completes the game', async () => {
    assert.deepEqual(counts(), { titles: 1, earned: 1, list: 1 });
    const { fetched_at, ...sum } = (await t.get(`/games/${game.id}`)).achievements;
    assert.deepEqual(sum, { total: 4, unlocked: 2, percent: 50, points: null, points_total: null, grades: { platinum: 1, gold: 1, silver: 0, bronze: 0 }, last_unlocked_at: ago(30), completed: true, completed_at: ago(30) });
    const items = (await t.get(`/games/${game.id}/achievements`)).items;
    assert.deepEqual(items.map((i) => [i.id, i.name, i.grade, i.rarity, i.group]), [
      ['NPWR00001_00:0', 'Trophy 0', 'platinum', 1.5, 'default'], ['NPWR00001_00:1', 'Trophy 1', 'gold', 9.9, 'default'],
      ['NPWR00001_00:2', 'Trophy 2', 'bronze', 60, 'default'], ['NPWR00001_00:3', 'Trophy 3', 'silver', null, '001']]);
    checkOwners(t, { items });
    assert.equal((await t.get(`/games/${(await t.get('/games?q=No%20Trophy')).items[0].id}`)).achievements.total, 0, 'no trophy set: read, none');
    assert.deepEqual(t.hist(acc, 'PPSA00001_00').anchors, earnedTimes({ trophies: fake.psn.earned.get('NPWR00001_00') }).sort((a, b) => a - b));
  });

  test('after play the earned list is read again; the trophy list only when trophies it does not know appear', async () => {
    const s = fake.psn;
    const est = t.estimates(t.entry(acc, 'PPSA00001_00').id);
    clock.t = T0 + 3 * HOUR;
    const last = clock.t - 5 * MIN;
    Object.assign(s.titles[0], { playDuration: 'PT11H', playCount: 11, lastPlayedDateTime: iso(last) });
    s.earned.get('NPWR00001_00')[2] = earnedTrophy(2, 'bronze', last - 20 * MIN, 60);
    const c = counts();
    assert.equal((await t.sync(acc)).sessions_created, 1);
    assert.deepEqual(counts(), { titles: c.titles, earned: c.earned + 1, list: c.list }, 'one request: the trophy sets are known, the names stored');
    const items = (await t.get(`/games/${game.id}/achievements`)).items;
    const two = items.find((i) => i.id === 'NPWR00001_00:2');
    assert.deepEqual([two.unlocked, two.session_kind], [true, 'tracked']);
    assert.deepEqual(t.estimates(t.entry(acc, 'PPSA00001_00').id), est, 'history untouched');
    // a patch adds a trophy: the next read after play asks for the list again
    clock.t += 3 * HOUR;
    Object.assign(s.titles[0], { playDuration: 'PT12H', playCount: 12, lastPlayedDateTime: iso(clock.t - 5 * MIN) });
    s.earned.get('NPWR00001_00').push(earnedTrophy(4, 'gold', clock.t - 15 * MIN, 0.4));
    s.lists.get('NPWR00001_00').push(listTrophy(4, 'gold', '002'));
    await t.sync(acc);
    assert.equal(counts().list, c.list + 1);
    const four = (await t.get(`/games/${game.id}/achievements`)).items.find((i) => i.id === 'NPWR00001_00:4');
    assert.deepEqual([four.name, four.grade, four.group, four.session_kind], ['Trophy 4', 'gold', '002', 'tracked']);
    assert.deepEqual(t.unbalanced(), []);
  });
});

describe('upgrade: a database from before achievements were kept', () => {
  test('migrates (no table before), then the background back-fill reads every enriched title once; history evidence and estimates untouched', async () => {
    clock.t = T0 + 30 * DAY;
    steamWorld();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ach-'));
    const file = path.join(dir, 'vestigo.db');
    const all = (db, sql) => db.prepare(sql).all().map((r) => ({ ...r }));
    try {
      let t = await startApp({ dbFile: file });
      const acc = (await t.link('steam', { api_key: 'steam-key', steam_id: STEAMID })).id;
      await t.sync(acc);
      const gameId = (await t.get('/games?q=Space')).items[0].id;
      const before_ = {
        entries: all(t.db, 'SELECT id, hist, enriched_at, inferred_v, baseline_min, playtime_min FROM entries ORDER BY id'),
        sessions: all(t.db, 'SELECT * FROM sessions ORDER BY id'),
        rows: all(t.db, 'SELECT entry_id, ach_id, name, description, icon_url, unlocked, unlocked_at, rarity, hidden FROM achievements ORDER BY entry_id, ach_id'),
      };
      assert.equal(before_.rows.length, 5);
      await t.close();
      // the database exactly as the previous version left it: enriched, no achievements kept
      const raw = new DatabaseSync(file);
      raw.exec('DROP TABLE achievements; ALTER TABLE entries DROP COLUMN ach_v; ALTER TABLE entries DROP COLUMN ach_at; PRAGMA user_version = 5;');
      raw.close();

      t = await startApp({ dbFile: file });
      try {
        assert.ok(t.db.prepare('PRAGMA user_version').get().user_version >= 8, 'migrated');
        const diag = async () => (await t.get('/system')).accounts.find((a) => a.id === acc).achievements;
        const d0 = await diag();
        assert.deepEqual([d0.titles, d0.done, d0.pending, d0.pending_with_history, d0.achievements], [3, 0, 3, 0, 0], 'every played title waits for the back-fill');
        assert.equal((await t.get(`/games/${gameId}`)).achievements, null, 'not read yet');
        const c = { player: sent(/GetPlayerAchievements/), store: sent(/appdetails/) };
        t.svc.kickAchievements(); // what the scheduler does shortly after a start
        await t.settle();
        const d1 = await diag();
        assert.deepEqual([d1.titles, d1.done, d1.pending, d1.achievements, d1.unlocked], [3, 3, 0, 5, 3]);
        assert.equal(sent(/GetPlayerAchievements/) - c.player, 3, 'once per played title');
        assert.equal(sent(/appdetails/), c.store, 'no history requests');
        assert.deepEqual(all(t.db, 'SELECT entry_id, ach_id, name, description, icon_url, unlocked, unlocked_at, rarity, hidden FROM achievements ORDER BY entry_id, ach_id'), before_.rows);
        assert.deepEqual(all(t.db, 'SELECT id, hist, enriched_at, inferred_v, baseline_min, playtime_min FROM entries ORDER BY id'), before_.entries, 'history evidence untouched');
        assert.deepEqual(all(t.db, 'SELECT * FROM sessions ORDER BY id'), before_.sessions, 'sessions untouched');
        assert.equal((await t.get(`/games/${gameId}`)).achievements.total, 5);
        // done: a later start has nothing to read
        const n = sent(/GetPlayerAchievements/);
        t.svc.kickAchievements();
        await t.settle();
        assert.equal(sent(/GetPlayerAchievements/), n);
      } finally { await t.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('GET /stats/achievements', () => {
  let t;
  const local = (m, d, h = 20) => new Date(2026, m - 1, d, h).getTime();
  before(async () => {
    clock.t = T0;
    t = await startApp();
    const db = t.db;
    const acc = (plat) => Number(db.prepare("INSERT INTO accounts(platform, name, enabled, created_at) VALUES (?, ?, 0, 0)").run(plat, plat).lastInsertRowid);
    const entry = (plat, title, { minutes = 600, excluded = 0 } = {}) => {
      const g = Number(db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, 0, 0)').run(title, title.toLowerCase()).lastInsertRowid);
      return Number(db.prepare('INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, excluded, ach_v) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
        .run(acc(plat), g, plat, title, title, minutes, excluded, ACH_VERSION).lastInsertRowid);
    };
    storeAchievements(db, entry('steam', 'Steam Game'), [
      { id: 'a', unlocked: true, unlocked_at: local(3, 15), rarity: 5 }, { id: 'b', unlocked: true, unlocked_at: local(3, 20), rarity: 50 },
      { id: 'c', unlocked: true, unlocked_at: local(5, 2), rarity: 0.5 }, { id: 'd', rarity: 0.1 },
    ]);
    storeAchievements(db, entry('xbox', 'Xbox Game'), [{ id: '1', unlocked: true, unlocked_at: local(4, 1), points: 10, rarity: 20 }, { id: '2', unlocked: true, unlocked_at: local(4, 2), points: 40, rarity: 2 }]);
    storeAchievements(db, entry('psn', 'PS Game'), [
      { id: 'N:0', grade: 'platinum', unlocked: true, unlocked_at: local(6, 10), rarity: 1 }, { id: 'N:1', grade: 'bronze', unlocked: true, unlocked_at: local(6, 9), rarity: 70 },
      { id: 'N:2', grade: 'silver', group: '001' },
    ]);
    storeAchievements(db, entry('steam', 'Excluded Copy', { excluded: 1 }), [{ id: 'x', unlocked: true, unlocked_at: local(3, 1), rarity: 0.01 }]);
  });
  after(() => t.close());

  test('per period, rarest first, games completed in the range, all-time totals, completion of played games; excluded entries left out', async () => {
    const r = await t.get('/stats/achievements?range=year:2026&group=month');
    assert.deepEqual([r.range.group, r.range.label], ['month', '2026']);
    assert.deepEqual([r.unlocked, r.points, r.grades], [7, 50, { platinum: 1, gold: 0, silver: 0, bronze: 1 }]);
    assert.deepEqual(r.series.filter((x) => x.unlocked).map((x) => [x.key, x.unlocked, x.points]), [['2026-03', 2, 0], ['2026-04', 2, 50], ['2026-05', 1, 0], ['2026-06', 2, 0]]);
    assert.equal(r.series[0].key, '2026-01');
    assert.deepEqual(r.rarest.map((x) => [x.title, x.id, x.rarity]), [['Steam Game', 'c', 0.5], ['PS Game', 'N:0', 1], ['Xbox Game', '2', 2], ['Steam Game', 'a', 5], ['Xbox Game', '1', 20], ['Steam Game', 'b', 50], ['PS Game', 'N:1', 70]]);
    assert.deepEqual(Object.keys(r.rarest[0]).sort(), ['cover_url', 'description', 'entry_id', 'game_id', 'grade', 'group', 'hidden', 'icon_locked_url', 'icon_url', 'id', 'name', 'platform', 'points', 'rarity', 'title', 'unlocked', 'unlocked_at']);
    assert.deepEqual(r.completed.map((x) => [x.title, x.platinum, x.completed_at, x.total, x.unlocked]), [['PS Game', true, local(6, 10), 3, 2], ['Xbox Game', false, local(4, 2), 2, 2]]);
    assert.equal(r.completed_count, 2);
    assert.deepEqual(r.totals, { unlocked: 7, total: 9, percent: 77.7, points: 50, points_total: 50, grades: { platinum: 1, gold: 0, silver: 0, bronze: 1 }, entries: 3, completed: 2 });
    assert.deepEqual(r.completion.buckets.map((b) => [b.label, b.count]), [['0%', 0], ['1-24%', 0], ['25-49%', 0], ['50-74%', 1], ['75-99%', 1], ['100%', 1]]);
    assert.deepEqual([r.completion.entries, r.completion.average_percent], [3, 80.5]);
    // another range, a platform, the limit, bad input
    const recent = await t.get('/stats/achievements?range=30d');
    assert.deepEqual([recent.unlocked, recent.rarest, recent.completed, recent.range.group, recent.series.length], [0, [], [], 'day', 30]);
    assert.equal(recent.totals.unlocked, 7, 'totals are all-time');
    const xbox = await t.get('/stats/achievements?range=all&platform=xbox&limit=1');
    assert.deepEqual([xbox.unlocked, xbox.points, xbox.rarest.length, xbox.totals.entries], [2, 50, 1, 1]);
    assert.equal((await t.get('/stats/achievements')).range.label, 'Last 30 days');
    assert.equal((await t.call('GET', '/stats/achievements?group=fortnight')).status, 400);
    assert.equal((await t.call('GET', '/stats/achievements?range=year:20x')).status, 400);
  });

  test('the OpenAPI document describes the new endpoints and fields', async () => {
    const doc = await t.get('/api/openapi.json');
    const ach = doc.paths['/api/v1/games/{id}/achievements']?.get;
    assert.ok(ach, 'GET /games/{id}/achievements');
    assert.match(ach.responses[200].description, /session_kind/);
    assert.deepEqual(ach.parameters.map((p) => p.name).sort(), ['entry_id', 'id', 'state']);
    assert.match(doc.paths['/api/v1/stats/achievements'].get.responses[200].description, /completion/);
    assert.match(doc.paths['/api/v1/games/{id}'].get.responses[200].description, /completed_at/);
    for (const p of ['/api/v1/sessions', '/api/v1/sessions/{id}']) assert.match(doc.paths[p].get.responses[200].description, /achievements: \{ count, items/);
    assert.match(doc.paths['/api/v1/system'].get.responses[200].description, /pending/);
    assert.match(doc.paths['/api/v1/export'].get.responses[200].description, /achievements/);
  });
});
