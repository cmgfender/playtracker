// "What should I play?": a few picks from the library, scored with signals that can be explained
// in plain words, each reason built from the player's own numbers.
//
// Every candidate gets eight signals, each 0..1:
//   fit       its typical session (median tracked session; else the player's; else an hour) against
//             the time the player has
//   recent    tracked play in the last 14 days ("keep going")
//   momentum  a lot of play in the last 60 days and nothing in the last 14 ("pick up where you left off")
//   finish    achievement completion and how few are left; beaten games with some left
//   dusty     real past playtime, untouched for half a year or more ("rediscover")
//   fresh     never or barely played ("start something new")
//   pref      favorite, else the rating
//   status    playing > backlog > paused > beaten > no status
// A mode (preset) weighs them; the score is the weighted mean. Modes with a primary signal rank
// the games that have it above the ones that do not. A small seeded jitter breaks near-ties, so a
// pick is deterministic for the same inputs and seed; "Surprise me" draws from the best matches
// with seeded weights instead. The aggregates come from indexed SQL (entries, the per-day rollup,
// achievements, session-length frequencies) and are memoized until the next write.
import { HttpError, fmtMinutes } from '../util.js';
import { memo, dayKey, parseDay, addDays } from './stats.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const DEFAULT_SESSION = 60; // minutes, when nothing has been tracked at all
const LONG = 240; // "a long session"

export const MODES = {
  auto: { label: 'Best match', weights: { fit: 2, recent: 1, momentum: 1.5, finish: 1.2, dusty: 0.8, fresh: 0.8, pref: 1, status: 1 } },
  quick: { label: 'Quick fix', minutes: 30, primary: ['fit'], weights: { fit: 4, recent: 1, momentum: 1, finish: 1, dusty: 0.3, fresh: 0.3, pref: 0.8, status: 0.7 } },
  keep: { label: 'Keep going', primary: ['recent', 'momentum'], weights: { fit: 1, recent: 4, momentum: 1.5, finish: 0.5, pref: 0.5, status: 1 } },
  finish: { label: 'Finish something', primary: ['finish'], weights: { fit: 1, finish: 4, recent: 0.5, momentum: 0.5, pref: 0.5, status: 0.5 } },
  new: { label: 'Start something new', primary: ['fresh'], weights: { fit: 1, fresh: 4, pref: 1, status: 1 } },
  rediscover: { label: 'Rediscover', primary: ['dusty'], weights: { fit: 1, dusty: 4, pref: 1.5, finish: 0.3 } },
  surprise: { label: 'Surprise me', weights: { fit: 2, recent: 1, momentum: 1.5, finish: 1.2, dusty: 0.8, fresh: 0.8, pref: 1, status: 1 } },
};
const STATUS_WEIGHT = { playing: 1, backlog: 0.7, paused: 0.6, beaten: 0.5, unset: 0.4 };
const STATUS_TEXT = { playing: 'Marked Playing', backlog: 'In your backlog', paused: 'Marked Paused' };
export const FEEDBACK_ACTIONS = ['snooze', 'never', 'reset'];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const fmt = (m) => fmtMinutes(m);
const plural = (n, w) => `${n} ${n === 1 ? w : `${w}s`}`;
/** "9 days", "5 months", "2 years" (whole units, rounded down). */
export function span(days) {
  if (days < 60) return plural(Math.max(1, Math.floor(days)), 'day');
  if (days < 730) return plural(Math.floor(days / 30.44), 'month');
  return plural(Math.floor(days / 365.25), 'year');
}
/** A typical length as said aloud: to the nearest 5 minutes from half an hour up (the value keeps the minute). */
const roughly = (m) => (m >= 30 ? Math.round(m / 5) * 5 : m);
/** "today", "yesterday", "5 days ago": calendar days between two times. */
const ago = (t, now) => {
  const days = Math.round((parseDay(dayKey(now)) - parseDay(dayKey(t))) / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};
const median = (freq) => { // [[minutes, count]] sorted by minutes
  const n = freq.reduce((a, [, c]) => a + c, 0);
  if (!n) return null;
  const at = (rank) => { let c = 0; for (const [m, k] of freq) { c += k; if (c >= rank) return m; } return null; };
  return n % 2 ? at((n + 1) / 2) : (at(n / 2) + at(n / 2 + 1)) / 2;
};

/** 32-bit hash of the seed and a number: the same pair always gives the same 0..1. */
function hash01(seed, n) {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(n | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- per-game aggregates (SQL)
function libraryRows(db, now) {
  return memo(db, `suggest-rows:${dayKey(now)}`, () => {
    const d60 = dayKey(addDays(now, -59)); const d14 = dayKey(addDays(now, -13)); const d3 = dayKey(addDays(now, -2));
    const rows = db.prepare(`WITH e AS (
        SELECT game_id, MIN(excluded) all_excluded,
          SUM(CASE WHEN excluded = 0 THEN playtime_min ELSE 0 END) minutes,
          GROUP_CONCAT(DISTINCT CASE WHEN excluded = 0 THEN platform END) platforms,
          MAX(CASE WHEN excluded = 0 THEN MAX(COALESCE(last_played_at, 0), COALESCE(last_session_at, 0)) ELSE 0 END) lp,
          MIN(CASE WHEN hist LIKE '%"date_added"%' THEN json_extract(hist, '$.date_added') END) added,
          MIN(CASE WHEN excluded = 0 AND platform = 'steam' AND account_id IS NOT NULL AND ext_id GLOB '[0-9]*' AND ext_id NOT GLOB '*[^0-9]*' THEN ext_id END) steam_app
        FROM entries GROUP BY game_id),
      r AS (SELECT game_id, SUM(minutes) m60, SUM(CASE WHEN day >= ? THEN minutes ELSE 0 END) m14,
          SUM(CASE WHEN day >= ? THEN minutes ELSE 0 END) m3, MAX(day) last_tracked
        FROM play_days WHERE excluded = 0 AND estimated = 0 AND day >= ? GROUP BY game_id),
      d AS (SELECT game_id, MAX(day) last_day FROM play_days INDEXED BY play_days_game WHERE excluded = 0 GROUP BY game_id),
      a AS (SELECT en.game_id, COUNT(*) total, SUM(ac.unlocked) unlocked FROM achievements ac JOIN entries en ON en.id = ac.entry_id WHERE en.excluded = 0 GROUP BY en.game_id)
      SELECT g.id, g.title, g.cover_url, g.status, g.rating, g.favorite, g.hidden, g.created_at,
        e.all_excluded, e.minutes, e.platforms, e.lp, e.added, e.steam_app,
        COALESCE(r.m60, 0) m60, COALESCE(r.m14, 0) m14, COALESCE(r.m3, 0) m3, r.last_tracked, d.last_day,
        a.total ach_total, a.unlocked ach_unlocked, gm.ttb_main
      FROM games g JOIN e ON e.game_id = g.id LEFT JOIN r ON r.game_id = g.id LEFT JOIN d ON d.game_id = g.id LEFT JOIN a ON a.game_id = g.id
        LEFT JOIN game_meta gm ON gm.game_id = g.id`).all(d14, d3, d60);
    // typical session length: tracked sessions with real times or a sync window of a day or so
    // (a weekly sync's delta is a week of play, not a session), one row per distinct length
    const freq = db.prepare(`SELECT e.game_id, s.minutes m, COUNT(*) n FROM sessions s JOIN entries e ON e.id = s.entry_id
      WHERE s.kind = 'play' AND s.minutes > 0 AND e.excluded = 0
        AND ((s.started_at IS NOT NULL AND s.ended_at > s.started_at) OR s.window_start IS NULL OR s.window_end - s.window_start <= ?)
      GROUP BY e.game_id, s.minutes ORDER BY e.game_id, s.minutes`).all(30 * HOUR);
    const byGame = new Map(); const all = new Map();
    for (const f of freq) {
      let l = byGame.get(f.game_id);
      if (!l) byGame.set(f.game_id, l = []);
      l.push([f.m, f.n]);
      all.set(f.m, (all.get(f.m) || 0) + f.n);
    }
    const lengths = new Map([...byGame].map(([id, l]) => [id, { median: median(l), n: l.reduce((a, [, c]) => a + c, 0) }]));
    const overall = median([...all].sort((a, b) => a[0] - b[0]));
    return { rows, lengths, overall };
  });
}

function feedbackMap(db, now) {
  const out = new Map();
  for (const f of db.prepare('SELECT game_id, action, until FROM suggest_feedback').all()) {
    if (f.action === 'snooze' && !(f.until > now)) continue; // expired
    out.set(f.game_id, f);
  }
  return out;
}

// ---------------------------------------------------------------- signals
/**
 * How well a typical session of T minutes fits M: 1 from 40% of M up to M, a little less for
 * much shorter ones, 0.9 up to 15% over, then down to 0 at about 65% over. Long: 2.5h+ is best.
 */
export function timeFit(T, M, long = false) {
  if (long) return clamp01(T / 150);
  if (T <= M) return T >= 0.4 * M ? 1 : 0.6 + 0.4 * (T / (0.4 * M));
  const over = (T - M) / M;
  return over <= 0.15 ? 0.9 : clamp01(0.9 - 1.8 * (over - 0.15));
}

/** Signals and their reasons for one game. */
function signals(g, ctx) {
  const { now, M, long } = ctx;
  const lastAt = Math.max(g.lp || 0, g.last_tracked ? parseDay(g.last_tracked) : 0, g.last_day ? parseDay(g.last_day) : 0);
  const daysSince = lastAt ? Math.max(0, (now - lastAt) / DAY) : null;
  const s = {}; const why = {};

  // typical session
  const own = ctx.lengths.get(g.id);
  let T; let source; let conf;
  if (own && own.n >= 2) { T = own.median; source = 'game'; conf = own.n >= 3 ? 1 : 0.75; } else if (ctx.overall != null) { T = ctx.overall; source = 'overall'; conf = 0.4; } else { T = DEFAULT_SESSION; source = 'default'; conf = 0.2; }
  T = Math.round(T);
  if (M != null) {
    const f = timeFit(T, M, long);
    s.fit = 0.5 + (f - 0.5) * conf;
    if (source === 'game') {
      if (long && f >= 0.6) why.fit = { text: `Sessions here run about ${fmt(roughly(T))}, good for a long session`, value: T };
      else if (!long && f >= 0.75) why.fit = { text: `Sessions here run about ${fmt(roughly(T))}, ${roughly(T) <= M ? 'fits in' : 'close to'} ${fmt(M)}`, value: T };
      else if (!long && T > 1.25 * M) why.fit = { text: `Sessions here usually run ${fmt(roughly(T))}, longer than ${fmt(M)}`, value: T, negative: true };
    } else if (f >= 0.75) {
      why.fit = { text: source === 'overall' ? `No sessions tracked here yet; yours usually run ${fmt(roughly(T))}` : 'No sessions tracked yet to compare', value: T, weak: true };
    }
  }

  // recent play / momentum
  if (g.m14 >= 1) {
    s.recent = clamp01(g.m14 / 300) * (daysSince != null && daysSince <= 3 ? 1 : 0.8);
    why.recent = { text: `${fmt(g.m14)} in the last 2 weeks, last played ${ago(lastAt || now, now)}`, value: Math.round(g.m14) };
  }
  if (g.m60 >= 60 && g.m14 < 1 && daysSince != null && daysSince >= 14) {
    s.momentum = clamp01(g.m60 / 600);
    why.momentum = { text: `${fmt(g.m60)} in the last 60 days, nothing in the last 2 weeks`, value: Math.round(g.m60) };
  }

  // achievements
  let ach = null;
  if (g.ach_total > 0) {
    const unlocked = g.ach_unlocked || 0;
    const left = g.ach_total - unlocked;
    const pct = Math.floor((unlocked * 1000) / g.ach_total) / 10;
    ach = { unlocked, total: g.ach_total, percent: pct };
    if (left > 0) {
      const p = unlocked / g.ach_total;
      let f = p * p * (0.6 + 0.4 * (1 - Math.min(left, 40) / 40));
      if (g.status === 'beaten') f = Math.min(1, Math.max(f, 0.5) + 0.2);
      s.finish = f;
      why.finish = g.status === 'beaten'
        ? { text: `Beaten, ${plural(left, 'achievement')} left (${pct}%)`, value: pct }
        : { text: `${pct}% of achievements, ${left} left`, value: pct };
    }
  }

  // no achievements to go by: how far into IGDB's typical main story (when known)
  if (s.finish == null && g.ttb_main > 0 && g.minutes >= 60 && g.minutes < g.ttb_main && !['completed', 'beaten', 'dropped'].includes(g.status)) {
    const p = g.minutes / g.ttb_main;
    s.finish = p * p * 0.8;
    why.finish = { text: `About ${fmt(roughly(g.ttb_main - g.minutes))} left of a typical main story (${fmt(roughly(g.ttb_main))})`, value: Math.round(p * 100), id: 'time_to_beat' };
  }

  // dusty / fresh
  if (g.minutes >= 120 && daysSince != null && daysSince >= 180) {
    s.dusty = clamp01(g.minutes / 1200) * clamp01(0.5 + daysSince / 730);
    why.dusty = { text: `${fmt(g.minutes)} played, untouched for ${span(daysSince)}`, value: Math.floor(daysSince) };
  }
  if (g.minutes < 60 && (daysSince == null || daysSince >= 60)) {
    const since = typeof g.added === 'number' && g.added > 0 ? g.added : g.created_at;
    const age = Math.max(0, (now - since) / DAY);
    s.fresh = (g.minutes === 0 ? 1 : 0.75) * (0.8 + 0.2 * clamp01(age / 365));
    const where = g.status === 'backlog' ? 'backlog' : 'library';
    const played = g.minutes === 0 ? 'Never played' : `Only ${fmt(g.minutes)} played`;
    why.fresh = { text: age < 1 ? `${played}, added to your ${where} today` : `${played}, in your ${where} for ${span(age)}`, value: g.minutes };
  }

  // preference and status
  s.pref = g.favorite ? 1 : g.rating != null ? clamp01(g.rating / 10) : 0.3;
  if (g.favorite) why.pref = { text: 'One of your favorites', value: 1, id: 'favorite' };
  else if (g.rating >= 6) why.pref = { text: `Rated ${g.rating / 2} of 5`, value: g.rating, id: 'rating' };
  s.status = STATUS_WEIGHT[g.status] ?? 0.4;
  if (STATUS_TEXT[g.status]) why.status = { text: STATUS_TEXT[g.status], value: g.status };
  // when nothing else stands out: what is known about it
  why.played = g.minutes > 0
    ? { text: `${fmt(g.minutes)} played${daysSince != null ? `, last played ${daysSince < 7 ? ago(lastAt, now) : `${span(daysSince)} ago`}` : ''}`, value: g.minutes, weak: true, fallback: true }
    : { text: now - g.created_at < DAY ? 'Added to your library today' : `In your library for ${span((now - g.created_at) / DAY)}`, value: 0, weak: true, fallback: true };

  return { s, why, T, source, ach, lastAt: lastAt || null };
}

// ---------------------------------------------------------------- the picker
/**
 * Picks for the given time and mode.
 * opts: { minutes (number | 'long' | null), mode, platform (comma list), count, seed, exclude (game ids already shown),
 *         chase (include beaten games with achievements left), now }
 */
export function suggest(db, opts = {}) {
  const now = opts.now ?? Date.now();
  const mode = opts.mode ?? 'auto';
  const def = MODES[mode];
  if (!def) throw new HttpError(400, `mode must be one of ${Object.keys(MODES).join(', ')}`);
  const long = opts.minutes === 'long';
  let M = long ? LONG : opts.minutes == null || opts.minutes === '' ? null : Number(opts.minutes);
  if (M != null && !(Number.isFinite(M) && M >= 5 && M <= 1440)) throw new HttpError(400, 'minutes must be 5..1440 or "long"');
  if (M == null && def.minutes) M = def.minutes;
  if (M != null) M = Math.round(M);
  const count = Math.max(1, Math.min(10, Math.round(Number(opts.count ?? 3)) || 3));
  const seed = Number.isFinite(Number(opts.seed)) && opts.seed !== '' && opts.seed != null ? Math.trunc(Number(opts.seed)) : Number(dayKey(now).replace(/-/g, ''));
  const platforms = new Set(String(opts.platform || '').split(',').map((x) => x.trim()).filter(Boolean));
  const skip = new Set((opts.exclude || []).map(Number));
  const chase = !!opts.chase;

  const { rows, lengths, overall } = libraryRows(db, now);
  const fb = feedbackMap(db, now);
  // the game played most in the last three days is left for "Keep going"
  let justPlayed = null;
  if (mode !== 'keep') for (const g of rows) if (g.m3 >= 30 && (!justPlayed || g.m3 > justPlayed.m3)) justPlayed = g;

  const excluded = { hidden: 0, excluded: 0, wishlist: 0, completed: 0, dropped: 0, beaten: 0, never: 0, snoozed: 0, platform: 0, shown: 0, just_played: 0 };
  const ctx = { now, M, long, lengths, overall };
  const weights = Object.entries(def.weights).filter(([k]) => k !== 'fit' || M != null);
  const wsum = weights.reduce((a, [, w]) => a + w, 0);
  const scored = [];
  for (const g of rows) {
    const reason = g.hidden ? 'hidden' : g.all_excluded ? 'excluded' : ['wishlist', 'completed', 'dropped'].includes(g.status) ? g.status
      : g.status === 'beaten' && !(chase && g.ach_total > (g.ach_unlocked || 0)) ? 'beaten'
        : fb.get(g.id)?.action === 'never' ? 'never' : fb.has(g.id) ? 'snoozed'
          : platforms.size && !String(g.platforms || '').split(',').some((p) => platforms.has(p)) ? 'platform'
            : skip.has(g.id) ? 'shown' : justPlayed?.id === g.id ? 'just_played' : null;
    if (reason) { excluded[reason]++; continue; }
    const x = signals(g, ctx);
    let score = weights.reduce((a, [k, w]) => a + w * (x.s[k] || 0), 0) / wsum;
    const hasPrimary = !def.primary || def.primary.some((k) => (k === 'fit' ? (x.s.fit ?? 0) >= 0.75 : x.s[k] > 0));
    if (!hasPrimary) score *= 0.5;
    scored.push({ g, x, score, match: hasPrimary, rank: score + (mode === 'surprise' ? 0 : (hash01(seed, g.id) - 0.5) * 0.04) });
  }
  scored.sort((a, b) => b.rank - a.rank || a.g.id - b.g.id);

  let picks;
  if (mode === 'surprise') {
    // a seeded draw from the best matches, weighted by score squared
    const pool = scored.slice(0, 25).filter((c) => c.score >= scored[0].score * 0.5);
    picks = [];
    for (let i = 0; i < count && pool.length; i++) {
      const total = pool.reduce((a, c) => a + c.score ** 2, 0);
      let r = hash01(seed, 7919 * (i + 1)) * total;
      let j = 0;
      while (j < pool.length - 1 && (r -= pool[j].score ** 2) > 0) j++;
      picks.push(pool.splice(j, 1)[0]);
    }
  } else picks = scored.slice(0, count);

  return {
    mode,
    mode_label: def.label,
    minutes: M,
    long,
    platform: platforms.size ? [...platforms].join(',') : null,
    chase,
    seed,
    count,
    typical_session_minutes: overall != null ? Math.round(overall) : null,
    picks: picks.map((c) => pickOut(c, def)),
    considered: scored.length,
    excluded_counts: excluded,
    note: 'Vestigo cannot see what is installed: picks come from every game you own on the chosen platforms.',
  };
}

function pickOut({ g, x, score, match }, def) {
  // reasons: the mode's own signal first, then by how much each adds to the score
  const order = Object.entries(x.why).filter(([, r]) => !r.negative && !r.fallback)
    .map(([k, r]) => ({ k, r, c: (def.weights[k] || 0.2) * (x.s[k] || 0) * (r.weak ? 0.3 : 1) + (def.primary?.includes(k) ? 10 : 0) }))
    .sort((a, b) => b.c - a.c);
  const reasons = order.slice(0, 3).map(({ k, r }) => ({ id: r.id || k, text: r.text, value: r.value }));
  if (!reasons.length) reasons.push({ id: 'played', text: x.why.played.text, value: x.why.played.value });
  if (x.why.fit?.negative) reasons.push({ id: 'fit_long', text: x.why.fit.text, value: x.why.fit.value });
  return {
    game_id: g.id,
    title: g.title,
    cover_url: g.cover_url ?? null,
    platforms: String(g.platforms || '').split(',').filter(Boolean),
    status: g.status,
    rating: g.rating ?? null,
    favorite: !!g.favorite,
    minutes: g.minutes,
    score: Math.round(score * 100),
    // false: nothing in the library has what the mode looks for (e.g. no unplayed game): the closest match
    mode_match: match,
    reasons,
    typical_session_minutes: x.T,
    typical_session_source: x.source,
    last_played_at: x.lastAt,
    achievements: x.ach,
    launch_url: g.steam_app ? `steam://rungameid/${g.steam_app}` : null,
  };
}

// ---------------------------------------------------------------- feedback
export function feedbackList(db, now = Date.now()) {
  const items = db.prepare(`SELECT f.game_id, f.action, f.until, f.created_at, g.title, g.cover_url FROM suggest_feedback f JOIN games g ON g.id = f.game_id
    ORDER BY f.created_at DESC, f.game_id`).all().filter((f) => f.action === 'never' || f.until > now)
    .map((f) => ({ game_id: f.game_id, title: f.title, cover_url: f.cover_url ?? null, action: f.action, until: f.action === 'snooze' ? f.until : null, created_at: f.created_at }));
  return { items, snoozed: items.filter((f) => f.action === 'snooze').length, never: items.filter((f) => f.action === 'never').length };
}

export function setFeedback(db, { game_id: gameId, action, days }, now = Date.now()) {
  const id = Number(gameId);
  if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM games WHERE id = ?').get(id)) throw new HttpError(404, 'Game not found');
  if (!FEEDBACK_ACTIONS.includes(action)) throw new HttpError(400, `action must be one of ${FEEDBACK_ACTIONS.join(', ')}`);
  // expired snoozes are dropped whenever feedback is written
  db.prepare("DELETE FROM suggest_feedback WHERE action = 'snooze' AND until <= ?").run(now);
  if (action === 'reset') {
    db.prepare('DELETE FROM suggest_feedback WHERE game_id = ?').run(id);
    return { ok: true, game_id: id, action, until: null };
  }
  let until = null;
  if (action === 'snooze') {
    const d = days == null || days === '' ? 7 : Number(days);
    if (!(Number.isFinite(d) && d > 0 && d <= 365)) throw new HttpError(400, 'days must be 1..365');
    until = now + Math.round(d * DAY);
  }
  db.prepare(`INSERT INTO suggest_feedback(game_id, action, until, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(game_id) DO UPDATE SET action = excluded.action, until = excluded.until, created_at = excluded.created_at`).run(id, action, until, now);
  return { ok: true, game_id: id, action, until };
}
