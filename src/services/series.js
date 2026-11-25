// Series (franchises): which games belong together. IGDB says so for the games it matched
// (game_tags kind 'franchise'); for the rest - and for a library without IGDB - the titles do:
// "Halo 3", "Halo: Reach" and "Halo Infinite" are one series. Inferring from titles is kept
// cautious: a wrong series ("Journey" with "Journey to the Savage Planet") is worse than none.

import { memo } from './stats.js';
import { normalizeTitle } from './titles.js';

// a shared beginning that ends in one of these is a phrase, not a name ("Call of" Duty / Juarez)
const STOP = new Set(['of', 'and', 'in', 'to', 'a', 'an', 'for', 'on', 'at', 'vs', 'with', 'from', 'by']);
// one shared word is a series only when a title marks it as one (a number, a subtitle); these never are
const GENERIC = new Set(['super', 'new', 'game', 'world', 'star', 'dark', 'final', 'project', 'lego', 'pro', 'big', 'my', 'mega', 'ultra']);
const SUBTITLE = /\s*[:–—]\s+|\s+-\s+/;
const isNumber = (t) => /^\d+$/.test(t);

const words = (title) => normalizeTitle(title).split(' ').filter(Boolean);
/** The words without the numbers at the end ("final fantasy 7" -> "final fantasy"); `marked` when any were dropped. */
function unnumbered(tokens) {
  const out = [...tokens];
  while (out.length > 1 && isNumber(out[out.length - 1])) out.pop();
  return { tokens: out, marked: out.length < tokens.length };
}

/** The beginning of `title` as it is written that normalises to `key` ("The Legend of Zelda" for "legend of zelda"). */
function written(title, key) {
  const parts = title.split(/\s+/);
  for (let i = 1; i <= parts.length; i++) {
    const head = parts.slice(0, i).join(' ');
    if (normalizeTitle(head) === key && !STOP.has(parts[i - 1].toLowerCase())) return head.replace(/[\s:–—-]+$/, '');
  }
  return null;
}

/**
 * Series from titles alone: Map of game id -> [series names, the most specific first], for the
 * games that share one with at least one other game. A series is named by
 *  - what stands before a subtitle or a number in some title ("Halo: Reach", "Portal 2",
 *    "Final Fantasy VII"), which other titles may then simply begin with ("Halo Infinite"); or
 *  - two or more words that two titles begin with ("Assassin's Creed Odyssey" / "... Valhalla").
 * One shared word without such a mark is not enough ("Doom" and "Doom Eternal" stay apart: so do
 * "Journey" and "Journey to the Savage Planet").
 */
export function inferSeries(games) {
  const list = games.map((g) => ({ id: g.id, title: String(g.title || ''), tokens: words(g.title) })).filter((g) => g.tokens.length);
  const keys = new Map(); // key -> a title it was read from
  const propose = (tokens, title) => {
    if (!tokens.length || STOP.has(tokens[tokens.length - 1]) || tokens.every(isNumber)) return;
    if (tokens.length === 1 && (tokens[0].length < 3 || GENERIC.has(tokens[0]))) return;
    const key = tokens.join(' ');
    if (!keys.has(key)) keys.set(key, title);
  };
  for (const g of list) {
    const head = g.title.split(SUBTITLE)[0];
    const sub = head.trim() !== g.title.trim();
    const { tokens, marked } = unnumbered(words(head));
    if (sub || marked) propose(tokens, g.title);
  }
  // two or more words in common, read off titles that sort next to each other
  for (const g of list) g.key = g.tokens.join(' ');
  const sorted = [...list].sort((a, b) => (a.key < b.key ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1].tokens; const b = sorted[i].tokens;
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    while (n > 0 && (STOP.has(a[n - 1]) || isNumber(a[n - 1]))) n--;
    if (n >= 2 && (n < a.length || n < b.length)) propose(a.slice(0, n), sorted[i - 1].title);
  }
  // a series needs two games; of names that hold the very same games the shortest is the series
  // ("Batman", not "Batman: Arkham"). A game is in every series it begins with: a Star Wars Jedi
  // game is a Star Wars game too.
  // (a game's series are beginnings of its own title, so each title is read once, a word at a time:
  // comparing every name with every title is the square of a big library)
  const heads = (g, fn) => { let p = ''; for (let i = 0; i < g.tokens.length; i++) { p = i ? `${p} ${g.tokens[i]}` : g.tokens[0]; fn(p); } };
  const holds = new Map(); // key -> the ids of the games that begin with it, in the library's order
  for (const g of list) heads(g, (p) => { if (keys.has(p)) { if (!holds.has(p)) holds.set(p, []); holds.get(p).push(g.id); } });
  const size = (k) => k.split(' ').length;
  const bySet = new Map();
  for (const k of keys.keys()) {
    const ids = holds.get(k);
    if (!ids || ids.length < 2) continue;
    const set = ids.join(',');
    if (!bySet.has(set) || size(k) < size(bySet.get(set))) bySet.set(set, k);
  }
  const valid = new Map([...bySet.values()].map((k) => [k, written(keys.get(k), k) || k]));
  const out = new Map();
  for (const g of list) {
    const hits = [];
    heads(g, (p) => { if (valid.has(p)) hits.unshift(valid.get(p)); }); // the longest beginning first
    if (hits.length) out.set(g.id, hits);
  }
  return out;
}

/**
 * Every game's series: Map of game id -> [names]. IGDB's franchises where it gave any, the title's
 * otherwise; names that differ only in how they are written are one series.
 */
export function seriesOf(db) {
  return memo(db, 'series-of', () => {
    const games = db.prepare('SELECT id, title FROM games').all();
    const out = new Map();
    const names = new Map(); // normalised name -> the name as first written
    const name = (x) => { const k = normalizeTitle(x); if (!names.has(k)) names.set(k, x); return names.get(k); };
    for (const t of db.prepare("SELECT game_id, name FROM game_tags WHERE kind = 'franchise' ORDER BY game_id, name").all()) {
      if (!out.has(t.game_id)) out.set(t.game_id, []);
      out.get(t.game_id).push(name(t.name));
    }
    for (const [id, list] of inferSeries(games)) if (!out.has(id)) out.set(id, list.map(name));
    return out;
  });
}
