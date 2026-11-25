// Who belongs to which legend: every game of the library with its series, makers, generation, trends
// and platforms, and how much of it was played in which year. Worked out once until the next write.

import { memo, dayKey } from '../stats.js';
import { franchiseIndex } from '../franchises.js';
import { libraryGames } from '../franchises/library.js';
import { slug } from '../franchises/catalog.js';
import { generationOf, makersOf, trendsOf, genresOf, isMakers, MAKER_LIST, MAKER_BY_ID } from './catalog.js';

// Houses that sell other makers' games under their own name in one region: in Japan (not Sega or Bandai
// Namco: Atlus's and FromSoftware's publishers abroad are part of those games' story), and Deep Silver
// and 505 Games in Europe and on disc (Persona 5, Control)
const JAPAN_PUBLISHERS = ['square-enix', 'capcom', 'konami', 'koei-tecmo', 'spike-chunsoft', 'deep-silver', '505-games'];
// (makers.js: studio) counted by what they developed only
const STUDIOS = MAKER_LIST.filter((m) => m.studio);

/** A studio IGDB names as developer gets a legend of its own from this many games of yours. */
const STUDIO_MIN_GAMES = 3;

/**
 * { games: Map id -> game, sets: { series, maker, generation, trend, genre, platform }: Map legend id -> [game ids],
 *   studios: Map id -> name (makers found in IGDB's developers, not curated), seriesNames: Map id -> name }
 * A game: the library's (id, title, cover_url, minutes, state, platforms, first_day, last_day, release_at,
 * release_year) plus series (id | null), gen (id | null), years: [{ year, minutes, estimated, first, last, days }]
 * (dated play), dated (minutes with a date), plat (Map platform -> lifetime minutes), unlocked (achievements).
 * units: Map uid -> a game's part, for a game holding two releases of a series entry (an original and
 * its remake, see franchises/parts.js): the same shape, with only its entries' play and its own release.
 * A console generation counts each part in its own generation (the N64 original in one, the Switch 2
 * remake in another); everything else counts the game as a whole.
 */
export function membership(db, { now = Date.now() } = {}) {
  return memo(db, `legends:members:${dayKey(now)}`, () => {
    // (a game only on your wish list is no part of your career: it is left out)
    const games = new Map(libraryGames(db, now).filter((g) => g.state !== 'wanted').map((g) => [g.id, { ...g, series: null, entry: null, gen: null, years: [], dated: 0 }]));
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
    const tags = new Map(); // game id -> { developer: [], publisher: [], platform: [], genre: [], theme: [] }
    for (const t of db.prepare("SELECT game_id, kind, name FROM game_tags WHERE kind IN ('developer', 'publisher', 'platform', 'genre', 'theme')").all()) {
      if (!tags.has(t.game_id)) tags.set(t.game_id, { developer: [], publisher: [], platform: [], genre: [], theme: [] });
      tags.get(t.game_id)[t.kind].push(t.name);
    }
    const sets = { series: new Map(), maker: new Map(), generation: new Map(), trend: new Map(), genre: new Map(), platform: new Map() };
    const put = (kind, id, gameId) => { const m = sets[kind]; if (!m.has(id)) m.set(id, []); m.get(id).push(gameId); };
    // series: the franchise pages' own placing (entries, versions, betas, launchers, the rest of the series)
    const seriesNames = new Map();
    const partsOf = new Map(); // game id -> [{ uid, entries, year, title, main }]
    for (const r of franchiseIndex(db, { now }).values()) {
      seriesNames.set(r.id, r.name);
      for (const it of r.items) {
        if (it.game?.part) {
          if (!partsOf.has(it.game.id)) partsOf.set(it.game.id, []);
          partsOf.get(it.game.id).push({ uid: it.game.uid, entries: it.game.part.entries, year: it.year, title: it.title, main: it.game.part.main });
        }
        for (const id of [it.game?.id, ...(it.others || []).map((o) => o.id), ...(it.addons || []).map((a) => a.id)].filter(Boolean)) {
          const g = games.get(id);
          if (!g || g.series) continue; // (a game in two inferred series: the first)
          g.series = r.id;
          g.entry = it.curated ? { title: it.title, year: it.year } : null;
          // a series' app (the Battlefield app, Call of Duty HQ): its time is the series' games of its years -
          // not the year of whatever IGDB matched its bare name to (a 1997 "Battlefield")
          if (it.kind === 'hub' && it.year != null && id === it.game?.id) g.hubYear = it.year;
          put('series', r.id, id);
        }
      }
    }
    // a game's parts: each with only its entries' play, dated and by platform, and its achievements
    const units = new Map();
    const unitEntries = [...partsOf.values()].flat().flatMap((p) => p.entries);
    if (unitEntries.length) {
      const list = JSON.stringify(unitEntries);
      const byEntry = (sql) => { const m = new Map(); for (const r of db.prepare(sql).all(list)) { if (!m.has(r.entry_id)) m.set(r.entry_id, []); m.get(r.entry_id).push(r); } return m; };
      const days = byEntry(`SELECT entry_id, substr(day, 1, 4) y, SUM(minutes) m, SUM(minutes * estimated) e, MIN(day) f, MAX(day) l, COUNT(DISTINCT day) d
        FROM play_days WHERE excluded = 0 AND entry_id IN (SELECT value FROM json_each(?)) GROUP BY entry_id, y ORDER BY y`);
      const ents = byEntry('SELECT id entry_id, platform, playtime_min m FROM entries WHERE excluded = 0 AND id IN (SELECT value FROM json_each(?))');
      const unl = byEntry('SELECT entry_id, SUM(unlocked) u FROM achievements WHERE entry_id IN (SELECT value FROM json_each(?)) GROUP BY entry_id');
      for (const [gid, ps] of partsOf) {
        const g = games.get(gid);
        if (!g || ps.length < 2) continue;
        for (const p of ps) {
          const years = new Map(); const plat = new Map(); let minutes = 0; let unlocked = 0;
          for (const id of p.entries) {
            for (const r of days.get(id) || []) {
              const y = years.get(r.y) || { year: Number(r.y), minutes: 0, estimated: 0, first: r.f, last: r.l, days: 0 };
              y.minutes += r.m; y.estimated += r.e; y.days += r.d; if (r.f < y.first) y.first = r.f; if (r.l > y.last) y.last = r.l;
              years.set(r.y, y);
            }
            for (const r of ents.get(id) || []) { minutes += r.m; plat.set(r.platform, (plat.get(r.platform) || 0) + r.m); }
            for (const r of unl.get(id) || []) unlocked += r.u || 0;
          }
          const ys = [...years.values()].sort((a, b) => a.year - b.year);
          units.set(p.uid, { ...g, uid: p.uid, minutes, years: ys, dated: ys.reduce((a, y) => a + y.minutes, 0), plat, unlocked, platforms: [...plat.keys()],
            release_at: null, release_year: p.year, entry: { title: p.title, year: p.year }, part: { entries: p.entries, main: p.main } });
        }
      }
    }
    const unitsOf = new Map();
    for (const u of units.values()) { if (!unitsOf.has(u.id)) unitsOf.set(u.id, []); unitsOf.get(u.id).push(u); }
    const studioGames = new Map(); // IGDB developer -> [game ids] of developers no curated maker claims
    for (const g of games.values()) {
      const t = tags.get(g.id) || { developer: [], publisher: [], platform: [], genre: [], theme: [] };
      // a curated entry with no release date of its own: its year, mid-year; a series' app: the years it holds
      const release = g.hubYear ? new Date(g.hubYear, 6, 1).getTime() : g.release_at ?? (g.entry?.year ? new Date(g.entry.year, 6, 1).getTime() : null);
      const parts = unitsOf.get(g.id) || [];
      if (parts.length) {
        // each release in its own generation (IGDB's platforms are the game's own release's: only for that one)
        for (const u of parts) {
          const gen = generationOf(new Date(u.release_year, 6, 1).getTime(), u.part.main ? t.platform : []);
          if (gen) { u.gen = gen.id; put('generation', gen.id, u.uid); }
        }
        g.gen = parts.find((u) => u.part.main)?.gen ?? parts[0].gen ?? null;
      } else {
        const gen = generationOf(release, g.hubYear ? [] : t.platform);
        if (gen) { g.gen = gen.id; put('generation', gen.id, g.id); }
      }
      // (IGDB's companies of what it matched a series' app to are not the app's: the series decides)
      // a game its own maker publishes, with a Japanese house among IGDB's publishers: that one sold it
      // in Japan (Square Enix for Overwatch and Call of Duty) and made no part of it
      const own = MAKER_LIST.filter((m) => t.developer.some((c) => isMakers(m, c)) && t.publisher.some((c) => isMakers(m, c)));
      const publishers = (own.length ? t.publisher.filter((c) => !JAPAN_PUBLISHERS.some((id) => MAKER_BY_ID.has(id) && !own.some((m) => m.id === id) && isMakers(MAKER_BY_ID.get(id), c))) : t.publisher)
        .filter((c) => !STUDIOS.some((m) => isMakers(m, c)));
      const makers = makersOf(g.series, g.hubYear ? [] : [...t.developer, ...publishers], g.hubYear ?? g.entry?.year ?? g.release_year);
      for (const m of makers) put('maker', m.id, g.id);
      for (const d of t.developer) {
        if (MAKER_LIST.some((m) => isMakers(m, d))) continue;
        if (!studioGames.has(d)) studioGames.set(d, []);
        studioGames.get(d).push(g.id);
      }
      for (const tr of trendsOf(g.title, g.series, g.entry?.title)) put('trend', tr.id, g.id);
      // (what IGDB matched a series' app to says nothing of the games it holds)
      if (!g.hubYear) for (const ge of genresOf(t.genre, t.theme)) put('genre', ge.id, g.id);
      for (const p of g.platforms) put('platform', p, g.id);
    }
    const studios = new Map();
    for (const [name, ids] of studioGames) {
      if (ids.length < STUDIO_MIN_GAMES) continue;
      const id = `studio-${slug(name)}`;
      studios.set(id, name);
      sets.maker.set(id, ids);
    }
    return { games, units, sets, studios, seriesNames };
  });
}
