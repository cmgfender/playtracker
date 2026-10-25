// Stats are computed from 'play' sessions. A session only tells us minutes played inside a
// window (the time between two syncs); when the exact time is unknown the minutes are spread
// evenly across the window so weekly/monthly syncs still yield sensible daily charts.
// The spreading happens once at write time (see rollup.js -> play_days / play_hours); every
// query here is an indexed SQL aggregate, so stats stay fast with millions of sessions.

import { HttpError } from '../util.js';

const MIN = 60_000;
const DAY = 86_400_000;

export function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const parseDay = (k) => new Date(`${k}T12:00:00`).getTime();

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function nextDay(t) {
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function sessionInterval(s) {
  if (s.started_at && s.ended_at && s.ended_at > s.started_at) return [s.started_at, s.ended_at];
  if (s.ended_at) return [s.ended_at - s.minutes * MIN, s.ended_at];
  const end = s.window_end ?? s.created_at;
  const start = s.window_start && s.window_start < end ? s.window_start : end - s.minutes * MIN;
  return [start, end];
}

/** Split a session's minutes across local calendar days, proportionally to overlap. */
export function spreadByDay(s, from = -Infinity, to = Infinity) {
  const [a, b] = sessionInterval(s);
  const len = Math.max(1, b - a);
  const out = [];
  for (let d = startOfDay(a); d < b; d = nextDay(d)) {
    const lo = Math.max(a, d);
    const hi = Math.min(b, nextDay(d));
    if (hi <= lo) continue;
    if (hi <= from || lo >= to) continue;
    const clippedLo = Math.max(lo, from);
    const clippedHi = Math.min(hi, to);
    out.push([dayKey(d), (s.minutes * (clippedHi - clippedLo)) / len, d]);
  }
  if (!out.length && b > from && a < to) out.push([dayKey(b), s.minutes, startOfDay(b)]);
  return out;
}

// ---------- small result cache, invalidated by any write on the connection ----------
const caches = new WeakMap();
export function memo(db, key, fn) {
  let cache = caches.get(db);
  if (!cache) { cache = new Map(); caches.set(db, cache); }
  const ver = db.prepare('SELECT total_changes() v').get().v;
  const k = `${key}|${ver}|${dayKey(Date.now())}`;
  if (cache.has(k)) return cache.get(k);
  const v = fn();
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(k, v);
  return v;
}

export function resolveRange(range, now = Date.now(), weekStartsOn = 1) {
  const r = String(range || '30d');
  let m;
  if ((m = /^(\d+)d$/.exec(r))) {
    // capped at 100 years: the empty series walks every day of the range
    const n = Math.min(Number(m[1]), 36500);
    return { from: startOfDay(now - (n - 1) * DAY), to: now, label: `Last ${n} days` };
  }
  if ((m = /^year:(\d{4})$/.exec(r))) {
    const y = Number(m[1]);
    return { from: new Date(y, 0, 1).getTime(), to: Math.min(now, new Date(y + 1, 0, 1).getTime() - 1), label: String(y) };
  }
  if ((m = /^month:(\d{4})-(0[1-9]|1[0-2])$/.exec(r))) {
    const y = Number(m[1]); const mo = Number(m[2]) - 1;
    return { from: new Date(y, mo, 1).getTime(), to: Math.min(now, new Date(y, mo + 1, 1).getTime() - 1), label: `${y}-${m[2]}` };
  }
  // a malformed year/month must not be answered with the 30-day fallback under its own label
  if (/^(year|month):/.test(r)) throw new HttpError(400, `Invalid range "${r}" - use year:YYYY or month:YYYY-MM`);
  if (r === 'week') { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() - weekStartsOn + 7) % 7)); return { from: d.getTime(), to: now, label: 'This week' }; }
  if (r === 'month') { const d = new Date(now); return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now, label: 'This month' }; }
  if (r === 'year') { const d = new Date(now); return { from: new Date(d.getFullYear(), 0, 1).getTime(), to: now, label: 'This year' }; }
  if (r === 'all') return { from: 0, to: now, label: 'All time' };
  return resolveRange('30d', now);
}

const GROUPS = ['day', 'week', 'month', 'year'];

/** The grouping a chart of `span` days uses unless one is asked for. */
export function groupFor(span, group) {
  return GROUPS.includes(group) ? group : (span <= 45 ? 'day' : span <= 200 ? 'week' : span <= 1100 ? 'month' : 'year');
}

export function groupKey(dayStart, group, weekStartsOn) {
  const d = new Date(dayStart);
  if (group === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (group === 'year') return String(d.getFullYear());
  if (group === 'week') {
    const offset = (d.getDay() - weekStartsOn + 7) % 7;
    d.setDate(d.getDate() - offset);
    return dayKey(d.getTime());
  }
  return dayKey(dayStart);
}

export function emptySeries(from, to, group, weekStartsOn) {
  const keys = [];
  const seen = new Set();
  for (let d = startOfDay(from); d <= to; d = nextDay(d)) {
    const k = groupKey(d, group, weekStartsOn);
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  return keys;
}

/** WHERE fragment + args shared by every play_days / play_hours query (covering indexes, no joins). */
// estimates: 'include' (tracked + inferred history, default), 'exclude' (tracked only), 'only'
function filter(alias, { fromDay, toDay, gameId, platform, accountId, estimates = 'include' }) {
  const est = estimates === 'exclude' ? '= 0' : estimates === 'only' ? '= 1' : 'IN (0, 1)';
  const where = [`${alias}.excluded = 0`, `${alias}.estimated ${est}`];
  const args = [];
  if (gameId) { where.push(`${alias}.game_id = ?`); args.push(gameId); }
  if (fromDay) { where.push(`${alias}.day >= ?`); args.push(fromDay); }
  if (toDay) { where.push(`${alias}.day <= ?`); args.push(toDay); }
  if (platform) { where.push(`${alias}.platform = ?`); args.push(platform); }
  if (accountId) { where.push(`${alias}.entry_id IN (SELECT id FROM entries WHERE account_id = ?)`); args.push(accountId); }
  return { sql: `FROM ${alias === 'p' ? 'play_days' : 'play_hours'} ${alias} WHERE ${where.join(' AND ')}`, args };
}

/** Minutes per local day (whole history) - used for streaks. */
export function dailyTotals(db, { gameId, platform } = {}) {
  return memo(db, `daily:${gameId}:${platform}`, () => {
    // streaks only count real, tracked play - never inferred history
    const f = filter('p', { gameId, platform, estimates: 'exclude' });
    return new Map(db.prepare(`SELECT p.day, SUM(p.minutes) m ${f.sql} GROUP BY p.day`).all(...f.args).map((r) => [r.day, r.m]));
  });
}

export function computeStreaks(dayMinutes, now = Date.now()) {
  const days = [...dayMinutes.entries()].filter(([, m]) => m >= 1).map(([k]) => k).sort();
  let longest = 0; let longestEnd = null; let run = 0; let prev = null;
  for (const k of days) {
    const t = parseDay(k);
    run = prev != null && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1;
    if (run > longest) { longest = run; longestEnd = k; }
    prev = t;
  }
  let current = 0;
  let cursor = startOfDay(now);
  if ((dayMinutes.get(dayKey(cursor)) || 0) < 1) cursor = startOfDay(cursor - DAY / 2);
  while ((dayMinutes.get(dayKey(cursor)) || 0) >= 1) { current++; cursor = startOfDay(cursor - DAY / 2); }
  return { current, longest, longest_end: longestEnd };
}

export function firstPlayDay(db, estimates = 'include') {
  return db.prepare(`SELECT MIN(day) d FROM play_days WHERE excluded = 0 AND estimated ${estimates === 'exclude' ? '= 0' : 'IN (0, 1)'}`).get().d;
}

export function computeStats(db, opts = {}) {
  const { range = '30d', group, gameId, platform, weekStartsOn = 1, now = Date.now(), topLimit = 25, estimates = 'include' } = opts;
  return memo(db, `stats:${range}:${group}:${gameId}:${platform}:${weekStartsOn}:${topLimit}:${estimates}`, () => {
    let { from, to, label } = resolveRange(range, now, weekStartsOn);
    if (from === 0) {
      const first = gameId
        ? db.prepare(`SELECT MIN(day) d FROM play_days WHERE game_id = ? AND estimated ${estimates === 'exclude' ? '= 0' : 'IN (0, 1)'}`).get(gameId).d
        : firstPlayDay(db, estimates);
      from = first ? parseDay(first) - 12 * 3600_000 : startOfDay(now);
    }
    const span = Math.max(1, (to - from) / DAY);
    const g = groupFor(span, group);
    const range_ = { fromDay: dayKey(from), toDay: dayKey(to), gameId, platform, estimates };
    const f = filter('p', range_);

    const series = new Map(emptySeries(from, to, g, weekStartsOn).map((k) => [k, 0]));
    const seriesEst = new Map();
    const byPlat = new Map();
    const weekday = Array(7).fill(0);
    const dayTotals = new Map();
    let total = 0;
    let estTotal = 0;
    for (const r of db.prepare(`SELECT p.day, p.platform, p.estimated, SUM(p.minutes) m ${f.sql} GROUP BY p.day, p.platform, p.estimated`).all(...f.args)) {
      const t = parseDay(r.day);
      const k = groupKey(t, g, weekStartsOn);
      series.set(k, (series.get(k) || 0) + r.m);
      total += r.m;
      if (r.estimated) { seriesEst.set(k, (seriesEst.get(k) || 0) + r.m); estTotal += r.m; continue; }
      // platform stacks, weekday pattern, busiest day and days played use tracked play only
      if (!byPlat.has(r.platform)) byPlat.set(r.platform, new Map());
      byPlat.get(r.platform).set(k, (byPlat.get(r.platform).get(k) || 0) + r.m);
      weekday[new Date(t).getDay()] += r.m;
      dayTotals.set(r.day, (dayTotals.get(r.day) || 0) + r.m);
    }

    // per-game totals; SUM(ends) counts sessions ending in range (a session spanning the range start counts once, where it ends)
    const perGame = db.prepare(`SELECT p.game_id, SUM(p.minutes) minutes, SUM(p.minutes * p.estimated) est, SUM(p.ends) sessions, GROUP_CONCAT(DISTINCT p.platform) platforms, MAX(p.day) last_day
      ${f.sql} GROUP BY p.game_id ORDER BY minutes DESC`).all(...f.args);
    const top = perGame.slice(0, topLimit);
    const sessionCount = perGame.reduce((a, x) => a + x.sessions, 0);
    const gameInfo = db.prepare('SELECT title, cover_url FROM games WHERE id = ?');
    const platforms = db.prepare(`SELECT p.platform, SUM(p.minutes) minutes ${f.sql} GROUP BY p.platform ORDER BY minutes DESC`).all(...f.args);

    const fh = filter('h', range_);
    const hours = Array(24).fill(0);
    for (const r of db.prepare(`SELECT h.hour, SUM(h.minutes) m ${fh.sql} GROUP BY h.hour`).all(...fh.args)) hours[r.hour] = r.m;

    // longest session: walk sessions by minutes (index) for long ranges, by time for short ones
    const lwhere = ["s.kind = 'play'", 'e.excluded = 0', 's.sort_time >= ?', 's.sort_time <= ?'];
    const largs = [from, to]; // `to` already ends the period (or is now)
    if (gameId) { lwhere.push('s.entry_id IN (SELECT id FROM entries WHERE game_id = ?)'); largs.push(gameId); }
    if (platform) { lwhere.push('e.platform = ?'); largs.push(platform); }
    const idx = gameId ? '' : span > 120 ? 'INDEXED BY sessions_kind_minutes' : 'INDEXED BY sessions_kind_time';
    const longest = db.prepare(`SELECT s.minutes, g.title, g.id game_id, s.sort_time ended_at FROM sessions s ${idx} JOIN entries e ON e.id = s.entry_id JOIN games g ON g.id = e.game_id
      WHERE ${lwhere.join(' AND ')} ORDER BY s.minutes DESC LIMIT 1`).get(...largs) || null;

    const r = (x) => Math.round(x);
    const busiest = [...dayTotals.entries()].sort((a, b) => b[1] - a[1])[0];
    const sessions = sessionCount;
    const tracked = total - estTotal;
    return {
      range: { from, to, label, group: g },
      total_minutes: r(total),
      sessions,
      games_played: perGame.length,
      tracked_minutes: r(tracked),
      estimated_minutes: r(estTotal),
      estimates,
      avg_session_minutes: sessions ? r(tracked / sessions) : 0,
      avg_per_day_minutes: r(tracked / Math.max(1, Math.ceil(span))),
      days_played: [...dayTotals.values()].filter((m) => m >= 1).length,
      longest_session: longest,
      busiest_day: busiest ? { day: busiest[0], minutes: r(busiest[1]) } : null,
      series: [...series.entries()].map(([key, minutes]) => ({ key, minutes: r(minutes), estimated: r(seriesEst.get(key) || 0) })),
      series_by_platform: Object.fromEntries([...byPlat.entries()].map(([p, m]) => [p, [...series.keys()].map((k) => r(m.get(k) || 0))])),
      series_estimated: [...series.keys()].map((k) => r(seriesEst.get(k) || 0)),
      top_games: top.map((x) => ({ ...gameInfo.get(x.game_id), game_id: x.game_id, minutes: r(x.minutes), estimated_minutes: r(x.est || 0), sessions: x.sessions, platforms: String(x.platforms || '').split(','), last: parseDay(x.last_day) })),
      platforms: platforms.map((p) => ({ platform: p.platform, minutes: r(p.minutes) })),
      weekday: weekday.map(r),
      hours: hours.map(r),
      streaks: computeStreaks(dailyTotals(db, { gameId, platform }), now),
    };
  });
}

export function heatmap(db, { year, gameId, estimates = 'include' } = {}) {
  const y = Number(year) || new Date().getFullYear();
  return memo(db, `heat:${y}:${gameId}:${estimates}`, () => {
    const f = filter('p', { fromDay: `${y}-01-01`, toDay: `${y}-12-31`, gameId, estimates });
    const rows = db.prepare(`SELECT p.day, SUM(p.minutes) m, SUM(p.minutes * p.estimated) e ${f.sql} GROUP BY p.day`).all(...f.args);
    return {
      year: y,
      days: Object.fromEntries(rows.map((x) => [x.day, Math.round(x.m)])),
      estimated_days: Object.fromEntries(rows.filter((x) => x.e > 0).map((x) => [x.day, Math.round(x.e)])),
    };
  });
}

export function lifetime(db) {
  return memo(db, 'lifetime', () => {
    const tot = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN excluded = 0 THEN playtime_min END), 0) total,
        COUNT(DISTINCT game_id) games,
        COUNT(DISTINCT CASE WHEN playtime_min > 0 AND excluded = 0 THEN game_id END) played
      FROM entries`).get();
    const kinds = db.prepare('SELECT s.kind, COALESCE(SUM(s.minutes),0) m, COUNT(*) n FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.excluded = 0 GROUP BY s.kind').all();
    const k = Object.fromEntries(kinds.map((x) => [x.kind, x]));
    const status = db.prepare('SELECT status, COUNT(*) n FROM games GROUP BY status').all();
    const byPlatform = db.prepare('SELECT platform, COALESCE(SUM(playtime_min),0) minutes, COUNT(*) games FROM entries WHERE excluded = 0 GROUP BY platform ORDER BY minutes DESC').all();
    return {
      total_minutes: tot.total,
      tracked_minutes: k.play?.m || 0,
      estimated_minutes: k.estimate?.m || 0,
      baseline_minutes: k.baseline?.m || 0,
      sessions: k.play?.n || 0,
      games: tot.games,
      games_played: tot.played,
      status: Object.fromEntries(status.map((s) => [s.status, s.n])),
      platforms: byPlatform,
    };
  });
}

export function yearInReview(db, year, { weekStartsOn = 1, estimates = 'include' } = {}) {
  const y = Number(year);
  return memo(db, `year:${y}:${weekStartsOn}:${estimates}`, () => {
    const s = computeStats(db, { range: `year:${y}`, group: 'month', weekStartsOn, estimates });
    const from = `${y}-01-01`;
    const to = `${y}-12-31`;
    // first-ever play day per game, restricted to games played this year
    const est = estimates === 'exclude' ? '= 0' : 'IN (0, 1)';
    const firstPlays = db.prepare(`WITH played AS (SELECT DISTINCT game_id FROM play_days WHERE excluded = 0 AND estimated ${est} AND day BETWEEN ? AND ?)
      SELECT pl.game_id, g.title, g.cover_url,
        (SELECT MIN(p2.day) FROM play_days p2 WHERE p2.game_id = pl.game_id AND p2.excluded = 0 AND p2.estimated ${est}) first
      FROM played pl JOIN games g ON g.id = pl.game_id`).all(from, to).filter((r) => r.first >= from).sort((a, b) => a.first.localeCompare(b.first));
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const best = [...s.series].sort((a, b) => b.minutes - a.minutes)[0];
    const completed = db.prepare("SELECT COUNT(*) n FROM games WHERE status = 'completed' AND updated_at >= ? AND updated_at < ?").get(new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime()).n;
    let longestStreak = 0; let run = 0; let prev = null;
    for (const k of Object.keys(heatmap(db, { year: y, estimates: 'exclude' }).days).sort()) {
      const t = parseDay(k);
      run = prev != null && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1;
      longestStreak = Math.max(longestStreak, run); prev = t;
    }
    return {
      year: y,
      total_minutes: s.total_minutes,
      tracked_minutes: s.tracked_minutes,
      estimated_minutes: s.estimated_minutes,
      sessions: s.sessions,
      games_played: s.games_played,
      days_played: s.days_played,
      top_games: s.top_games.slice(0, 10),
      platforms: s.platforms,
      months: s.series.map((x) => ({ month: months[Number(x.key.slice(5, 7)) - 1], minutes: x.minutes, estimated: x.estimated })),
      best_month: best && best.minutes ? { month: months[Number(best.key.slice(5, 7)) - 1], minutes: best.minutes } : null,
      busiest_day: s.busiest_day,
      longest_session: s.longest_session,
      longest_streak: longestStreak,
      weekday: s.weekday,
      new_games: firstPlays.length,
      new_game_list: firstPlays.slice(0, 20).map((r) => ({ ...r, first: parseDay(r.first) })),
      completed,
    };
  });
}
