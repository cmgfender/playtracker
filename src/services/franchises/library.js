// The games of a library as the franchise pages see them: totals, state (finished, playing, played,
// dropped, owned), first and last day played, release year (the store's, else IGDB's), IGDB's name
// and franchises, and store ids; for a game of more than one entry, its entries too (see parts.js:
// they can be different releases of one series entry).

import { dayKey } from '../stats.js';

const DAY = 86_400_000;
const FINISHED = new Set(['completed', 'beaten']);
const PLAYING_DAYS = 30;

/** Every game with what the franchise pages show of it. */
export function libraryGames(db, now) {
  const games = db.prepare(`SELECT g.id, g.title, g.cover_url, g.status, COALESCE(SUM(CASE WHEN e.excluded = 0 THEN e.playtime_min END), 0) minutes,
      GROUP_CONCAT(DISTINCT e.platform) platforms, MAX(e.last_played_at) last_played
    FROM games g JOIN entries e ON e.game_id = g.id GROUP BY g.id`).all();
  const meta = new Map(db.prepare('SELECT game_id, name, release_date FROM game_meta WHERE igdb_id IS NOT NULL').all().map((m) => [m.game_id, m]));
  const store = new Map();
  for (const r of db.prepare("SELECT game_id, MIN(json_extract(hist, '$.release_at')) t FROM entries WHERE json_extract(hist, '$.release_at') > 31536000000 GROUP BY game_id").all()) store.set(r.game_id, r.t);
  const ids = new Map();
  for (const r of db.prepare('SELECT game_id, platform, ext_id FROM entries').all()) { if (!ids.has(r.game_id)) ids.set(r.game_id, []); ids.get(r.game_id).push(`${r.platform}:${r.ext_id}`); }
  const days = new Map(db.prepare('SELECT game_id, MIN(day) first, MAX(day) last FROM play_days WHERE excluded = 0 GROUP BY game_id').all().map((r) => [r.game_id, r]));
  const sets = new Map(db.prepare(`SELECT e.game_id, COUNT(*) total, SUM(a.unlocked) unlocked, MAX(CASE WHEN a.unlocked = 1 AND a.grade = 'platinum' THEN 1 ELSE 0 END) plat
    FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.excluded = 0 GROUP BY e.game_id`).all().map((r) => [r.game_id, r]));
  const tags = new Map();
  for (const t of db.prepare("SELECT game_id, name FROM game_tags WHERE kind = 'franchise'").all()) { if (!tags.has(t.game_id)) tags.set(t.game_id, []); tags.get(t.game_id).push(t.name); }
  const recent = dayKey(now - PLAYING_DAYS * DAY);
  // the entries of games that have more than one: what each says of its hardware and its first play
  const entriesOf = new Map();
  const multi = `SELECT game_id FROM entries WHERE excluded = 0 GROUP BY game_id HAVING COUNT(*) > 1`;
  const entryDays = new Map(db.prepare(`SELECT entry_id, MIN(day) f, MAX(day) l, MIN(CASE WHEN estimated = 0 THEN day END) tf FROM play_days
    WHERE excluded = 0 AND game_id IN (${multi}) GROUP BY entry_id`).all().map((r) => [r.entry_id, r]));
  for (const e of db.prepare(`SELECT id, game_id, platform, ext_id, title, playtime_min, json_extract(meta, '$.device') device, json_extract(meta, '$.played_on') played_on,
      json_extract(hist, '$.first_played_at') fp, json_extract(hist, '$.manual.start') ms FROM entries WHERE excluded = 0 AND game_id IN (${multi}) ORDER BY id`).all()) {
    const d = entryDays.get(e.id);
    if (!entriesOf.has(e.game_id)) entriesOf.set(e.game_id, []);
    entriesOf.get(e.game_id).push({
      id: e.id, platform: e.platform, ext_id: e.ext_id, title: e.title, minutes: e.playtime_min, hardware: e.device || e.played_on || null,
      first_played_at: e.fp, manual_start: e.ms, first_tracked_at: d?.tf ? new Date(`${d.tf}T12:00:00`).getTime() : null, first_day: d?.f || null, last_day: d?.l || null,
    });
  }
  return games.map((g) => {
    const m = meta.get(g.id);
    // IGDB's release is a calendar day at midnight UTC
    const igdb = m?.release_date > 31536000000 ? (() => { const d = new Date(m.release_date); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12).getTime(); })() : null;
    const release = store.get(g.id) ?? igdb;
    const d = days.get(g.id);
    const set = sets.get(g.id);
    const complete = !!(set && ((set.total > 0 && set.unlocked === set.total) || set.plat));
    const lastDay = d?.last || (g.last_played > 31536000000 ? dayKey(g.last_played) : null);
    const state = FINISHED.has(g.status) || complete ? 'finished' : g.status === 'dropped' ? 'dropped'
      : g.minutes > 0 && (g.status === 'playing' || (lastDay && lastDay >= recent)) ? 'playing' : g.minutes > 0 ? 'played' : 'owned';
    return {
      id: g.id, title: g.title, cover_url: g.cover_url, status: g.status, minutes: g.minutes, platforms: (g.platforms || '').split(',').filter(Boolean),
      first_day: d?.first || null, last_day: lastDay, release_at: release || null, release_year: release ? new Date(release).getFullYear() : null,
      igdb_name: m?.name || null, franchises: tags.get(g.id) || [], complete, state, ids: ids.get(g.id) || [],
      ...(entriesOf.has(g.id) ? { entries: entriesOf.get(g.id) } : {}),
    };
  });
}
