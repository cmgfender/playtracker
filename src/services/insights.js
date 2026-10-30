// Richer stats for charts: punchcard, session lengths, platform / device stacks, "when did I
// play what" timelines, a game's curve, the library overview, year over year and records.
//
// Same rules as stats.js: everything is read from the per-day / per-hour rollups (play_days /
// play_hours) or from indexed aggregates over sessions / entries, never by re-spreading
// sessions, and every answer is memoized until the next write. Local days follow the server
// timezone (TZ), weeks the week_starts_on setting.
//
// Tracked play and estimated (pre-tracking) history are always reported apart, so clients can
// draw history differently (hatched). `estimates` (include | exclude | only) filters them as it
// does on /stats. Time-of-play views (punchcard, session lengths, day / week / streak records)
// use tracked play only: history is spread evenly over a window, so it has no real time of day,
// session lengths or day totals. Excluded entries never count.

import { HttpError, fmtMinutes } from '../util.js';
import { memo, resolveRange, groupFor, groupKey, emptySeries, filter, dayKey, parseDay, startOfDay, nextDay, dailyTotals, computeStreaks } from './stats.js';

const DAY = 86_400_000;
const r = (x) => Math.round(x);
// play_days.basis, by index (see migration 10)
const BASES = ['tracked', 'imported', 'anchored', 'confirmed', 'estimated'];
const zeros = (n) => Array(n).fill(0);

export const STATUSES = ['unset', 'backlog', 'playing', 'paused', 'completed', 'beaten', 'dropped', 'wishlist'];
// a tracked session with real start and end times (not a sync window)
const EXACT = '(s.started_at IS NOT NULL AND s.ended_at > s.started_at)';

/** The range as /stats resolves it; "all" starts on the first day with matching play. */
function period(db, { range, now, weekStartsOn, gameId, platform, estimates = 'include' }) {
  let { from, to, label } = resolveRange(range, now, weekStartsOn);
  if (from === 0) {
    const f = filter('p', { gameId, platform, estimates });
    const first = db.prepare(`SELECT MIN(p.day) d ${f.sql}`).get(...f.args).d;
    from = startOfDay(first ? parseDay(first) : now);
  }
  return { from, to, label, span: Math.max(1, (to - from) / DAY), fromDay: dayKey(from), toDay: dayKey(to) };
}

/** id -> { title, cover_url } for a handful of games. */
function gameInfo(db, ids) {
  if (!ids.length) return new Map();
  return new Map(db.prepare('SELECT id, title, cover_url FROM games WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids))
    .map((g) => [g.id, { title: g.title, cover_url: g.cover_url ?? null }]));
}

// per-game aggregates over long ranges: walking the game index saves sorting every row
const perGameSql = (f, p) => (p.span > 365 ? f.sql.replace('FROM play_days p ', 'FROM play_days p INDEXED BY play_days_game ') : f.sql);

/** Per period: the most played game (ties: lower id) and the period's total, from (k, game_id, m, e) rows. */
function leaders(rows) {
  const by = new Map();
  for (const x of rows) {
    let b = by.get(x.k);
    if (!b) by.set(x.k, b = { k: x.k, total: 0, best: null });
    b.total += x.m;
    if (!b.best || x.m > b.best.m || (x.m === b.best.m && x.game_id < b.best.game_id)) b.best = x;
  }
  return [...by.values()].filter((b) => b.best.m >= 0.5).sort((a, b) => (a.k < b.k ? -1 : 1))
    .map((b) => ({ k: b.k, game_id: b.best.game_id, m: b.best.m, e: b.best.e, total: b.total }));
}

/** Per game totals (most played first, ties: lower id) from (game_id, m, e, ...) rows. */
function perGame(rows) {
  const by = new Map();
  for (const x of rows) {
    let g = by.get(x.game_id);
    if (!g) by.set(x.game_id, g = { game_id: x.game_id, m: 0, e: 0, first: x.first, last: x.last });
    g.m += x.m; g.e += x.e;
    if (x.first < g.first) g.first = x.first;
    if (x.last > g.last) g.last = x.last;
  }
  return [...by.values()].sort((a, b) => b.m - a.m || a.game_id - b.game_id);
}
const share = (m, total) => (total ? Math.round((m / total) * 1000) / 1000 : 0);

const keyIndex = (keys) => new Map(keys.map((k, i) => [k, i]));
/** Cached day -> group key (many rows share a day). */
function keyer(g, weekStartsOn) {
  const cache = new Map();
  return (day) => {
    let k = cache.get(day);
    if (k === undefined) { k = groupKey(parseDay(day), g, weekStartsOn); cache.set(day, k); }
    return k;
  };
}

// ---------------------------------------------------------------- tracked play sessions in a range
function sessionWhere(p, { gameId, platform, exact }) {
  const where = ["s.kind = 'play'", 's.minutes > 0', 'e.excluded = 0', 's.sort_time >= ?', 's.sort_time <= ?'];
  const args = [p.from, p.to];
  if (gameId) { where.push('e.game_id = ?'); args.push(gameId); }
  if (platform) { where.push('e.platform = ?'); args.push(platform); }
  if (exact) where.push(EXACT);
  return { where: where.join(' AND '), args };
}

function sessionRef(s) {
  if (!s) return null;
  const precise = !!(s.started_at && s.ended_at && s.ended_at > s.started_at);
  return {
    session_id: s.id, minutes: s.minutes, game_id: s.game_id, title: s.title, cover_url: s.cover_url ?? null, platform: s.platform,
    // day: the local day it ended in (an end at exactly midnight belongs to the day before)
    started_at: precise ? s.started_at : null, ended_at: s.sort_time, day: dayKey(s.sort_time - 1), precise,
  };
}
const SESSION_REF = 'SELECT s.id, s.minutes, s.started_at, s.ended_at, s.sort_time, e.game_id, e.platform, g.title, g.cover_url FROM sessions s JOIN entries e ON e.id = s.entry_id JOIN games g ON g.id = e.game_id';

/** The longest tracked session (the first to reach that length on a tie). */
function longestSession(db, p, opts) {
  const w = sessionWhere(p, opts);
  const max = db.prepare(`SELECT MAX(s.minutes) m FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE ${w.where}`).get(...w.args).m;
  if (!max) return null;
  return sessionRef(db.prepare(`${SESSION_REF} WHERE ${w.where} AND s.minutes = ? ORDER BY s.sort_time, s.id LIMIT 1`).get(...w.args, max));
}

// =====================================================================================
// 1. punchcard: weekday x hour of day
// =====================================================================================
export function punchcard(db, { range = '30d', gameId = null, platform = null, weekStartsOn = 1, now = Date.now() } = {}) {
  return memo(db, `punch:${range}:${gameId}:${platform}:${weekStartsOn}`, () => {
    const p = period(db, { range, now, weekStartsOn, gameId, platform, estimates: 'exclude' });
    const q = { fromDay: p.fromDay, toDay: p.toDay, gameId, platform, estimates: 'exclude' };
    const fh = filter('h', q);
    const grid = Array.from({ length: 7 }, () => zeros(24));
    // day is a local calendar date, so SQLite's weekday of it is the local weekday (0 = Sunday)
    for (const row of db.prepare(`SELECT CAST(strftime('%w', h.day) AS INTEGER) w, h.hour, SUM(h.minutes) m ${fh.sql} GROUP BY w, h.hour`).iterate(...fh.args)) grid[row.w][row.hour] += row.m;
    const fp = filter('p', q);
    const tracked = db.prepare(`SELECT COALESCE(SUM(p.minutes), 0) m ${fp.sql}`).get(...fp.args).m;
    const weekday = grid.map((row) => row.reduce((a, b) => a + b, 0));
    const hours = zeros(24).map((_, h) => grid.reduce((a, row) => a + row[h], 0));
    const timed = weekday.reduce((a, b) => a + b, 0);
    const days = zeros(7);
    for (let d = p.from; d <= p.to; d = nextDay(d)) days[new Date(d).getDay()]++;
    // busiest: scanned in week order from the configured first day, so ties go to the earlier one
    let busiest = null;
    for (let i = 0; i < 7; i++) {
      const w = (weekStartsOn + i) % 7;
      for (let h = 0; h < 24; h++) if (grid[w][h] >= 0.5 && (!busiest || grid[w][h] > busiest.m)) busiest = { weekday: w, hour: h, m: grid[w][h] };
    }
    const top = (arr, name) => {
      let best = null;
      arr.forEach((m, i) => { if (m >= 0.5 && (!best || m > best.m)) best = { [name]: i, m }; });
      return best && { [name]: best[name], minutes: r(best.m) };
    };
    return {
      range: { from: p.from, to: p.to, label: p.label },
      estimates: 'exclude',
      week_starts_on: weekStartsOn,
      minutes: grid.map((row) => row.map(r)),
      weekday: weekday.map(r),
      hours: hours.map(r),
      days,
      total_minutes: r(timed),
      tracked_minutes: r(tracked),
      untimed_minutes: r(Math.max(0, tracked - timed)),
      busiest: busiest && { weekday: busiest.weekday, hour: busiest.hour, minutes: r(busiest.m) },
      busiest_weekday: top(weekday, 'weekday'),
      busiest_hour: top(hours, 'hour'),
    };
  });
}

// =====================================================================================
// 2. session lengths
// =====================================================================================
export const LENGTH_BUCKETS = [[0, 15, '<15m'], [15, 30, '15-30m'], [30, 60, '30-60m'], [60, 120, '1-2h'], [120, 180, '2-3h'], [180, 300, '3-5h'], [300, null, '5h+']];

export function sessionLengths(db, { range = '30d', gameId = null, platform = null, exact = false, weekStartsOn = 1, now = Date.now() } = {}) {
  return memo(db, `lengths:${range}:${gameId}:${platform}:${exact}:${weekStartsOn}`, () => {
    const p = period(db, { range, now, weekStartsOn, gameId, platform, estimates: 'exclude' });
    const w = sessionWhere(p, { gameId, platform, exact });
    // one row per distinct length: exact percentiles without fetching every session
    const freq = db.prepare(`SELECT s.minutes m, COUNT(*) n, SUM(CASE WHEN ${EXACT} THEN 1 ELSE 0 END) x
      FROM sessions s ${!gameId && p.span <= 120 ? 'INDEXED BY sessions_kind_time' : ''} JOIN entries e ON e.id = s.entry_id WHERE ${w.where} GROUP BY s.minutes ORDER BY s.minutes`).all(...w.args);
    const buckets = LENGTH_BUCKETS.map(([min, max, label]) => ({ label, min, max, count: 0, minutes: 0 }));
    let n = 0; let total = 0; let exactN = 0;
    for (const f of freq) {
      const b = buckets.find((x) => f.m >= x.min && (x.max == null || f.m < x.max));
      b.count += f.n; b.minutes += f.m * f.n;
      n += f.n; total += f.m * f.n; exactN += f.x;
    }
    const at = (rank) => { let c = 0; for (const f of freq) { c += f.n; if (c >= rank) return f.m; } return null; };
    return {
      range: { from: p.from, to: p.to, label: p.label },
      estimates: 'exclude',
      exact_only: !!exact,
      sessions: n,
      exact_sessions: exactN,
      total_minutes: total,
      mean_minutes: n ? r(total / n) : 0,
      median_minutes: n ? (n % 2 ? at((n + 1) / 2) : (at(n / 2) + at(n / 2 + 1)) / 2) : null,
      p90_minutes: n ? at(Math.ceil(0.9 * n)) : null,
      buckets,
      longest: n ? sessionRef(db.prepare(`${SESSION_REF} WHERE ${w.where} AND s.minutes = ? ORDER BY s.sort_time, s.id LIMIT 1`).get(...w.args, freq.at(-1).m)) : null,
    };
  });
}

// =====================================================================================
// 3. platforms / devices over time
// =====================================================================================
export function platformSeries(db, { range = '30d', group, by = 'platform', gameId = null, platform = null, estimates = 'include', weekStartsOn = 1, now = Date.now() } = {}) {
  return memo(db, `plat-series:${range}:${group}:${by}:${gameId}:${platform}:${estimates}:${weekStartsOn}`, () => {
    const p = period(db, { range, now, weekStartsOn, gameId, platform, estimates });
    const g = groupFor(p.span, group);
    const keys = emptySeries(p.from, p.to, g, weekStartsOn);
    const idx = keyIndex(keys);
    const key = keyer(g, weekStartsOn);
    const f = filter('p', { fromDay: p.fromDay, toDay: p.toDay, gameId, platform, estimates });
    // devices are kept per session (the rollups carry the platform only); history has none, so
    // only tracked rows look theirs up and estimated minutes go to the "no device" series
    const sql = by === 'device'
      ? `SELECT p.day, CASE WHEN p.estimated = 0 THEN (SELECT s.device FROM sessions s WHERE s.id = p.session_id) END k, p.estimated, SUM(p.minutes) m ${f.sql} GROUP BY p.day, k, p.estimated`
      : `SELECT p.day, p.platform k, p.estimated, SUM(p.minutes) m ${f.sql} GROUP BY p.day, k, p.estimated`;
    const per = new Map();
    const totals = { tracked: zeros(keys.length), estimated: zeros(keys.length) };
    for (const row of db.prepare(sql).iterate(...f.args)) {
      const i = idx.get(key(row.day));
      if (i === undefined) continue;
      const name = row.k ?? null;
      let s = per.get(name);
      if (!s) per.set(name, s = { name, minutes: 0, tracked_minutes: 0, estimated_minutes: 0, tracked: zeros(keys.length), estimated: zeros(keys.length) });
      const part = row.estimated ? 'estimated' : 'tracked';
      s[part][i] += row.m; s[`${part}_minutes`] += row.m; s.minutes += row.m;
      totals[part][i] += row.m;
    }
    const series = [...per.values()].sort((a, b) => b.minutes - a.minutes || String(a.name).localeCompare(String(b.name)))
      .map((s) => ({ name: s.name, minutes: r(s.minutes), tracked_minutes: r(s.tracked_minutes), estimated_minutes: r(s.estimated_minutes), tracked: s.tracked.map(r), estimated: s.estimated.map(r) }));
    return {
      range: { from: p.from, to: p.to, label: p.label, group: g },
      by,
      estimates,
      keys,
      series,
      totals: { tracked: totals.tracked.map(r), estimated: totals.estimated.map(r) },
    };
  });
}

// =====================================================================================
// 4. timeline: top games per bucket (swimlanes) + the most played game per month (eras)
// =====================================================================================
export function timeline(db, { range = '365d', group, limit = 10, platform = null, estimates = 'include', weekStartsOn = 1, now = Date.now() } = {}) {
  return memo(db, `timeline:${range}:${group}:${limit}:${platform}:${estimates}:${weekStartsOn}`, () => {
    const p = period(db, { range, now, weekStartsOn, platform, estimates });
    const g = ['day', 'week', 'month', 'year'].includes(group) ? group : (p.span <= 200 ? 'week' : 'month');
    const keys = emptySeries(p.from, p.to, g, weekStartsOn);
    const idx = keyIndex(keys);
    const key = keyer(g, weekStartsOn);
    const f = filter('p', { fromDay: p.fromDay, toDay: p.toDay, platform, estimates });
    // one pass per (game, calendar month): the top games, how many were played, and each month's leader
    const gm = db.prepare(`SELECT p.game_id, substr(p.day, 1, 7) k, SUM(p.minutes) m, SUM(p.minutes * p.estimated) e, MIN(p.day) first, MAX(p.day) last
      ${perGameSql(f, p)} GROUP BY p.game_id, k`).all(...f.args);
    const games = perGame(gm);
    const top = games.slice(0, limit);
    const ids = top.map((t) => t.game_id);
    const lanes = new Map(top.map((t) => [t.game_id, { tracked: zeros(keys.length), estimated: zeros(keys.length) }]));
    if (ids.length) {
      // a few games: seek each one in the game index, its rows already in (estimated, day) order
      const lane = `SELECT p.day, p.game_id, p.estimated, SUM(p.minutes) m ${f.sql.replace('FROM play_days p ', 'FROM play_days p INDEXED BY play_days_game ')} AND p.game_id IN (SELECT value FROM json_each(?)) GROUP BY p.game_id, p.estimated, p.day`;
      for (const row of db.prepare(lane).iterate(...f.args, JSON.stringify(ids))) {
        const i = idx.get(key(row.day));
        if (i !== undefined) lanes.get(row.game_id)[row.estimated ? 'estimated' : 'tracked'][i] += row.m;
      }
    }
    // everything else, per bucket (totals minus the lanes)
    const others = { tracked: zeros(keys.length), estimated: zeros(keys.length) };
    for (const row of db.prepare(`SELECT p.day, p.estimated, SUM(p.minutes) m ${f.sql} GROUP BY p.day, p.estimated`).iterate(...f.args)) {
      const i = idx.get(key(row.day));
      if (i !== undefined) others[row.estimated ? 'estimated' : 'tracked'][i] += row.m;
    }
    for (const l of lanes.values()) for (const part of ['tracked', 'estimated']) l[part].forEach((m, i) => { others[part][i] -= m; });

    // the leader of each calendar month in the range
    const months = leaders(gm);
    const info = gameInfo(db, [...new Set([...ids, ...months.map((x) => x.game_id)])]);
    const monthRows = months.map((x) => ({ month: x.k, game_id: x.game_id, ...info.get(x.game_id), minutes: r(x.m), estimated_minutes: r(x.e), month_minutes: r(x.total), share: share(x.m, x.total) }));
    // eras: every calendar month of the range with what was played in it, segmented
    const span = monthSpan(groupKey(p.from, 'month'), groupKey(p.to, 'month'));
    const per = new Map(span.map((k) => [k, { month: k, games: [] }]));
    for (const x of gm) per.get(x.k)?.games.push({ game_id: x.game_id, m: x.m, e: x.e });
    const segs = segmentEras([...per.values()]);
    const more = new Set(segs.flatMap((e) => [e.game_id, ...e.alongside.map((g) => g.game_id), ...e.games.map((g) => g.game_id)]).filter((id) => id != null && !info.has(id)));
    for (const [id, g] of gameInfo(db, [...more])) info.set(id, g);
    const named = (g) => ({ game_id: g.game_id, ...info.get(g.game_id), ...g });
    const eras = segs.map((e) => ({ game_id: e.game_id, title: null, cover_url: null, ...info.get(e.game_id), ...e, alongside: e.alongside.map(named), games: e.games.map(named) }));
    return {
      range: { from: p.from, to: p.to, label: p.label, group: g },
      estimates,
      keys,
      games_played: games.length,
      games: top.map((t) => ({
        game_id: t.game_id, ...info.get(t.game_id), minutes: r(t.m), estimated_minutes: r(t.e), first_day: t.first, last_day: t.last,
        tracked: lanes.get(t.game_id).tracked.map(r), estimated: lanes.get(t.game_id).estimated.map(r),
      })),
      others: { tracked: others.tracked.map((m) => Math.max(0, r(m))), estimated: others.estimated.map((m) => Math.max(0, r(m))) },
      months: monthRows,
      eras,
      era_range: { from: span[0], to: span.at(-1), months: span.length },
    };
  });
}

/** Every month key from `from` to `to` (YYYY-MM), both included. */
function monthSpan(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  for (let k = from; k <= to; k = `${y}-${String(m).padStart(2, '0')}`) {
    out.push(k);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Era segmentation, by month. Shares are of all play in the month (or era); thresholds:
 * - a month is a game's when that game has a clear lead: at least `lead` of the month, or at least
 *   `edge` and `ratio` times the runner-up, or when it tops two or more months running with at
 *   least `edge` of their play together. A month with play but no clear lead is variety; a month
 *   without play is a break.
 * - a one-month interruption between two runs of the same game is absorbed into one era when that
 *   game still had at least `present` of the month and either the month's top game had less than
 *   `dominant` or the era's game kept at least `holds`. A clear takeover still splits.
 * - consecutive variety months are one variety era, consecutive empty months one break; breaks
 *   before the first and after the last month with play are not eras.
 * - an era lists `alongside` it the other games with at least `alongside` of its play (top 3).
 */
export const ERA_RULES = { lead: 0.3, edge: 0.2, ratio: 1.5, present: 0.1, dominant: 0.5, holds: 0.25, alongside: 0.05 };

/**
 * Eras from per-month play. `months`: every calendar month of the span in order, each
 * { month: 'YYYY-MM', games: [{ game_id, m (minutes), e (estimated minutes) }] }. Returns eras in
 * order, games by id only: { game_id, from, to, months, minutes, estimated_minutes, kind, share,
 * total_minutes, alongside, games, ordinal, color_index }.
 */
export function segmentEras(months, R = ERA_RULES) {
  const byMinutes = (a, b) => b.m - a.m || a.game_id - b.game_id;
  const cls = months.map((x) => {
    const games = x.games.filter((g) => g.m > 0).sort(byMinutes);
    const total = games.reduce((a, g) => a + g.m, 0);
    if (total < 0.5) return { month: x.month, games: [], total: 0, kind: 'break', key: 'break' };
    const s1 = games[0].m / total;
    const s2 = (games[1]?.m || 0) / total;
    const clear = s1 >= R.lead || (s1 >= R.edge && s1 >= R.ratio * s2);
    return { month: x.month, games, total, kind: clear ? 'game' : 'variety', game_id: clear ? games[0].game_id : null, key: clear ? `g${games[0].game_id}` : 'variety' };
  });
  // a narrow lead held two months or more running is a lead too
  for (let i = 0; i < cls.length;) {
    const top = cls[i].games[0]?.game_id;
    let j = i + 1;
    while (top != null && j < cls.length && cls[j].games[0]?.game_id === top) j++;
    const run = cls.slice(i, j);
    if (run.length >= 2 && run.some((m) => m.kind === 'variety')) {
      const mine = run.reduce((s, m) => s + m.games[0].m, 0);
      if (mine >= R.edge * run.reduce((s, m) => s + m.total, 0)) for (const m of run) Object.assign(m, { kind: 'game', game_id: top, key: `g${top}` });
    }
    i = j;
  }
  let a = 0;
  let b = cls.length;
  while (a < b && cls[a].kind === 'break') a++;
  while (b > a && cls[b - 1].kind === 'break') b--;
  const runs = [];
  for (const m of cls.slice(a, b)) {
    const last = runs.at(-1);
    if (last?.key === m.key) last.list.push(m); else runs.push({ key: m.key, kind: m.kind, game_id: m.game_id ?? null, list: [m] });
  }
  // a narrow one-month interruption (by another game, or a month of variety) keeps the era whole
  const shareIn = (m, id) => (m.games.find((g) => g.game_id === id)?.m || 0) / m.total;
  for (let i = 1; i < runs.length - 1; i++) {
    const [prev, x, next] = [runs[i - 1], runs[i], runs[i + 1]];
    if (x.list.length !== 1 || x.kind === 'break' || prev.kind !== 'game' || prev.key !== next.key) continue;
    const m = x.list[0];
    const own = shareIn(m, prev.game_id);
    if (own >= R.present && (m.games[0].m / m.total < R.dominant || own >= R.holds)) {
      prev.list.push(m, ...next.list);
      runs.splice(i, 2);
      i--;
    }
  }
  const eras = [];
  const count = new Map(); // game -> its eras so far
  const color = new Map(); // game -> colour index, in order of first appearance
  for (const run of runs) {
    const games = new Map();
    let total = 0;
    let est = 0;
    for (const m of run.list) {
      for (const g of m.games) {
        let t = games.get(g.game_id);
        if (!t) games.set(g.game_id, t = { game_id: g.game_id, m: 0, e: 0 });
        t.m += g.m; t.e += g.e; total += g.m; est += g.e;
      }
    }
    const ranked = [...games.values()].sort(byMinutes);
    const item = (g) => ({ game_id: g.game_id, minutes: r(g.m), estimated_minutes: r(g.e), share: share(g.m, total) });
    const span = { from: run.list[0].month, to: run.list.at(-1).month, months: run.list.length };
    if (run.kind === 'game') {
      const id = run.game_id;
      const own = games.get(id);
      count.set(id, (count.get(id) || 0) + 1);
      if (!color.has(id)) color.set(id, color.size);
      eras.push({
        game_id: id, ...span, minutes: r(own.m), estimated_minutes: r(own.e),
        kind: 'game', share: share(own.m, total), total_minutes: r(total),
        alongside: ranked.filter((g) => g.game_id !== id && g.m >= total * R.alongside).slice(0, 3).map(item), games: [],
        ordinal: count.get(id), color_index: color.get(id),
      });
    } else {
      eras.push({
        game_id: null, ...span, minutes: r(total), estimated_minutes: r(est),
        kind: run.kind, share: null, total_minutes: r(total), alongside: [], games: ranked.slice(0, 3).map(item), ordinal: null, color_index: null,
      });
    }
  }
  return eras;
}

// =====================================================================================
// 5. one game: cumulative curve, sessions and unlocks per period
// =====================================================================================
export function gameCurve(db, gameId, { group = 'month', estimates = 'include', weekStartsOn = 1, now = Date.now() } = {}) {
  return memo(db, `game-curve:${gameId}:${group}:${estimates}:${weekStartsOn}`, () => {
    const game = db.prepare('SELECT id, title, cover_url, status FROM games WHERE id = ?').get(gameId);
    if (!game) throw new HttpError(404, 'Game not found');
    const f = filter('p', { gameId, estimates });
    const days = db.prepare(`SELECT p.day, p.estimated, p.basis, SUM(p.minutes) m, SUM(p.ends) n ${f.sql} GROUP BY p.day, p.estimated, p.basis ORDER BY p.day`).all(...f.args);
    const unlocks = db.prepare(`SELECT a.unlocked_at t FROM achievements a JOIN entries e ON e.id = a.entry_id
      WHERE e.game_id = ? AND e.excluded = 0 AND a.unlocked = 1 AND a.unlocked_at IS NOT NULL ORDER BY a.unlocked_at`).all(gameId).map((x) => x.t);
    // per entry, what the platform says it has when more than stored (Xbox titles read in part)
    const ach = db.prepare(`SELECT COALESCE(SUM(MAX(n, COALESCE(reported, 0))), 0) total, COALESCE(SUM(u), 0) unlocked, COALESCE(SUM(undated), 0) undated
      FROM (SELECT COUNT(*) n, e.ach_total reported, SUM(a.unlocked) u, SUM(CASE WHEN a.unlocked = 1 AND a.unlocked_at IS NULL THEN 1 ELSE 0 END) undated
        FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.game_id = ? AND e.excluded = 0 GROUP BY e.id)`).get(gameId);
    const kinds = Object.fromEntries(db.prepare(`SELECT s.kind, COUNT(*) n, COALESCE(SUM(s.minutes), 0) m, MIN(COALESCE(s.started_at, s.sort_time)) first, MAX(s.sort_time) last
      FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.game_id = ? AND e.excluded = 0 AND s.minutes > 0 GROUP BY s.kind`).all(gameId).map((x) => [x.kind, x]));
    const plat = db.prepare('SELECT MIN(first_played_at) first, MAX(last_played_at) last FROM entries WHERE game_id = ? AND excluded = 0').get(gameId);

    const starts = [days[0] && parseDay(days[0].day), unlocks[0]].filter((x) => x != null);
    let series = [];
    if (starts.length) {
      const from = startOfDay(Math.min(...starts));
      const to = Math.max(now, days.length ? parseDay(days.at(-1).day) : 0, unlocks.at(-1) ?? 0);
      const keys = emptySeries(from, to, group, weekStartsOn);
      const idx = keyIndex(keys);
      const key = keyer(group, weekStartsOn);
      series = keys.map((k) => ({ key: k, minutes: 0, tracked: 0, estimated: 0, sessions: 0, unlocked: 0, cumulative_tracked: 0, cumulative_estimated: 0, cumulative_unlocked: 0, by: zeros(BASES.length) }));
      for (const d of days) {
        const s = series[idx.get(key(d.day))];
        if (!s) continue;
        s[d.estimated ? 'estimated' : 'tracked'] += d.m;
        s.by[BASES[d.basis] ? d.basis : d.estimated ? 4 : 0] += d.m;
        if (!d.estimated) s.sessions += d.n;
      }
      for (const t of unlocks) { const s = series[idx.get(groupKey(t, group, weekStartsOn))]; if (s) s.unlocked++; }
      let ct = 0; let ce = 0; let cu = 0;
      const cb = zeros(BASES.length);
      series = series.map(({ by, ...s }) => {
        ct += s.tracked; ce += s.estimated; cu += s.unlocked;
        by.forEach((m, i) => { cb[i] += m; });
        return {
          ...s, minutes: r(s.tracked + s.estimated), tracked: r(s.tracked), estimated: r(s.estimated), cumulative_tracked: r(ct), cumulative_estimated: r(ce), cumulative_unlocked: cu,
          // what the minutes rest on (tracked + imported = tracked; anchored + confirmed + estimated = estimated)
          by_basis: Object.fromEntries(BASES.map((b, i) => [b, r(by[i])])),
          cumulative_by_basis: Object.fromEntries(BASES.map((b, i) => [b, r(cb[i])])),
        };
      });
    }
    const tracked = kinds.play?.m || 0; const est = kinds.estimate?.m || 0; const base = kinds.baseline?.m || 0;
    return {
      game_id: game.id, title: game.title, cover_url: game.cover_url ?? null, status: game.status,
      group, estimates,
      totals: { minutes: tracked + est + base, tracked_minutes: tracked, estimated_minutes: est, baseline_minutes: base, sessions: kinds.play?.n || 0 },
      first_day: days[0]?.day ?? null,
      last_day: days.at(-1)?.day ?? null,
      first_session_at: kinds.play?.first ?? null,
      last_session_at: kinds.play?.last ?? null,
      platform_first_played_at: plat.first ?? null,
      platform_last_played_at: plat.last ?? null,
      achievements: { total: ach.total, unlocked: ach.unlocked, undated: ach.undated, percent: ach.total ? Math.floor((ach.unlocked * 1000) / ach.total) / 10 : 0 },
      series,
    };
  });
}

// =====================================================================================
// 6. library overview
// =====================================================================================
export const HOUR_BUCKETS = [[0, 0, 'Never'], [1, 60, '<1h'], [60, 300, '1-5h'], [300, 600, '5-10h'], [600, 1500, '10-25h'], [1500, 3000, '25-50h'], [3000, 6000, '50-100h'], [6000, null, '100h+']];
const AGE_BUCKETS = [[0, 30, '<1 month'], [30, 182, '1-6 months'], [182, 365, '6-12 months'], [365, 730, '1-2 years'], [730, null, '2+ years']];
const FINISHED = new Set(['completed', 'beaten', 'dropped', 'wishlist']);

export function libraryOverview(db, { hidden = false, points = 500, dustyLimit = 20, now = Date.now() } = {}) {
  return memo(db, `library:${hidden}:${points}:${dustyLimit}`, () => {
    const hid = hidden ? '' : 'WHERE g.hidden = 0';
    // one row per game, aggregated in SQL (entries, rollups, achievements: all indexed scans)
    const rows = db.prepare(`WITH e AS (
        SELECT game_id,
          SUM(CASE WHEN excluded = 0 THEN playtime_min ELSE 0 END) minutes,
          MAX(CASE WHEN excluded = 0 AND (playtime_min > 0 OR last_played_at IS NOT NULL) THEN 1 ELSE 0 END) played,
          MIN(CASE WHEN excluded = 0 THEN first_played_at END) fp,
          MAX(CASE WHEN excluded = 0 THEN MAX(COALESCE(last_played_at, 0), COALESCE(last_session_at, 0)) END) lp,
          MIN(CASE WHEN hist LIKE '%"date_added"%' THEN json_extract(hist, '$.date_added') END) added
        FROM entries GROUP BY game_id),
      d AS (SELECT game_id, MIN(day) first_day, MAX(day) last_day, MIN(CASE WHEN estimated = 0 THEN day END) first_tracked,
          SUM(CASE WHEN estimated = 0 THEN minutes ELSE 0 END) tracked
        FROM play_days INDEXED BY play_days_game WHERE excluded = 0 GROUP BY game_id),
      a AS (SELECT game_id, SUM(MAX(n, COALESCE(reported, 0))) total, SUM(u) unlocked
        FROM (SELECT en.game_id, COUNT(*) n, en.ach_total reported, SUM(ac.unlocked) u FROM achievements ac JOIN entries en ON en.id = ac.entry_id WHERE en.excluded = 0 GROUP BY en.id) GROUP BY game_id)
      SELECT g.id, g.status, g.created_at, e.minutes, e.played, e.fp, e.lp, e.added, d.first_day, d.last_day, d.first_tracked, COALESCE(d.tracked, 0) tracked, a.total ach_total, a.unlocked ach_unlocked
      FROM games g JOIN e ON e.game_id = g.id LEFT JOIN d ON d.game_id = g.id LEFT JOIN a ON a.game_id = g.id ${hid}`).all();

    const status = Object.fromEntries(STATUSES.map((s) => [s, { status: s, games: 0, played: 0, minutes: 0, tracked_minutes: 0, history_minutes: 0 }]));
    const hours = HOUR_BUCKETS.map(([min, max, label]) => ({ label, min, max, games: 0, minutes: 0 }));
    const firstYear = new Map(); const addedYear = new Map();
    let firstUnknown = 0; let addedUnknown = 0; let played = 0; let minutes = 0; let tracked = 0;
    const dusty = []; const backlog = []; const scatter = [];
    const yearAgo = now - 365 * DAY;
    for (const g of rows) {
      const hist = Math.max(0, g.minutes - g.tracked);
      const st = status[g.status] || (status[g.status] = { status: g.status, games: 0, played: 0, minutes: 0, tracked_minutes: 0, history_minutes: 0 });
      st.games++; st.minutes += g.minutes; st.tracked_minutes += g.tracked; st.history_minutes += hist;
      minutes += g.minutes; tracked += g.tracked;
      if (g.played) { played++; st.played++; }
      const hb = hours.find((b) => (b.max === 0 ? g.minutes <= 0 : g.minutes >= b.min && (b.max == null || g.minutes < b.max)));
      hb.games++; hb.minutes += g.minutes;
      // first played: platform-reported first play or the first day with play (tracked or history)
      const firsts = [g.fp != null ? dayKey(g.fp) : null, g.first_day].filter(Boolean).sort();
      if (firsts.length) {
        const y = Number(firsts[0].slice(0, 4));
        const b = firstYear.get(y) || firstYear.set(y, { year: y, games: 0, minutes: 0, from_history: 0 }).get(y);
        b.games++; b.minutes += g.minutes;
        if (g.first_tracked !== firsts[0]) b.from_history++;
      } else if (g.played) firstUnknown++;
      if (typeof g.added === 'number' && g.added > 0) {
        const y = new Date(g.added).getFullYear();
        const b = addedYear.get(y) || addedYear.set(y, { year: y, games: 0, minutes: 0 }).get(y);
        b.games++; b.minutes += g.minutes;
      } else addedUnknown++;
      const last = Math.max(g.lp || 0, g.last_day ? parseDay(g.last_day) : 0);
      if (g.minutes > 0 && last && last < yearAgo && !FINISHED.has(g.status)) dusty.push({ id: g.id, status: g.status, minutes: g.minutes, last });
      if (g.status === 'backlog') {
        const since = typeof g.added === 'number' && g.added > 0 ? g.added : g.created_at;
        backlog.push({ id: g.id, since, days: Math.max(0, Math.floor((now - since) / DAY)), minutes: g.minutes });
      }
      if (g.ach_total > 0) scatter.push({ id: g.id, minutes: g.minutes, percent: Math.floor((g.ach_unlocked * 1000) / g.ach_total) / 10, status: g.status, unlocked: g.ach_unlocked, total: g.ach_total });
    }
    dusty.sort((a, b) => b.minutes - a.minutes || a.id - b.id);
    backlog.sort((a, b) => b.days - a.days || a.id - b.id);
    scatter.sort((a, b) => b.minutes - a.minutes || a.id - b.id);
    const pts = scatter.slice(0, points);
    const info = gameInfo(db, [...new Set([...dusty.slice(0, dustyLimit), ...backlog.slice(0, 5), ...pts].map((x) => x.id))]);
    const ages = backlog.map((b) => b.days).sort((a, b) => a - b);
    const median = (xs) => (xs.length ? (xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2) : null);

    const hid2 = hidden ? '' : 'AND g.hidden = 0';
    const platforms = db.prepare(`SELECT e.platform, COUNT(DISTINCT e.game_id) games,
        COUNT(DISTINCT CASE WHEN e.excluded = 0 AND (e.playtime_min > 0 OR e.last_played_at IS NOT NULL) THEN e.game_id END) played,
        COALESCE(SUM(CASE WHEN e.excluded = 0 THEN e.playtime_min END), 0) minutes
      FROM entries e JOIN games g ON g.id = e.game_id WHERE 1 = 1 ${hid2} GROUP BY e.platform ORDER BY minutes DESC, e.platform`).all();
    const trackedBy = new Map(db.prepare(`SELECT p.platform, SUM(p.minutes) m FROM play_days p WHERE p.excluded = 0 AND p.estimated = 0
      ${hidden ? '' : 'AND p.game_id IN (SELECT id FROM games WHERE hidden = 0)'} GROUP BY p.platform`).all().map((x) => [x.platform, x.m]));

    return {
      hidden_included: !!hidden,
      games: rows.length,
      played,
      never_played: rows.length - played,
      minutes,
      tracked_minutes: r(tracked),
      history_minutes: r(Math.max(0, minutes - tracked)),
      by_status: Object.values(status).map((s) => ({ ...s, tracked_minutes: r(s.tracked_minutes), history_minutes: r(s.history_minutes) })),
      by_platform: platforms.map((x) => {
        const t = trackedBy.get(x.platform) || 0;
        return { platform: x.platform, games: x.games, played: x.played, minutes: x.minutes, tracked_minutes: r(t), history_minutes: r(Math.max(0, x.minutes - t)) };
      }),
      by_first_played_year: [...firstYear.values()].sort((a, b) => a.year - b.year),
      first_played_unknown: firstUnknown,
      by_year_added: [...addedYear.values()].sort((a, b) => a.year - b.year),
      added_unknown: addedUnknown,
      hours,
      dusty: {
        count: dusty.length,
        minutes: dusty.reduce((a, x) => a + x.minutes, 0),
        items: dusty.slice(0, dustyLimit).map((x) => ({ game_id: x.id, ...info.get(x.id), status: x.status, minutes: x.minutes, last_played_at: x.last, days_since: Math.floor((now - x.last) / DAY) })),
      },
      backlog: {
        count: backlog.length,
        minutes: backlog.reduce((a, x) => a + x.minutes, 0),
        median_days: median(ages),
        buckets: AGE_BUCKETS.map(([min, max, label]) => ({ label, min_days: min, max_days: max, games: backlog.filter((b) => b.days >= min && (max == null || b.days < max)).length })),
        oldest: backlog.slice(0, 5).map((x) => ({ game_id: x.id, ...info.get(x.id), since: x.since, days: x.days, minutes: x.minutes })),
      },
      completion: {
        games: scatter.length,
        points: pts.map((x) => ({ game_id: x.id, title: info.get(x.id)?.title ?? null, minutes: x.minutes, percent: x.percent, unlocked: x.unlocked, total: x.total, status: x.status })),
        truncated: scatter.length > pts.length,
      },
    };
  });
}

// =====================================================================================
// 7. year over year
// =====================================================================================
export function yearOverYear(db, { years, gameId = null, platform = null, estimates = 'include', now = Date.now() } = {}) {
  const cur = new Date(now).getFullYear();
  const ys = [...new Set((years?.length ? years : [cur - 1, cur]).map(Number))].sort((a, b) => a - b);
  return memo(db, `yoy:${ys.join(',')}:${gameId}:${platform}:${estimates}`, () => {
    const today = dayKey(now).slice(5); // MM-DD: "this year so far" against the same date in other years
    // a game is new in the year of its first day with play (all history, estimates as asked)
    const fa = filter('p', { gameId, platform, estimates });
    const firsts = new Map(db.prepare(`SELECT substr(first, 1, 4) y, COUNT(*) n FROM (SELECT MIN(p.day) first ${perGameSql(fa, { span: Infinity })} GROUP BY p.game_id) GROUP BY y`)
      .all(...fa.args).map((x) => [Number(x.y), x.n]));
    // one pass per (game, month) over the years asked for: months, totals, top game, games played
    const span = { fromDay: `${ys[0]}-01-01`, toDay: `${ys.at(-1)}-12-31`, gameId, platform };
    const fy = filter('p', { ...span, estimates });
    const rows = db.prepare(`SELECT p.game_id, substr(p.day, 1, 7) k, p.estimated, SUM(p.minutes) m, SUM(p.ends) n ${fy.sql} GROUP BY p.game_id, k, p.estimated`).all(...fy.args);
    const ft = filter('p', { ...span, estimates: 'exclude' });
    const daysPlayed = new Map(db.prepare(`SELECT substr(d, 1, 4) y, COUNT(*) n FROM (SELECT p.day d ${ft.sql} GROUP BY p.day HAVING SUM(p.minutes) >= 1) GROUP BY y`).all(...ft.args).map((x) => [Number(x.y), x.n]));
    const tops = new Map();
    const out = ys.map((y) => {
      const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, key: `${y}-${String(i + 1).padStart(2, '0')}`, minutes: 0, tracked: 0, estimated: 0, sessions: 0 }));
      const games = new Map();
      let tot = 0; let est = 0; let sessions = 0;
      for (const row of rows) {
        if (Number(row.k.slice(0, 4)) !== y) continue;
        const mo = months[Number(row.k.slice(5, 7)) - 1];
        mo[row.estimated ? 'estimated' : 'tracked'] += row.m; mo.minutes += row.m; mo.sessions += row.n;
        tot += row.m; sessions += row.n; if (row.estimated) est += row.m;
        const g = games.get(row.game_id) || games.set(row.game_id, { game_id: row.game_id, m: 0, e: 0 }).get(row.game_id);
        g.m += row.m; if (row.estimated) g.e += row.m;
      }
      const top = [...games.values()].sort((a, b) => b.m - a.m || a.game_id - b.game_id)[0];
      if (top) tops.set(y, top);
      // Jan 1 to today's date in that year: the months before this one, plus this month so far
      const mm = Number(today.slice(0, 2));
      const part = filter('p', { fromDay: `${y}-${today.slice(0, 2)}-01`, toDay: `${y}-${today}`, gameId, platform, estimates });
      const cut = db.prepare(`SELECT COALESCE(SUM(p.minutes), 0) m, COALESCE(SUM(p.minutes * p.estimated), 0) e ${part.sql}`).get(...part.args);
      const ytd = { m: cut.m, e: cut.e };
      for (const mo of months.slice(0, mm - 1)) { ytd.m += mo.minutes; ytd.e += mo.estimated; }
      return {
        year: y,
        partial: y === cur,
        total_minutes: r(tot),
        tracked_minutes: r(tot - est),
        estimated_minutes: r(est),
        to_date: { through: today, minutes: r(ytd.m), tracked_minutes: r(ytd.m - ytd.e), estimated_minutes: r(ytd.e) },
        sessions,
        games_played: games.size,
        days_played: daysPlayed.get(y) || 0,
        new_games: firsts.get(y) || 0,
        top_game: top ? { game_id: top.game_id, minutes: r(top.m), estimated_minutes: r(top.e) } : null,
        months: months.map((m) => ({ ...m, minutes: r(m.minutes), tracked: r(m.tracked), estimated: r(m.estimated) })),
      };
    });
    const info = gameInfo(db, [...new Set([...tops.values()].map((t) => t.game_id))]);
    for (const y of out) if (y.top_game) y.top_game = { game_id: y.top_game.game_id, ...info.get(y.top_game.game_id), minutes: y.top_game.minutes, estimated_minutes: y.top_game.estimated_minutes };
    return { estimates, years: out };
  });
}

// =====================================================================================
// 8. records and highlights
// =====================================================================================
const PARTS = [[0, 6, 'night'], [6, 12, 'morning'], [12, 18, 'afternoon'], [18, 24, 'evening']];
const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const addDays = (day, n) => { const d = new Date(parseDay(day)); d.setDate(d.getDate() + n); return dayKey(d.getTime()); };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export function records(db, { range = 'all', group, gameId = null, platform = null, estimates = 'include', weekStartsOn = 1, now = Date.now() } = {}) {
  return memo(db, `records:${range}:${group}:${gameId}:${platform}:${estimates}:${weekStartsOn}`, () => {
    const p = period(db, { range, now, weekStartsOn, gameId, platform, estimates });
    // tracked minutes per local day (all history, memoized for streaks), cut to the range
    const all = dailyTotals(db, { gameId, platform });
    const inRange = new Map([...all].filter(([d, m]) => d >= p.fromDay && d <= p.toDay && m > 0));
    const best = (map) => { let b = null; for (const [k, m] of map) if (m >= 0.5 && (!b || m > b[1] || (m === b[1] && k < b[0]))) b = [k, m]; return b; };
    const by = (g) => { const m = new Map(); for (const [d, x] of inRange) { const k = groupKey(parseDay(d), g, weekStartsOn); m.set(k, (m.get(k) || 0) + x); } return m; };
    const day = best(inRange);
    const week = best(by('week'));
    const month = best(by('month'));
    const streak = computeStreaks(inRange, now);
    const current = computeStreaks(all, now).current;
    const weekday = zeros(7);
    for (const [d, m] of inRange) weekday[new Date(parseDay(d)).getDay()] += m;
    const tracked = [...inRange.values()].reduce((a, b) => a + b, 0);

    const longest = longestSession(db, p, { gameId, platform });
    const w = sessionWhere(p, { gameId, platform });
    const idx = gameId ? '' : 'INDEXED BY sessions_kind_time';
    const firstS = sessionRef(db.prepare(`${SESSION_REF.replace('FROM sessions s', `FROM sessions s ${idx}`)} WHERE ${w.where} ORDER BY s.sort_time, s.id LIMIT 1`).get(...w.args));
    // sessions as /stats counts them: tracked sessions ending in the range
    const ft = filter('p', { fromDay: p.fromDay, toDay: p.toDay, gameId, platform, estimates: 'exclude' });
    const sessions = db.prepare(`SELECT COALESCE(SUM(p.ends), 0) n ${ft.sql}`).get(...ft.args).n;

    // most played (estimates as asked): overall and per month / year, from one (game, period) pass
    const f = filter('p', { fromDay: p.fromDay, toDay: p.toDay, gameId, platform, estimates });
    const g = group === 'month' || group === 'year' ? group : (p.span > 400 ? 'year' : 'month');
    const rows = db.prepare(`SELECT p.game_id, substr(p.day, 1, ${g === 'year' ? 4 : 7}) k, SUM(p.minutes) m, SUM(p.minutes * p.estimated) e, MIN(p.day) first, MAX(p.day) last
      ${perGameSql(f, p)} GROUP BY p.game_id, k`).all(...f.args);
    const games = perGame(rows);
    const topRow = games[0];
    const totals = { m: games.reduce((a, x) => a + x.m, 0), e: games.reduce((a, x) => a + x.e, 0), games: games.length };
    const per = leaders(rows);
    const info = gameInfo(db, [...new Set([topRow?.game_id, ...per.map((x) => x.game_id)].filter(Boolean))]);
    const fh = filter('h', { fromDay: p.fromDay, toDay: p.toDay, gameId, platform, estimates: 'exclude' });
    const hours = zeros(24);
    for (const row of db.prepare(`SELECT h.hour, SUM(h.minutes) m ${fh.sql} GROUP BY h.hour`).all(...fh.args)) hours[row.hour] = row.m;

    const out = {
      range: { from: p.from, to: p.to, label: p.label },
      estimates,
      tracked_minutes: r(tracked),
      estimated_minutes: r(totals.e),
      sessions,
      days_played: [...inRange.values()].filter((m) => m >= 1).length,
      games_played: totals.games,
      longest_session: longest,
      first_session: firstS,
      biggest_day: day && { day: day[0], minutes: r(day[1]) },
      best_week: week && { key: week[0], from: week[0], to: addDays(week[0], 6), minutes: r(week[1]) },
      best_month: month && { key: month[0], minutes: r(month[1]) },
      longest_streak: streak.longest ? { days: streak.longest, from: addDays(streak.longest_end, -(streak.longest - 1)), to: streak.longest_end } : null,
      current_streak: current,
      most_played: topRow ? { game_id: topRow.game_id, ...info.get(topRow.game_id), minutes: r(topRow.m), estimated_minutes: r(topRow.e), share: share(topRow.m, totals.m) } : null,
      most_played_by: { group: g, items: per.map((x) => ({ key: x.k, game_id: x.game_id, ...info.get(x.game_id), minutes: r(x.m), estimated_minutes: r(x.e), share: share(x.m, x.total) })) },
      weekday: weekday.map(r),
      hours: hours.map(r),
    };
    out.highlights = highlights(out, { weekday, hours, total: totals.m });
    return out;
  });
}

/** One-line highlights from fixed templates, each with the numbers behind it. */
function highlights(x, { weekday, hours, total }) {
  const out = [];
  const add = (id, text, value, unit, extra = {}) => out.push({ id, text, value, unit, ...extra });
  if (x.longest_session) add('longest_session', `Longest session: ${fmtMinutes(x.longest_session.minutes)} of ${x.longest_session.title} on ${x.longest_session.day}.`, x.longest_session.minutes, 'minutes', { game_id: x.longest_session.game_id, day: x.longest_session.day, session_id: x.longest_session.session_id });
  if (x.biggest_day) add('biggest_day', `Biggest day: ${fmtMinutes(x.biggest_day.minutes)} on ${x.biggest_day.day}.`, x.biggest_day.minutes, 'minutes', { day: x.biggest_day.day });
  if (x.best_week) add('best_week', `Best week: ${fmtMinutes(x.best_week.minutes)} in the week of ${x.best_week.from}.`, x.best_week.minutes, 'minutes', { day: x.best_week.from });
  if (x.longest_streak && x.longest_streak.days > 1) add('longest_streak', `Longest streak: ${x.longest_streak.days} days in a row (${x.longest_streak.from} to ${x.longest_streak.to}).`, x.longest_streak.days, 'days', { day: x.longest_streak.to });
  if (x.most_played && total >= 1) {
    const part = pct(x.most_played.minutes, total);
    add('most_played', `${x.most_played.title} was ${part}% of your play time (${fmtMinutes(x.most_played.minutes)}).`, part, 'percent', { game_id: x.most_played.game_id, minutes: x.most_played.minutes });
  }
  const wsum = weekday.reduce((a, b) => a + b, 0);
  if (wsum >= 1) {
    const i = weekday.indexOf(Math.max(...weekday));
    const part = pct(weekday[i], wsum);
    add('favorite_weekday', `You play most on ${WEEKDAYS[i]} (${part}% of tracked play).`, part, 'percent', { weekday: i });
  }
  const hsum = hours.reduce((a, b) => a + b, 0);
  if (hsum >= 1) {
    const parts = PARTS.map(([a, b, name]) => ({ name, from: a, to: b, m: hours.slice(a, b).reduce((s, v) => s + v, 0) }));
    const top = parts.reduce((a, b) => (b.m > a.m ? b : a));
    const part = pct(top.m, hsum);
    add('time_of_day', `Most of your timed play is in the ${top.name} (${String(top.from).padStart(2, '0')}:00-${String(top.to).padStart(2, '0')}:00): ${part}%.`, part, 'percent', { part: top.name, from_hour: top.from, to_hour: top.to });
  }
  if (x.first_session) add('first_session', `First tracked session: ${x.first_session.title} on ${x.first_session.day}.`, x.first_session.minutes, 'minutes', { game_id: x.first_session.game_id, day: x.first_session.day, session_id: x.first_session.session_id });
  return out;
}

// =====================================================================================
// play style: focus, what became of the games started, staying power, comebacks
// =====================================================================================
// Tracked play only: estimated history is spread by inference, so it has no real rhythm.
export const STYLE_RULES = {
  tried: 60,       // a game started with less than this many minutes, on one day, was only tried
  invested: 600,   // ... at least this many minutes: stuck with
  recent: 14,      // played within this many days: still going
  early: 7,        // staying power: the share of a game's hours in its first N days ...
  settled: 30,     // ... for games started at least this many days ago
  gap: 90,         // a return after this many days without play is a comeback
  focused: 0.7,    // a week's top game with this share of the week, at the median: focused
  varied: 0.45,    // ... at most this share: varied
};
const OUTCOMES = ['finished', 'playing', 'invested', 'faded', 'tried', 'dropped'];
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / DAY);

/**
 * How you play, in a range: how focused your weeks are (games per week, the top game's share),
 * what became of the games you started (finished, still going, stuck with, faded, only tried,
 * dropped), how front-loaded a game's hours are, and the games you came back to after a long gap.
 * Starts count games whose first play anywhere falls in the range and was tracked (not estimated).
 */
export function playStyle(db, { range = '365d', platform = null, weekStartsOn = 1, now = Date.now(), limit = 10, R = STYLE_RULES } = {}) {
  return memo(db, `style:${range}:${platform}:${weekStartsOn}:${limit}`, () => {
    const p = period(db, { range, now, weekStartsOn, platform, estimates: 'exclude' });
    const pf = platform ? 'AND platform = ?' : '';
    const pa = platform ? [platform] : [];
    const today = dayKey(now);
    // tracked minutes per game and day, all time: starts, staying power and comebacks look past the range
    const byGame = new Map();
    for (const x of db.prepare(`SELECT game_id, day, SUM(minutes) m FROM play_days INDEXED BY play_days_game
        WHERE excluded = 0 AND estimated = 0 ${pf} GROUP BY game_id, day ORDER BY game_id, day`).all(...pa)) {
      if (x.m < 0.5) continue;
      let g = byGame.get(x.game_id);
      if (!g) byGame.set(x.game_id, g = []);
      g.push([x.day, x.m]);
    }
    const firstAny = new Map(db.prepare(`SELECT game_id, MIN(day) d FROM play_days WHERE excluded = 0 ${pf} GROUP BY game_id`).all(...pa).map((x) => [x.game_id, x.d]));
    const inRange = (d) => d >= p.fromDay && d <= p.toDay;

    // focus: per week, how many games and the top one's share
    const wk = keyer('week', weekStartsOn);
    const weeks = new Map();
    for (const [id, list] of byGame) {
      for (const [d, m] of list) {
        if (!inRange(d)) continue;
        const k = wk(d);
        let w = weeks.get(k);
        if (!w) weeks.set(k, w = new Map());
        w.set(id, (w.get(id) || 0) + m);
      }
    }
    const weekRows = [...weeks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, w]) => {
      const vals = [...w.values()];
      const total = vals.reduce((a, b) => a + b, 0);
      // the week still under way is drawn but not counted in the typical week
      return { key, games: w.size, minutes: r(total), top_share: share(Math.max(...vals), total), ...(key === wk(today) ? { partial: true } : {}) };
    }).filter((w) => w.minutes >= 1);
    const whole = weekRows.filter((w) => !w.partial).length ? weekRows.filter((w) => !w.partial) : weekRows;
    const topShare = median(whole.map((w) => w.top_share));
    const focus = weekRows.length ? {
      weeks: whole.length,
      games_per_week: Math.round((whole.reduce((a, w) => a + w.games, 0) / whole.length) * 10) / 10,
      median_top_share: topShare,
      style: topShare >= R.focused ? 'focused' : topShare <= R.varied ? 'varied' : 'balanced',
      series: weekRows,
    } : null;

    // starts: first played in the range, tracked from that first day
    const started = [...byGame.entries()].filter(([id, list]) => inRange(list[0][0]) && firstAny.get(id) === list[0][0]);
    const ids = started.map(([id]) => id);
    const info = new Map(ids.length ? db.prepare(`SELECT g.id, g.title, g.cover_url, g.status,
        (SELECT SUM(a.unlocked) FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.game_id = g.id AND e.excluded = 0) unlocked,
        (SELECT COUNT(*) FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.game_id = g.id AND e.excluded = 0) total
      FROM games g WHERE g.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)).map((g) => [g.id, g]) : []);
    const starts = started.map(([id, list]) => {
      const g = info.get(id) || {};
      const minutes = list.reduce((a, [, m]) => a + m, 0);
      const first = list[0][0]; const last = list[list.length - 1][0];
      const since = daysBetween(last, today);
      const early = list.filter(([d]) => daysBetween(first, d) < R.early).reduce((a, [, m]) => a + m, 0);
      const outcome = ['completed', 'beaten'].includes(g.status) || (g.total && g.unlocked >= g.total) ? 'finished'
        : g.status === 'dropped' ? 'dropped'
          : since <= R.recent ? 'playing'
            : minutes < R.tried && list.length === 1 ? 'tried'
              : minutes >= R.invested ? 'invested' : 'faded';
      return { game_id: id, title: g.title, cover_url: g.cover_url ?? null, status: g.status, first_day: first, last_day: last, minutes: r(minutes), days: list.length, span_days: daysBetween(first, last) + 1, outcome, early_share: share(early, minutes), settled: daysBetween(first, today) >= R.settled };
    }).sort((a, b) => (a.first_day < b.first_day ? 1 : a.first_day > b.first_day ? -1 : b.minutes - a.minutes));
    const counts = Object.fromEntries(OUTCOMES.map((o) => [o, starts.filter((s) => s.outcome === o).length]));
    const settled = starts.filter((s) => s.settled && s.minutes >= R.tried);

    // comebacks: a return to a game after a long gap, the return in the range
    const comebacks = [];
    for (const [id, list] of byGame) {
      for (let i = 1; i < list.length; i++) {
        const gap = daysBetween(list[i - 1][0], list[i][0]);
        if (gap < R.gap || !inRange(list[i][0])) continue;
        const after = list.slice(i).reduce((a, [, m]) => a + m, 0);
        comebacks.push({ game_id: id, returned_on: list[i][0], gap_days: gap, minutes_since: r(after) });
      }
    }
    comebacks.sort((a, b) => (a.returned_on < b.returned_on ? 1 : -1));
    const cbInfo = gameInfo(db, [...new Set(comebacks.slice(0, limit).map((c) => c.game_id))]);

    return {
      range: { from: p.from, to: p.to, label: p.label },
      rules: R,
      focus,
      starts: {
        count: starts.length, outcomes: counts,
        median_minutes: starts.length ? r(median(starts.map((s) => s.minutes))) : null,
        median_days: starts.length ? median(starts.map((s) => s.days)) : null,
        items: starts.slice(0, limit),
      },
      staying_power: settled.length ? {
        games: settled.length,
        median_early_share: median(settled.map((s) => s.early_share)),
        median_span_days: median(settled.map((s) => s.span_days)),
      } : null,
      comebacks: { count: comebacks.length, items: comebacks.slice(0, limit).map((c) => ({ ...c, ...cbInfo.get(c.game_id) })) },
    };
  });
}

// =====================================================================================
// tags (IGDB metadata): genres, themes, modes, perspectives, franchises, developers, publishers
// =====================================================================================
export const TAG_KIND_NAMES = ['genre', 'theme', 'mode', 'perspective', 'franchise', 'developer', 'publisher'];

/**
 * Play by tag in a range: each tag's minutes (a game counts fully in every tag it has), games,
 * sessions and games finished, the top tags per period, and how much of the play has metadata
 * at all (coverage). Empty items until IGDB has matched games.
 */
export function tagStats(db, { kind = 'genre', range = '365d', group, platform = null, estimates = 'include', weekStartsOn = 1, now = Date.now(), limit = 12 } = {}) {
  if (!TAG_KIND_NAMES.includes(kind)) throw new HttpError(400, `kind must be one of ${TAG_KIND_NAMES.join(', ')}`);
  return memo(db, `tags:${kind}:${range}:${group}:${platform}:${estimates}:${weekStartsOn}:${limit}`, () => {
    const p = period(db, { range, now, weekStartsOn, platform, estimates });
    const g = ['day', 'week', 'month', 'year'].includes(group) ? group : (p.span <= 200 ? 'week' : 'month');
    const keys = emptySeries(p.from, p.to, g, weekStartsOn);
    const idx = keyIndex(keys);
    const key = keyer(g, weekStartsOn);
    const f = filter('p', { fromDay: p.fromDay, toDay: p.toDay, platform, estimates });
    const perG = db.prepare(`SELECT p.game_id, SUM(p.minutes) m, SUM(p.minutes * p.estimated) e, SUM(p.ends) n ${perGameSql(f, p)} GROUP BY p.game_id`).all(...f.args);
    const tagsOf = new Map();
    for (const t of db.prepare('SELECT game_id, name FROM game_tags WHERE kind = ?').iterate(kind)) {
      let l = tagsOf.get(t.game_id);
      if (!l) tagsOf.set(t.game_id, l = []);
      l.push(t.name);
    }
    const matched = new Set(db.prepare('SELECT game_id FROM game_meta WHERE igdb_id IS NOT NULL').all().map((x) => x.game_id));
    const finished = new Set(db.prepare("SELECT id FROM games WHERE status IN ('completed', 'beaten')").all().map((x) => x.id));
    const by = new Map();
    let total = 0; let matchedMin = 0; let matchedGames = 0; let untagged = 0;
    for (const x of perG) {
      total += x.m;
      if (matched.has(x.game_id)) { matchedMin += x.m; matchedGames++; }
      const list = tagsOf.get(x.game_id);
      if (!list) { if (matched.has(x.game_id)) untagged += x.m; continue; }
      for (const n of list) {
        let t = by.get(n);
        if (!t) by.set(n, t = { name: n, m: 0, e: 0, games: 0, sessions: 0, finished: 0 });
        t.m += x.m; t.e += x.e; t.games++; t.sessions += x.n; if (finished.has(x.game_id)) t.finished++;
      }
    }
    const all = [...by.values()].filter((t) => t.m >= 0.5).sort((a, b) => b.m - a.m || (a.name < b.name ? -1 : 1));
    const top = all.slice(0, limit);
    const topSet = new Set(top.map((t) => t.name));
    const series = new Map(top.map((t) => [t.name, zeros(keys.length)]));
    if (top.length) {
      for (const row of db.prepare(`SELECT p.day, p.game_id, SUM(p.minutes) m ${f.sql} GROUP BY p.day, p.game_id`).iterate(...f.args)) {
        const i = idx.get(key(row.day));
        if (i === undefined) continue;
        for (const n of tagsOf.get(row.game_id) || []) if (topSet.has(n)) series.get(n)[i] += row.m;
      }
    }
    return {
      kind,
      range: { from: p.from, to: p.to, label: p.label, group: g },
      estimates,
      coverage: { games: perG.length, matched_games: matchedGames, minutes: r(total), matched_minutes: r(matchedMin), untagged_minutes: r(untagged) },
      tags: all.length,
      items: top.map((t) => ({ name: t.name, minutes: r(t.m), estimated_minutes: r(t.e), games: t.games, sessions: t.sessions, finished: t.finished, share: share(t.m, total) })),
      keys,
      series: top.map((t) => ({ name: t.name, values: series.get(t.name).map(r) })),
    };
  });
}

/**
 * Your pace against IGDB's typical times to beat, for games you finished (status Completed or
 * Beaten): your hours over the main story's (or main + extras when only that is known). The
 * median ratio says whether you rush or linger.
 */
export function paceStats(db, { limit = 10 } = {}) {
  return memo(db, `pace:${limit}`, () => {
    const rows = db.prepare(`SELECT g.id game_id, g.title, g.cover_url, g.status, m.ttb_main, m.ttb_extra, m.ttb_complete,
        (SELECT COALESCE(SUM(playtime_min), 0) FROM entries e WHERE e.game_id = g.id AND e.excluded = 0) minutes
      FROM games g JOIN game_meta m ON m.game_id = g.id
      WHERE g.status IN ('completed', 'beaten') AND COALESCE(m.ttb_main, m.ttb_extra) > 0`).all()
      .filter((x) => x.minutes >= 30)
      .map((x) => { const typical = x.ttb_main || x.ttb_extra; return { ...x, typical, basis: x.ttb_main ? 'main' : 'extra', ratio: Math.round((x.minutes / typical) * 100) / 100 }; });
    const sorted = [...rows].sort((a, b) => a.ratio - b.ratio);
    const mid = sorted.length ? (sorted.length % 2 ? sorted[sorted.length >> 1].ratio : (sorted[sorted.length / 2 - 1].ratio + sorted[sorted.length / 2].ratio) / 2) : null;
    return {
      games: rows.length,
      median_ratio: mid == null ? null : Math.round(mid * 100) / 100,
      items: rows.sort((a, b) => b.minutes - a.minutes).slice(0, limit).map((x) => ({ game_id: x.game_id, title: x.title, cover_url: x.cover_url ?? null, status: x.status, minutes: x.minutes, typical_minutes: x.typical, basis: x.basis, complete_minutes: x.ttb_complete, ratio: x.ratio })),
    };
  });
}
