import { matchScore, normalizeTitle, similarity } from './titles.js';
import { RULES } from './franchises/match.js';

// What may follow a game's title and still be that game: an edition, a platform's build, a remaster.
// (Not a remake, a VR version or a mode: those are told apart by the series pages, and are other games here.)
const REMASTER = /\s*(?:[-–—:|]\s*|\(\s*)?(?:(?:the )?(?:hd )?remaster(?:ed)?|hd remix|hd edition|hd|redux|reforged|resurrected|console(?: edition)?)\s*\)?\s*$/i;
const strip = (t, re) => { let x = t; for (let i = 0; i < 3; i++) { const n = x.replace(re, '').trim(); if (n === x || !n) break; x = n; } return x; };
/** A title without its editions, platform builds and remaster marks: what it is a copy of. */
const core = (title) => { let t = String(title || ''); for (let i = 0; i < 3; i++) { const n = strip(strip(t, RULES.same), REMASTER); if (n === t) break; t = n; } return normalizeTitle(t); };
/** Not the game: a beta, a demo, bonus content, a soundtrack. */
const notTheGame = (title) => RULES.test.test(title) || RULES.bonus.test(title);

/**
 * How surely two games are two copies of one (0: they are not). Titles that only look alike are not
 * enough: a suggestion list of "GreedFall / Redfall", a game beside its beta, its demo, its sequel in
 * all but number (Battlefield / Battlefield Hardline, Perfect Dark / Perfect Dark Zero) is a chore
 * that teaches you to ignore it. Suggested are:
 *   1     the same title once normalised
 *   0.9   the same game in another edition, platform build or remaster (Alan Wake / Alan Wake Remastered)
 *   0.85  the publisher's name in front of one of them (Sid Meier's Civilization V / Civilization V)
 *   sim   titles that differ by a letter or a space (FARCRY 6 / Far Cry 6, Watch_Dogs 2 / Watch Dogs2), at 93% or more
 * and never a pair where one is a beta, demo or bonus content and the other is not.
 */
export function sameGame(a, b) {
  if (a.norm_title === b.norm_title) return 1;
  if (notTheGame(a.title) !== notTheGame(b.title)) return 0;
  const score = matchScore(a.norm_title, b.norm_title);
  if (score <= 0.5) return 0; // (different numbers: a sequel)
  const ca = core(a.title); const cb = core(b.title);
  if (ca && ca === cb) return 0.9;
  const [short, long] = a.norm_title.length <= b.norm_title.length ? [a.norm_title, b.norm_title] : [b.norm_title, a.norm_title];
  // (a name of two words or more: "Haven" is not Teddy's Haven)
  if (short.includes(' ') && long.endsWith(` ${short}`) && / s$/.test(long.slice(0, -short.length - 1))) return 0.85;
  // one title is the other and more: a subtitle, so another game (unless the rest was an edition, above)
  if (long.startsWith(`${short} `) || long.endsWith(` ${short}`)) return 0;
  const sim = similarity(a.norm_title, b.norm_title);
  return sim >= 0.93 ? sim : 0;
}
import { memo } from './stats.js';

// the least time each of two copies holds for them to count anything twice
const DOUBLE_MIN = 10;

/**
 * Duplicate tracking:
 *  - suggestions:   separate games whose titles look like the same game (merge candidates)
 *  - double_counted: one game with several counted entries that probably report the same
 *                    playtime (same platform twice, or near-identical totals) - exclude one
 *  - cross_platform: games owned on several platforms/accounts (already grouped)
 */
export function findDuplicates(db, { threshold = 0.8, limit = 300 } = {}) {
  return memo(db, `dupes:${threshold}:${limit}`, () => compute(db, threshold, limit));
}

const wished = (g) => g.status === 'wishlist' && !g.minutes;

function compute(db, threshold, limit) {
  const dismissed = new Set(db.prepare('SELECT key FROM dismissed_duplicates').all().map((r) => r.key));
  const games = db.prepare(`SELECT g.id, g.title, g.norm_title, g.cover_url, g.status,
      COALESCE(SUM(CASE WHEN e.excluded = 0 THEN e.playtime_min END), 0) minutes,
      GROUP_CONCAT(DISTINCT e.platform) platforms, COUNT(e.id) entries
    FROM games g JOIN entries e ON e.game_id = g.id GROUP BY g.id`).all();

  // Sorted-neighbourhood comparison: titles that only differ by a suffix (editions,
  // subtitles) sort next to each other, so comparing each title with its next few
  // neighbours finds them in O(n·W) instead of O(n²) - fine for 100k+ games.
  const WINDOW = 12;
  const suggestions = [];
  const seen = new Set();
  const consider = (a, b) => {
    if (a.id === b.id) return;
    // scored first: the pair's key is only built for the few that match (a pair both passes
    // compare is scored twice, which is cheaper than a key for every comparison)
    if (matchScore(a.norm_title, b.norm_title) < threshold) return; // (cheap: most pairs end here)
    const score = sameGame(a, b);
    if (score < threshold) return;
    // a game you only wish for, never played, is not a copy of another game you have: "Fable" (the new
    // one) and Fable: The Lost Chapters, Call of Duty and Call of Duty: Vanguard, a DLC and its game.
    // (the same title is merged as it is added; titles that differ say it is another game)
    if ((wished(a) || wished(b)) && a.norm_title !== b.norm_title) return;
    const key = `merge:${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`;
    if (seen.has(key) || dismissed.has(key)) return;
    seen.add(key);
    suggestions.push({ key, score: Math.round(score * 100) / 100, games: [a, b].map(slim) });
  };
  const sweep = (list) => {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j <= i + WINDOW && j < list.length; j++) consider(list[i], list[j]);
  };
  sweep([...games].sort((a, b) => (a.norm_title < b.norm_title ? -1 : a.norm_title > b.norm_title ? 1 : 0)));
  // second pass on reversed titles catches prefix differences ("the ...", "tom clancy's ...")
  const rev = (t) => [...t].reverse().join('');
  sweep(games.map((g) => ({ ...g, r: rev(g.norm_title) })).sort((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : 0)));
  suggestions.sort((x, y) => y.score - x.score);

  const entries = db.prepare(`WITH multi AS (SELECT game_id FROM entries GROUP BY game_id HAVING COUNT(*) > 1)
    SELECT e.id, e.game_id, e.account_id, e.platform, e.ext_id, e.title, e.playtime_min, e.excluded, e.last_played_at,
      a.name account_name, g.title game_title, g.cover_url
    FROM multi m JOIN entries e ON e.game_id = m.game_id JOIN games g ON g.id = e.game_id LEFT JOIN accounts a ON a.id = e.account_id
    ORDER BY e.game_id, e.id`).all();
  const byGame = new Map();
  for (const e of entries) {
    if (!byGame.has(e.game_id)) byGame.set(e.game_id, []);
    byGame.get(e.game_id).push(e);
  }

  const doubleCounted = [];
  const crossPlatform = [];
  for (const [gameId, list] of byGame) {
    // hours assumed for a copy its platform reports no time for are no second report of the same play
    const counted = list.filter((e) => !e.excluded && e.platform !== 'manual' && !(e.account_id == null && String(e.ext_id).startsWith('assumed:')));
    const g = { id: gameId, title: list[0].game_title, cover_url: list[0].cover_url };
    crossPlatform.push({ game: g, entries: list.map(slimEntry), platforms: [...new Set(list.map((e) => e.platform))] });
    for (let i = 0; i < counted.length; i++) {
      for (let j = i + 1; j < counted.length; j++) {
        const a = counted[i]; const b = counted[j];
        // a copy with no time (or a minute or two) adds nothing to the totals: it counts nothing twice
        // (Xbox keeps a 360 and a One title of one game, Steam a launcher and the game: 0m beside 19h)
        if (Math.min(a.playtime_min, b.playtime_min) < DOUBLE_MIN) continue;
        let reason = null;
        if (a.platform === b.platform) reason = `Tracked twice on ${a.platform}`;
        else if (a.playtime_min >= 60 && Math.abs(a.playtime_min - b.playtime_min) <= Math.max(5, 0.02 * a.playtime_min)) reason = 'Near-identical playtime on two platforms (mirrored stats?)';
        if (!reason) continue;
        const key = `double:${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`;
        if (dismissed.has(key)) continue;
        // Suggest excluding the entry with less information (imports first, then lower playtime)
        const rank = (e) => (e.account_id ? 1 : 0) * 1e9 + e.playtime_min;
        const suggestExclude = rank(a) <= rank(b) ? a.id : b.id;
        doubleCounted.push({ key, reason, game: g, entries: [a, b].map(slimEntry), suggest_exclude: suggestExclude });
      }
    }
  }
  crossPlatform.sort((a, b) => b.platforms.length - a.platforms.length || a.game.title.localeCompare(b.game.title));
  return {
    counts: { suggestions: suggestions.length, double_counted: doubleCounted.length, cross_platform: crossPlatform.length },
    suggestions: suggestions.slice(0, limit),
    double_counted: doubleCounted.slice(0, limit),
    cross_platform: crossPlatform.slice(0, limit),
  };
}

const slim = (g) => ({ id: g.id, title: g.title, cover_url: g.cover_url, minutes: g.minutes, platforms: (g.platforms || '').split(',').filter(Boolean), entries: g.entries });
const slimEntry = (e) => ({ id: e.id, platform: e.platform, account_id: e.account_id, account_name: e.account_name, title: e.title, playtime_min: e.playtime_min, excluded: !!e.excluded, last_played_at: e.last_played_at });
