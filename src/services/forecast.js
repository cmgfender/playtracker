// Looking ahead: when a game will be finished at the pace it is played, and how long the backlog
// would take. Both rest on IGDB's typical time to beat, scaled by how this player's finished games
// compared with it (see paceStats), and on tracked play only: estimated history has no pace.

import { memo, filter, dayKey } from './stats.js';
import { paceStats } from './insights.js';
import { fmtMinutes } from '../util.js';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const PACE_DAYS = 28;       // a game's pace: its tracked play of the last four weeks
const LIBRARY_DAYS = 84;    // the player's pace: all tracked play of the last twelve weeks
const MIN_WEEKLY = 15;      // minutes a week below which a game is not being played
const MIN_PACE_GAMES = 3;   // finished games needed before the player's own ratio is trusted
const RATE_DAYS = 90;       // games added and finished are counted over this many days
const DONE = new Set(['completed', 'beaten']);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const round1 = (x) => Math.round(x * 10) / 10;

/** This player's time against the typical time (1 without enough finished games; kept within reason). */
export function paceRatio(db) {
  const p = paceStats(db, { limit: 1 });
  if (p.games < MIN_PACE_GAMES || !p.median_ratio) return { ratio: 1, personal: false, games: p.games };
  return { ratio: Math.min(3, Math.max(0.5, p.median_ratio)), personal: true, games: p.games };
}

/** Tracked minutes from `fromDay` on, of one game or of all. */
function trackedSince(db, fromDay, gameId = null) {
  const f = filter('p', { fromDay, gameId, estimates: 'exclude' });
  return db.prepare(`SELECT COALESCE(SUM(p.minutes), 0) m ${f.sql}`).get(...f.args).m;
}

/** A span of weeks in words: "about 3 weeks", "about 5 months", "about 2.5 years". */
export function spanText(weeks) {
  if (weeks < 1) return 'under a week';
  if (weeks < 9) return `about ${plural(Math.round(weeks), 'week')}`;
  if (weeks < 78) return `about ${plural(Math.round(weeks / 4.35), 'month')}`; // a year and a half, then years
  const years = round1(weeks / 52.18);
  return `about ${years} year${years === 1 ? '' : 's'}`;
}

/**
 * When a game will be finished at the pace it is played. null for an unknown game; otherwise
 * { available: false, reason } when there is nothing to forecast (no typical time, already
 * finished or dropped), or the forecast: what is left of the expected length and, when the game
 * was played in the last four weeks, how many weeks that is.
 */
export function finishForecast(db, gameId, { now = Date.now() } = {}) {
  return memo(db, `forecast:${gameId}:${dayKey(now)}`, () => {
    const g = db.prepare(`SELECT g.id, g.title, g.status, m.ttb_main, m.ttb_extra,
        (SELECT COALESCE(SUM(e.playtime_min), 0) FROM entries e WHERE e.game_id = g.id AND e.excluded = 0) minutes
      FROM games g LEFT JOIN game_meta m ON m.game_id = g.id WHERE g.id = ?`).get(gameId);
    if (!g) return null;
    const typical = g.ttb_main || g.ttb_extra || 0;
    if (DONE.has(g.status)) return { available: false, reason: 'finished', game_id: g.id };
    if (g.status === 'dropped') return { available: false, reason: 'dropped', game_id: g.id };
    if (!typical) return { available: false, reason: 'no_typical_time', game_id: g.id };
    const pace = paceRatio(db);
    const expected = Math.round(typical * pace.ratio);
    const played = Math.round(g.minutes);
    const remaining = Math.max(0, expected - played);
    const weekly = trackedSince(db, dayKey(now - (PACE_DAYS - 1) * DAY), g.id) / (PACE_DAYS / 7);
    const out = {
      available: true, game_id: g.id,
      typical_minutes: typical, basis: g.ttb_main ? 'main' : 'extra',
      pace_ratio: pace.ratio, personal_pace: pace.personal,
      expected_minutes: expected, played_minutes: played, remaining_minutes: remaining,
      percent: Math.min(100, Math.round((played / expected) * 100)),
      weekly_minutes: Math.round(weekly), weeks: null, finish_day: null,
      state: !remaining ? 'past' : weekly < MIN_WEEKLY ? 'idle' : 'playing',
    };
    if (out.state === 'playing') {
      out.weeks = round1(remaining / weekly);
      out.finish_day = dayKey(now + out.weeks * WEEK);
    }
    const length = `${fmtMinutes(expected)}${pace.personal ? ' at your pace' : ' typical'}`;
    out.text = out.state === 'past' ? `Past the ${length}: ${fmtMinutes(played)} played.`
      : out.state === 'idle' ? `About ${fmtMinutes(remaining)} left of ${length}. Not played in the last four weeks.`
        : `${spanText(out.weeks).replace(/^./, (c) => c.toUpperCase())} to finish: ${fmtMinutes(remaining)} left of ${length}, at ${fmtMinutes(out.weekly_minutes)} a week.`;
    return out;
  });
}

/**
 * How long the backlog would take: what is left of the expected length of every game marked
 * Backlog, against the player's tracked hours a week. Games without a typical time are assumed
 * to need the median of those with one (`assumed` says how many). With enough history, also how
 * many games a month are added and how many finished.
 */
export function backlogReality(db, { now = Date.now() } = {}) {
  return memo(db, `backlog-reality:${dayKey(now)}`, () => {
    const pace = paceRatio(db);
    const rows = db.prepare(`SELECT g.id, m.ttb_main, m.ttb_extra,
        (SELECT COALESCE(SUM(e.playtime_min), 0) FROM entries e WHERE e.game_id = g.id AND e.excluded = 0) minutes
      FROM games g LEFT JOIN game_meta m ON m.game_id = g.id WHERE g.status = 'backlog' AND g.hidden = 0`).all();
    const left = rows.map((x) => { const t = x.ttb_main || x.ttb_extra; return t ? Math.max(0, t * pace.ratio - x.minutes) : null; });
    const known = left.filter((x) => x != null).sort((a, b) => a - b);
    const median = known.length ? (known.length % 2 ? known[known.length >> 1] : (known[known.length / 2 - 1] + known[known.length / 2]) / 2) : 0;
    const assumed = known.length >= MIN_PACE_GAMES ? rows.length - known.length : 0;
    const remaining = Math.round(known.reduce((a, b) => a + b, 0) + assumed * median);

    // the player's pace: tracked play of the last twelve weeks, or since tracking began if that is later
    const first = db.prepare('SELECT MIN(p.day) d FROM play_days p WHERE p.excluded = 0 AND p.estimated = 0').get().d;
    const from = dayKey(now - (LIBRARY_DAYS - 1) * DAY);
    const start = first && first > from ? first : from;
    const days = first ? Math.max(1, Math.round((Date.parse(`${dayKey(now)}T12:00:00`) - Date.parse(`${start}T12:00:00`)) / DAY) + 1) : 0;
    const weekly = days >= 14 ? trackedSince(db, start) / (days / 7) : 0;
    const weeks = remaining && weekly >= MIN_WEEKLY ? round1(remaining / weekly) : null;

    // games a month, added and finished: only once the library is older than the window (a first import adds everything at once)
    const oldest = db.prepare('SELECT MIN(created_at) t FROM games').get().t;
    const since = now - RATE_DAYS * DAY;
    const rates = oldest && oldest < since - 30 * DAY;
    const added = rates ? db.prepare('SELECT COUNT(*) n FROM games WHERE hidden = 0 AND created_at >= ?').get(since).n : null;
    // finished: marked Completed or Beaten and last played (tracked) in the window - there is no date for the status itself
    const finished = rates ? db.prepare(`SELECT COUNT(*) n FROM games g WHERE g.status IN ('completed', 'beaten')
      AND (SELECT MAX(p.day) FROM play_days p WHERE p.game_id = g.id AND p.excluded = 0 AND p.estimated = 0) >= ?`).get(dayKey(since)).n : null;
    const perMonth = (n) => (n == null ? null : round1(n / (RATE_DAYS / 30.4)));

    const out = {
      games: rows.length, with_typical_time: known.length, assumed,
      remaining_minutes: remaining, pace_ratio: pace.ratio, personal_pace: pace.personal,
      weekly_minutes: Math.round(weekly), weeks, years: weeks == null ? null : round1(weeks / 52.18),
      added_per_month: perMonth(added), finished_per_month: perMonth(finished),
      text: null,
    };
    if (rows.length && remaining && weeks != null) {
      // all of it: in practice much of a week goes to games already being played, so this is the least it would take
      out.text = `${plural(rows.length, 'game')} in the backlog hold${rows.length === 1 ? 's' : ''} about ${fmtMinutes(remaining)} of play: ${spanText(weeks)} if all your play went to it (${fmtMinutes(out.weekly_minutes)} a week).`
        + (out.added_per_month != null ? ` You add ${plural(out.added_per_month, 'game')} a month and finish ${out.finished_per_month}.` : '');
    }
    return out;
  });
}
