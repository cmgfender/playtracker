// Milestones: the round numbers of a player's history, each with the day it was reached, and the
// ones coming up with how far along they are. A record that only grows: where a fact (facts.js) is
// said in the week it happens, a milestone stays.
//
// A career of forty hours and one of forty thousand both have to find themselves here, so
//  - every ladder starts low and climbs far (ten hours of play ... fifty thousand);
//  - what counts as notable is measured against the career itself: of each kind, the three highest
//    rungs this player has reached. "10 hours in a game" is a milestone of a first month and noise
//    in a library with a hundred such games - there, "1,000 hours in a game" is the news;
//  - there are many things to count: play in all, in a game, in a series, in a genre; games, days,
//    sessions and streaks; achievements, completions, platinums, Gamerscore and rare unlocks.
//
// Dated from tracked play alone - estimated history has no real days, so a milestone it would
// carry has no day to stand on. Achievement milestones need the time of the unlock.

import { memo, filter, dayKey, parseDay, dailyTotals } from './stats.js';
import { seriesOf } from './series.js';

const DAY = 86_400_000;
const ACTIVE_DAYS = 90;       // played this recently, a game / series / genre can still be "coming up"
const NEAR = 0.5;             // ... once it is at least half way to its next round number
const NOTABLE_RUNGS = 3;      // of each kind, the highest rungs reached that are shown first
const RARE_PERCENT = 5;       // an achievement this few players have

export const MARKS = {
  hours: [10, 25, 50, 100, 250, 500, 1000, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 50000], // of tracked play in all
  game_hours: [10, 25, 50, 100, 250, 500, 1000, 2000, 3000, 5000, 10000],   // in one game
  series_hours: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],       // in the games of one series
  genre_hours: [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000],     // in the games of one genre
  games: [5, 10, 25, 50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000], // games played
  series_games: [3, 5, 10, 15, 20, 30, 50],                                 // games played of one series
  genre_games: [5, 10, 25, 50, 100, 250, 500, 1000],
  days: [10, 25, 50, 100, 200, 365, 500, 730, 1000, 1500, 2000, 3000, 3650, 5000], // days with play
  sessions: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000],
  streak: [7, 14, 30, 50, 100, 200, 365, 500, 730, 1000],                   // days in a row
  achievements: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000], // unlocked
  completions: [1, 5, 10, 25, 50, 100, 250, 500],                           // games with every achievement, or the platinum
  platinums: [1, 5, 10, 25, 50, 100, 250],
  gamerscore: [1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000],
  rare: [1, 10, 25, 50, 100, 250, 500, 1000],                               // unlocks under RARE_PERCENT % of players
};

const n = (x) => x.toLocaleString('en-US');
const ordinal = (x) => { const t = x % 100; return `${n(x)}${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][x % 10] || 'th'}`; };
const nextMark = (marks, value) => marks.find((m) => m > value) ?? null;

/** How each kind is said, for a mark `v` and its subject (a game, a series, a genre). */
const TEXT = {
  hours: (v) => `${n(v)} hours of play`,
  game_hours: (v, s) => `${n(v)} hours in ${s}`,
  series_hours: (v, s) => `${n(v)} hours in the ${s} series`,
  genre_hours: (v, s) => `${n(v)} hours of ${s} games`,
  games: (v, s) => (s ? `Your ${ordinal(v)} game: ${s}` : `${n(v)} games played`),
  series_games: (v, s) => `${n(v)} games of the ${s} series`,
  genre_games: (v, s) => `${n(v)} ${s} games`,
  days: (v) => `${n(v)} days with play`,
  sessions: (v) => `${n(v)} sessions`,
  streak: (v) => `${n(v)} days in a row`,
  achievements: (v) => `${n(v)} achievements unlocked`,
  completions: (v, s) => (v === 1 ? `Your first completed game${s ? `: ${s}` : ''}` : `${n(v)} games completed`),
  platinums: (v, s) => (v === 1 ? `Your first platinum${s ? `: ${s}` : ''}` : `${n(v)} platinum trophies`),
  gamerscore: (v) => `${n(v)} Gamerscore`,
  rare: (v) => (v === 1 ? 'Your first rare achievement' : `${n(v)} rare achievements`),
};

/**
 * { day, total, notable_total, counts: { kind: reached }, reached: [{ id, kind, text, value, tier,
 *   notable, day, subject?, game_id?, title? }] newest first, coming: [{ id, kind, text, target,
 *   current, percent, subject?, game_id?, title? }] nearest first }
 * `reached` holds the notable ones (see NOTABLE_RUNGS) unless `all`; `limit` cuts it. `tier` is
 * the rung on the kind's ladder (1 = the first). Hours are in hours; `current` in the unit of `target`.
 */
export function milestones(db, { now = Date.now(), limit = 60, all = false } = {}) {
  const today = dayKey(now);
  return memo(db, `milestones:${today}:${limit}:${all}`, () => {
    const reached = [];
    const coming = [];
    const hit = (kind, value, day, subject = null, extra = {}) => reached.push({
      id: `${kind}:${value}${extra.game_id ? `:${extra.game_id}` : subject && kind !== 'games' ? `:${subject}` : ''}`,
      kind, text: TEXT[kind](value, subject), value, tier: MARKS[kind].indexOf(value) + 1, day, ...(subject && !extra.game_id ? { subject } : {}), ...extra,
    });
    const ahead = (kind, current, subject = null, extra = {}) => {
      const target = nextMark(MARKS[kind], current);
      if (target == null) return;
      coming.push({
        id: `${kind}:${target}${extra.game_id ? `:${extra.game_id}` : subject ? `:${subject}` : ''}`, kind, text: TEXT[kind](target, kind === 'games' ? null : subject),
        target, current: Math.round(current * 10) / 10, percent: Math.min(99, Math.floor((current / target) * 100)), ...(subject && !extra.game_id ? { subject } : {}), ...extra,
      });
    };
    /** Marks of `kind` passed when a running total goes from `before` to `after` (in the unit of the marks). */
    const crossed = (kind, before, after) => MARKS[kind].filter((m) => before < m && after >= m);
    const titles = new Map(db.prepare('SELECT id, title FROM games').all().map((g) => [g.id, g.title]));
    const tracked = filter('p', { estimates: 'exclude' });

    // ---- hours in all, days with play, days in a row: one walk over the days
    const days = [...dailyTotals(db)].filter(([, m]) => m >= 1).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    let minutes = 0; let run = 0; let best = 0; let prev = null;
    days.forEach(([day, m], i) => {
      for (const h of crossed('hours', minutes / 60, (minutes + m) / 60)) hit('hours', h, day);
      minutes += m;
      if (MARKS.days.includes(i + 1)) hit('days', i + 1, day);
      run = prev != null && Math.round((parseDay(day) - parseDay(prev)) / DAY) === 1 ? run + 1 : 1;
      // a streak's mark counts the first time any streak gets there
      if (run > best) { best = run; if (MARKS.streak.includes(run)) hit('streak', run, day); }
      prev = day;
    });
    ahead('hours', minutes / 60);
    ahead('days', days.length);
    // the streak under way (it ended yesterday at the latest), towards the next mark no streak has reached
    const last = days.length ? days[days.length - 1][0] : null;
    const live = last && Math.round((parseDay(today) - parseDay(last)) / DAY) <= 1 ? run : 0;
    const streakTarget = nextMark(MARKS.streak, best);
    if (live >= 3 && streakTarget && live / streakTarget >= 0.25) coming.push({ id: `streak:${streakTarget}`, kind: 'streak', text: TEXT.streak(streakTarget), target: streakTarget, current: live, percent: Math.min(99, Math.floor((live / streakTarget) * 100)) });

    // ---- games, and the series and genres they belong to: one walk over every (day, game)
    const series = seriesOf(db);
    const genres = new Map();
    for (const t of db.prepare("SELECT game_id, name FROM game_tags WHERE kind = 'genre' ORDER BY game_id, name").all()) { if (!genres.has(t.game_id)) genres.set(t.game_id, []); genres.get(t.game_id).push(t.name); }
    const rows = db.prepare(`SELECT p.day, p.game_id, SUM(p.minutes) m ${tracked.sql} GROUP BY p.day, p.game_id ORDER BY p.day, p.game_id`).all(...tracked.args);
    const game = new Map();   // game id -> { minutes, last }
    const group = { series: new Map(), genre: new Map() }; // name -> { minutes, games, last }
    let started = 0;
    for (const r of rows) {
      const title = titles.get(r.game_id);
      if (title == null) continue;
      const of = { series: series.get(r.game_id) || [], genre: genres.get(r.game_id) || [] };
      let g = game.get(r.game_id);
      if (!g) {
        game.set(r.game_id, g = { minutes: 0, last: r.day });
        started++;
        if (MARKS.games.includes(started)) hit('games', started, r.day, title, { game_id: r.game_id, title });
        for (const k of ['series', 'genre']) {
          for (const name of of[k]) {
            const s = group[k].get(name) || { minutes: 0, games: 0, last: r.day };
            group[k].set(name, s);
            s.games++;
            if (MARKS[`${k}_games`].includes(s.games)) hit(`${k}_games`, s.games, r.day, name);
          }
        }
      }
      for (const h of crossed('game_hours', g.minutes / 60, (g.minutes + r.m) / 60)) hit('game_hours', h, r.day, title, { game_id: r.game_id, title });
      g.minutes += r.m; g.last = r.day;
      for (const k of ['series', 'genre']) {
        for (const name of of[k]) {
          const s = group[k].get(name);
          for (const h of crossed(`${k}_hours`, s.minutes / 60, (s.minutes + r.m) / 60)) hit(`${k}_hours`, h, r.day, name);
          s.minutes += r.m; s.last = r.day;
        }
      }
    }
    ahead('games', game.size);
    // still being played and at least half way to the next round number: the three nearest of each kind
    const active = dayKey(now - ACTIVE_DAYS * DAY);
    const nearest = (kind, items) => items.filter((x) => x.last >= active).map((x) => ({ x, target: nextMark(MARKS[kind], x.value) }))
      .filter((y) => y.target && y.x.value / y.target >= NEAR).sort((a, b) => b.x.value / b.target - a.x.value / a.target || (a.x.key < b.x.key ? -1 : 1)).slice(0, 3);
    for (const { x } of nearest('game_hours', [...game].map(([id, g]) => ({ key: id, value: g.minutes / 60, last: g.last })))) ahead('game_hours', x.value, titles.get(x.key), { game_id: x.key, title: titles.get(x.key) });
    for (const k of ['series', 'genre']) {
      for (const { x } of nearest(`${k}_hours`, [...group[k]].map(([name, s]) => ({ key: name, value: s.minutes / 60, last: s.last })))) ahead(`${k}_hours`, x.value, x.key);
      for (const { x } of nearest(`${k}_games`, [...group[k]].map(([name, s]) => ({ key: name, value: s.games, last: s.last })))) ahead(`${k}_games`, x.value, x.key);
    }

    // ---- sessions: the day the Nth one came
    const sessionsSql = "FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE s.kind = 'play' AND s.minutes > 0 AND e.excluded = 0";
    const sessions = db.prepare(`SELECT COUNT(*) c ${sessionsSql}`).get().c;
    const sessionAt = db.prepare(`SELECT s.sort_time t ${sessionsSql} ORDER BY s.sort_time LIMIT 1 OFFSET ?`);
    for (const m of MARKS.sessions) { if (m > sessions) break; hit('sessions', m, dayKey(sessionAt.get(m - 1).t)); }
    ahead('sessions', sessions);

    // ---- achievements, in the order they were unlocked: how many, how rare, their Gamerscore
    const unlocks = db.prepare(`SELECT a.unlocked_at t, a.rarity, a.points FROM achievements a JOIN entries e ON e.id = a.entry_id
      WHERE a.unlocked = 1 AND a.unlocked_at IS NOT NULL AND e.excluded = 0 ORDER BY a.unlocked_at, a.id`).all();
    let rare = 0; let score = 0;
    unlocks.forEach((u, i) => {
      const day = dayKey(u.t);
      if (MARKS.achievements.includes(i + 1)) hit('achievements', i + 1, day);
      if (u.rarity != null && u.rarity <= RARE_PERCENT) { rare++; if (MARKS.rare.includes(rare)) hit('rare', rare, day); }
      if (u.points) { for (const m of crossed('gamerscore', score, score + u.points)) hit('gamerscore', m, day); score += u.points; }
    });
    ahead('achievements', unlocks.length);
    if (rare) ahead('rare', rare);
    if (score) ahead('gamerscore', score);

    // ---- completions (every achievement, or the platinum) and platinums, once per game, by their day
    const sets = db.prepare(`SELECT e.game_id, COUNT(*) total, SUM(a.unlocked) unlocked, MAX(a.unlocked_at) last,
        SUM(CASE WHEN a.unlocked = 1 AND a.unlocked_at IS NULL THEN 1 ELSE 0 END) undated,
        MIN(CASE WHEN a.unlocked = 1 AND a.grade = 'platinum' THEN a.unlocked_at END) platinum_at
      FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.excluded = 0 GROUP BY a.entry_id`).all();
    const firstOf = (pick) => {
      const at = new Map();
      for (const s of sets) { const t = pick(s); if (t != null && titles.has(s.game_id) && (!at.has(s.game_id) || t < at.get(s.game_id))) at.set(s.game_id, t); }
      return [...at].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    };
    // (a set unlocked at times the platform does not know has no day: it is not counted)
    const done = firstOf((s) => { const whole = s.total > 0 && s.unlocked === s.total && !s.undated ? s.last : null; return whole != null && s.platinum_at != null ? Math.min(whole, s.platinum_at) : whole ?? s.platinum_at; });
    const first = (i, id) => (i === 0 ? [titles.get(id), { game_id: id, title: titles.get(id) }] : [null, {}]);
    done.forEach(([id, t], i) => { if (MARKS.completions.includes(i + 1)) hit('completions', i + 1, dayKey(t), ...first(i, id)); });
    if (sets.length) ahead('completions', done.length);
    const plats = firstOf((s) => s.platinum_at);
    plats.forEach(([id, t], i) => { if (MARKS.platinums.includes(i + 1)) hit('platinums', i + 1, dayKey(t), ...first(i, id)); });
    if (plats.length) ahead('platinums', plats.length);

    // ---- notable: of each kind, the highest rungs this player has reached
    const top = {};
    for (const r of reached) top[r.kind] = Math.max(top[r.kind] || 0, r.tier);
    for (const r of reached) r.notable = r.tier > top[r.kind] - NOTABLE_RUNGS;
    // newest first; of one day, the higher rungs first
    reached.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.tier - a.tier || a.id.localeCompare(b.id)));
    coming.sort((a, b) => b.percent - a.percent || a.id.localeCompare(b.id));
    const counts = {};
    for (const r of reached) counts[r.kind] = (counts[r.kind] || 0) + 1;
    const shown = all ? reached : reached.filter((r) => r.notable);
    return { day: today, total: reached.length, notable_total: reached.filter((r) => r.notable).length, counts, reached: shown.slice(0, limit), coming };
  });
}
