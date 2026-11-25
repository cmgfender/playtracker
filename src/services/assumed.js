// Assumed hours: playtime for games a platform reports no time for.
//
// An older console (Xbox 360, PS3, PS Vita) reports a game's achievements and when it was last
// played, and no playtime. With the setting `assumed_hours` on, such a game gets an estimate of
// its hours: IGDB's typical time for the game, scaled by the share of its achievements you
// unlocked. The hours are a guess; the dates are not (the unlock times and the last played date
// date them like any other history).
//
// The estimate is an entry of its own next to the platform's (no account, same platform,
// ext_id 'assumed:<the platform entry's id>'), so nothing a platform reported is ever changed:
// turning the setting off, or the platform reporting real time, removes it. Its history is
// 'assumed' wherever history says what it rests on. reconcileAssumed() makes the entries match
// what the library holds now; it is safe to run at any time.

import { tx } from '../db.js';
import { flushRollups } from './rollup.js';
import { reinferMany, realTime } from './inference.js';

export const ASSUMED_PREFIX = 'assumed:';
export const isAssumed = (e) => e != null && e.account_id == null && String(e.ext_id || '').startsWith(ASSUMED_PREFIX);
/** SQL for "this entry is an assumption" on the alias given. */
export const assumedSql = (alias = 'e') => `(${alias}.account_id IS NULL AND ${alias}.ext_id LIKE 'assumed:%')`;

// IGDB's typical times for an endless game run to thousands of hours: no single game is assumed longer
export const MAX_TYPICAL = 200 * 60;
const MIN_MINUTES = 15;
const FINISHED = new Set(['completed', 'beaten']);

/**
 * The hours assumed for one game: { minutes, typical_minutes, typical ('complete' | 'extra' | 'main'), share, floor }.
 * null when IGDB has no typical time for it.
 */
export function assume({ unlocked, total, ttb_main: main, ttb_extra: extra, ttb_complete: complete, finished = false }) {
  if (!(unlocked > 0) || !(total > 0)) return null;
  // every achievement is a completionist's run; with no such time, the longest IGDB knows
  const typical = complete > 0 ? 'complete' : extra > 0 ? 'extra' : main > 0 ? 'main' : null;
  if (!typical) return null;
  const t = Math.min(MAX_TYPICAL, { complete, extra, main }[typical]);
  const share = Math.min(1, unlocked / total);
  let minutes = share * t;
  // a game you marked finished took at least its main story
  const floor = finished && main > 0 && Math.min(MAX_TYPICAL, main) > minutes;
  if (floor) minutes = Math.min(MAX_TYPICAL, main);
  minutes = Math.max(MIN_MINUTES, Math.round(minutes / 5) * 5);
  return { minutes, typical_minutes: t, typical, share: Math.round(share * 1000) / 1000, floor };
}

/**
 * What the library calls for: one assumption for every counted platform entry with unlocks and no
 * playtime, in a game no one gave hours by hand. Returns { items, no_typical (entries IGDB has no time for) }.
 */
export function planAssumed(db) {
  const rows = db.prepare(`SELECT e.id, e.game_id, e.platform, e.title, e.icon_url, e.cover_url, e.last_played_at, e.first_seen_at, g.status,
      m.ttb_main, m.ttb_extra, m.ttb_complete, m.release_date,
      (SELECT COUNT(*) FROM achievements a WHERE a.entry_id = e.id) total,
      (SELECT COUNT(*) FROM achievements a WHERE a.entry_id = e.id AND a.unlocked = 1) unlocked,
      (SELECT COALESCE(SUM(x.playtime_min), 0) FROM entries x WHERE x.game_id = e.game_id AND x.excluded = 0 AND NOT ${assumedSql('x')}) game_minutes,
      (SELECT COUNT(*) FROM entries x WHERE x.game_id = e.game_id AND x.account_id IS NULL AND x.playtime_min > 0 AND NOT ${assumedSql('x')}) by_hand
    FROM entries e JOIN games g ON g.id = e.game_id LEFT JOIN game_meta m ON m.game_id = e.game_id AND m.igdb_id IS NOT NULL
    WHERE e.account_id IS NOT NULL AND e.excluded = 0 AND e.playtime_min = 0
      AND EXISTS (SELECT 1 FROM achievements a WHERE a.entry_id = e.id AND a.unlocked = 1)
    ORDER BY e.id`).all();
  const times = db.prepare('SELECT unlocked_at t FROM achievements WHERE entry_id = ? AND unlocked = 1 AND unlocked_at IS NOT NULL ORDER BY unlocked_at');
  const items = [];
  let noTypical = 0;
  const now = Date.now();
  for (const r of rows) {
    // hours you entered yourself, or imported, already say how long the game took
    if (r.by_hand) continue;
    const a = assume({ ...r, finished: FINISHED.has(r.status) && r.game_minutes === 0 });
    if (!a) { noTypical++; continue; }
    const anchors = times.all(r.id).map((x) => x.t).filter((t) => realTime(t) && t <= now).slice(-500);
    const last = realTime(r.last_played_at) ?? anchors.at(-1) ?? null;
    items.push({ source: r.id, game_id: r.game_id, platform: r.platform, title: r.title, icon_url: r.icon_url, cover_url: r.cover_url, first_seen_at: r.first_seen_at,
      minutes: a.minutes, anchors, last_played_at: last, first_played_at: anchors[0] ?? null, release_at: realTime(r.release_date) ?? null,
      calc: { source_entry: r.id, unlocked: r.unlocked, total: r.total, ...a } });
  }
  return { items, no_typical: noTypical };
}

/** What turning it on would add (or adds now): { enabled, games, minutes, no_typical, by_platform: [{ platform, games, minutes }], top: [{ game_id, title, minutes }] }. */
export function assumedSummary(db, settings) {
  const { items, no_typical: noTypical } = planAssumed(db);
  const by = new Map();
  for (const it of items) { const x = by.get(it.platform) || { platform: it.platform, games: 0, minutes: 0 }; x.games++; x.minutes += it.minutes; by.set(it.platform, x); }
  const counted = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(playtime_min), 0) m FROM entries e WHERE ${assumedSql('e')} AND e.excluded = 0`).get();
  return {
    enabled: settings.get('assumed_hours') === true,
    games: items.length, minutes: items.reduce((a, x) => a + x.minutes, 0), no_typical: noTypical,
    counted_games: counted.n, counted_minutes: counted.m,
    by_platform: [...by.values()].sort((a, b) => b.minutes - a.minutes),
    top: [...items].sort((a, b) => b.minutes - a.minutes).slice(0, 5).map((x) => ({ game_id: x.game_id, title: x.title, minutes: x.minutes })),
  };
}

/**
 * Make the assumed entries match the library: created, re-sized or removed as the setting, the
 * achievements, IGDB's times and the platform's own playtime say. Your choices on one stay
 * (excluded from totals, the dates you set). Returns { created, updated, removed }.
 */
export function reconcileAssumed(db, settings, { log = null } = {}) {
  const on = settings.get('assumed_hours') === true;
  const existing = db.prepare(`SELECT * FROM entries e WHERE ${assumedSql('e')}`).all();
  if (!on && !existing.length) return { created: 0, updated: 0, removed: 0 };
  const want = on ? planAssumed(db).items : [];
  const have = new Map(existing.map((e) => [e.ext_id, e]));
  const out = { created: 0, updated: 0, removed: 0 };
  const touched = [];
  tx(db, () => {
    const keep = new Set(want.map((w) => `${ASSUMED_PREFIX}${w.source}`));
    for (const e of existing) if (!keep.has(e.ext_id)) { db.prepare('DELETE FROM entries WHERE id = ?').run(e.id); out.removed++; }
    const ins = db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, icon_url, cover_url, playtime_min, baseline_min, last_played_at, first_seen_at, last_synced_at, hist, meta)
      VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const upd = db.prepare('UPDATE entries SET game_id = ?, title = ?, icon_url = ?, cover_url = ?, playtime_min = ?, baseline_min = ?, last_played_at = ?, hist = ?, meta = ?, inferred_v = 0 WHERE id = ?');
    const now = Date.now();
    for (const w of want) {
      const ext = `${ASSUMED_PREFIX}${w.source}`;
      const old = have.get(ext);
      const prev = old ? JSON.parse(old.hist || '{}') : {};
      // the evidence is the platform entry's; what you said of the dates stays
      const hist = { tracking_start: w.first_seen_at, last_played_at: w.last_played_at, first_played_at: w.first_played_at, anchors: w.anchors, release_at: w.release_at,
        ...(prev.manual ? { manual: prev.manual } : {}), ...(prev.mode ? { mode: prev.mode } : {}) };
      const meta = JSON.stringify({ assumed: w.calc });
      if (!old) {
        touched.push(Number(ins.run(w.game_id, w.platform, ext, w.title, w.icon_url, w.cover_url, w.minutes, w.minutes, w.last_played_at, w.first_seen_at, now, JSON.stringify(hist), meta).lastInsertRowid));
        out.created++;
        continue;
      }
      const same = old.game_id === w.game_id && old.playtime_min === w.minutes && old.baseline_min === w.minutes && old.last_played_at === w.last_played_at && old.meta === meta
        && JSON.stringify([prev.anchors || [], prev.first_played_at ?? null, prev.release_at ?? null]) === JSON.stringify([w.anchors, w.first_played_at, w.release_at]);
      if (same) continue;
      // a confirmed estimate is kept row by row while it adds up: other hours need other rows
      if (hist.manual?.chunks && old.baseline_min !== w.minutes) { delete hist.manual.chunks; delete hist.manual.undated; }
      upd.run(w.game_id, w.title, w.icon_url, w.cover_url, w.minutes, w.minutes, w.last_played_at, JSON.stringify(hist), meta, old.id);
      touched.push(old.id);
      out.updated++;
    }
    if (out.removed) flushRollups(db);
    if (touched.length) {
      flushRollups(db);
      reinferMany(db, touched, { settings: settings.all() });
      flushRollups(db);
    }
  });
  if (log && (out.created || out.updated || out.removed)) log.info?.(`Assumed hours: ${out.created} added, ${out.updated} updated, ${out.removed} removed`);
  return out;
}
