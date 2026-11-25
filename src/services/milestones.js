// Career milestones: the round numbers of a whole gaming life, each with the day it was reached
// as precisely as the evidence allows, and the ones coming up.
//
// A career reaches back long before tracking began, so every source of dates is used:
//  - tracked play and imported sessions: the day;
//  - achievement and trophy unlocks, a platform's first played date: the moment;
//  - estimated history (see inference.js): its day is a spread of hours over a window, so a
//    milestone it carries is said "around March 2015" when the window rests on unlocks or on your
//    dates, and "in 2015" when it rests on less;
//  - undated history counts toward totals, and a milestone only it reaches has no date at all.
// Streaks, days with play, sessions and their times of day need real days: tracked play only.
//
// Varied on purpose, like a music service's listening milestones: playtime in all, by year and by
// platform; the library (games played, platforms, decades of releases, old games, launch days);
// genres; series; achievements; the career itself (its years and decades); habits. A single game
// is a milestone only at a hundred hours and up. What counts as notable is measured against the
// career: of each kind, the three highest rungs this player has reached (and every career first).

import { memo, dayKey, parseDay } from './stats.js';
import { seriesOf } from './series.js';

// a time before 1971 is a placeholder (Steam reports 1 Jan 1970 + a day for games last played before it kept dates)
const realTime = (t) => (Number.isFinite(t) && t >= Date.UTC(1971, 0, 1) ? t : null);

const DAY = 86_400_000;
const YEAR = 365.25 * DAY;
const ACTIVE_DAYS = 90;       // played this recently, a game / series / genre / platform can be "coming up"
const NEAR = 0.5;             // ... once it is at least half way to its next round number
const NOTABLE_RUNGS = 3;      // of each kind, the highest rungs reached that are shown first
const RARE_PERCENT = 5;       // an achievement this few players have
const ULTRA_PERCENT = 1;

export const MARKS = {
  // playtime
  hours: [10, 50, 100, 250, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7500, 10000, 12500, 15000, 20000, 25000, 30000, 40000, 50000],
  year_hours: [100, 250, 500, 750, 1000, 1500, 2000, 3000],          // in one calendar year
  platform_hours: [100, 250, 500, 1000, 2500, 5000, 10000, 25000],   // on one platform
  game_hours: [100, 250, 500, 1000, 2000, 3000, 5000, 10000],        // one game: only the extremes
  // library
  games: [1, 10, 25, 50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000], // games played (the 1st is your first game)
  platforms: [2, 3, 4, 5, 6, 8],
  release_decades: [2, 3, 4, 5, 6],                                  // decades of release among the games played
  retro: [10, 20, 25, 30, 40],                                       // a game this many years old when first played
  day_one: [1, 5, 10, 25, 50, 100],                                  // games first played on their release day
  // genres and series
  genres: [5, 10, 15, 20, 25],                                       // genres played
  genre_hours: [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  genre_games: [5, 10, 25, 50, 100, 250, 500],
  series: [5, 10, 25, 50, 100, 200],                                 // series played
  series_hours: [25, 50, 100, 250, 500, 1000, 2500, 5000],
  series_games: [3, 5, 10, 15, 20, 30, 50],
  series_years: [5, 10, 15, 20, 25, 30],                             // from the first play of a series to a later one
  // achievements
  achievements: [1, 100, 500, 1000, 2500, 5000, 7500, 10000, 15000, 20000, 25000, 50000],
  ach_games: [10, 50, 100, 250, 500, 1000],                          // games with at least one unlock
  ach_day: [25, 50, 100, 200],                                       // unlocks in a single day
  rare: [1, 10, 50, 100, 250, 500, 1000],
  ultra_rare: [1, 10, 25, 50, 100],
  gamerscore: [1000, 5000, 10000, 25000, 50000, 75000, 100000, 150000, 250000, 500000, 1000000],
  completions: [1, 5, 10, 25, 50, 100, 250, 500],                    // games with every achievement, or the platinum
  platinums: [1, 5, 10, 25, 50, 100, 250],
  // the career
  career_years: [1, 5, 10, 15, 20, 25, 30, 40, 50],                  // since the first known play
  decades: [2, 3, 4, 5],                                             // decades with play
  // habits (tracked play only)
  days: [10, 50, 100, 250, 365, 500, 1000, 2000, 3650],
  streak: [7, 14, 30, 50, 100, 200, 365, 500],
  sessions: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  long_session: [3, 5, 8, 12],                                       // hours in one session
  night: [1, 10, 50, 100, 250],                                      // sessions still going at 3 am
};

export const CATEGORY = {
  hours: 'playtime', year_hours: 'playtime', platform_hours: 'playtime', game_hours: 'playtime',
  games: 'library', platforms: 'library', release_decades: 'library', retro: 'library', day_one: 'library',
  genres: 'genres', genre_hours: 'genres', genre_games: 'genres',
  series: 'series', series_hours: 'series', series_games: 'series', series_years: 'series',
  achievements: 'achievements', ach_games: 'achievements', ach_day: 'achievements', rare: 'achievements', ultra_rare: 'achievements', gamerscore: 'achievements', completions: 'achievements', platinums: 'achievements',
  career_years: 'career', decades: 'career',
  days: 'habits', streak: 'habits', sessions: 'habits', long_session: 'habits', night: 'habits',
};
export const CATEGORIES = ['playtime', 'library', 'genres', 'series', 'achievements', 'career', 'habits'];
// kinds counted per year, platform, game, genre or series
const PER_SUBJECT = new Set(['year_hours', 'platform_hours', 'game_hours', 'genre_hours', 'genre_games', 'series_hours', 'series_games', 'series_years']);

const PLATFORM = { steam: 'Steam', xbox: 'Xbox', psn: 'PlayStation', nintendo: 'Nintendo Switch', switch: 'Nintendo Switch', epic: 'Epic', gog: 'GOG' };
const platformName = (p) => PLATFORM[p] || (p ? p.replace(/^\w/, (c) => c.toUpperCase()) : p);
const n = (x) => x.toLocaleString('en-US');
const ordinal = (x) => { const t = x % 100; return `${n(x)}${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][x % 10] || 'th'}`; };
/** "the 90s", "the 2000s", "the 2010s" */
const decadeName = (y) => { const d = Math.floor(y / 10) * 10; return d >= 2000 ? `the ${d}s` : `the ${String(d).slice(2)}s`; };
/** The highest mark of `kind` above `from` that `value` reaches (one event, one milestone: a 30-year-old game is not also 10, 20 and 25 years old that day). */
const topMark = (kind, from, value) => MARKS[kind].filter((m) => m > from && value >= m).at(-1) ?? null;
const nextMark = (marks, value) => marks.find((m) => m > value) ?? null;

/** How each kind is said, for a mark `v` and its subject. */
const TEXT = {
  hours: (v) => `${n(v)} hours of play`,
  year_hours: (v, s) => `${n(v)} hours in ${s}`,
  platform_hours: (v, s) => `${n(v)} hours on ${s}`,
  game_hours: (v, s) => `${n(v)} hours in ${s}`,
  games: (v, s) => (v === 1 ? `Your first game${s ? `: ${s}` : ''}` : s ? `Your ${ordinal(v)} game: ${s}` : `${n(v)} games played`),
  platforms: (v, s) => (s ? `Your ${ordinal(v)} platform: ${s}` : `${n(v)} platforms`),
  release_decades: (v, s) => `Games from ${n(v)} decades${s ? `: ${s}` : ''}`,
  retro: (v, s) => `A ${n(v)}-year-old game${s ? `: ${s}` : ''}`,
  day_one: (v, s) => (v === 1 ? `Your first launch-day game${s ? `: ${s}` : ''}` : `${n(v)} games on launch day`),
  genres: (v, s) => (s ? `Your ${ordinal(v)} genre: ${s}` : `${n(v)} genres`),
  genre_hours: (v, s) => `${n(v)} hours of ${s}`,
  genre_games: (v, s) => `${n(v)} ${s} games`,
  series: (v, s) => (s ? `Your ${ordinal(v)} series: ${s}` : `${n(v)} series`),
  series_hours: (v, s) => `${n(v)} hours in the ${s} series`,
  series_games: (v, s) => `${n(v)} games of the ${s} series`,
  series_years: (v, s) => `${n(v)} years of ${s}`,
  achievements: (v, s) => (v === 1 ? `Your first achievement${s ? `: ${s}` : ''}` : `${n(v)} achievements`),
  ach_games: (v) => `Achievements in ${n(v)} games`,
  ach_day: (v) => `${n(v)} achievements in one day`,
  rare: (v) => (v === 1 ? 'Your first rare achievement' : `${n(v)} rare achievements`),
  ultra_rare: (v) => (v === 1 ? 'Your first ultra-rare achievement' : `${n(v)} ultra-rare achievements`),
  gamerscore: (v) => `${n(v)} Gamerscore`,
  completions: (v, s) => (v === 1 ? `Your first completed game${s ? `: ${s}` : ''}` : `${n(v)} games completed`),
  platinums: (v, s) => (v === 1 ? `Your first platinum${s ? `: ${s}` : ''}` : `${n(v)} platinum trophies`),
  career_years: (v) => (v === 1 ? 'A year of gaming' : `${n(v)} years of gaming`),
  decades: (v, s) => `Playing in ${n(v)} decades${s ? `: ${s}` : ''}`,
  days: (v) => `${n(v)} days with tracked play`,
  streak: (v) => `${n(v)} days in a row`,
  sessions: (v) => `${n(v)} sessions`,
  long_session: (v) => `A ${n(v)}-hour session`,
  night: (v) => (v === 1 ? 'Still playing at 3 am' : `${n(v)} nights still playing at 3 am`),
};

/** How a day of play is known: play_days.basis (0 tracked, 1 imported, 2 an estimate an unlock is in, 3 one you confirmed, 4 another estimate). */
const PRECISION = { 0: 'day', 1: 'day', 2: 'month', 3: 'month', 4: 'year' };
const BASIS = (b) => (b <= 1 ? 'tracked' : 'estimated');
const PREC_RANK = { day: 0, month: 1, year: 2 };
const later = (a, b) => (a == null ? b : b == null ? a : a > b ? a : b);

/**
 * { day, first_day, total, notable_total, counts: { kind: n }, categories: { category: n }, years: [{ year, n }],
 *   reached: [{ id, kind, category, text, value, tier, notable, day (YYYY-MM-DD) | null, precision: day|month|year|null,
 *     basis: tracked|estimated|unlock|platform|undated, subject?, game_id?, title?, detail? }] newest first, undated last,
 *   coming: [{ id, kind, category, text, target, current, percent, subject?, game_id?, title? }] nearest first }
 * `reached` holds the notable ones unless `all`; `category` keeps one category; `limit` cuts the list.
 */
export function milestones(db, { now = Date.now(), limit = 60, all = false, category = null } = {}) {
  const today = dayKey(now);
  // worked out once (until the next write or day): the highlights, a category and a limit are views of it
  const m = memo(db, `milestones2:${today}`, () => career(db, now, today));
  const inCat = (x) => !category || x.category === category;
  const shown = (all ? m.reached : m.reached.filter((r) => r.notable)).filter(inCat);
  const { reached, coming, ...rest } = m;
  return { ...rest, reached: shown.slice(0, limit), coming: coming.filter(inCat) };
}

function career(db, now, today) {
  {
    const reached = [];
    const coming = [];
    const at = (day, precision, basis) => ({ day, precision, basis });
    const hit = (kind, value, when, subject = null, extra = {}) => {
      if (!when || when.day > today) when = when?.day > today ? at(today, 'day', when.basis) : at(null, null, 'undated');
      reached.push({
        id: `${kind}:${value}${extra.game_id && kind !== 'games' ? `:${extra.game_id}` : subject && !['games', 'platforms', 'genres', 'series', 'release_decades', 'decades', 'retro', 'day_one', 'achievements', 'completions', 'platinums'].includes(kind) ? `:${subject}` : ''}`,
        kind, category: CATEGORY[kind], text: TEXT[kind](value, subject), value, tier: MARKS[kind].indexOf(value) + 1,
        day: when.day, precision: when.precision, basis: when.basis, ...(subject ? { subject } : {}), ...extra,
      });
    };
    const ahead = (kind, current, subject = null, extra = {}) => {
      const target = nextMark(MARKS[kind], current);
      if (target == null) return;
      coming.push({
        id: `${kind}:${target}${extra.game_id ? `:${extra.game_id}` : subject ? `:${subject}` : ''}`, kind, category: CATEGORY[kind],
        text: TEXT[kind](target, ['games', 'platforms', 'genres', 'series', 'achievements', 'completions', 'platinums', 'release_decades', 'decades', 'retro', 'day_one'].includes(kind) ? null : subject),
        target, current: Math.round(current * 10) / 10, percent: Math.min(99, Math.floor((current / target) * 100)), ...(subject ? { subject } : {}), ...extra,
      });
    };
    /** Marks of `kind` passed when a running total goes from `before` to `after`. */
    // (estimated history comes in fractions of minutes: 6,000 of them can add up to 99.999... hours)
    const crossed = (kind, before, after) => MARKS[kind].filter((m) => before < m - 1e-6 && after >= m - 1e-6);
    const titles = new Map(db.prepare('SELECT id, title FROM games').all().map((g) => [g.id, g.title]));
    const gameRef = (id) => ({ game_id: id, title: titles.get(id) });

    // ---- every dated day of play (tracked, imported, estimated), per game and platform, oldest first
    const rows = db.prepare(`SELECT day, game_id, platform, basis, SUM(minutes) m FROM play_days WHERE excluded = 0
      GROUP BY day, game_id, platform, basis HAVING m > 0 ORDER BY day, basis, game_id, platform`).all().filter((r) => titles.has(r.game_id));
    const when = (r) => at(r.day, PRECISION[r.basis] ?? 'year', BASIS(r.basis));
    // what each game, platform and the whole library hold in all (undated history included)
    const life = db.prepare("SELECT game_id, platform, SUM(playtime_min) m FROM entries WHERE excluded = 0 GROUP BY game_id, platform").all();
    const lifeGame = new Map(); const lifePlat = new Map(); let lifeAll = 0;
    for (const l of life) { if (!titles.has(l.game_id)) continue; lifeGame.set(l.game_id, (lifeGame.get(l.game_id) || 0) + l.m); lifePlat.set(l.platform, (lifePlat.get(l.platform) || 0) + l.m); lifeAll += l.m; }

    // ---- the first known play of every game: its first dated day, first unlock or the platform's first played date
    const first = new Map(); // game id -> { t, day, precision, basis }
    const firstAt = (id, t, w) => { const cur = first.get(id); if (!cur || t < cur.t || (t === cur.t && PREC_RANK[w.precision] < PREC_RANK[cur.precision])) first.set(id, { t, ...w }); };
    for (const r of rows) if (!first.has(r.game_id)) firstAt(r.game_id, parseDay(r.day), when(r));
    for (const u of db.prepare(`SELECT e.game_id, MIN(a.unlocked_at) t FROM achievements a JOIN entries e ON e.id = a.entry_id
        WHERE a.unlocked = 1 AND a.unlocked_at IS NOT NULL AND e.excluded = 0 GROUP BY e.game_id`).all()) {
      if (titles.has(u.game_id) && realTime(u.t) && u.t <= now) firstAt(u.game_id, u.t, at(dayKey(u.t), 'day', 'unlock'));
    }
    for (const p of db.prepare('SELECT game_id, MIN(first_played_at) t FROM entries WHERE excluded = 0 AND first_played_at IS NOT NULL GROUP BY game_id').all()) {
      if (titles.has(p.game_id) && realTime(p.t) && p.t <= now) firstAt(p.game_id, p.t, at(dayKey(p.t), 'day', 'platform'));
    }
    const played = [...first].sort((a, b) => a[1].t - b[1].t || a[0] - b[0]);
    // games played with no date at all (only undated history): they count, without a day
    const undatedGames = [...lifeGame].filter(([id, m]) => m > 0 && !first.has(id)).length;

    // ---- playtime: in all, by year, by platform, in one game; and the decades with play
    let total = 0;
    const byYear = new Map(); const byPlat = new Map(); const byGame = new Map();
    const lastPlat = new Map(); const lastGame = new Map();
    const decadesSeen = new Set();
    for (const r of rows) {
      const w = when(r);
      for (const h of crossed('hours', total / 60, (total + r.m) / 60)) hit('hours', h, w);
      total += r.m;
      const y = r.day.slice(0, 4);
      const ym = byYear.get(y) || 0;
      for (const h of crossed('year_hours', ym / 60, (ym + r.m) / 60)) hit('year_hours', h, w, y);
      byYear.set(y, ym + r.m);
      if (PLATFORM[r.platform] || !['manual', 'import', 'imported', 'custom'].includes(r.platform)) {
        const pm = byPlat.get(r.platform) || 0;
        for (const h of crossed('platform_hours', pm / 60, (pm + r.m) / 60)) hit('platform_hours', h, w, platformName(r.platform));
        byPlat.set(r.platform, pm + r.m); lastPlat.set(r.platform, r.day);
      }
      const gm = byGame.get(r.game_id) || 0;
      for (const h of crossed('game_hours', gm / 60, (gm + r.m) / 60)) hit('game_hours', h, w, titles.get(r.game_id), gameRef(r.game_id));
      byGame.set(r.game_id, gm + r.m); lastGame.set(r.game_id, r.day);
      const dec = Math.floor(Number(y) / 10);
      if (!decadesSeen.has(dec)) { decadesSeen.add(dec); if (MARKS.decades.includes(decadesSeen.size)) hit('decades', decadesSeen.size, w, decadeName(Number(y))); }
    }
    // what only undated history reaches: reached, on no known day
    for (const h of crossed('hours', total / 60, lifeAll / 60)) hit('hours', h, null);
    for (const [id, m] of lifeGame) for (const h of crossed('game_hours', (byGame.get(id) || 0) / 60, m / 60)) hit('game_hours', h, null, titles.get(id), gameRef(id));
    for (const [p, m] of lifePlat) if (PLATFORM[p]) for (const h of crossed('platform_hours', (byPlat.get(p) || 0) / 60, m / 60)) hit('platform_hours', h, null, platformName(p));
    ahead('hours', lifeAll / 60);
    ahead('year_hours', (byYear.get(today.slice(0, 4)) || 0) / 60, today.slice(0, 4));

    // ---- the library: games played, platforms, decades of releases, old games, launch days
    // a platform's first day: its first dated day of play
    const platFirst = new Map();
    for (const r of rows) if (!platFirst.has(r.platform) && !['manual', 'import', 'imported', 'custom'].includes(r.platform)) platFirst.set(r.platform, when(r));
    [...platFirst].sort((a, b) => (a[1].day < b[1].day ? -1 : 1)).forEach(([p, w], i) => { if (MARKS.platforms.includes(i + 1)) hit('platforms', i + 1, w, platformName(p)); });
    ahead('platforms', platFirst.size);
    // releases: the store's date (Steam), else IGDB's (a calendar day at midnight UTC)
    const release = new Map();
    for (const g of db.prepare('SELECT game_id, release_date FROM game_meta WHERE igdb_id IS NOT NULL AND release_date IS NOT NULL').all()) {
      if (realTime(g.release_date)) { const d = new Date(g.release_date); release.set(g.game_id, new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12).getTime()); }
    }
    for (const e of db.prepare("SELECT game_id, json_extract(hist, '$.release_at') r FROM entries WHERE json_extract(hist, '$.release_at') IS NOT NULL").all()) {
      if (realTime(e.r) && !release.has(e.game_id)) release.set(e.game_id, e.r);
    }
    const relDecades = new Set();
    let oldest = 0; let launch = 0;
    played.forEach(([id, f], i) => {
      const title = titles.get(id);
      if (MARKS.games.includes(i + 1)) hit('games', i + 1, f, title, gameRef(id));
      const rel = release.get(id);
      if (rel == null) return;
      const ry = new Date(rel).getFullYear();
      const dec = Math.floor(ry / 10);
      if (!relDecades.has(dec)) { relDecades.add(dec); if (MARKS.release_decades.includes(relDecades.size)) hit('release_decades', relDecades.size, f, `${decadeName(ry)} with ${title}`, gameRef(id)); }
      // how old it was when you first played it (a first play known to the year says little about months)
      const age = (f.t - rel) / YEAR;
      const old = topMark('retro', oldest, age);
      if (old) { hit('retro', old, f, title, gameRef(id)); oldest = old; }
      // on its launch day: known to the day, and within a day of the release either side (a launch at
      // midnight in New Zealand is the evening before in the Americas)
      if (f.precision === 'day' && Math.abs(f.t - rel) <= 1.5 * DAY) { launch++; if (MARKS.day_one.includes(launch)) hit('day_one', launch, f, launch === 1 ? title : null, launch === 1 ? gameRef(id) : {}); }
    });
    ahead('games', played.length + undatedGames);
    if (relDecades.size) ahead('release_decades', relDecades.size);
    if (launch) ahead('day_one', launch);

    // ---- genres and series: games as they are first played, hours as they are played
    const series = seriesOf(db);
    const genres = new Map();
    for (const t of db.prepare("SELECT game_id, name FROM game_tags WHERE kind = 'genre' ORDER BY game_id, name").all()) { if (!genres.has(t.game_id)) genres.set(t.game_id, []); genres.get(t.game_id).push(t.name); }
    const groups = { genre: new Map(), series: new Map() }; // name -> { games, minutes, last, first }
    const of = (id) => ({ genre: genres.get(id) || [], series: series.get(id) || [] });
    for (const [id, f] of played) {
      for (const k of ['genre', 'series']) {
        for (const name of of(id)[k]) {
          let s = groups[k].get(name);
          if (!s) {
            groups[k].set(name, s = { games: 0, minutes: 0, last: f.day, first: f });
            const count = groups[k].size;
            const kind = k === 'genre' ? 'genres' : 'series';
            if (MARKS[kind].includes(count)) hit(kind, count, f, name);
          }
          s.games++;
          if (MARKS[`${k}_games`].includes(s.games)) hit(`${k}_games`, s.games, f, name);
        }
      }
    }
    for (const r of rows) {
      for (const k of ['genre', 'series']) {
        for (const name of of(r.game_id)[k]) {
          const s = groups[k].get(name);
          if (!s) continue;
          for (const h of crossed(`${k}_hours`, s.minutes / 60, (s.minutes + r.m) / 60)) hit(`${k}_hours`, h, when(r), name);
          s.minutes += r.m; s.last = later(s.last, r.day);
          if (k === 'series') {
            // years of a series: from its first play to this one
            const years = (parseDay(r.day) - s.first.t) / YEAR;
            const m = topMark('series_years', s.years || 0, years);
            if (m) { hit('series_years', m, when(r), name); s.years = m; }
          }
        }
      }
    }
    ahead('genres', groups.genre.size);
    ahead('series', groups.series.size);

    // ---- the career: its years since the first known play
    const start = played[0]?.[1] || null;
    if (start) {
      for (const m of MARKS.career_years) {
        const d = new Date(start.t); d.setFullYear(d.getFullYear() + m);
        if (d.getTime() > now) { ahead('career_years', (now - start.t) / YEAR); break; }
        hit('career_years', m, at(dayKey(d.getTime()), start.precision, start.basis));
      }
    }

    // ---- achievements, in the order they were unlocked
    const unlocks = db.prepare(`SELECT a.unlocked_at t, a.rarity, a.points, a.name, e.game_id FROM achievements a JOIN entries e ON e.id = a.entry_id
      WHERE a.unlocked = 1 AND a.unlocked_at IS NOT NULL AND e.excluded = 0 ORDER BY a.unlocked_at, a.id`).all().filter((u) => realTime(u.t) && u.t <= now && titles.has(u.game_id));
    let rare = 0; let ultra = 0; let score = 0; let perDay = 0; let dayOf = null; let bestDay = 0;
    const achGames = new Set();
    unlocks.forEach((u, i) => {
      const w = at(dayKey(u.t), 'day', 'unlock');
      if (MARKS.achievements.includes(i + 1)) hit('achievements', i + 1, w, i === 0 ? `${u.name || 'an achievement'} in ${titles.get(u.game_id)}` : null, i === 0 ? gameRef(u.game_id) : {});
      if (!achGames.has(u.game_id)) { achGames.add(u.game_id); if (MARKS.ach_games.includes(achGames.size)) hit('ach_games', achGames.size, w); }
      if (u.rarity != null && u.rarity <= RARE_PERCENT) { rare++; if (MARKS.rare.includes(rare)) hit('rare', rare, w); }
      if (u.rarity != null && u.rarity <= ULTRA_PERCENT) { ultra++; if (MARKS.ultra_rare.includes(ultra)) hit('ultra_rare', ultra, w, null, ultra === 1 ? { detail: `${u.name} in ${titles.get(u.game_id)} (${u.rarity}%)`, ...gameRef(u.game_id) } : {}); }
      if (u.points) { for (const m of crossed('gamerscore', score, score + u.points)) hit('gamerscore', m, w); score += u.points; }
      perDay = w.day === dayOf ? perDay + 1 : 1; dayOf = w.day;
      if (perDay > bestDay) { const m = topMark('ach_day', bestDay, perDay); if (m && perDay === m) hit('ach_day', m, w); bestDay = perDay; }
    });
    ahead('achievements', unlocks.length);
    if (unlocks.length) ahead('ach_games', achGames.size);
    if (rare) ahead('rare', rare);
    if (ultra) ahead('ultra_rare', ultra);
    if (score) ahead('gamerscore', score);
    // completions (every achievement, or the platinum) and platinums, once per game, by their day
    const sets = db.prepare(`SELECT e.game_id, COUNT(*) total, SUM(a.unlocked) unlocked, MAX(a.unlocked_at) last,
        SUM(CASE WHEN a.unlocked = 1 AND a.unlocked_at IS NULL THEN 1 ELSE 0 END) undated,
        MIN(CASE WHEN a.unlocked = 1 AND a.grade = 'platinum' THEN a.unlocked_at END) platinum_at
      FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.excluded = 0 GROUP BY a.entry_id`).all();
    const firstOf = (pick) => {
      const m = new Map();
      for (const s of sets) { const t = pick(s); if (t != null && realTime(t) && titles.has(s.game_id) && (!m.has(s.game_id) || t < m.get(s.game_id))) m.set(s.game_id, t); }
      return [...m].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    };
    // (a set unlocked at times the platform does not know has no day: it is not counted)
    const done = firstOf((s) => { const whole = s.total > 0 && s.unlocked === s.total && !s.undated ? s.last : null; return whole != null && s.platinum_at != null ? Math.min(whole, s.platinum_at) : whole ?? s.platinum_at; });
    const named = (i, id) => (i === 0 ? [titles.get(id), gameRef(id)] : [null, {}]);
    done.forEach(([id, t], i) => { if (MARKS.completions.includes(i + 1)) hit('completions', i + 1, at(dayKey(t), 'day', 'unlock'), ...named(i, id)); });
    if (sets.length) ahead('completions', done.length);
    const plats = firstOf((s) => s.platinum_at);
    plats.forEach(([id, t], i) => { if (MARKS.platinums.includes(i + 1)) hit('platinums', i + 1, at(dayKey(t), 'day', 'unlock'), ...named(i, id)); });
    if (plats.length) ahead('platinums', plats.length);

    // ---- habits: real days and sessions only
    const tracked = db.prepare("SELECT day, SUM(minutes) m FROM play_days WHERE excluded = 0 AND estimated = 0 GROUP BY day HAVING m >= 1 ORDER BY day").all();
    let run = 0; let best = 0; let prev = null;
    tracked.forEach(({ day }, i) => {
      const w = at(day, 'day', 'tracked');
      if (MARKS.days.includes(i + 1)) hit('days', i + 1, w);
      run = prev != null && Math.round((parseDay(day) - parseDay(prev)) / DAY) === 1 ? run + 1 : 1;
      if (run > best) { best = run; if (MARKS.streak.includes(run)) hit('streak', run, w); }
      prev = day;
    });
    ahead('days', tracked.length);
    const live = prev && Math.round((parseDay(today) - parseDay(prev)) / DAY) <= 1 ? run : 0;
    const streakTarget = nextMark(MARKS.streak, best);
    if (live >= 3 && streakTarget && live / streakTarget >= 0.25) coming.push({ id: `streak:${streakTarget}`, kind: 'streak', category: 'habits', text: TEXT.streak(streakTarget), target: streakTarget, current: live, percent: Math.min(99, Math.floor((live / streakTarget) * 100)) });
    const sessions = db.prepare(`SELECT s.minutes, s.started_at, s.ended_at, s.sort_time t FROM sessions s JOIN entries e ON e.id = s.entry_id
      WHERE s.kind = 'play' AND s.minutes > 0 AND e.excluded = 0 ORDER BY s.sort_time, s.id`).all();
    let longest = 0; let nights = 0;
    sessions.forEach((s, i) => {
      const w = at(dayKey(s.t), 'day', 'tracked');
      if (MARKS.sessions.includes(i + 1)) hit('sessions', i + 1, w);
      const long = topMark('long_session', longest, s.minutes / 60);
      if (long) { hit('long_session', long, w); longest = long; }
      // still going at 3 am (exact times only)
      if (s.started_at && s.ended_at) {
        const three = new Date(s.ended_at); three.setHours(3, 0, 0, 0);
        if (s.started_at < three.getTime() && s.ended_at > three.getTime()) { nights++; if (MARKS.night.includes(nights)) hit('night', nights, at(dayKey(three.getTime()), 'day', 'tracked')); }
      }
    });
    ahead('sessions', sessions.length);

    // ---- coming up for the games, platforms, series and genres still played: the nearest of each kind
    const active = dayKey(now - ACTIVE_DAYS * DAY);
    const nearest = (kind, items, k = 3) => items.filter((x) => x.last >= active).map((x) => ({ x, target: nextMark(MARKS[kind], x.value) }))
      .filter((y) => y.target && y.x.value / y.target >= NEAR).sort((a, b) => b.x.value / b.target - a.x.value / a.target || String(a.x.key).localeCompare(String(b.x.key))).slice(0, k);
    for (const { x } of nearest('game_hours', [...lifeGame].map(([id, m]) => ({ key: id, value: m / 60, last: lastGame.get(id) || '' })), 2)) ahead('game_hours', x.value, titles.get(x.key), gameRef(x.key));
    for (const { x } of nearest('platform_hours', [...lifePlat].filter(([p]) => PLATFORM[p]).map(([p, m]) => ({ key: p, value: m / 60, last: lastPlat.get(p) || '' })), 2)) ahead('platform_hours', x.value, platformName(x.key));
    for (const k of ['genre', 'series']) {
      for (const { x } of nearest(`${k}_hours`, [...groups[k]].map(([name, s]) => ({ key: name, value: s.minutes / 60, last: s.last })), 2)) ahead(`${k}_hours`, x.value, x.key);
      for (const { x } of nearest(`${k}_games`, [...groups[k]].map(([name, s]) => ({ key: name, value: s.games, last: s.last })), 2)) ahead(`${k}_games`, x.value, x.key);
    }

    // ---- notable: of each kind, the highest rungs reached, and every career first
    // (of a year, a platform, a genre, a series or a game, only its highest rung: "750 hours in 2018", not 250, 500 and 750)
    const top = {}; const topOf = {};
    const keyed = (r) => PER_SUBJECT.has(r.kind) && (r.subject || r.game_id);
    const key = (r) => `${r.kind}|${r.game_id || r.subject}`;
    for (const r of reached) {
      top[r.kind] = Math.max(top[r.kind] || 0, r.tier);
      if (keyed(r)) topOf[key(r)] = Math.max(topOf[key(r)] || 0, r.tier);
    }
    for (const r of reached) {
      r.notable = (r.tier > top[r.kind] - NOTABLE_RUNGS && (!keyed(r) || r.tier === topOf[key(r)]))
        || (r.value === 1 && ['games', 'achievements', 'completions', 'platinums', 'day_one', 'ultra_rare'].includes(r.kind));
    }
    // newest first, undated last; of one day, the higher rungs first
    reached.sort((a, b) => (a.day === b.day ? b.tier - a.tier || a.id.localeCompare(b.id) : a.day == null ? 1 : b.day == null ? -1 : a.day < b.day ? 1 : -1));
    coming.sort((a, b) => b.percent - a.percent || a.id.localeCompare(b.id));
    const counts = {}; const categories = {}; const years = new Map();
    for (const r of reached) {
      counts[r.kind] = (counts[r.kind] || 0) + 1;
      categories[r.category] = (categories[r.category] || 0) + 1;
      const y = r.day ? r.day.slice(0, 4) : null;
      if (y) years.set(y, (years.get(y) || 0) + 1);
    }
    return {
      day: today, first_day: start?.day || null, first_precision: start?.precision || null,
      total: reached.length, notable_total: reached.filter((r) => r.notable).length, counts, categories,
      years: [...years].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([year, c]) => ({ year: Number(year), n: c })),
      reached, coming,
    };
  }
}
