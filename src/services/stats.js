// Stats are computed from 'play' sessions. A session only tells us minutes played inside a
// window (the time between two syncs); when the exact time is unknown the minutes are spread
// evenly across the window so weekly/monthly syncs still yield sensible daily charts.

const MIN = 60_000;
const DAY = 86_400_000;

export function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

export function loadPlaySessions(db, { from = 0, to = Date.now() + DAY, gameId, platform, accountId } = {}) {
  const where = ["s.kind = 'play'", 'e.excluded = 0', 'COALESCE(s.window_end, s.ended_at, s.created_at) >= ?', 'COALESCE(s.window_start, s.started_at, s.created_at) <= ?'];
  const args = [from, to];
  if (gameId) { where.push('e.game_id = ?'); args.push(gameId); }
  if (platform) { where.push('e.platform = ?'); args.push(platform); }
  if (accountId) { where.push('e.account_id = ?'); args.push(accountId); }
  return db.prepare(`SELECT s.*, e.game_id, e.platform, e.account_id, g.title, g.cover_url
    FROM sessions s JOIN entries e ON e.id = s.entry_id JOIN games g ON g.id = e.game_id
    WHERE ${where.join(' AND ')}`).all(...args);
}

export function resolveRange(range, now = Date.now()) {
  const r = String(range || '30d');
  let m;
  if ((m = /^(\d+)d$/.exec(r))) return { from: startOfDay(now - (Number(m[1]) - 1) * DAY), to: now, label: `Last ${m[1]} days` };
  if ((m = /^year:(\d{4})$/.exec(r))) {
    const y = Number(m[1]);
    return { from: new Date(y, 0, 1).getTime(), to: Math.min(now, new Date(y + 1, 0, 1).getTime()), label: String(y) };
  }
  if ((m = /^month:(\d{4})-(\d{2})$/.exec(r))) {
    const y = Number(m[1]); const mo = Number(m[2]) - 1;
    return { from: new Date(y, mo, 1).getTime(), to: Math.min(now, new Date(y, mo + 1, 1).getTime()), label: `${y}-${m[2]}` };
  }
  if (r === 'week') { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return { from: d.getTime(), to: now, label: 'This week' }; }
  if (r === 'month') { const d = new Date(now); return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now, label: 'This month' }; }
  if (r === 'year') { const d = new Date(now); return { from: new Date(d.getFullYear(), 0, 1).getTime(), to: now, label: 'This year' }; }
  if (r === 'all') return { from: 0, to: now, label: 'All time' };
  return resolveRange('30d', now);
}

function groupKey(dayStart, group, weekStartsOn) {
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

function emptySeries(from, to, group, weekStartsOn) {
  const keys = [];
  const seen = new Set();
  for (let d = startOfDay(from); d <= to; d = nextDay(d)) {
    const k = groupKey(d, group, weekStartsOn);
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
    if (keys.length > 2000) break;
  }
  return keys;
}

export function computeStreaks(dayMinutes, now = Date.now()) {
  const days = [...dayMinutes.entries()].filter(([, m]) => m >= 1).map(([k]) => k).sort();
  let longest = 0; let longestEnd = null; let run = 0; let prev = null;
  for (const k of days) {
    const t = new Date(`${k}T12:00:00`).getTime();
    run = prev != null && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1;
    if (run > longest) { longest = run; longestEnd = k; }
    prev = t;
  }
  // current streak: ending today or yesterday
  let current = 0;
  let cursor = startOfDay(now);
  if (!dayMinutes.has(dayKey(cursor)) || dayMinutes.get(dayKey(cursor)) < 1) cursor -= DAY;
  while ((dayMinutes.get(dayKey(cursor)) || 0) >= 1) { current++; cursor = startOfDay(cursor - DAY / 2); }
  return { current, longest, longest_end: longestEnd };
}

export function computeStats(db, { range = '30d', group, gameId, platform, weekStartsOn = 1, now = Date.now() } = {}) {
  let { from, to, label } = resolveRange(range, now);
  if (from === 0) {
    const first = db.prepare("SELECT MIN(COALESCE(s.started_at, s.window_start, s.window_end)) t FROM sessions s WHERE s.kind = 'play'").get().t;
    from = startOfDay(first || now);
  }
  const span = (to - from) / DAY;
  const g = group || (span <= 45 ? 'day' : span <= 200 ? 'week' : span <= 1100 ? 'month' : 'year');
  const sessions = loadPlaySessions(db, { from, to, gameId, platform });

  const series = new Map(emptySeries(from, to, g, weekStartsOn).map((k) => [k, 0]));
  const seriesByPlatform = new Map();
  const games = new Map();
  const platforms = new Map();
  const weekday = Array(7).fill(0);
  const hours = Array(24).fill(0);
  let total = 0;
  let longest = null;
  const dayTotals = new Map();
  let inRangeSessions = 0;

  for (const s of sessions) {
    const parts = spreadByDay(s, from, to);
    const mins = parts.reduce((a, p) => a + p[1], 0);
    if (mins <= 0) continue;
    inRangeSessions++;
    total += mins;
    for (const [k, m, d] of parts) {
      const gk = groupKey(d, g, weekStartsOn);
      series.set(gk, (series.get(gk) || 0) + m);
      if (!seriesByPlatform.has(s.platform)) seriesByPlatform.set(s.platform, new Map());
      const sp = seriesByPlatform.get(s.platform);
      sp.set(gk, (sp.get(gk) || 0) + m);
      weekday[new Date(d).getDay()] += m;
      dayTotals.set(k, (dayTotals.get(k) || 0) + m);
    }
    if (s.started_at && s.ended_at) {
      const len = s.ended_at - s.started_at;
      for (let t = s.started_at; t < s.ended_at; t += MIN * 15) hours[new Date(t).getHours()] += (s.minutes * Math.min(MIN * 15, s.ended_at - t)) / len;
    }
    const gm = games.get(s.game_id) || { game_id: s.game_id, title: s.title, cover_url: s.cover_url, minutes: 0, sessions: 0, platforms: new Set(), last: 0 };
    gm.minutes += mins; gm.sessions++; gm.platforms.add(s.platform); gm.last = Math.max(gm.last, s.ended_at || s.window_end || 0);
    games.set(s.game_id, gm);
    platforms.set(s.platform, (platforms.get(s.platform) || 0) + mins);
    if (!longest || s.minutes > longest.minutes) longest = { minutes: s.minutes, title: s.title, game_id: s.game_id, ended_at: s.ended_at || s.window_end };
  }

  const r = (x) => Math.round(x);
  const busiest = [...dayTotals.entries()].sort((a, b) => b[1] - a[1])[0];
  const allDays = new Map();
  for (const s of loadPlaySessions(db, { from: 0, to: now, gameId, platform })) for (const [k, m] of spreadByDay(s)) allDays.set(k, (allDays.get(k) || 0) + m);

  return {
    range: { from, to, label, group: g },
    total_minutes: r(total),
    sessions: inRangeSessions,
    games_played: games.size,
    avg_session_minutes: inRangeSessions ? r(total / inRangeSessions) : 0,
    avg_per_day_minutes: r(total / Math.max(1, Math.ceil(span))),
    days_played: [...dayTotals.values()].filter((m) => m >= 1).length,
    longest_session: longest,
    busiest_day: busiest ? { day: busiest[0], minutes: r(busiest[1]) } : null,
    series: [...series.entries()].map(([key, minutes]) => ({ key, minutes: r(minutes) })),
    series_by_platform: Object.fromEntries([...seriesByPlatform.entries()].map(([p, m]) => [p, [...series.keys()].map((k) => r(m.get(k) || 0))])),
    top_games: [...games.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 25)
      .map((x) => ({ ...x, minutes: r(x.minutes), platforms: [...x.platforms] })),
    platforms: [...platforms.entries()].map(([platform, minutes]) => ({ platform, minutes: r(minutes) })).sort((a, b) => b.minutes - a.minutes),
    weekday: weekday.map(r),
    hours: hours.map(r),
    streaks: computeStreaks(allDays, now),
  };
}

export function heatmap(db, { year, gameId } = {}) {
  const y = Number(year) || new Date().getFullYear();
  const from = new Date(y, 0, 1).getTime();
  const to = new Date(y + 1, 0, 1).getTime();
  const days = new Map();
  for (const s of loadPlaySessions(db, { from, to, gameId })) {
    for (const [k, m] of spreadByDay(s, from, to)) days.set(k, (days.get(k) || 0) + m);
  }
  return { year: y, days: Object.fromEntries([...days.entries()].map(([k, m]) => [k, Math.round(m)])) };
}

export function lifetime(db) {
  const tot = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN e.excluded = 0 THEN e.playtime_min END), 0) total,
      COUNT(DISTINCT e.game_id) games,
      COUNT(DISTINCT CASE WHEN e.playtime_min > 0 AND e.excluded = 0 THEN e.game_id END) played
    FROM entries e`).get();
  const kinds = db.prepare(`SELECT s.kind, COALESCE(SUM(s.minutes),0) m, COUNT(*) n FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.excluded = 0 GROUP BY s.kind`).all();
  const k = Object.fromEntries(kinds.map((x) => [x.kind, x]));
  const status = db.prepare('SELECT status, COUNT(*) n FROM games GROUP BY status').all();
  const byPlatform = db.prepare(`SELECT platform, COALESCE(SUM(playtime_min),0) minutes, COUNT(*) games FROM entries WHERE excluded = 0 GROUP BY platform ORDER BY minutes DESC`).all();
  return {
    total_minutes: tot.total,
    tracked_minutes: k.play?.m || 0,
    baseline_minutes: k.baseline?.m || 0,
    sessions: k.play?.n || 0,
    games: tot.games,
    games_played: tot.played,
    status: Object.fromEntries(status.map((s) => [s.status, s.n])),
    platforms: byPlatform,
  };
}

export function yearInReview(db, year, { weekStartsOn = 1 } = {}) {
  const y = Number(year);
  const s = computeStats(db, { range: `year:${y}`, group: 'month', weekStartsOn });
  const from = new Date(y, 0, 1).getTime();
  const to = new Date(y + 1, 0, 1).getTime();
  const firstPlays = db.prepare(`SELECT e.game_id, g.title, g.cover_url, MIN(COALESCE(s.started_at, s.window_end)) first
    FROM sessions s JOIN entries e ON e.id = s.entry_id JOIN games g ON g.id = e.game_id
    WHERE s.kind = 'play' AND e.excluded = 0 GROUP BY e.game_id HAVING first >= ? AND first < ? ORDER BY first`).all(from, to);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const best = [...s.series].sort((a, b) => b.minutes - a.minutes)[0];
  const completed = db.prepare("SELECT COUNT(*) n FROM games WHERE status = 'completed' AND updated_at >= ? AND updated_at < ?").get(from, to).n;
  const hm = heatmap(db, { year: y });
  const dm = new Map(Object.entries(hm.days));
  let longestStreak = 0; let run = 0; let prev = null;
  for (const k of [...dm.keys()].sort()) {
    const t = new Date(`${k}T12:00:00`).getTime();
    run = prev != null && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run); prev = t;
  }
  return {
    year: y,
    total_minutes: s.total_minutes,
    sessions: s.sessions,
    games_played: s.games_played,
    days_played: s.days_played,
    top_games: s.top_games.slice(0, 10),
    platforms: s.platforms,
    months: s.series.map((x) => ({ month: months[Number(x.key.slice(5, 7)) - 1], minutes: x.minutes })),
    best_month: best && best.minutes ? { month: months[Number(best.key.slice(5, 7)) - 1], minutes: best.minutes } : null,
    busiest_day: s.busiest_day,
    longest_session: s.longest_session,
    longest_streak: longestStreak,
    weekday: s.weekday,
    new_games: firstPlays.length,
    new_game_list: firstPlays.slice(0, 20),
    completed,
  };
}
