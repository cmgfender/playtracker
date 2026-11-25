// Legends: the stories in a career. Where Insights digs for findings and Milestones hands out badges,
// a legend follows one thread from where it began to where it stands:
//   series      a franchise (your Zelda career) - with its timeline, eras and versions (franchises.js)
//   maker       the people behind the games (your Nintendo career), curated and from IGDB's developers
//   generation  a console generation (your Xbox 360 and PS3 era)
//   trend       something games were into for a while (when space marines were cool)
//   genre       a kind of game, or the world it keeps (your role-playing career, your horror years)
//   platform    where you played (your Xbox career)
//   era         a stretch of your life you name (college, high school): what you played in it
//   career      all of it
// Every legend also says where it stands: its share of the career and its place among its kind.
// The data: src/data/legends/ (generations, makers, trends, genres) and src/data/franchises/ (series).

import { HttpError } from '../util.js';
import { memo, dayKey } from './stats.js';
import { franchiseList, franchiseDetail } from './franchises.js';
import { milestones } from './milestones.js';
import { membership } from './legends/members.js';
import { GENS, GEN_BY_ID, MAKER_LIST, MAKER_BY_ID, TREND_LIST, TREND_BY_ID, GENRE_LIST, GENRE_BY_ID } from './legends/catalog.js';
import { listEras, suggestEras, dismissedEras } from './legends/eras.js';
import { careerPlays, windowPlays, platformPlays, brief, tell } from './legends/story.js';

export { addEra, updateEra, removeEra, listEras, dismissEra } from './legends/eras.js';
export const LEGEND_KINDS = ['series', 'maker', 'generation', 'trend', 'genre', 'platform', 'era', 'career'];

/** A trend shows up from this many of its games in a library. */
const TREND_MIN_GAMES = 2;
/** A genre, from this many: one horror game is not a horror career. */
const GENRE_MIN_GAMES = 3;
const PLATFORM_NAMES = { steam: 'Steam', xbox: 'Xbox', psn: 'PlayStation', nintendo: 'Nintendo Switch', switch: 'Nintendo Switch (imported games)', manual: 'games added by hand' };
const platformName = (p) => PLATFORM_NAMES[p] || (/^(?:pc|gog|ea|vr|n64|ps[1-5])$/.test(p) ? p.toUpperCase() : String(p).replace(/^\w/, (c) => c.toUpperCase()));

// (a generation's members can be parts of a game: one release of the game each - see legends/members.js)
const playsOf = (m, ids) => careerPlays((ids || []).map((id) => m.units?.get(id) ?? m.games.get(id)).filter(Boolean));
const eraWindow = (era, today) => ({ from: era.from, to: era.to && era.to < today ? era.to : today });
const weeksOf = (w) => Math.max(1, (new Date(`${w.to}T12:00`) - new Date(`${w.from}T12:00`)) / (7 * 86_400_000));
const round1 = (n) => Math.round(n * 10) / 10;
const minutesOf = (plays) => plays.reduce((a, p) => a + p.minutes, 0);

/**
 * Where every legend stands: the career's minutes, and each kind's legends by minutes, the most played
 * first ({ total, rank: { maker: [[id, minutes]], ... } }). A legend with no time has no place.
 */
function standings(db, now) {
  return memo(db, `legends:standing:${dayKey(now)}`, () => {
    const m = membership(db, { now });
    const rank = {};
    const least = { trend: TREND_MIN_GAMES, genre: GENRE_MIN_GAMES };
    for (const kind of ['series', 'maker', 'generation', 'trend', 'genre']) {
      rank[kind] = [...m.sets[kind]].filter(([, ids]) => ids.length >= (least[kind] || 1)).map(([id, ids]) => [id, minutesOf(playsOf(m, ids))]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
    }
    rank.platform = [...m.sets.platform].map(([id, ids]) => [id, ids.reduce((a, g) => a + (m.games.get(g)?.plat.get(id) || 0), 0)]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
    return { total: [...m.games.values()].reduce((a, g) => a + g.minutes, 0), rank };
  });
}

/**
 * The Legends page: your eras, then the legends found in your library, the most played first.
 * { career, eras: [...], suggested: [...] (eras found in your play, to adopt), series: [...] (the top 8; `series_total` in all), makers, generations (oldest first), trends, genres, platforms }
 * A card: { kind, id, name, tagline?, games, played, minutes, from, to (the years you played it), top, covers }.
 */
export function legends(db, settings, { now = Date.now() } = {}) {
  const today = dayKey(now);
  const eras = listEras(settings);
  return memo(db, `legends:home:${today}:${JSON.stringify(eras)}:${dismissedEras(settings).join(',')}`, () => {
    const m = membership(db, { now });
    const card = (kind, id, name, plays, extra = {}) => ({ kind, id, name, ...extra, ...brief(plays) });
    const eraUnlocks = db.prepare(`SELECT COUNT(*) n, COUNT(DISTINCT e.game_id) games FROM achievements a JOIN entries e ON e.id = a.entry_id
      WHERE e.excluded = 0 AND a.unlocked = 1 AND a.unlocked_at >= ? AND a.unlocked_at < ?`);
    const byMinutes = (a, b) => b.minutes - a.minutes || b.games - a.games || a.name.localeCompare(b.name);
    const fr = franchiseList(db, { now, limit: 8 });
    const all = careerPlays([...m.games.values()]);
    return {
      career: card('career', 'all', 'Your career', all),
      // an era also counts what was unlocked in it: consoles that report no playtime (the Xbox 360) leave only that
      eras: eras.map((e) => {
        const w = eraWindow(e, today);
        const u = eraUnlocks.get(new Date(`${w.from}T00:00`).getTime(), new Date(`${w.to}T00:00`).getTime() + 86_400_000);
        const plays = windowPlays(db, m.games, w.from, w.to);
        return card('era', String(e.id), e.name, plays, { from_day: e.from, to_day: e.to, note: e.note, unlocks: u.n, unlock_games: u.games, weekly: round1(minutesOf(plays) / 60 / weeksOf(w)) });
      }),
      suggested: suggestEras(db, settings, { today, platformName }),
      series: fr.items.map((f) => ({ kind: 'series', id: f.id, name: f.name, games: f.games, played: f.played, minutes: f.minutes, from: f.first_day ? Number(f.first_day.slice(0, 4)) : null, to: f.last_day ? Number(f.last_day.slice(0, 4)) : null,
        covers: f.covers.slice(0, 3), mainline: f.mainline, your_era: f.your_era?.name || null })),
      series_total: fr.total,
      makers: [...m.sets.maker].map(([id, ids]) => card('maker', id, MAKER_BY_ID.get(id)?.name || m.studios.get(id), playsOf(m, ids))).filter((c) => c.played > 0).sort(byMinutes).slice(0, 24),
      generations: GENS.filter((g) => m.sets.generation.has(g.id)).map((g) => card('generation', g.id, g.name, playsOf(m, m.sets.generation.get(g.id)), { tagline: g.short, from_day: g.fromDay, to_day: g.toDay })),
      trends: TREND_LIST.filter((t) => (m.sets.trend.get(t.id) || []).length >= TREND_MIN_GAMES).map((t) => card('trend', t.id, t.name, playsOf(m, m.sets.trend.get(t.id)), { tagline: t.tagline, peak: { from: t.from, to: t.to } }))
        .filter((c) => c.played > 0).sort(byMinutes),
      genres: GENRE_LIST.filter((g) => (m.sets.genre.get(g.id) || []).length >= GENRE_MIN_GAMES).map((g) => card('genre', g.id, g.name, playsOf(m, m.sets.genre.get(g.id)), { tagline: g.tagline }))
        .filter((c) => c.played > 0).sort(byMinutes),
      platforms: [...m.sets.platform.keys()].map((id) => card('platform', id, platformName(id), platformPlays(db, m.games, id))).filter((c) => c.played > 0).sort(byMinutes),
    };
  });
}

/** One legend's story, or null: { kind, id, name, tagline, window, totals, chapters, years, months, games, series, platforms, ...its kind's own }. */
export function legend(db, settings, kind, id, { now = Date.now() } = {}) {
  if (!LEGEND_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${LEGEND_KINDS.join(', ')}`);
  const today = dayKey(now);
  const eras = listEras(settings);
  return memo(db, `legends:one:${kind}:${id}:${today}:${kind === 'era' ? JSON.stringify(eras) : ''}`, () => {
    const m = membership(db, { now });
    const L = { kind, id: String(id), today, seriesNames: m.seriesNames, window: null };
    let own = {};
    if (kind === 'series') {
      const f = franchiseDetail(db, id, { now });
      if (!f) return null;
      Object.assign(L, { id: f.id, name: f.name, tagline: f.curated ? null : 'A series in your library', series: f, plays: playsOf(m, m.sets.series.get(f.id)) });
      own = { series_detail: f };
    } else if (kind === 'maker') {
      const name = MAKER_BY_ID.get(id)?.name || m.studios.get(id);
      if (!name) return null;
      Object.assign(L, { name, tagline: MAKER_BY_ID.has(id) ? 'The games they made and published' : 'A studio you keep coming back to', plays: playsOf(m, m.sets.maker.get(id)) });
    } else if (kind === 'generation') {
      const g = GEN_BY_ID.get(id);
      if (!g) return null;
      Object.assign(L, { name: g.name, tagline: g.note, gen: g, plays: playsOf(m, m.sets.generation.get(id)) });
      own = { generation: { short: g.short, from_day: g.fromDay, to_day: g.toDay } };
    } else if (kind === 'trend') {
      const t = TREND_BY_ID.get(id);
      if (!t) return null;
      Object.assign(L, { name: t.name, tagline: t.tagline, trend: t, plays: playsOf(m, m.sets.trend.get(id)) });
      own = { peak: { from: t.from, to: t.to } };
    } else if (kind === 'genre') {
      const g = GENRE_BY_ID.get(id);
      if (!g || (m.sets.genre.get(id) || []).length < GENRE_MIN_GAMES) return null;
      Object.assign(L, { name: g.name, tagline: g.tagline, plays: playsOf(m, m.sets.genre.get(id)) });
    } else if (kind === 'platform') {
      if (!m.sets.platform.has(id)) return null;
      Object.assign(L, { name: platformName(id), tagline: 'Everything you played there', plays: platformPlays(db, m.games, id) });
    } else if (kind === 'era') {
      const e = eras.find((x) => String(x.id) === String(id));
      if (!e) return null;
      const w = eraWindow(e, today);
      // the whole record's pace, to set the era's against
      const all = [...m.games.values()];
      const firsts = all.map((g) => g.years[0]?.first).filter(Boolean).sort();
      const datedAll = all.reduce((a, g) => a + g.dated, 0);
      const weeks = firsts[0] ? Math.max(1, (new Date(`${today}T12:00`) - new Date(`${firsts[0]}T12:00`)) / (7 * 86_400_000)) : 0;
      Object.assign(L, { name: e.name, tagline: e.note || 'An era of your own', era: e, window: w, plays: windowPlays(db, m.games, w.from, w.to),
        allFirst: new Map(all.filter((g) => g.years[0]).map((g) => [g.id, g.years[0].first])), careerWeekly: weeks ? datedAll / 60 / weeks : 0 });
      const unlockedIn = db.prepare('SELECT COUNT(*) n FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.excluded = 0 AND a.unlocked = 1 AND a.unlocked_at >= ? AND a.unlocked_at < ?');
      const unlocks = (x) => unlockedIn.get(new Date(`${x.from}T00:00`).getTime(), new Date(`${x.to}T00:00`).getTime() + 86_400_000).n;
      L.achievements = unlocks(w);
      // an era still going: the last 30 days against the era so far
      if (!e.to || e.to >= today) {
        const since = dayKey(new Date(`${today}T12:00`).getTime() - 29 * 86_400_000);
        const from30 = since > w.from ? since : w.from;
        const recent = db.prepare('SELECT COALESCE(SUM(minutes), 0) m FROM play_days WHERE excluded = 0 AND day >= ? AND day <= ?').get(from30, today).m;
        L.pace = { recent: recent / 60 / weeksOf({ from: from30, to: today }), days: Math.round(weeksOf({ from: from30, to: today }) * 7) + 1 };
      }
      // every era side by side: the same few measures of each, so one can be set against another
      const measured = eras.map((x) => {
        const xw = eraWindow(x, today);
        const plays = xw.from <= today ? windowPlays(db, m.games, xw.from, xw.to) : [];
        const minutes = minutesOf(plays);
        return { id: String(x.id), name: x.name, from: x.from, to: x.to, minutes: Math.round(minutes), weekly: round1(minutes / 60 / weeksOf(xw)), games: plays.filter((p) => p.minutes > 0).length,
          fresh: plays.filter((p) => L.allFirst.get(p.game.id) >= xw.from).length, achievements: xw.from <= today ? unlocks(xw) : 0, top: plays.sort((a, b) => b.minutes - a.minutes)[0]?.game.title || null };
      });
      L.compare = { eras: measured, career: { minutes: Math.round(datedAll), weekly: round1(L.careerWeekly) } };
      // the badges earned in it (Milestones has them all)
      const ms = milestones(db, { now, all: true, limit: 5000 }).reached.filter((x) => x.day && x.precision !== 'year' && x.day >= w.from && x.day <= w.to);
      own = { era: e, milestones: [...ms.filter((x) => x.notable), ...ms.filter((x) => !x.notable)].slice(0, 12), compare: L.compare };
    } else {
      Object.assign(L, { id: 'all', name: 'Your career', tagline: 'Everything, from the first game on record', plays: careerPlays([...m.games.values()]) });
    }
    if (kind !== 'era') L.achievements = L.plays.reduce((a, p) => a + (p.game.unlocked || 0), 0);
    const story = tell(L);
    // where it stands: its share of all the time on record, and its place among its kind
    const st = standings(db, now);
    const list = st.rank[kind] || null;
    const at = list ? list.findIndex((x) => x[0] === L.id) : -1;
    const standing = { share: st.total > 0 && kind !== 'career' ? round1((story.totals.minutes / st.total) * 100) : null, rank: at >= 0 ? at + 1 : null, of: at >= 0 ? list.length : null,
      achievements: L.achievements || 0, weekly: kind === 'era' ? round1(story.totals.minutes / 60 / weeksOf(L.window)) : null };
    return { kind, id: L.id, name: L.name, tagline: L.tagline || null, window: L.window, standing, ...story, ...own };
  });
}
