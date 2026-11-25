// Legends: the stories in a career. Where Insights digs for findings and Milestones hands out badges,
// a legend follows one thread from where it began to where it stands:
//   series      a franchise (your Zelda career) - with its timeline, eras and versions (franchises.js)
//   maker       the people behind the games (your Nintendo career), curated and from IGDB's developers
//   generation  a console generation (your Xbox 360 and PS3 era)
//   trend       something games were into for a while (when space marines were cool)
//   platform    where you played (your Xbox career)
//   era         a stretch of your life you name (college, high school): what you played in it
//   career      all of it
// The data: src/data/legends/ (generations, makers, trends) and src/data/franchises/ (series).

import { HttpError } from '../util.js';
import { memo, dayKey } from './stats.js';
import { franchiseList, franchiseDetail } from './franchises.js';
import { milestones } from './milestones.js';
import { membership } from './legends/members.js';
import { GENS, GEN_BY_ID, MAKER_LIST, MAKER_BY_ID, TREND_LIST, TREND_BY_ID } from './legends/catalog.js';
import { listEras } from './legends/eras.js';
import { careerPlays, windowPlays, platformPlays, brief, tell } from './legends/story.js';

export { addEra, updateEra, removeEra, listEras } from './legends/eras.js';
export const LEGEND_KINDS = ['series', 'maker', 'generation', 'trend', 'platform', 'era', 'career'];

/** A trend shows up from this many of its games in a library. */
const TREND_MIN_GAMES = 2;
const PLATFORM_NAMES = { steam: 'Steam', xbox: 'Xbox', psn: 'PlayStation', nintendo: 'Nintendo Switch', switch: 'Nintendo Switch (imported games)', manual: 'games added by hand' };
const platformName = (p) => PLATFORM_NAMES[p] || (/^(?:pc|gog|ea|vr|n64|ps[1-5])$/.test(p) ? p.toUpperCase() : String(p).replace(/^\w/, (c) => c.toUpperCase()));

// (a generation's members can be parts of a game: one release of the game each - see legends/members.js)
const playsOf = (m, ids) => careerPlays((ids || []).map((id) => m.units?.get(id) ?? m.games.get(id)).filter(Boolean));
const eraWindow = (era, today) => ({ from: era.from, to: era.to && era.to < today ? era.to : today });

/**
 * The Legends page: your eras, then the legends found in your library, the most played first.
 * { career, eras: [...], series: [...] (the top 8; `series_total` in all), makers, generations (oldest first), trends, platforms }
 * A card: { kind, id, name, tagline?, games, played, minutes, from, to (the years you played it), top, covers }.
 */
export function legends(db, settings, { now = Date.now() } = {}) {
  const today = dayKey(now);
  const eras = listEras(settings);
  return memo(db, `legends:home:${today}:${JSON.stringify(eras)}`, () => {
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
        return card('era', String(e.id), e.name, windowPlays(db, m.games, w.from, w.to), { from_day: e.from, to_day: e.to, note: e.note, unlocks: u.n, unlock_games: u.games });
      }),
      series: fr.items.map((f) => ({ kind: 'series', id: f.id, name: f.name, games: f.games, played: f.played, minutes: f.minutes, from: f.first_day ? Number(f.first_day.slice(0, 4)) : null, to: f.last_day ? Number(f.last_day.slice(0, 4)) : null,
        covers: f.covers.slice(0, 3), mainline: f.mainline, your_era: f.your_era?.name || null })),
      series_total: fr.total,
      makers: [...m.sets.maker].map(([id, ids]) => card('maker', id, MAKER_BY_ID.get(id)?.name || m.studios.get(id), playsOf(m, ids))).filter((c) => c.played > 0).sort(byMinutes).slice(0, 24),
      generations: GENS.filter((g) => m.sets.generation.has(g.id)).map((g) => card('generation', g.id, g.name, playsOf(m, m.sets.generation.get(g.id)), { tagline: g.short, from_day: g.fromDay, to_day: g.toDay })),
      trends: TREND_LIST.filter((t) => (m.sets.trend.get(t.id) || []).length >= TREND_MIN_GAMES).map((t) => card('trend', t.id, t.name, playsOf(m, m.sets.trend.get(t.id)), { tagline: t.tagline, peak: { from: t.from, to: t.to } }))
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
      L.achievements = db.prepare('SELECT COUNT(*) n FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.excluded = 0 AND a.unlocked = 1 AND a.unlocked_at >= ? AND a.unlocked_at < ?')
        .get(new Date(`${w.from}T00:00`).getTime(), new Date(`${w.to}T00:00`).getTime() + 86_400_000).n;
      // the badges earned in it (Milestones has them all)
      const ms = milestones(db, { now, all: true, limit: 5000 }).reached.filter((x) => x.day && x.precision !== 'year' && x.day >= w.from && x.day <= w.to);
      own = { era: e, milestones: [...ms.filter((x) => x.notable), ...ms.filter((x) => !x.notable)].slice(0, 12) };
    } else {
      Object.assign(L, { id: 'all', name: 'Your career', tagline: 'Everything, from the first game on record', plays: careerPlays([...m.games.values()]) });
    }
    if (kind !== 'era') L.achievements = L.plays.reduce((a, p) => a + (p.game.unlocked || 0), 0);
    const story = tell(L);
    return { kind, id: L.id, name: L.name, tagline: L.tagline || null, window: L.window, ...story, ...own };
  });
}
