// GameTrack (iOS/macOS) export import. The ZIP holds one CSV per table: games, playthroughs,
// steam/xbox/playstation games with their achievements and trophies, lists, ...
//
// GameTrack's hours mostly mirror Steam / Xbox / PlayStation, so its data is used as evidence,
// never counted twice:
//  - achievement / trophy unlock times date the history of games already synced here
//  - hours of games no account here tracks (Switch, PlayStation without a linked account, other
//    PC stores) are imported as history, dated from GameTrack's dates
//  - status, rating and cover fill in only where PlayTracker has none; wish-listed games are added
import { tx } from '../db.js';
import { normalizeTitle } from './titles.js';
import { findOrCreateGame } from './library.js';
import { parseCsv, importRows } from './importer.js';
import { mergeEvidence, reinferMany, relearnStyle } from './inference.js';
import { flushRollups } from './rollup.js';
import { HttpError } from '../util.js';

const STATUS = [
  [/now playing|^playing/i, 'playing'],
  [/play next|play later|backlog|up next/i, 'backlog'],
  [/^finished|beaten/i, 'beaten'],
  [/^completed|100%/i, 'completed'],
  [/abandon|dropped/i, 'dropped'],
  [/paused|on hold|shelved/i, 'paused'],
  [/wanted|wish/i, 'wishlist'],
];
// owned_platform -> platform family used for imported entries
const PLATFORM = [
  [/switch|nintendo/i, 'switch'],
  [/ps[345]|playstation|vita|psp/i, 'psn'],
  [/xbox|xone|x360|series x|xsx|xss/i, 'xbox'],
  [/^pc$|windows|steam deck|mac|linux/i, 'pc'],
];
const SYNCED_FAMILY = { pc: ['steam', 'xbox'], xbox: ['xbox'], psn: ['psn'], steam: ['steam'], switch: [] };

const t = (v) => {
  if (!v) return null;
  const ms = Date.parse(String(v).replace(/(\.\d{3})\d+/, '$1')); // Xbox writes 7 fraction digits
  return Number.isFinite(ms) && ms > Date.UTC(1990, 0, 1) && ms < Date.now() + 86_400_000 ? ms : null;
};

/** Find GameTrack's CSV tables in an unzipped export (any folder depth). */
export function gameTrackTables(files) {
  const tables = {};
  for (const [name, buf] of files) {
    const m = /(?:^|\/)([a-z_]+)\.csv$/i.exec(name);
    if (m) tables[m[1].toLowerCase()] = parseCsv(buf.toString('utf8'), { commaOnly: true });
  }
  if (!tables.games) throw new HttpError(400, 'No games.csv found - is this a GameTrack export?');
  return tables;
}

export function importGameTrack(db, tables, { settings = null, now = Date.now() } = {}) {
  const res = {
    gametrack_games: tables.games.length, anchored_entries: 0, anchors: 0, statuses: 0, ratings: 0, covers: 0,
    wishlist_added: 0, imported_titles: 0, skipped_synced: 0, skipped_no_playtime: 0, hidden: 0,
  };
  const by = (rows, key) => {
    const m = new Map();
    for (const r of rows || []) { const k = r[key]; if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
  };
  const steamOf = by(tables.steam_games, 'game_uuid');
  const xboxOf = by(tables.xbox_games, 'game_uuid');
  const psOf = by(tables.playstation_games, 'game_uuid');
  const playsOf = by(tables.playthroughs, 'game_uuid');
  const steamAch = by((tables.steam_achievements || []).filter((a) => a.unlock_time), 'steam_game_appid');
  const xboxAch = by((tables.xbox_achievements || []).filter((a) => a.time_unlocked && /achieved/i.test(a.progress_state || 'Achieved')), 'xbox_game_title_id');
  const trophies = by((tables.game_trophies || []).filter((a) => a.earn_date && a.earned !== 'false'), 'playstation_game_npid');
  const hidden = new Set((tables.hidden_games || []).map((h) => normalizeTitle(h.name)));
  const wishLists = new Set((tables.lists || []).filter((l) => /wish/i.test(`${l.list_type} ${l.list_name}`)).map((l) => l.uuid));
  const wished = new Set((tables.game_lists || []).filter((g) => wishLists.has(g.list_uuid)).map((g) => g.game_uuid));

  // dates GameTrack stamped on many games at once (its own first import) say nothing about play
  const stampCount = new Map();
  for (const g of tables.games) for (const k of ['start_date', 'finish_date', 'added_date']) {
    const v = g[k] && String(g[k]).slice(0, 16);
    if (v) stampCount.set(v, (stampCount.get(v) || 0) + 1);
  }
  const real = (v) => (v && (stampCount.get(String(v).slice(0, 16)) || 0) <= 5 ? t(v) : null);

  // what PlayTracker already tracks
  const synced = db.prepare('SELECT e.id, e.platform, e.ext_id, e.title, e.game_id FROM entries e WHERE e.account_id IS NOT NULL').all();
  const byExt = new Map(synced.map((e) => [`${e.platform}:${e.ext_id}`, e]));
  const syncedByTitle = new Map();
  for (const e of synced) {
    const k = normalizeTitle(e.title);
    if (!syncedByTitle.has(k)) syncedByTitle.set(k, []);
    syncedByTitle.get(k).push(e);
  }
  const gameByTitle = new Map(db.prepare('SELECT id, norm_title FROM games').all().map((g) => [g.norm_title, g.id]));
  const getGame = db.prepare('SELECT id, status, rating, cover_url FROM games WHERE id = ?');
  const setStatus = db.prepare("UPDATE games SET status = ?, updated_at = ? WHERE id = ? AND status = 'unset'");
  const setRating = db.prepare('UPDATE games SET rating = ?, updated_at = ? WHERE id = ? AND rating IS NULL');
  const setCover = db.prepare('UPDATE games SET cover_url = ? WHERE id = ? AND cover_url IS NULL');
  // a wish-listed game gets a 0-minute entry, so the library lists it and keeps it like any game
  const addWish = db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, last_synced_at)
    SELECT NULL, ?, ?, ?, ?, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM entries WHERE game_id = ?)`);

  const anchoredIds = new Set();
  const rows = [];
  const pendingAnchors = []; // for imported entries, applied after they exist

  const out = tx(db, () => {
    for (const g of tables.games) {
      const title = String(g.title || '').trim();
      if (!title) continue;
      const norm = normalizeTitle(title);
      if (hidden.has(norm)) { res.hidden++; continue; }
      const steam = steamOf.get(g.uuid) || [];
      const xbox = xboxOf.get(g.uuid) || [];
      const ps = psOf.get(g.uuid) || [];
      const plays = playsOf.get(g.uuid) || [];

      // unlock times per platform
      const steamTimes = steam.flatMap((s) => (steamAch.get(s.appid) || []).map((a) => t(a.unlock_time))).filter(Boolean);
      const xboxIds = [...new Set(xbox.flatMap((x) => [x.title_id, x.modern_title_id]).filter(Boolean))];
      const xboxTimes = xboxIds.flatMap((id) => (xboxAch.get(id) || []).map((a) => t(a.time_unlocked))).filter(Boolean);
      const psTimes = ps.flatMap((p) => (trophies.get(p.np_communication_id) || []).map((a) => t(a.earn_date))).filter(Boolean);

      // the synced entries this game corresponds to
      const matched = [];
      for (const s of steam) { const e = byExt.get(`steam:${s.appid}`); if (e) matched.push([e, steamTimes]); }
      for (const id of xboxIds) { const e = byExt.get(`xbox:${id}`); if (e && !matched.some(([m]) => m.id === e.id)) matched.push([e, xboxTimes]); }
      for (const p of ps) {
        const e = (p.title_id && byExt.get(`psn:${p.title_id}`)) || (syncedByTitle.get(norm) || []).find((x) => x.platform === 'psn');
        if (e && !matched.some(([m]) => m.id === e.id)) matched.push([e, psTimes]);
      }
      for (const [e, times] of matched) {
        if (!times.length) continue;
        mergeEvidence(db, e.id, { anchors: times });
        anchoredIds.add(e.id);
        res.anchors += times.length;
      }

      // game details, only where PlayTracker has none
      const gameIds = new Set(matched.map(([e]) => e.game_id));
      if (!gameIds.size && gameByTitle.has(norm)) gameIds.add(gameByTitle.get(norm));
      const status = STATUS.find(([re]) => re.test(g.status || ''))?.[1] || (wished.has(g.uuid) ? 'wishlist' : null);
      const rating = Number(g.user_rating) > 0 ? Math.min(10, Number(g.user_rating)) : null;
      const cover = /^https?:\/\//.test(g.poster_url || '') ? g.poster_url : null;

      // hours that no account here tracks
      const family = PLATFORM.find(([re]) => re.test(g.owned_platform || ''))?.[1] || (ps.length ? 'psn' : xbox.length ? 'xbox' : steam.length ? 'steam' : 'pc');
      const syncedSame = (syncedByTitle.get(norm) || []).some((e) => (SYNCED_FAMILY[family] || []).includes(e.platform));
      let minutes = 0; let platform = family; let playCount; let lastPlayed = null; let firstPlayed = null;
      const psRow = ps.find((p) => Number(p.play_duration) > 0);
      if (psRow) {
        minutes = Math.round(Number(psRow.play_duration) * 60); platform = 'psn';
        playCount = Number(psRow.play_count) || undefined;
        lastPlayed = t(psRow.last_played); firstPlayed = t(psRow.first_played);
      } else if (steam.length && Number(steam[0].playtime_forever) > 0) {
        minutes = steam.reduce((a, s) => a + (Number(s.playtime_forever) || 0), 0); platform = 'steam';
      } else if (Number(g.hours_played) > 0) minutes = Math.round(Number(g.hours_played) * 60);
      const starts = [real(g.start_date), ...plays.map((p) => real(p.date_started))].filter(Boolean);
      const ends = [real(g.finish_date), ...plays.map((p) => real(p.date_finished)), ...xbox.map((x) => t(x.last_time_played))].filter(Boolean);
      firstPlayed = firstPlayed ?? (starts.length ? Math.min(...starts) : null);
      lastPlayed = lastPlayed ?? (ends.length ? Math.max(...ends) : null);
      if (firstPlayed && lastPlayed && lastPlayed < firstPlayed) firstPlayed = null;

      if (minutes > 0 && (matched.length || syncedSame || (platform === 'steam' && byExt.size && [...byExt.keys()].some((k) => k.startsWith('steam:'))))) {
        // a synced account here already counts this game's time
        res.skipped_synced++;
      } else if (minutes > 0) {
        rows.push({ title, platform, account: 'GameTrack', playtime_minutes: minutes, last_played: lastPlayed || undefined, first_played: firstPlayed || undefined, play_count: playCount });
        const times = [...steamTimes, ...xboxTimes, ...psTimes];
        if (times.length) pendingAnchors.push({ platform, title, times });
        res.imported_titles++;
      } else if (!gameIds.size && (status === 'wishlist' || wished.has(g.uuid))) {
        const id = findOrCreateGame(db, { title, coverUrl: cover }, { autoMerge: settings?.auto_merge_titles !== false, now });
        addWish.run(id, platform, `import:gametrack:${norm}`, title, now, now, id);
        gameIds.add(id);
        res.wishlist_added++;
      } else if (!gameIds.size) res.skipped_no_playtime++;

      for (const id of gameIds) {
        const cur = getGame.get(id);
        if (!cur) continue;
        if (status && cur.status === 'unset' && setStatus.run(status, now, id).changes) res.statuses++;
        if (rating && cur.rating == null && setRating.run(rating, now, id).changes) res.ratings++;
        if (cover && !cur.cover_url && setCover.run(cover, id).changes) res.covers++;
      }
    }

    flushRollups(db);
    reinferMany(db, anchoredIds, { settings });
    res.anchored_entries = anchoredIds.size;
    res.import = rows.length ? importRows(db, rows, { settings, now }) : null;
    // unlock times of the imported titles, then re-date them
    const imported = new Set();
    for (const p of pendingAnchors) {
      const e = db.prepare('SELECT id FROM entries WHERE account_id IS NULL AND platform = ? AND ext_id = ?').get(p.platform, `import:gametrack:${normalizeTitle(p.title)}`);
      if (e) { mergeEvidence(db, e.id, { anchors: p.times }); imported.add(e.id); res.anchors += p.times.length; }
    }
    if (imported.size) reinferMany(db, imported, { settings });
    // set details on games created by the import
    for (const g of tables.games) {
      const norm = normalizeTitle(String(g.title || ''));
      if (!rows.some((r) => normalizeTitle(r.title) === norm)) continue;
      const id = db.prepare('SELECT game_id FROM entries WHERE account_id IS NULL AND ext_id = ?').get(`import:gametrack:${norm}`)?.game_id;
      if (!id) continue;
      const status = STATUS.find(([re]) => re.test(g.status || ''))?.[1];
      if (status && setStatus.run(status, now, id).changes) res.statuses++;
      if (Number(g.user_rating) > 0 && setRating.run(Math.min(10, Number(g.user_rating)), now, id).changes) res.ratings++;
      if (/^https?:\/\//.test(g.poster_url || '') && setCover.run(g.poster_url, id).changes) res.covers++;
    }
    flushRollups(db);
    return res;
  });
  // achievement-rich games can teach the player's style; re-dates history if it moved
  relearnStyle(db, { settings });
  return out;
}
