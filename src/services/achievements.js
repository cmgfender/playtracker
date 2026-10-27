// Achievements / trophies: what each platform lists for a title (name, description, icon, rarity,
// Xbox gamerscore or PlayStation trophy grade, hidden flag) and when the player unlocked each one.
//
// They are read with the same requests that date pre-tracking history (enrichment), read again
// after a sync records new play of a title, and back-filled once for titles read before they
// were stored (entries.ach_v) - see sync.js. They are separate data: sessions, totals and history
// minutes never depend on them, and nothing here writes those.
//
// The session an unlock belongs to is found by time whenever it is read (sessions are edited,
// split and merged, so no session id is stored):
//
//   1. the tracked (play) session whose span holds it - exact start/end first, else its sync
//      window - allowing ACH_SLACK after the end (platforms can stamp an unlock a little late)
//   2. else the dated history estimate whose window holds it
//   3. else none

import { memo, resolveRange, groupFor, groupKey, emptySeries, sessionInterval } from './stats.js';

export const ACH_VERSION = 1;
export const ACH_SLACK = 10 * 60_000;
export const GRADES = ['platinum', 'gold', 'silver', 'bronze'];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EARLIEST = Date.UTC(2000, 0, 1); // older "unlock times" are placeholders (Xbox locks read 0001-01-01)

// titles that can have unlocks (played, or reported as played), and titles whose achievements the
// history enrichment will read anyway (the back-fill leaves those to it)
export const PLAYED_SQL = '(playtime_min > 0 OR last_played_at IS NOT NULL)';
export const HISTORY_PENDING_SQL = '(baseline_min > 0 AND enriched_at IS NULL)';
// played since its achievements were last read
export const PLAYED_SINCE_SQL = 'COALESCE(last_session_at, 0) > COALESCE(ach_at, 0)';

// ---------------------------------------------------------------- parsing helpers (providers)
/** Trimmed text, or null for nothing / whitespace. */
export function text(v, max = 2000) {
  if (v == null || typeof v === 'object') return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/** A share of players in percent (0..100, two decimals), or null. */
export function percent(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : null;
}

/** Epoch ms of an unlock (ISO text or epoch ms), or null for placeholders and impossible times. */
export function unlockTime(v, now = Date.now()) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) && t > EARLIEST && t <= now + DAY ? t : null;
}

const bool = (v) => (v == null ? null : v === true || v === 1 || v === '1' || v === 'true');
const int = (v) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null; };

/** One provider item in the stored shape, or null when it has no id. */
function normalize(it, i) {
  const id = text(it?.id, 200);
  if (!id) return null;
  const unlocked = !!it.unlocked;
  const grade = text(it.grade)?.toLowerCase();
  return {
    id,
    name: text(it.name, 500), description: text(it.description), icon_url: text(it.icon_url), icon_locked_url: text(it.icon_locked_url),
    unlocked: unlocked ? 1 : 0, unlocked_at: unlocked ? unlockTime(it.unlocked_at) : null,
    rarity: percent(it.rarity), points: int(it.points), grade: GRADES.includes(grade) ? grade : null,
    hidden: bool(it.hidden) == null ? null : bool(it.hidden) ? 1 : 0, group_id: text(it.group, 100), sort: int(it.sort) ?? i,
  };
}

// ---------------------------------------------------------------- storage
const META = ['name', 'description', 'icon_url', 'icon_locked_url', 'rarity', 'points', 'grade', 'hidden', 'group_id', 'sort'];
// A read updates what the platform says now and never repeats a row. An unlock is kept even if a
// later reply says locked (a glitchy or partial reply must not take it back, like totals keep
// their high-water mark); only rows that really change are written. A row known from an import
// (source) is the platform's own once the platform names it.
const UPSERT = `INSERT INTO achievements(entry_id, ach_id, name, description, icon_url, icon_locked_url, unlocked, unlocked_at, rarity, points, grade, hidden, group_id, sort, first_seen_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(entry_id, ach_id) DO UPDATE SET
    ${META.map((c) => `${c} = COALESCE(excluded.${c}, ${c})`).join(', ')},
    unlocked = MAX(unlocked, excluded.unlocked), unlocked_at = COALESCE(excluded.unlocked_at, unlocked_at), updated_at = excluded.updated_at,
    source = CASE WHEN excluded.name IS NOT NULL THEN NULL ELSE source END
  WHERE ${META.map((c) => `COALESCE(excluded.${c}, ${c}) IS NOT ${c}`).join(' OR ')}
    OR MAX(unlocked, excluded.unlocked) IS NOT unlocked OR COALESCE(excluded.unlocked_at, unlocked_at) IS NOT unlocked_at
    OR (excluded.name IS NOT NULL AND source IS NOT NULL)`;

/** A name as compared across sources (case, spacing, quotes and trademark signs aside). */
export const nameKey = (v) => (text(v, 500) || '').toLowerCase().replace(/[‘’“”'"`™®©]/g, '').replace(/\s+/g, ' ').trim();
/** The trophy set an id is scoped to ('<npCommunicationId>:<trophyId>' -> '<npCommunicationId>:'), or null. */
const scopeOf = (id) => /^[^:]+:/.exec(id)?.[0] ?? null;

/**
 * Upsert one entry's achievements as a provider read them. Returns what changed:
 * { added, updated, newly_unlocked } (re-reading the same reply changes nothing).
 *
 * A row an import brought in under an id of its own (it knew no platform id) becomes the
 * platform's row of the same name, its unlock kept. complete = the reply listed every
 * achievement of the title: imported rows it knows by neither id nor name are dropped, so
 * nothing is listed twice (for PlayStation only in the trophy sets the reply covers).
 */
export function storeAchievements(db, entryId, items, { now = Date.now(), complete = false } = {}) {
  const rows = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach((it, i) => {
    const r = normalize(it, i);
    if (r && !seen.has(r.id)) { seen.add(r.id); rows.push(r); }
  });
  const out = { added: 0, updated: 0, newly_unlocked: 0 };
  if (!rows.length) return out;
  const before = new Map(db.prepare('SELECT ach_id, unlocked FROM achievements WHERE entry_id = ?').all(entryId).map((r) => [r.ach_id, r.unlocked]));
  const imported = db.prepare('SELECT id, ach_id, name FROM achievements WHERE entry_id = ? AND source IS NOT NULL ORDER BY sort, id').all(entryId).filter((g) => !seen.has(g.ach_id));
  if (imported.length) {
    const byName = new Map();
    for (const g of imported) {
      const k = nameKey(g.name);
      if (k) byName.set(k, [...(byName.get(k) || []), g]);
    }
    const rename = db.prepare('UPDATE achievements SET ach_id = ? WHERE id = ?');
    const taken = new Set();
    for (const r of rows) {
      if (before.has(r.id) || !r.name) continue;
      const list = byName.get(nameKey(r.name)) || [];
      // of several with that name, one of the same trophy set first
      const g = list.find((x) => !taken.has(x.id) && scopeOf(x.ach_id) === scopeOf(r.id)) || list.find((x) => !taken.has(x.id));
      if (!g) continue;
      taken.add(g.id);
      rename.run(r.id, g.id);
      before.set(r.id, before.get(g.ach_id));
      before.delete(g.ach_id);
    }
    if (complete) {
      const scopes = rows.every((r) => scopeOf(r.id)) ? new Set(rows.map((r) => scopeOf(r.id))) : null;
      const drop = db.prepare('DELETE FROM achievements WHERE id = ?');
      for (const g of imported) if (!taken.has(g.id) && (!scopes || scopes.has(scopeOf(g.ach_id)))) drop.run(g.id);
    }
  }
  const up = db.prepare(UPSERT);
  for (const r of rows) {
    const res = up.run(entryId, r.id, r.name, r.description, r.icon_url, r.icon_locked_url, r.unlocked, r.unlocked_at, r.rarity, r.points, r.grade, r.hidden, r.group_id, r.sort, now, now);
    if (!before.has(r.id)) out.added++;
    else if (res.changes) {
      out.updated++;
      if (!before.get(r.id) && r.unlocked) out.newly_unlocked++;
    }
  }
  return out;
}

/** What is stored for an entry, for providers deciding whether details must be read again (what only an import told counts as unknown). */
export function knownAchievements(db, entryId) {
  return db.prepare('SELECT ach_id, name IS NOT NULL AND source IS NULL named, icon_url IS NOT NULL AND source IS NULL iconed FROM achievements WHERE entry_id = ?').all(entryId);
}

const FILL = ['name', 'description', 'icon_url', 'icon_locked_url', 'rarity', 'points', 'grade', 'hidden', 'group_id'];
/**
 * Merge achievements an import (GameTrack) knows into one entry, filling gaps only: what the
 * platform reported wins (names, icons, rarity, its unlock times); the import adds unlocks,
 * unlock times the platform has none for and - for titles no account reads yet - the rows
 * themselves. An unlock is never taken back.
 *
 * Items are { id?, alt_ids?, fallback_id?, name, ..., unlocked, unlocked_at }. Each lands on the
 * stored row with its id (or one of alt_ids), else the one with its name, else a new row under
 * its id (fallback_id when it has none: a later platform read takes it over by name). Once the
 * platform has listed the title (`listed`), items it does not know are left out (unmatched):
 * they can only be another spelling of a row it has. Returns { added, matched, updated,
 * unmatched }; the same items again change nothing.
 */
export function importAchievements(db, entryId, items, { now = Date.now(), source = 'gametrack', listed = false } = {}) {
  const out = { added: 0, matched: 0, updated: 0, unmatched: 0 };
  const stored = db.prepare('SELECT id, ach_id, name, sort FROM achievements WHERE entry_id = ? ORDER BY sort, id').all(entryId);
  const byId = new Map(stored.map((r) => [r.ach_id, r]));
  const byName = new Map();
  for (const r of stored) {
    const k = nameKey(r.name);
    if (k) byName.set(k, [...(byName.get(k) || []), r]);
  }
  const taken = new Set();
  let sort = stored.reduce((m, r) => Math.max(m, r.sort ?? 0), -1) + 1;
  const ins = db.prepare(`INSERT INTO achievements(entry_id, ach_id, name, description, icon_url, icon_locked_url, unlocked, unlocked_at, rarity, points, grade, hidden, group_id, sort, first_seen_at, updated_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare(`UPDATE achievements SET ${FILL.map((c) => `${c} = COALESCE(${c}, ?)`).join(', ')},
      unlocked = MAX(unlocked, ?), unlocked_at = COALESCE(unlocked_at, ?), updated_at = ?
    WHERE id = ? AND (${FILL.map((c) => `(${c} IS NULL AND ? IS NOT NULL)`).join(' OR ')} OR unlocked < ? OR (unlocked_at IS NULL AND ? IS NOT NULL))`);
  const free = (r) => r && !taken.has(r.id);
  (Array.isArray(items) ? items : []).forEach((it, i) => {
    const r = normalize({ ...it, id: text(it?.id, 200) ?? it?.fallback_id }, i);
    if (!r) return;
    const ids = [text(it.id, 200), ...(it.alt_ids || []).map((x) => text(x, 200))].filter(Boolean);
    const row = ids.map((id) => byId.get(id)).find(free) || (byName.get(nameKey(r.name)) || []).find(free) || (free(byId.get(r.id)) ? byId.get(r.id) : null);
    if (row) {
      taken.add(row.id);
      out.matched++;
      const vals = FILL.map((c) => r[c]);
      if (upd.run(...vals, r.unlocked, r.unlocked_at, now, row.id, ...vals, r.unlocked, r.unlocked_at).changes) out.updated++;
      return;
    }
    if (listed || byId.has(r.id)) { out.unmatched++; return; }
    const id = Number(ins.run(entryId, r.id, r.name, r.description, r.icon_url, r.icon_locked_url, r.unlocked, r.unlocked_at, r.rarity, r.points, r.grade, r.hidden, r.group_id, sort++, now, now, source).lastInsertRowid);
    byId.set(r.id, { id, ach_id: r.id, name: r.name });
    taken.add(id);
    out.added++;
  });
  return out;
}

// ---------------------------------------------------------------- summaries
const pct = (n, total) => (total ? Math.floor((n * 1000) / total) / 10 : 0);
const SUMMARY = `SELECT a.entry_id, COUNT(*) total, SUM(a.unlocked) unlocked,
    SUM(a.points) points_total, SUM(CASE WHEN a.unlocked = 1 THEN a.points ELSE 0 END) points,
    MAX(CASE WHEN a.unlocked = 1 THEN a.unlocked_at END) last_unlocked_at,
    MIN(CASE WHEN a.unlocked = 1 AND a.grade = 'platinum' THEN COALESCE(a.unlocked_at, 0) END) platinum_at,
    COUNT(a.grade) graded,
    ${GRADES.map((g) => `SUM(CASE WHEN a.unlocked = 1 AND a.grade = '${g}' THEN 1 ELSE 0 END) g_${g}`).join(', ')}
  FROM achievements a`;

/**
 * One entry's summary from its aggregate row:
 * { total, unlocked, percent, points, points_total, grades, last_unlocked_at, completed, completed_at, fetched_at }
 * completed = everything unlocked, or (PlayStation) the platinum earned; completed_at = the
 * earlier of the two moments. points (Xbox) and grades (PlayStation) are null where the platform
 * has none. reported: how many the platform says the title has (Xbox lists are read page by
 * page), when more than what is stored.
 */
export function summaryOf(r, fetchedAt = null, reported = null) {
  const total = Math.max(r?.total || 0, reported || 0);
  const unlocked = r?.unlocked || 0;
  const platinum = r?.platinum_at != null;
  const all = total > 0 && unlocked >= total;
  const moments = [all ? r.last_unlocked_at : null, platinum && r.platinum_at > 0 ? r.platinum_at : null].filter((t) => t != null);
  return {
    total,
    unlocked,
    percent: pct(unlocked, total),
    points: r?.points_total != null ? r.points || 0 : null,
    points_total: r?.points_total ?? null,
    grades: r?.graded ? Object.fromEntries(GRADES.map((g) => [g, r[`g_${g}`] || 0])) : null,
    last_unlocked_at: r?.last_unlocked_at ?? null,
    completed: all || platinum,
    completed_at: moments.length ? Math.min(...moments) : null,
    fetched_at: fetchedAt ?? null,
  };
}

/**
 * Summaries for entries (rows with id, ach_v, ach_at, ach_total): Map(entry id -> summary | null). null =
 * never read (or the platform has no achievements); a read title without any is all zeros.
 */
export function entrySummaries(db, entries) {
  const list = [...entries];
  if (!list.length) return new Map();
  const rows = new Map(db.prepare(`${SUMMARY} WHERE a.entry_id IN (SELECT value FROM json_each(?)) GROUP BY a.entry_id`).all(JSON.stringify(list.map((e) => e.id))).map((r) => [r.entry_id, r]));
  return new Map(list.map((e) => [e.id, rows.has(e.id) || e.ach_v > 0 ? summaryOf(rows.get(e.id), e.ach_at ?? null, e.ach_total ?? null) : null]));
}

/** Several entries' summaries as one (a game): counts add up, completed when any entry is. */
export function combineSummaries(summaries) {
  const xs = summaries.filter(Boolean);
  if (!xs.length) return null;
  const add = (list, k) => list.reduce((a, s) => a + (s[k] || 0), 0);
  const total = add(xs, 'total');
  const unlocked = add(xs, 'unlocked');
  const scored = xs.filter((s) => s.points_total != null);
  const graded = xs.filter((s) => s.grades);
  const latest = (k) => xs.reduce((m, s) => (s[k] != null && (m == null || s[k] > m) ? s[k] : m), null);
  const done = xs.filter((s) => s.completed_at != null).map((s) => s.completed_at);
  return {
    total,
    unlocked,
    percent: pct(unlocked, total),
    points: scored.length ? add(scored, 'points') : null,
    points_total: scored.length ? add(scored, 'points_total') : null,
    grades: graded.length ? Object.fromEntries(GRADES.map((g) => [g, graded.reduce((a, s) => a + s.grades[g], 0)])) : null,
    last_unlocked_at: latest('last_unlocked_at'),
    completed: xs.some((s) => s.completed),
    completed_at: done.length ? Math.min(...done) : null,
    fetched_at: latest('fetched_at'),
  };
}

/** A stored row as the API shows it. */
export function itemOf(r) {
  return {
    id: r.ach_id, entry_id: r.entry_id, platform: r.platform ?? null,
    name: r.name ?? null, description: r.description ?? null, icon_url: r.icon_url ?? null, icon_locked_url: r.icon_locked_url ?? null,
    unlocked: !!r.unlocked, unlocked_at: r.unlocked_at ?? null,
    rarity: r.rarity ?? null, points: r.points ?? null, grade: r.grade ?? null, hidden: r.hidden == null ? null : !!r.hidden, group: r.group_id ?? null,
  };
}

// ---------------------------------------------------------------- which session an unlock belongs to
function lowerBound(list, t) { // first index with a > t
  let lo = 0; let hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].a <= t) lo = m + 1; else hi = m; }
  return lo;
}

/** The session of `list` (sorted by start) holding t, by preference; null when none. */
function pick(list, maxLen, t, slack, better) {
  let best = null;
  for (let i = lowerBound(list, t) - 1; i >= 0 && list[i].a >= t - maxLen - slack; i--) {
    const s = list[i];
    if (t > s.b + slack) continue;
    if (!best || better(s, best, t)) best = s;
  }
  return best;
}
/** Of two sessions holding an unlock: the narrowest, then the latest. */
const betterHistory = (x, y) => (x.b - x.a !== y.b - y.a ? x.b - x.a < y.b - y.a : x.a > y.a);
/** Of two tracked sessions: exact times first, then one holding the unlock without the slack. */
function betterTracked(x, y, t) {
  if (x.precise !== y.precise) return x.precise;
  if ((t <= x.b) !== (t <= y.b)) return t <= x.b;
  return betterHistory(x, y);
}

/**
 * The session each unlocked row (entry_id, unlocked_at, id) belongs to:
 * Map(row id -> { session: { id, started_at, ended_at, precise }, kind: 'tracked' | 'history' }).
 * started_at / ended_at are the session's exact times, or its window when it has none
 * (precise = false). Rows without an unlock time belong to none.
 */
export function ownersOf(db, rows) {
  const byEntry = new Map();
  for (const r of rows) {
    if (!r.unlocked || r.unlocked_at == null) continue;
    let e = byEntry.get(r.entry_id);
    if (!e) byEntry.set(r.entry_id, (e = { lo: Infinity, hi: -Infinity, rows: [] }));
    e.lo = Math.min(e.lo, r.unlocked_at);
    e.hi = Math.max(e.hi, r.unlocked_at);
    e.rows.push(r);
  }
  const out = new Map();
  if (!byEntry.size) return out;
  // sessions of those entries that can hold any of the unlocks (CROSS JOIN: the list drives the
  // lookups on the entry, kind, sort_time index - never a scan of every session)
  const ranges = [...byEntry].map(([id, e]) => [id, e.lo - ACH_SLACK, e.hi]);
  const sessions = db.prepare(`SELECT s.id, s.entry_id, s.kind, s.minutes, s.started_at, s.ended_at, s.window_start, s.window_end, s.created_at
    FROM json_each(?) j CROSS JOIN sessions s ON s.entry_id = json_extract(j.value, '$[0]')
    WHERE s.kind IN ('play', 'estimate') AND s.sort_time >= json_extract(j.value, '$[1]')
      AND MIN(COALESCE(s.window_start, s.sort_time), COALESCE(s.started_at, s.sort_time), s.sort_time - s.minutes * 60000) <= json_extract(j.value, '$[2]')`).all(JSON.stringify(ranges));
  const lists = new Map();
  for (const s of sessions) {
    const [a, b] = sessionInterval(s);
    const k = `${s.entry_id}:${s.kind}`;
    if (!lists.has(k)) lists.set(k, { list: [], maxLen: 0 });
    const l = lists.get(k);
    l.list.push({ id: s.id, a, b, precise: !!(s.started_at && s.ended_at) });
    l.maxLen = Math.max(l.maxLen, b - a);
  }
  for (const l of lists.values()) l.list.sort((x, y) => x.a - y.a);
  const none = { list: [], maxLen: 0 };
  for (const [entryId, e] of byEntry) {
    const play = lists.get(`${entryId}:play`) || none;
    const est = lists.get(`${entryId}:estimate`) || none;
    for (const r of e.rows) {
      const t = r.unlocked_at;
      const s = pick(play.list, play.maxLen, t, ACH_SLACK, betterTracked);
      const h = s ? null : pick(est.list, est.maxLen, t, 0, betterHistory);
      const o = s || h;
      if (o) out.set(r.id, { session: { id: o.id, started_at: o.a, ended_at: o.b, precise: o.precise }, kind: s ? 'tracked' : 'history' });
    }
  }
  return out;
}

const SESSION_ITEMS = 5;
/**
 * Achievements unlocked during each of a page of sessions (rows of SELECT s.* ...), in two
 * queries for the whole page: Map(session id -> { count, items }). items: the first ones in
 * unlock order (`limit`, all when null), each { id, entry_id, name, icon_url, rarity, points, grade, unlocked_at }.
 */
export function sessionAchievements(db, sessions, { limit = SESSION_ITEMS } = {}) {
  const ranges = new Map();
  for (const s of sessions) {
    if (s.kind !== 'play' && s.kind !== 'estimate') continue;
    const [a, b] = sessionInterval(s);
    const r = ranges.get(s.entry_id);
    ranges.set(s.entry_id, r ? [Math.min(r[0], a), Math.max(r[1], b + ACH_SLACK)] : [a, b + ACH_SLACK]);
  }
  const out = new Map();
  if (!ranges.size) return out;
  const rows = db.prepare(`SELECT a.* FROM json_each(?) j CROSS JOIN achievements a ON a.entry_id = json_extract(j.value, '$[0]')
    AND a.unlocked_at BETWEEN json_extract(j.value, '$[1]') AND json_extract(j.value, '$[2]')
    WHERE a.unlocked = 1 ORDER BY a.unlocked_at, a.sort, a.id`).all(JSON.stringify([...ranges].map(([id, [a, b]]) => [id, a, b])));
  const owners = ownersOf(db, rows);
  const page = new Set(sessions.map((s) => s.id));
  for (const r of rows) {
    const o = owners.get(r.id);
    if (!o || !page.has(o.session.id)) continue;
    if (!out.has(o.session.id)) out.set(o.session.id, { count: 0, items: [] });
    const x = out.get(o.session.id);
    x.count++;
    if (limit == null || x.items.length < limit) {
      x.items.push({ id: r.ach_id, entry_id: r.entry_id, name: r.name ?? null, icon_url: r.icon_url ?? null, rarity: r.rarity ?? null, points: r.points ?? null, grade: r.grade ?? null, unlocked_at: r.unlocked_at });
    }
  }
  return out;
}

/** Session rows (API shape) with `achievements: { count, items }` added. */
export function withSessionAchievements(db, rows, opts) {
  const map = sessionAchievements(db, rows, opts);
  return rows.map((s) => ({ ...s, achievements: map.get(s.id) || { count: 0, items: [] } }));
}

// ---------------------------------------------------------------- reads for the API
/**
 * A game's achievements: per-entry summaries, the game's summary (entries not excluded) and the
 * full list - unlocked first, newest first (unlocks without a time after them), then locked in
 * the platform's order - each with the session it belongs to.
 */
export function gameAchievements(db, gameId, { entryId = null, state = 'all' } = {}) {
  const ent = entryId ? 'AND e.id = ?' : '';
  const args = entryId ? [gameId, entryId] : [gameId];
  const entries = db.prepare(`SELECT e.id, e.platform, e.account_id, ac.name account_name, e.title, e.excluded, e.ach_v, e.ach_at, e.ach_total
    FROM entries e LEFT JOIN accounts ac ON ac.id = e.account_id WHERE e.game_id = ? ${ent} ORDER BY e.id`).all(...args);
  const sums = entrySummaries(db, entries);
  const st = state === 'unlocked' ? 'AND a.unlocked = 1' : state === 'locked' ? 'AND a.unlocked = 0' : '';
  const rows = db.prepare(`SELECT a.*, e.platform FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.game_id = ? ${ent} ${st}
    ORDER BY a.unlocked DESC, (a.unlocked = 1 AND a.unlocked_at IS NULL), a.unlocked_at DESC, a.entry_id, a.sort, a.id`).all(...args);
  const owners = ownersOf(db, rows);
  return {
    game_id: gameId,
    summary: combineSummaries(entries.filter((e) => !e.excluded).map((e) => sums.get(e.id))),
    entries: entries.map((e) => ({ entry_id: e.id, platform: e.platform, account_id: e.account_id, account_name: e.account_name ?? null, title: e.title, excluded: !!e.excluded, achievements: sums.get(e.id) })),
    total: rows.length,
    items: rows.map((r) => {
      const o = owners.get(r.id);
      return { ...itemOf(r), session: o?.session ?? null, session_kind: o?.kind ?? null };
    }),
  };
}

// completion buckets (percent unlocked): 0, under 25, under 50, under 75, under 100, 100
const BUCKETS = [[0, 0, '0%'], [0.1, 24.9, '1-24%'], [25, 49.9, '25-49%'], [50, 74.9, '50-74%'], [75, 99.9, '75-99%'], [100, 100, '100%']];
const bucketOf = (p) => (p <= 0 ? 0 : p >= 100 ? 5 : p < 25 ? 1 : p < 50 ? 2 : p < 75 ? 3 : 4);

/**
 * Achievement stats for a range: unlocks (and gamerscore) per group of the range, the rarest
 * unlocks, games completed in it, all-time totals and how complete the played games are.
 */
export function achievementStats(db, { range = '30d', group, platform = null, weekStartsOn = 1, now = Date.now(), limit = 10 } = {}) {
  return memo(db, `ach-stats:${range}:${group}:${platform}:${weekStartsOn}:${limit}`, () => {
    let { from, to, label } = resolveRange(range, now, weekStartsOn);
    const pf = platform ? 'AND e.platform = ?' : '';
    const pa = platform ? [platform] : [];
    const base = `FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.excluded = 0 ${pf}`;
    if (from === 0) {
      const first = db.prepare(`SELECT MIN(a.unlocked_at) t ${base} AND a.unlocked = 1 AND a.unlocked_at IS NOT NULL`).get(...pa).t;
      const d = new Date(first ?? now); d.setHours(0, 0, 0, 0);
      from = d.getTime();
    }
    const g = groupFor(Math.max(1, (to - from) / DAY), group);
    const series = new Map(emptySeries(from, to, g, weekStartsOn).map((k) => [k, { key: k, unlocked: 0, points: 0 }]));
    const grades = Object.fromEntries(GRADES.map((x) => [x, 0]));
    let unlocked = 0;
    let points = 0;
    for (const r of db.prepare(`SELECT a.unlocked_at t, a.points, a.grade ${base} AND a.unlocked = 1 AND a.unlocked_at BETWEEN ? AND ?`).iterate(...pa, from, to)) {
      const d = new Date(r.t); d.setHours(0, 0, 0, 0);
      const k = groupKey(d.getTime(), g, weekStartsOn);
      const bucket = series.get(k) || series.set(k, { key: k, unlocked: 0, points: 0 }).get(k);
      bucket.unlocked++;
      bucket.points += r.points || 0;
      unlocked++;
      points += r.points || 0;
      if (r.grade in grades) grades[r.grade]++;
    }
    const rarest = db.prepare(`SELECT a.*, e.platform, e.game_id, gm.title, gm.cover_url FROM achievements a JOIN entries e ON e.id = a.entry_id JOIN games gm ON gm.id = e.game_id
      WHERE e.excluded = 0 ${pf} AND a.unlocked = 1 AND a.unlocked_at BETWEEN ? AND ? AND a.rarity IS NOT NULL ORDER BY a.rarity, a.unlocked_at DESC, a.id LIMIT ?`).all(...pa, from, to, limit)
      .map((r) => ({ ...itemOf(r), game_id: r.game_id, title: r.title, cover_url: r.cover_url ?? null }));

    // per entry: completion, all-time totals, games completed in the range
    const per = db.prepare(`SELECT s.*, e.game_id, e.platform, e.ach_at, e.ach_total, gm.title, gm.cover_url, ${PLAYED_SQL.replace(/(playtime_min|last_played_at)/g, 'e.$1')} played
      FROM (${SUMMARY} GROUP BY a.entry_id) s JOIN entries e ON e.id = s.entry_id JOIN games gm ON gm.id = e.game_id WHERE e.excluded = 0 ${pf}`).all(...pa);
    const totals = { unlocked: 0, total: 0, percent: 0, points: 0, points_total: 0, grades: Object.fromEntries(GRADES.map((x) => [x, 0])), entries: 0, completed: 0 };
    const buckets = BUCKETS.map(([min, max, lbl]) => ({ label: lbl, min, max, count: 0 }));
    const completed = [];
    let pctSum = 0;
    let played = 0;
    for (const r of per) {
      const s = summaryOf(r, r.ach_at, r.ach_total);
      totals.unlocked += s.unlocked;
      totals.total += s.total;
      totals.points += s.points || 0;
      totals.points_total += s.points_total || 0;
      if (s.grades) for (const x of GRADES) totals.grades[x] += s.grades[x];
      if (s.total) totals.entries++;
      if (s.completed) totals.completed++;
      if (s.completed && s.completed_at != null && s.completed_at >= from && s.completed_at <= to) {
        completed.push({ entry_id: r.entry_id, game_id: r.game_id, title: r.title, cover_url: r.cover_url ?? null, platform: r.platform, total: s.total, unlocked: s.unlocked, platinum: r.platinum_at != null, completed_at: s.completed_at });
      }
      if (!s.total || !r.played) continue;
      played++;
      pctSum += s.percent;
      buckets[bucketOf(s.percent)].count++;
    }
    totals.percent = pct(totals.unlocked, totals.total);
    completed.sort((a, b) => b.completed_at - a.completed_at || a.entry_id - b.entry_id);
    return {
      range: { from, to, label, group: g },
      unlocked,
      points,
      grades,
      series: [...series.values()],
      rarest,
      completed: completed.slice(0, limit),
      completed_count: completed.length,
      totals,
      completion: { entries: played, average_percent: played ? Math.round((pctSum / played) * 10) / 10 : 0, buckets },
    };
  });
}

/** Diagnostics for one account: how far reading achievements has got. */
export function achievementProgress(db, accountId) {
  const e = db.prepare(`SELECT COUNT(*) titles, COALESCE(SUM(ach_v >= ?), 0) done, COALESCE(SUM(ach_v < ?), 0) pending,
      COALESCE(SUM(ach_v < ? AND ${HISTORY_PENDING_SQL}), 0) with_history, COALESCE(SUM(ach_v >= ? AND ${PLAYED_SINCE_SQL}), 0) played_since, MAX(ach_at) last_read_at
    FROM entries WHERE account_id = ? AND ${PLAYED_SQL}`).get(ACH_VERSION, ACH_VERSION, ACH_VERSION, ACH_VERSION, accountId);
  const a = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(a.unlocked), 0) u FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.account_id = ?').get(accountId);
  return {
    titles: e.titles, done: e.done, pending: e.pending,
    // of the pending ones: read by the history enrichment (the rest by the one-time back-fill)
    pending_with_history: e.with_history,
    // read already, played since: read again after the next sync
    refresh_due: e.played_since,
    achievements: a.n, unlocked: a.u, last_read_at: e.last_read_at ?? null, version: ACH_VERSION,
  };
}

// ---------------------------------------------------------------- shared platform data cache
/** Bounded cache with expiry, for platform data every account shares (Steam schemas, rarity). */
export class TtlCache {
  constructor(max = 500) { this.max = max; this.map = new Map(); }
  get(k, now = Date.now()) {
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k);
    if (e.until <= now) return undefined;
    this.map.set(k, e); // most recently used last
    return e;
  }
  set(k, value, ttlMs, now = Date.now()) {
    this.map.delete(k);
    this.map.set(k, { value, until: now + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

/**
 * fn() through `cache` for ttlMs. A failed request is remembered as null for an hour (not asked
 * again at once); one fn() skipped without asking (an error with `skipped`) is not remembered.
 */
export async function cached(cache, key, ttlMs, fn) {
  const hit = cache?.get(key);
  if (hit) return hit.value;
  try {
    const v = await fn();
    cache?.set(key, v, ttlMs);
    return v;
  } catch (err) {
    if (!err?.skipped) cache?.set(key, null, HOUR);
    return null;
  }
}
