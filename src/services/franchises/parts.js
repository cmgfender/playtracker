// One game of yours can hold more than one release of a series entry: Ocarina of Time played on the
// N64 in 1998, and its 2026 remake on Switch 2, kept together as one game. That is fine, as long as
// the series is told right: the original played, for its hours; the remake played, for its own.
//
// So each entry of a game (an account's copy, or one added by hand) is placed on its own, by its own
// title and by when it can have come out:
//  - not after it was first played (the platform's first play, the dates you gave, a tracked session)
//  - not before its hardware existed, nor after the hardware was gone (a Switch 2 copy is 2025 or
//    later; one played on the N64, 1996 to 2002)
// When a game's entries land on different entries of one series, the game is told in parts: each
// with its entries' minutes and dates and the release it is. Otherwise the game is placed as a whole.

import { dayKey } from '../stats.js';
import { entryOf } from './match.js';

const DAY = 86_400_000;

// [what the hardware is called (a Nintendo device code, or how a game added by hand says where it
// was played), the first year a game for it came out, the last (null: still sold)]. The order
// matters: "Switch 2" before "Switch", "Wii U" before "Wii", "Game Boy Advance" before "Game Boy".
const HARDWARE = [
  [/^bee$|switch ?2/i, 2025, null],
  [/^hac$|\bswitch\b|\bnsw\b/i, 2017, null],
  [/wii ?u\b/i, 2012, 2017],
  [/\bwii\b/i, 2006, 2013],
  [/gamecube|\bngc\b|\bgcn?\b/i, 2001, 2007],
  [/\bn64\b|nintendo 64/i, 1996, 2002],
  [/\bsnes\b|super nintendo|super famicom|\bsfc\b/i, 1990, 1999],
  [/\bnes\b|\bfamicom\b/i, 1983, 1995],
  [/\b3ds\b/i, 2011, 2020],
  [/\bn?ds\b|nintendo ds/i, 2004, 2014],
  [/game ?boy advance|\bgba\b/i, 2001, 2008],
  [/game ?boy colou?r|\bgbc\b/i, 1998, 2003],
  [/game ?boy|\bgb\b/i, 1989, 2001],
  [/\bps5\b|playstation ?5/i, 2020, null],
  [/\bps4\b|playstation ?4/i, 2013, null],
  [/\bps3\b|playstation ?3/i, 2006, 2017],
  [/\bps2\b|playstation ?2/i, 2000, 2013],
  [/\bps ?vita\b|\bvita\b/i, 2011, 2019],
  [/\bpsp\b/i, 2004, 2014],
  [/\bps1\b|\bpsx\b|\bps ?one\b|^playstation$/i, 1994, 2006],
  [/series [xs]|\bxs[xs]\b/i, 2020, null],
  [/xbox ?one|\bxone\b|\bxb1\b/i, 2013, null],
  [/xbox ?360|\bx360\b/i, 2005, 2016],
  [/^xbox$|original xbox/i, 2001, 2008],
  [/dreamcast/i, 1998, 2002],
  [/saturn/i, 1994, 2000],
  [/genesis|mega ?drive/i, 1988, 1997],
  [/master system/i, 1985, 1992],
  [/atari ?2600/i, 1977, 1992],
];

/**
 * The years a game played on this hardware can have come out in, [first, last] (last: null when it
 * is still sold), or null for hardware that says nothing (a PC, or nothing known). A title played on
 * two consoles ("HAC+BEE") came out for the older one.
 */
export function hardwareYears(text) {
  const out = [];
  for (const part of String(text || '').split('+').map((s) => s.trim()).filter(Boolean)) {
    const hw = HARDWARE.find(([re]) => re.test(part));
    if (hw) out.push([hw[1], hw[2]]);
  }
  if (!out.length) return null;
  return [Math.min(...out.map((x) => x[0])), out.some((x) => x[1] == null) ? null : Math.max(...out.map((x) => x[1]))];
}

/** The release year an entry can be: the game's, kept within what the entry's own evidence allows. */
export function entryYear(en, gameYear) {
  const hw = hardwareYears(en.hardware);
  const played = [en.first_played_at, en.manual_start, en.first_tracked_at].filter((t) => Number.isFinite(t) && t > 0);
  const playedYear = played.length ? new Date(Math.min(...played)).getFullYear() : null;
  const lo = hw?.[0] ?? null;
  let hi = [hw?.[1], playedYear].filter((x) => x != null).reduce((a, b) => Math.min(a, b), Infinity);
  if (hi === Infinity || (lo != null && hi < lo)) hi = hw?.[1] ?? null; // (a first play before the hardware existed: the dates are wrong)
  let y = gameYear ?? hi ?? lo;
  if (y != null && lo != null && y < lo) y = lo;
  if (y != null && hi != null && y > hi) y = hi;
  return y;
}

/**
 * A game's parts when its entries are different releases of one series entry, else null. A part:
 * the game (same id, for links) with a `uid`, only its entries' minutes, platforms, dates and store
 * ids, the release it is (`hit`), its own state, and `part: { entries: [entry ids], main }`. The main
 * part is the release the game itself is (its IGDB match, its title): the game's status speaks for it.
 */
export function partsOf(g, now = Date.now()) {
  if (!g.entries || g.entries.length < 2) return null;
  const keyOf = (h) => `${h.f.id}#${h.e.i}`;
  const placed = g.entries.map((en) => {
    const hit = entryOf({ title: en.title || g.title, igdb_name: null, release_year: entryYear(en, g.release_year), ids: [`${en.platform}:${en.ext_id}`] });
    // (only an entry of the series itself: a beta, bonus content or a launcher is no release of it)
    return { en, hit: hit?.e && (hit.how === 'title' || hit.how === 'version') ? hit : null };
  });
  const groups = new Map();
  for (const p of placed) if (p.hit) { const k = keyOf(p.hit); if (!groups.has(k)) groups.set(k, { hit: p.hit, ens: [] }); groups.get(k).ens.push(p.en); }
  if (groups.size < 2 || new Set([...groups.values()].map((x) => x.hit.f.id)).size > 1) return null;
  const minutesOf = (ens) => ens.reduce((a, e) => a + e.minutes, 0);
  // the release the game itself is: by its own release year (IGDB's, the store's); with none known,
  // the one played most (a title alone names the newest release: no reason to think it is that one)
  const base = g.release_year != null ? entryOf(g) : null;
  const mainKey = base?.e && groups.has(keyOf(base)) ? keyOf(base) : [...groups.entries()].sort((a, b) => minutesOf(b[1].ens) - minutesOf(a[1].ens))[0][0];
  for (const p of placed) if (!p.hit) groups.get(mainKey).ens.push(p.en); // placed nowhere: with the game's own release
  const recent = dayKey(now - 30 * DAY);
  return [...groups.entries()].map(([k, { hit, ens }]) => {
    const main = k === mainKey;
    const minutes = minutesOf(ens);
    const first = ens.map((e) => e.first_day).filter(Boolean).sort()[0] || null;
    const last = ens.map((e) => e.last_day).filter(Boolean).sort().at(-1) || null;
    // the game's status is about the release it is; another release is played, or being played, on its own dates
    const state = main && (g.state === 'finished' || g.state === 'dropped') ? g.state
      : minutes > 0 && last && last >= recent ? 'playing'
        : main && g.state === 'playing' && !last ? 'playing'
          : minutes > 0 || ens.some((e) => e.seen) ? 'played' : 'owned';
    return {
      ...g, uid: `${g.id}:${hit.e.i}`, minutes, first_day: first, last_day: last, state, complete: main ? g.complete : false,
      platforms: [...new Set(ens.map((e) => e.platform))], ids: ens.map((e) => `${e.platform}:${e.ext_id}`),
      release_year: hit.e.year, release_at: main ? g.release_at : null, hit, part: { entries: ens.map((e) => e.id), main },
    };
  });
}
