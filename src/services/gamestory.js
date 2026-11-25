// A game's story: where one game stands in a career, and the few sentences that tell what it was to
// you. The game page leads with it. Like a legend (services/legends/story.js) it is told in chapters of
// `parts` the page links and formats: text, { g, t } a game, { l, t } a link, { d, p } a date, { b } a figure.
// Play dated from history before tracking is told by the month, with "around".

import { memo, dayKey } from './stats.js';
import { membership } from './legends/members.js';
import { hrs } from './legends/story.js';

const DAY = 86_400_000;
const B = (text) => ({ b: text });
const n = (x) => x.toLocaleString('en-US');
const count = (x, one, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;
const ordinal = (x) => { const v = x % 100; return `${n(x)}${v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][x % 10] || 'th'}`; };
const when = (k, estimated) => (estimated ? ['around ', { d: k, p: 'month' }] : ['on ', { d: k, p: 'day' }]);
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
/** "the Halo series", "The Legend of Zelda series" (no "the The"). */
const theSeries = (name) => (/^the\s/i.test(name) ? '' : 'the ');
const PLATFORM = { steam: 'Steam', xbox: 'Xbox', psn: 'PlayStation', nintendo: 'Nintendo Switch', switch: 'Nintendo Switch' };

/** Every game's place: by lifetime minutes, by the minutes of each year, by the minutes on each platform. */
function places(db, now) {
  return memo(db, `gamestory:places:${dayKey(now)}`, () => {
    const m = membership(db, { now });
    const played = [...m.games.values()].filter((g) => g.minutes > 0).sort((a, b) => b.minutes - a.minutes || a.id - b.id);
    const rank = new Map(played.map((g, i) => [g.id, i + 1]));
    const years = new Map(); // year -> [[id, minutes]] most played first
    for (const g of m.games.values()) for (const y of g.years) { if (!years.has(y.year)) years.set(y.year, []); years.get(y.year).push([g.id, y.minutes]); }
    for (const l of years.values()) l.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const plats = new Map();
    for (const g of m.games.values()) for (const [p, min] of g.plat) { if (!(min > 0)) continue; if (!plats.has(p)) plats.set(p, []); plats.get(p).push([g.id, min]); }
    for (const l of plats.values()) l.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    return { m, rank, of: played.length, total: played.reduce((a, g) => a + g.minutes, 0), years, plats };
  });
}

/**
 * { standing: { rank, of, share (% of all the time on record), years: [{ year, rank, of, minutes }] (the years it was among
 *   the ten most played, best first), platform: { id, rank, of } | null, series: { id, name, rank, of, share } | null },
 *   span: { first_day, last_day, first_estimated, days, months, years (with play), busiest: { key: 'YYYY-MM', minutes } | null, unlock_first_day, unlock_last_day },
 *   chapters: [{ id, title, parts }] }, or null for a game that is no part of the career (only on the wish list).
 */
export function gameStory(db, id, { now = Date.now() } = {}) {
  const P = places(db, now);
  const g = P.m.games.get(id);
  if (!g) return null;
  const today = dayKey(now);
  const rank = P.rank.get(id) || null;
  const share = rank && P.total ? Math.round((g.minutes / P.total) * 1000) / 10 : null;
  const yearPlaces = g.years.map((y) => { const l = P.years.get(y.year) || []; return { year: y.year, rank: l.findIndex((x) => x[0] === id) + 1, of: l.length, minutes: Math.round(y.minutes) }; })
    .filter((y) => y.rank >= 1 && y.rank <= 10 && y.of >= 3).sort((a, b) => a.rank - b.rank || b.minutes - a.minutes);
  // its platform: the one most of it was played on, when the library has more than one
  const top = [...g.plat].filter(([, min]) => min > 0).sort((a, b) => b[1] - a[1])[0];
  const pl = top && P.plats.size > 1 && PLATFORM[top[0]] ? P.plats.get(top[0]) : null;
  const platform = pl ? { id: top[0], rank: pl.findIndex((x) => x[0] === id) + 1, of: pl.length } : null;
  // its series: its place among the games of it, and its share of the series' time
  let series = null;
  if (g.series) {
    const ids = [...new Set(P.m.sets.series.get(g.series) || [])].map((x) => P.m.games.get(x)).filter((x) => x && x.minutes > 0).sort((a, b) => b.minutes - a.minutes);
    const sum = ids.reduce((a, x) => a + x.minutes, 0);
    if (ids.length > 1 && g.minutes > 0) series = { id: g.series, name: P.m.seriesNames.get(g.series) || g.series, rank: ids.findIndex((x) => x.id === id) + 1, of: ids.length, share: Math.round((g.minutes / sum) * 100) };
  }
  const unlocks = db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(a.unlocked), 0) unlocked, MIN(CASE WHEN a.unlocked = 1 AND a.unlocked_at > 0 THEN a.unlocked_at END) first, MAX(CASE WHEN a.unlocked = 1 THEN a.unlocked_at END) last
    FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.excluded = 0 AND e.game_id = ?`).get(id);
  const months = db.prepare('SELECT substr(day, 1, 7) k, SUM(minutes) m, SUM(minutes * estimated) e FROM play_days WHERE excluded = 0 AND game_id = ? GROUP BY k ORDER BY k').all(id);
  const busiest = months.reduce((a, x) => (x.m > (a?.m || 0) ? x : a), null);
  const first = g.years[0]?.first || null; const last = g.years.at(-1)?.last || null;
  const firstEstimated = g.years.length ? g.years[0].estimated >= g.years[0].minutes / 2 : false;
  const estimated = g.years.reduce((a, y) => a + y.estimated, 0);
  const span = { first_day: first, last_day: last, first_estimated: firstEstimated, days: g.years.reduce((a, y) => a + (y.days || 0), 0), months: months.length, years: g.years.filter((y) => y.minutes > 0).length,
    busiest: busiest && months.length > 1 ? { key: busiest.k, minutes: Math.round(busiest.m) } : null,
    // (a game with no time on record: the days of its first and last achievement)
    unlock_first_day: unlocks.first ? dayKey(unlocks.first) : null, unlock_last_day: unlocks.last ? dayKey(unlocks.last) : null };
  const standing = { rank, of: P.of, share, years: yearPlaces.slice(0, 6), platform: platform && platform.rank >= 1 ? platform : null, series };

  // ---- the chapters
  const chapters = [];
  const chapter = (cid, title, ...parts) => {
    const p = parts.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== '' && x !== false);
    if (p.length) chapters.push({ id: cid, title, parts: p });
  };

  // how it began: the first day on record, set against the day it came out
  if (first) {
    const rel = g.release_at ? dayKey(g.release_at) : null;
    const days = rel ? Math.round((new Date(`${first}T12:00`) - new Date(`${rel}T12:00`)) / DAY) : null;
    const late = days == null || firstEstimated ? '' : days >= 0 && days <= 1 ? ', the day it came out' : days > 1 && days <= 14 ? `, ${count(days, 'day')} after it came out`
      : days > 730 ? `, ${Math.floor(days / 365.25)} years after it came out` : days > 60 ? `, ${count(Math.round(days / 30.44), 'month')} after it came out` : '';
    const lateEst = firstEstimated && days != null && days > 730 ? `, some ${Math.floor(days / 365.25)} years after it came out` : '';
    chapter('began', 'How it began', 'You first played it ', when(first, firstEstimated), late, lateEst, '.');
  } else if (unlocks.first) {
    chapter('began', 'How it began', 'Your first achievement in it came on ', { d: dayKey(unlocks.first), p: 'day' }, g.minutes ? '.' : ': the platform reported no playtime for it, so that is where the record starts.');
  }

  // where it stands among everything you played
  if (rank) {
    const head = rank === 1 ? ['It is your ', B('most played game'), ` of ${n(P.of)}`] : rank <= 3 ? ['It is your ', B(`${ordinal(rank)} most played game`), ` of ${n(P.of)}`]
      : rank <= Math.max(10, Math.round(P.of * 0.1)) ? ['It ranks ', B(`${ordinal(rank)} of ${n(P.of)}`), ' games you have played'] : [B(hrs(g.minutes)), ` puts it ${ordinal(rank)} of the ${n(P.of)} games you have played`];
    const sh = share >= 1 ? [': ', B(`${n(share)}%`), ' of all your time on record.'] : '.';
    const onPlat = platform && platform.rank === 1 && rank !== 1 ? ` Nothing on ${PLATFORM[platform.id]} has more of your time.` : '';
    const link = series && { l: `/legend/series/${encodeURIComponent(series.id)}`, t: series.name };
    // (the last of a series you played little of says nothing: only a place worth naming is named)
    const inSeries = !series ? '' : series.rank === 1 ? [` In ${theSeries(series.name)}`, link, ` series it is the one you played most, ${series.share}% of your time with it.`]
      : series.rank <= 3 && series.rank < series.of ? [` In ${theSeries(series.name)}`, link, ` series it is your ${ordinal(series.rank)} most played of ${series.of}.`] : '';
    // ("1 minute puts it 979th": a place far down the list is told only for a game with real time in it)
    const worth = rank <= Math.max(10, Math.round(P.of * 0.25)) || g.minutes >= 600;
    if (worth) chapter('stands', 'Where it stands', head, sh, onPlat, inSeries);
    else if (inSeries) chapter('stands', 'Where it stands', inSeries.map((x, i) => (i === 0 && typeof x === 'string' ? x.trimStart() : x)));
  }

  // its years: the ones it led, the ones it was near the top of, its busiest month
  const led = yearPlaces.filter((y) => y.rank === 1).map((y) => y.year).sort();
  const near = yearPlaces.filter((y) => y.rank > 1 && y.rank <= 5).sort((a, b) => a.year - b.year);
  const busy = span.busiest && span.busiest.minutes >= 300 && span.months >= 3 ? span.busiest : null;
  if (led.length || near.length || busy) {
    chapter('years', 'Its years',
      led.length ? ['It was your ', B('most played game'), ` of ${list(led.map(String))}.`] : '',
      near.length ? [led.length ? ' It was also ' : 'It was ', list(near.slice(0, 4).map((y) => `${ordinal(y.rank)} in ${y.year}`)), led.length ? '.' : ' among everything you played.'] : '',
      busy ? [led.length || near.length ? ' ' : '', 'Its busiest month: ', { d: `${busy.key}-01`, p: 'month' }, ', ', B(hrs(busy.minutes)), '.'] : '');
  }

  // how you played it: tracked sessions when there are any, else the shape of the history
  const ses = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(s.minutes), 0) m, MAX(s.minutes) longest FROM sessions s JOIN entries e ON e.id = s.entry_id
    WHERE e.game_id = ? AND e.excluded = 0 AND s.kind = 'play' AND s.source != 'inferred'`).get(id);
  if (ses.c >= 2) {
    const big = db.prepare(`SELECT s.minutes, COALESCE(s.started_at, s.ended_at, s.window_end) t FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.game_id = ? AND e.excluded = 0 AND s.kind = 'play' AND s.source != 'inferred'
      ORDER BY s.minutes DESC, s.id LIMIT 1`).get(id);
    chapter('played', 'How you play it', B(count(ses.c, 'session')), ` on record, ${hrs(ses.m / ses.c)} at a time.`,
      big && big.minutes >= 60 ? [' The longest: ', B(hrs(big.minutes)), big.t ? [' on ', { d: dayKey(big.t), p: 'day' }] : '', '.'] : '');
  } else if (g.dated >= 600 && span.months >= 2 && g.dated / span.months >= 120) {
    // (history an estimate spread thin over many years - 36 hours in 55 months - has no monthly pace worth telling)
    const per = g.dated / span.months;
    chapter('played', 'How you played it', B(hrs(g.dated)), ` over ${count(span.months, 'month')} with play`, span.years > 1 ? `, in ${count(span.years, 'year')}` : '', `: about ${hrs(per)} a month.`,
      estimated >= g.dated * 0.5 ? ' The hours are the platform\'s; when they fell is estimated.' : '');
  }

  // what it left: achievements, the rarest of them
  if (unlocks.unlocked > 0) {
    const rare = db.prepare(`SELECT a.name, a.rarity FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.excluded = 0 AND e.game_id = ? AND a.unlocked = 1 AND a.rarity > 0 ORDER BY a.rarity, a.id LIMIT 1`).get(id);
    const all = unlocks.unlocked >= unlocks.total;
    chapter('left', 'What it left', all ? ['Every one of its ', B(count(unlocks.total, 'achievement')), ' is yours.'] : [B(`${n(unlocks.unlocked)} of ${n(unlocks.total)}`), ' achievements unlocked.'],
      rare && rare.name && rare.rarity <= 25 ? [' The rarest: ', B(rare.name), `, which ${rare.rarity < 0.1 ? 'under 0.1' : n(Math.round(rare.rarity * 10) / 10)}% of players have.`] : '');
  }

  // where it is now
  if (last || g.last_day) {
    const l = last && g.last_day ? (last > g.last_day ? last : g.last_day) : last || g.last_day;
    const quiet = Math.round((new Date(`${today}T12:00`) - new Date(`${l}T12:00`)) / DAY);
    const state = g.state === 'finished' ? 'You finished it. ' : g.state === 'dropped' ? 'You set it down. ' : '';
    chapter('now', 'Where it is now', quiet <= 14 && g.state === 'finished' ? 'You finished it, and still go back: ' : state,
      quiet <= 14 ? [g.state === 'finished' ? 'you' : 'It is still going: you', ' last played it ', when(l, false), '.']
      : quiet <= 365 ? ['You last played it ', { d: l, p: 'month' }, `, ${count(Math.max(1, Math.round(quiet / 30.44)), 'month')} ago.`]
        : ['It has been quiet since ', { d: l, p: 'month' }, `: ${quiet >= 730 ? `${Math.floor(quiet / 365.25)} years` : 'over a year'}.`]);
  } else if (g.state === 'finished') chapter('now', 'Where it is now', 'You finished it.');
  return { standing, span, chapters };
}
