// The curated side of Legends, prepared: console generations (src/data/legends/generations.js),
// makers (makers.js) and trends (trends.js). Nothing here reads the database.

import { GENERATIONS } from '../../data/legends/generations.js';
import { MAKERS } from '../../data/legends/makers.js';
import { TRENDS } from '../../data/legends/trends.js';
import { GENRES } from '../../data/legends/genres.js';
import { normalizeTitle } from '../titles.js';
import { yearless } from '../franchises/catalog.js';

const dayOf = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

/** Generations oldest first: { id, name, short, note, from (ms), to (ms, the next one's start; null for the latest), fromDay, toDay, consoles: Set } */
export const GENS = GENERATIONS.map((g, i, all) => ({
  ...g, index: i, fromDay: g.from, toDay: all[i + 1]?.from || null, from: dayOf(g.from), to: all[i + 1] ? dayOf(all[i + 1].from) : null,
  consoles: new Set(g.consoles.map((c) => c.toLowerCase())),
}));
export const GEN_BY_ID = new Map(GENS.map((g) => [g.id, g]));
const GEN_OF_CONSOLE = new Map();
for (const g of GENS) for (const c of g.consoles) GEN_OF_CONSOLE.set(c, g.index);

/**
 * The generation a game belongs to: the one its release date falls in - unless it came out only on
 * other generations' consoles (Shenmue, 1999, is a Dreamcast game: the generation after), then the
 * nearest of those. `platforms`: IGDB's platform names, when known. Null with no release date.
 */
export function generationOf(releaseAt, platforms = []) {
  if (!releaseAt) return null;
  let byDate = null;
  for (const g of GENS) if (releaseAt >= g.from) byDate = g.index;
  if (byDate == null) return null;
  const on = [...new Set(platforms.map((p) => GEN_OF_CONSOLE.get(String(p).toLowerCase())).filter((x) => x != null))];
  if (!on.length || on.includes(byDate)) return GENS[byDate];
  return GENS[on.reduce((a, b) => (Math.abs(b - byDate) < Math.abs(a - byDate) ? b : a))];
}

/** Makers: { id, name, franchises: Map series id -> { from, until } (the years of the series that are theirs), igdb: [lower-case name starts] } */
export const MAKER_LIST = MAKERS.map((m) => ({ ...m, franchises: new Map(m.franchises.map((f) => (Array.isArray(f) ? [f[0], f[1] || {}] : [f, {}]))), igdb: m.igdb.map((x) => x.toLowerCase()) }));
export const MAKER_BY_ID = new Map(MAKER_LIST.map((m) => [m.id, m]));
const MAKERS_OF_FRANCHISE = new Map();
for (const m of MAKER_LIST) for (const f of m.franchises.keys()) { if (!MAKERS_OF_FRANCHISE.has(f)) MAKERS_OF_FRANCHISE.set(f, []); MAKERS_OF_FRANCHISE.get(f).push(m); }
/** Is a company (as IGDB names it) one of a curated maker's? */
export const isMakers = (m, company) => { const n = String(company).toLowerCase(); return m.igdb.some((p) => n === p.trim() || n.startsWith(p)); };
/**
 * The curated makers of a game: by IGDB's developers and publishers when it names any; else by its
 * series, for the years of the series that are theirs (`year`: the game's, when known).
 */
export function makersOf(franchiseId, companies = [], year = null) {
  const out = new Set();
  for (const c of companies) for (const m of MAKER_LIST) if (isMakers(m, c)) out.add(m);
  for (const m of MAKERS_OF_FRANCHISE.get(franchiseId) || []) {
    const { from, until } = m.franchises.get(franchiseId);
    const ranged = from != null || until != null;
    // a series that changed hands: IGDB's word when there is one, else the year
    if (ranged && (companies.length || (year != null && ((from != null && year < from) || (until != null && year > until))))) continue;
    out.add(m);
  }
  return [...out];
}

/** Genres and worlds: { id, name, tagline, genres: Set, themes: Set } (IGDB's names, lower case). */
export const GENRE_LIST = GENRES.map((g) => ({ ...g, genres: new Set((g.genres || []).map((x) => x.toLowerCase())), themes: new Set((g.themes || []).map((x) => x.toLowerCase())) }));
export const GENRE_BY_ID = new Map(GENRE_LIST.map((g) => [g.id, g]));
/** The genre legends a game is part of, by IGDB's genres and themes of it. */
export const genresOf = (genres = [], themes = []) => GENRE_LIST.filter((g) => genres.some((x) => g.genres.has(String(x).toLowerCase())) || themes.some((x) => g.themes.has(String(x).toLowerCase())));

/** Trends: { id, name, tagline, from, to, franchises: Set, keys: Set of normalised titles, prefixes: [normalised] } */
export const TREND_LIST = TRENDS.map((t) => ({
  ...t, franchises: new Set(t.franchises || []),
  keys: new Set((t.titles || []).flatMap((x) => [normalizeTitle(x), normalizeTitle(yearless(x))])),
  prefixes: (t.prefixes || []).map(normalizeTitle),
}));
export const TREND_BY_ID = new Map(TREND_LIST.map((t) => [t.id, t]));
/** The trends a game is part of: by its series, its title, or its title's beginning. `entryTitle`: the curated entry it is, if any. */
export function trendsOf(title, franchiseId, entryTitle = null) {
  const key = normalizeTitle(yearless(title));
  const ekey = entryTitle ? normalizeTitle(yearless(entryTitle)) : null;
  return TREND_LIST.filter((t) => (franchiseId && t.franchises.has(franchiseId)) || t.keys.has(key) || (ekey && t.keys.has(ekey)) || t.prefixes.some((p) => key === p || key.startsWith(`${p} `)));
}
