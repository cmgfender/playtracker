// Milestones: the round numbers of a player's history, each with the day it was reached, and the
// ones coming up with how far along they are. A record that only grows: where a fact (facts.js) is
// said in the week it happens, a milestone stays. Dated from tracked play alone - estimated
// history has no real days, so a milestone it would carry has no day to stand on.

import { memo, filter, dayKey, parseDay, dailyTotals } from './stats.js';

const DAY = 86_400_000;
const ACTIVE_DAYS = 90;       // a game played this recently can still be "coming up"
const NEAR = 0.5;             // ... once it is at least half way to its next round number

export const MARKS = {
  hours: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000],  // of tracked play in all
  game_hours: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],      // in one game
  games: [10, 25, 50, 100, 250, 500, 1000, 2500],                 // games played
  days: [10, 50, 100, 250, 365, 500, 1000, 2000, 3650],           // days with play
  sessions: [100, 500, 1000, 2500, 5000, 10000, 25000],
  streak: [7, 14, 30, 50, 100, 200, 365, 500, 1000],              // days in a row
  achievements: [50, 100, 250, 500, 1000, 2500, 5000, 10000],     // unlocked, with a known time
};

const n = (x) => x.toLocaleString('en-US');
const ordinal = (x) => { const t = x % 100; return `${n(x)}${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][x % 10] || 'th'}`; };
const next = (marks, value) => marks.find((m) => m > value) ?? null;

/**
 * { reached: [{ id, kind, text, value, day, game_id?, title? }] newest first (at most `limit`),
 *   counts: { kind: reached of that kind }, total: all reached,
 *   coming: [{ id, kind, text, target, current, percent, game_id?, title? }] nearest first }
 * Kinds: hours, game_hours, games, days, sessions, streak, achievements. Hours are given in hours,
 * `current` in the unit of `target`.
 */
export function milestones(db, { now = Date.now(), limit = 60 } = {}) {
  const today = dayKey(now);
  return memo(db, `milestones:${today}:${limit}`, () => {
    const reached = [];
    const coming = [];
    const hit = (kind, value, day, text, extra = {}) => reached.push({ id: `${kind}:${value}${extra.game_id ? `:${extra.game_id}` : ''}`, kind, text, value, day, ...extra });
    const ahead = (kind, target, current, text, extra = {}) => { if (target != null) coming.push({ id: `${kind}:${target}${extra.game_id ? `:${extra.game_id}` : ''}`, kind, text, target, current: Math.round(current * 10) / 10, percent: Math.min(99, Math.floor((current / target) * 100)), ...extra }); };
    const titles = new Map(db.prepare('SELECT id, title FROM games').all().map((g) => [g.id, g.title]));
    const tracked = filter('p', { estimates: 'exclude' });

    // ---- hours in all, days with play, days in a row: one walk over the days
    const days = [...dailyTotals(db)].filter(([, m]) => m >= 1).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    let minutes = 0; let run = 0; let best = 0; let prev = null;
    days.forEach(([day, m], i) => {
      for (const h of MARKS.hours) if (minutes < h * 60 && minutes + m >= h * 60) hit('hours', h, day, `${n(h)} hours of play`);
      minutes += m;
      if (MARKS.days.includes(i + 1)) hit('days', i + 1, day, `${n(i + 1)} days with play`);
      run = prev != null && Math.round((parseDay(day) - parseDay(prev)) / DAY) === 1 ? run + 1 : 1;
      // a streak's mark counts the first time any streak gets there
      if (run > best) { best = run; if (MARKS.streak.includes(run)) hit('streak', run, day, `${n(run)} days in a row`); }
      prev = day;
    });
    ahead('hours', next(MARKS.hours, minutes / 60), minutes / 60, `${n(next(MARKS.hours, minutes / 60) ?? 0)} hours of play`);
    ahead('days', next(MARKS.days, days.length), days.length, `${n(next(MARKS.days, days.length) ?? 0)} days with play`);
    // the streak under way (it ended yesterday at the latest), towards the next mark no streak has reached
    const last = days.length ? days[days.length - 1][0] : null;
    const live = last && Math.round((parseDay(today) - parseDay(last)) / DAY) <= 1 ? run : 0;
    if (live >= 3 && live / (next(MARKS.streak, best) ?? Infinity) >= 0.25) ahead('streak', next(MARKS.streak, best), live, `${n(next(MARKS.streak, best))} days in a row`);

    // ---- each game: its round numbers, and where it came in the order the games were started
    const rows = db.prepare(`SELECT p.game_id, p.day, SUM(p.minutes) m ${tracked.sql} GROUP BY p.game_id, p.day ORDER BY p.game_id, p.day`).all(...tracked.args);
    const games = []; // { game_id, first, last, minutes }
    let g = null;
    for (const r of rows) {
      if (!titles.has(r.game_id)) continue;
      if (!g || g.game_id !== r.game_id) games.push(g = { game_id: r.game_id, first: r.day, last: r.day, minutes: 0 });
      for (const h of MARKS.game_hours) if (g.minutes < h * 60 && g.minutes + r.m >= h * 60) hit('game_hours', h, r.day, `${n(h)} hours in ${titles.get(r.game_id)}`, { game_id: r.game_id, title: titles.get(r.game_id) });
      g.minutes += r.m; g.last = r.day;
    }
    [...games].sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.game_id - b.game_id))
      .forEach((x, i) => { if (MARKS.games.includes(i + 1)) hit('games', i + 1, x.first, `Your ${ordinal(i + 1)} game: ${titles.get(x.game_id)}`, { game_id: x.game_id, title: titles.get(x.game_id) }); });
    ahead('games', next(MARKS.games, games.length), games.length, `${n(next(MARKS.games, games.length) ?? 0)} games played`);
    // games still being played that are at least half way to their next round number: the three nearest
    const active = dayKey(now - ACTIVE_DAYS * DAY);
    games.filter((x) => x.last >= active).map((x) => ({ x, target: next(MARKS.game_hours, x.minutes / 60) })).filter((y) => y.target && y.x.minutes / 60 / y.target >= NEAR)
      .sort((a, b) => b.x.minutes / 60 / b.target - a.x.minutes / 60 / a.target || a.x.game_id - b.x.game_id).slice(0, 3)
      .forEach(({ x, target }) => ahead('game_hours', target, x.minutes / 60, `${n(target)} hours in ${titles.get(x.game_id)}`, { game_id: x.game_id, title: titles.get(x.game_id) }));

    // ---- sessions and achievements: the day the Nth one came
    const nth = (inner, marks, kind, text) => {
      const total = db.prepare(`SELECT COUNT(*) c FROM (${inner})`).get().c;
      const at = db.prepare(`SELECT t FROM (${inner}) ORDER BY t LIMIT 1 OFFSET ?`);
      for (const m of marks) { if (m > total) break; hit(kind, m, dayKey(at.get(m - 1).t), text(m)); }
      ahead(kind, next(marks, total), total, text(next(marks, total) ?? 0));
    };
    nth("SELECT s.sort_time t FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE s.kind = 'play' AND s.minutes > 0 AND e.excluded = 0", MARKS.sessions, 'sessions', (m) => `${n(m)} sessions`);
    nth('SELECT a.unlocked_at t FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE a.unlocked = 1 AND a.unlocked_at IS NOT NULL AND e.excluded = 0', MARKS.achievements, 'achievements', (m) => `${n(m)} achievements unlocked`);

    // newest first; of one day, the larger numbers first
    reached.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.value - a.value || a.id.localeCompare(b.id)));
    coming.sort((a, b) => b.percent - a.percent || a.id.localeCompare(b.id));
    const counts = {};
    for (const r of reached) counts[r.kind] = (counts[r.kind] || 0) + 1;
    return { day: today, total: reached.length, counts, reached: reached.slice(0, limit), coming };
  });
}
