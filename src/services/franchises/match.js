// What a game of yours is in the curated franchises, from its title, IGDB's name for it, its release
// year and its store ids. Exact titles first; then, in turn, a test build, bonus content, a mode or a
// platform's build, and a version (remaster or re-release) of an entry; else the series it belongs to
// by its title's beginning or IGDB's franchise.
//
// To teach it a new kind of store title, add the words to RULES: each rule strips one trailing part
// of the title (joined by a dash, a colon, brackets or just a space) before looking the rest up.

import { normalizeTitle } from '../titles.js';
import { BY_KEY, BY_ALIAS, PREFIXES, WITH_HUBS, VERSION_KINDS, yearless } from './catalog.js';

const tail = (words) => new RegExp(`\\s*(?:[-–—:|]\\s*|\\(\\s*|\\[\\s*)?(?:${words})\\s*[)\\]]?\\s*$`, 'i');

export const RULES = {
  /** A test build: a beta, an insider build, a public test server, a demo. Kept with the game, not the game. */
  test: tail("(?:(?:open|closed|public|private|early|multiplayer|technical|tech|network|stress|downloadable|playable) )*(?:beta|alpha|insider|demo|trial|playtest|test server|test|preview|server slam)|pts"),
  /** What comes with a game and is not one: bonus content, a soundtrack, an art book, a friend's pass. */
  bonus: tail("bonus content|digital bonus content|soundtrack|original soundtrack|ost|art ?book|digital art ?book|friend'?s pass"),
  /** A mode or a platform's build of the same game: the game itself. */
  same: tail("battlemode|multiplayer|campaign|base game|full game|xbox series x ?\\| ?s|xbox series x|xbox one|xbox 360|windows 10|windows pc|windows|pc|ps4|ps5|nintendo switch 2 edition|nintendo switch edition|for (?:xbox one|xbox series x ?\\| ?s|xbox 360|pc)|(?:[\\w'’]+ ){0,2}edition"),
  /** A version: remastered, remade or released again with its name kept. */
  version: tail("(?:the )?(?:hd )?remaster(?:ed)?|pixel remaster|master collection version|hd remix|hd edition|hd|classic edition|classic|redux|reforged|resurrected|remake|reimagined|vr"),
  /** One episode of an episodic game ("- Episode 1: Zer0 Sum", "(Episode One)"): the game. */
  episode: /\s*[(\-–—:]+\s*episode\s+(?:\d+|one|two|three|four|five|six)\b.*$/i,
  /** A brand in front of the series' own name ("EA SPORTS FIFA 16"). */
  brand: /^(?:ea sports|ea sports™|2k sports|2k)\s+/i,
};
const strip = (t, re) => { let s = t; for (let i = 0; i < 2; i++) { const n = s.replace(re, '').trim(); if (n === s || !n) break; s = n; } return s; };

/**
 * The curated entry a normalised title names, told apart by the game's release year when it names
 * two. `how` is 'title' (the entry itself) or 'version' (a later release under its name). `igdbKey`,
 * when given, is what IGDB calls the game: a later release IGDB knows by another name is not a
 * version of the entry (the Call of Duty app is not the 2003 game).
 */
function matchKey(key, g, igdbKey) {
  const cands = key && BY_KEY.get(key);
  if (!cands?.length) return null;
  const y = g.release_year;
  if (y == null) return { hit: cands.reduce((a, b) => (b.e.year > a.e.year ? b : a)), how: 'title' }; // a modern copy, most likely
  const best = cands.reduce((a, b) => (Math.abs(b.e.year - y) < Math.abs(a.e.year - y) ? b : a));
  const d = y - best.e.year;
  if (Math.abs(d) <= 3) return { hit: best, how: 'title' };
  const named = igdbKey != null && best.e.keys.includes(igdbKey);
  if (d > 3 && (igdbKey == null || named)) {
    // a later release under the entry's name that is one of its curated versions (Steam sells the
    // Resident Evil HD Remaster as "Resident Evil"): that version
    const { f, e } = best;
    const kin = (x) => x.of.includes(e.i) || x.roots.includes(e.i) || (e.roots.length && e.roots.some((r) => x.roots.includes(r)));
    const near = f.entries.filter((x) => x !== e && VERSION_KINDS.has(x.kind) && kin(x) && Math.abs(x.year - y) <= 1);
    if (near.length) return { hit: { f, e: near.reduce((a, b) => (Math.abs(b.year - y) < Math.abs(a.year - y) ? b : a)) }, how: 'title' };
    return { hit: best, how: 'version' };
  }
  return d < 0 && named ? { hit: best, how: 'title' } : null;
}

/**
 * What a game is in the curated franchises: { f, e, how: title|version|test|bonus } or
 * { f, hub, how: 'hub' }, or null. `g`: { title, igdb_name, release_year, ids: ['steam:1938090', …] }.
 */
export function entryOf(g) {
  const ids = g.ids || [];
  for (const f of WITH_HUBS) for (const hub of f.hubs) if (ids.some((id) => hub.idset.has(id))) return { f, hub, how: 'hub' };
  const igdbKey = g.igdb_name ? normalizeTitle(yearless(g.igdb_name)) : null;
  const as = (m, how) => m && { f: m.hit.f, e: m.hit.e, how: how || m.how };
  const title = yearless(g.title);
  const tries = [title, title.replace(RULES.episode, ''), title.replace(RULES.brand, ''), g.igdb_name && yearless(g.igdb_name)].filter((t, i, a) => t && a.indexOf(t) === i);
  for (const raw of tries) {
    const fromIgdb = raw !== title && raw === (g.igdb_name && yearless(g.igdb_name));
    const exact = matchKey(normalizeTitle(raw), g, fromIgdb ? null : igdbKey);
    if (exact) return as(exact);
    // a test build: matched without a year (a beta comes out before its game)
    const t = strip(raw, RULES.test);
    if (t !== raw) { const m = matchKey(normalizeTitle(strip(t, RULES.same)), { ...g, release_year: null }); if (m) return as(m, 'test'); }
    const b = strip(raw, RULES.bonus);
    if (b !== raw) { const m = matchKey(normalizeTitle(b), { ...g, release_year: null }); if (m) return as(m, 'bonus'); }
    // a mode, or a platform's build: the game itself, whenever that build came out
    const s = strip(raw, RULES.same);
    if (s !== raw) { const k = normalizeTitle(s); const m = matchKey(k, g, null) || matchKey(k, { ...g, release_year: null }); if (m) return as(m, 'title'); }
    // a remaster or re-release under the original's name: a version, unless it came out with it
    const v = strip(s, RULES.version);
    if (v !== s) {
      const m = matchKey(normalizeTitle(v), g);
      if (m) return as(m, g.release_year != null && g.release_year - m.hit.e.year <= 1 && m.how === 'title' ? 'title' : 'version');
    }
  }
  return null;
}

/**
 * The curated franchise a game that is no curated entry belongs to: the title's beginning (the
 * longest prefix wins: "Super Mario Kart" is Mario Kart's, not Super Mario's), else IGDB's franchise
 * - the title first, as IGDB tags a Persona game with Megami Tensei as well as Persona.
 */
export function curatedOf(g) {
  const key = normalizeTitle(g.title);
  let best = null;
  for (const { f, p } of PREFIXES.get(key.split(' ')[0]) || []) if ((key === p || key.startsWith(`${p} `)) && (!best || p.length > best.p.length)) best = { f, p };
  if (best) return best.f;
  for (const n of g.franchises || []) { const f = BY_ALIAS.get(normalizeTitle(n)); if (f) return f; }
  return null;
}

/** A title (with what else is known of it) as the franchise pages would place it: for tools and tests. */
export function matchTitle(title, { year = null, igdbName = null, ids = [], franchises = [] } = {}) {
  const g = { title, igdb_name: igdbName, release_year: year, ids, franchises };
  const hit = entryOf(g);
  if (hit?.hub) return { franchise: hit.f.id, how: 'hub', title: hit.hub.title };
  if (hit) return { franchise: hit.f.id, how: hit.how, entry: hit.e.title, year: hit.e.year, kind: hit.e.kind };
  const f = curatedOf(g);
  return f ? { franchise: f.id, how: f.aliasKeys.has(normalizeTitle(yearless(title))) ? 'hub' : 'other' } : null;
}
