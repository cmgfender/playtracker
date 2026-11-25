// The curated franchises (src/data/franchises/*.js), prepared for matching and building: entries
// keyed by normalised title, the versions each one comes down to, eras by entry, prefixes, aliases and
// launcher ids. Nothing here reads the database.

import { FRANCHISES } from '../../data/franchises.js';
import { normalizeTitle } from '../titles.js';

export const KINDS = ['main', 'spinoff', 'remake', 'remaster', 'rerelease', 'collection'];
/** Kinds that are another version of an earlier entry (`of`). */
export const VERSION_KINDS = new Set(['remake', 'remaster', 'rerelease']);
/** "Doom (2016)" without its year: the title it is sold under. */
export const yearless = (t) => String(t || '').replace(/\s*\((?:19|20)\d{2}\)$/, '');
export const slug = (name) => normalizeTitle(name).replace(/\s+/g, '-') || 'series';

/** One franchise file, prepared: entries with their keys, versions (`of`, `roots`), collections (`inc`) and era. */
export function prepare(f) {
  const entries = f.entries.map(([year, title, kind = 'main', opts = {}], i) => ({
    i, year, title, kind, includes: opts.includes || [], ofTitles: [].concat(opts.of || []), partial: !!opts.partial, eraName: opts.era || null,
    keys: [...new Set([title, yearless(title), ...(opts.aka || [])].map(normalizeTitle))],
  }));
  const byTitle = new Map(entries.map((e) => [e.title, e]));
  for (const e of entries) {
    e.of = e.ofTitles.map((t) => byTitle.get(t)?.i).filter((x) => x != null);
    e.inc = e.includes.map((t) => byTitle.get(t)?.i).filter((x) => x != null);
  }
  // the originals a version comes down to: a remaster of a remake is a version of the original
  const rootsOf = (e, seen) => (!e.of.length || seen.has(e.i) ? [e.i] : (seen.add(e.i), [...new Set(e.of.flatMap((j) => rootsOf(entries[j], seen)))]));
  for (const e of entries) e.roots = VERSION_KINDS.has(e.kind) && e.of.length ? rootsOf(e, new Set()) : [];
  // eras: each from its first entry up to the next era's first, in release order; `era` on an entry places it by name
  const eras = (f.eras || []).map(([start, name, note]) => ({ start: byTitle.get(start)?.i ?? -1, name, note })).filter((x) => x.start >= 0).sort((a, b) => a.start - b.start);
  for (const e of entries) {
    let k = 0;
    eras.forEach((x, j) => { if (x.start <= e.i) k = j; });
    const named = e.eraName ? eras.findIndex((x) => x.name === e.eraName) : -1;
    e.era = eras.length ? (named >= 0 ? named : k) : null;
  }
  for (const x of eras) x.from = entries[x.start].year;
  const hubs = (f.hubs || []).map((h) => ({ ...h, idset: new Set(Object.entries(h.ids || {}).flatMap(([p, ids]) => ids.map((id) => `${p}:${id}`))) }));
  return { ...f, curated: true, aliasKeys: new Set(f.aliases.map(normalizeTitle)), prefix: f.prefix.map(normalizeTitle), entries, eras, hubs };
}

export const CURATED = FRANCHISES.map(prepare);
/** normalised title -> [{ f, e }]: one title can name entries of different years (Doom 1993 and 2016). */
export const BY_KEY = new Map();
for (const f of CURATED) for (const e of f.entries) for (const k of e.keys) { if (!BY_KEY.has(k)) BY_KEY.set(k, []); BY_KEY.get(k).push({ f, e }); }
/** normalised series name (IGDB's, people's) -> franchise */
export const BY_ALIAS = new Map();
for (const f of CURATED) for (const k of f.aliasKeys) if (!BY_ALIAS.has(k)) BY_ALIAS.set(k, f);
export const BY_ID = new Map(CURATED.map((f) => [f.id, f]));
/** prefixes by their first word: a title is checked against the few that can start it */
export const PREFIXES = new Map();
for (const f of CURATED) for (const p of f.prefix) { const w = p.split(' ')[0]; if (!PREFIXES.has(w)) PREFIXES.set(w, []); PREFIXES.get(w).push({ f, p }); }
export const WITH_HUBS = CURATED.filter((f) => f.hubs.length);
export const CURATED_IDS = CURATED.map((f) => f.id);
