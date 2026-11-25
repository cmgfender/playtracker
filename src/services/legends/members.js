// Who belongs to which legend: every game of the library with its series, makers, generation, trends
// and platforms, and how much of it was played in which year. Worked out once until the next write.

import { memo, dayKey } from '../stats.js';
import { franchiseIndex } from '../franchises.js';
import { libraryGames } from '../franchises/library.js';
import { slug } from '../franchises/catalog.js';
import { generationOf, makersOf, trendsOf, isMakers, MAKER_LIST } from './catalog.js';

/** A studio IGDB names as developer gets a legend of its own from this many games of yours. */
const STUDIO_MIN_GAMES = 3;

/**
 * { games: Map id -> game, sets: { series, maker, generation, trend, platform }: Map legend id -> [game ids],
 *   studios: Map id -> name (makers found in IGDB's developers, not curated), seriesNames: Map id -> name }
 * A game: the library's (id, title, cover_url, minutes, state, platforms, first_day, last_day, release_at,
 * release_year) plus series (id | null), gen (id | null), years: [{ year, minutes, estimated, first, last, days }]
 * (dated play), dated (minutes with a date), plat (Map platform -> lifetime minutes), unlocked (achievements).
 */
export function membership(db, { now = Date.now() } = {}) {
  return memo(db, `legends:members:${dayKey(now)}`, () => {
    const games = new Map(libraryGames(db, now).map((g) => [g.id, { ...g, series: null, entry: null, gen: null, years: [], dated: 0 }]));
    // dated play, by game and year
    for (const r of db.prepare(`SELECT game_id, substr(day, 1, 4) y, SUM(minutes) m, SUM(minutes * estimated) e, MIN(day) f, MAX(day) l, COUNT(DISTINCT day) d
        FROM play_days WHERE excluded = 0 GROUP BY game_id, y ORDER BY game_id, y`).all()) {
      const g = games.get(r.game_id);
      if (!g) continue;
      g.years.push({ year: Number(r.y), minutes: r.m, estimated: r.e, first: r.f, last: r.l, days: r.d });
      g.dated += r.m;
    }
    // lifetime minutes by platform, and achievements unlocked
    for (const g of games.values()) { g.plat = new Map(); g.unlocked = 0; }
    for (const r of db.prepare('SELECT game_id, platform, SUM(playtime_min) m FROM entries WHERE excluded = 0 GROUP BY game_id, platform').all()) games.get(r.game_id)?.plat.set(r.platform, r.m);
    for (const r of db.prepare('SELECT e.game_id, SUM(a.unlocked) u FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.excluded = 0 GROUP BY e.game_id').all()) { const g = games.get(r.game_id); if (g) g.unlocked = r.u || 0; }
    const tags = new Map(); // game id -> { developer: [], publisher: [], platform: [] }
    for (const t of db.prepare("SELECT game_id, kind, name FROM game_tags WHERE kind IN ('developer', 'publisher', 'platform')").all()) {
      if (!tags.has(t.game_id)) tags.set(t.game_id, { developer: [], publisher: [], platform: [] });
      tags.get(t.game_id)[t.kind].push(t.name);
    }
    const sets = { series: new Map(), maker: new Map(), generation: new Map(), trend: new Map(), platform: new Map() };
    const put = (kind, id, gameId) => { const m = sets[kind]; if (!m.has(id)) m.set(id, []); m.get(id).push(gameId); };
    // series: the franchise pages' own placing (entries, versions, betas, launchers, the rest of the series)
    const seriesNames = new Map();
    for (const r of franchiseIndex(db, { now }).values()) {
      seriesNames.set(r.id, r.name);
      for (const it of r.items) {
        for (const id of [it.game?.id, ...(it.others || []).map((o) => o.id), ...(it.addons || []).map((a) => a.id)].filter(Boolean)) {
          const g = games.get(id);
          if (!g || g.series) continue; // (a game in two inferred series: the first)
          g.series = r.id;
          g.entry = it.curated ? { title: it.title, year: it.year } : null;
          put('series', r.id, id);
        }
      }
    }
    const studioGames = new Map(); // IGDB developer -> [game ids] of developers no curated maker claims
    for (const g of games.values()) {
      const t = tags.get(g.id) || { developer: [], publisher: [], platform: [] };
      // a curated entry with no release date of its own: its year, mid-year
      const release = g.release_at ?? (g.entry?.year ? new Date(g.entry.year, 6, 1).getTime() : null);
      const gen = generationOf(release, t.platform);
      if (gen) { g.gen = gen.id; put('generation', gen.id, g.id); }
      const makers = makersOf(g.series, [...t.developer, ...t.publisher], g.entry?.year ?? g.release_year);
      for (const m of makers) put('maker', m.id, g.id);
      for (const d of t.developer) {
        if (MAKER_LIST.some((m) => isMakers(m, d))) continue;
        if (!studioGames.has(d)) studioGames.set(d, []);
        studioGames.get(d).push(g.id);
      }
      for (const tr of trendsOf(g.title, g.series, g.entry?.title)) put('trend', tr.id, g.id);
      for (const p of g.platforms) put('platform', p, g.id);
    }
    const studios = new Map();
    for (const [name, ids] of studioGames) {
      if (ids.length < STUDIO_MIN_GAMES) continue;
      const id = `studio-${slug(name)}`;
      studios.set(id, name);
      sets.maker.set(id, ids);
    }
    return { games, sets, studios, seriesNames };
  });
}
