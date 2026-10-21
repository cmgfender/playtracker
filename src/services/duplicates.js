import { matchScore } from './titles.js';

/**
 * Duplicate tracking:
 *  - suggestions:   separate games whose titles look like the same game (merge candidates)
 *  - double_counted: one game with several counted entries that probably report the same
 *                    playtime (same platform twice, or near-identical totals) - exclude one
 *  - cross_platform: games owned on several platforms/accounts (already grouped)
 */
export function findDuplicates(db, { threshold = 0.8 } = {}) {
  const dismissed = new Set(db.prepare('SELECT key FROM dismissed_duplicates').all().map((r) => r.key));
  const games = db.prepare(`SELECT g.id, g.title, g.norm_title, g.cover_url,
      COALESCE(SUM(CASE WHEN e.excluded = 0 THEN e.playtime_min END), 0) minutes,
      GROUP_CONCAT(DISTINCT e.platform) platforms, COUNT(e.id) entries
    FROM games g JOIN entries e ON e.game_id = g.id GROUP BY g.id`).all();

  // Blocking by first token keeps this ~linear for big libraries.
  const blocks = new Map();
  for (const g of games) {
    const k = g.norm_title.split(' ')[0] || g.norm_title;
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k).push(g);
  }
  const suggestions = [];
  for (const list of blocks.values()) {
    if (list.length < 2 || list.length > 400) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]; const b = list[j];
        const score = matchScore(a.norm_title, b.norm_title);
        if (score < threshold) continue;
        const key = `merge:${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`;
        if (dismissed.has(key)) continue;
        suggestions.push({ key, score: Math.round(score * 100) / 100, games: [a, b].map(slim) });
      }
    }
  }
  suggestions.sort((x, y) => y.score - x.score);

  const entries = db.prepare(`SELECT e.id, e.game_id, e.account_id, e.platform, e.title, e.playtime_min, e.excluded, e.last_played_at,
      a.name account_name, g.title game_title, g.cover_url
    FROM entries e JOIN games g ON g.id = e.game_id LEFT JOIN accounts a ON a.id = e.account_id
    WHERE e.game_id IN (SELECT game_id FROM entries GROUP BY game_id HAVING COUNT(*) > 1)
    ORDER BY e.game_id, e.id`).all();
  const byGame = new Map();
  for (const e of entries) {
    if (!byGame.has(e.game_id)) byGame.set(e.game_id, []);
    byGame.get(e.game_id).push(e);
  }

  const doubleCounted = [];
  const crossPlatform = [];
  for (const [gameId, list] of byGame) {
    const counted = list.filter((e) => !e.excluded && e.platform !== 'manual');
    const g = { id: gameId, title: list[0].game_title, cover_url: list[0].cover_url };
    crossPlatform.push({ game: g, entries: list.map(slimEntry), platforms: [...new Set(list.map((e) => e.platform))] });
    for (let i = 0; i < counted.length; i++) {
      for (let j = i + 1; j < counted.length; j++) {
        const a = counted[i]; const b = counted[j];
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
  return { suggestions: suggestions.slice(0, 200), double_counted: doubleCounted, cross_platform: crossPlatform };
}

const slim = (g) => ({ id: g.id, title: g.title, cover_url: g.cover_url, minutes: g.minutes, platforms: (g.platforms || '').split(',').filter(Boolean), entries: g.entries });
const slimEntry = (e) => ({ id: e.id, platform: e.platform, account_id: e.account_id, account_name: e.account_name, title: e.title, playtime_min: e.playtime_min, excluded: !!e.excluded, last_played_at: e.last_played_at });
