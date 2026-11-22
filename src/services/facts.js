// Facts: short, true sentences about the player's own history, picked for today. Where Insights
// lays out every chart, this answers "tell me something". A fact has to be news to the person it
// is about, so each is an event, said on its day and fading after it - never a reading of a gauge:
//
//  - someone who plays daily played *something* on this date every year, and is always on a streak;
//    someone with forty games past ten hours does not care about the forty-first. So "on this day"
//    is kept for the three days of a game's life that are remembered (its first, its last, its
//    biggest), a round number is said only while few games have reached it, a streak only at a
//    record, near one or on a round number, and a rank only inside the top ten;
//  - play comes in bursts (a new game binged for three weeks, then dropped), so a month is not
//    compared with the month before: what is said is the biggest week in a long time.
//
// Each fact comes from a fixed template with the numbers behind it, and carries a score: the most
// notable come first. Tracked play only: estimated history has no days of its own.

import { memo, filter, dayKey, parseDay, dailyTotals, computeStreaks } from './stats.js';
import { records } from './insights.js';
import { backlogReality, spanText } from './forecast.js';
import { fmtMinutes } from '../util.js';

const WEEK_DAYS = 7;            // "this week" for facts: today and the six days before
const FADE = 3;                 // points a fact loses for each day since it happened
const COMEBACK_DAYS = 90;       // a gap this long makes a return worth saying
const DORMANT_DAYS = 90;        // not played for this long: the game is no longer in rotation
const RECORD_MIN_DAYS = 30;     // records count once there is a month of history to beat
const BIG_WEEK_MIN = 8;         // "the biggest week in N weeks" from this many weeks on
const TOP_RANKS = 10;
const RARE_GAMES = 10;          // a round number is news while at most this many games have reached it
const STARTED_MIN = 120;        // minutes of a game before its first day is an anniversary
const ENDED_MIN = 300;          // ... before its last day is
const PEAK_MIN = 180;           // minutes of a day before it is a game's "biggest day"
const STREAK_MARKS = [7, 14, 30, 50, 100, 200, 365, 500, 730, 1000];
const GAME_HOURS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const LIFE_HOURS = [100, 250, 500, 1000, 2500, 5000, 10000, 25000];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const addDays = (day, n) => { const d = new Date(parseDay(day)); d.setDate(d.getDate() + n); return dayKey(d.getTime()); };
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86_400_000);
const ordinal = (n) => { const t = n % 100; return `${n}${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`; };
const years = (n) => (n === 1 ? 'A year' : `${n} years`);
const passed = (value, steps) => steps.filter((s) => s * 60 <= value).pop();
/** A stretch of days in words: "3 days", "5 weeks", "7 months", "2.5 years". */
/** A day as it is said: "March 10, 2025". */
const nice = (day) => new Date(parseDay(day)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const stretch = (days) => (days < 14 ? plural(Math.max(1, days), 'day') : days < 61 ? plural(Math.round(days / 7), 'week') : days < 548 ? plural(Math.round(days / 30.4), 'month') : `${Math.round(days / 36.5) / 10} years`);

/**
 * The facts of today, most notable first: { day, facts: [{ id, kind, text, bold (the part of the
 * text that is the number), score, game_id?, title?, ...numbers }], on_this_day: the facts of
 * kind on_this_day (all of them, also those beyond `limit`) }. At most one fact per game.
 */
export function facts(db, { now = Date.now(), weekStartsOn = 1, limit = 6 } = {}) {
  const today = dayKey(now);
  return memo(db, `facts:${today}:${weekStartsOn}:${limit}`, () => {
    const out = [];
    const add = (kind, score, text, bold, extra = {}) => out.push({ id: `${kind}${extra.event ? `:${extra.event}` : ''}${extra.game_id ? `:${extra.game_id}` : ''}${extra.year ? `:${extra.year}` : ''}`, kind, text, bold, score, ...extra });
    const titles = new Map(db.prepare('SELECT id, title FROM games').all().map((g) => [g.id, g.title]));
    const md = today.slice(5);
    const thisYear = Number(today.slice(0, 4));
    const tracked = filter('p', { estimates: 'exclude' });
    const from = addDays(today, -(WEEK_DAYS - 1));
    const fade = (day) => FADE * Math.max(0, daysBetween(day, today));

    // every game's tracked life: first and last day, minutes
    const lives = new Map(db.prepare(`SELECT p.game_id, MIN(p.day) first, MAX(p.day) last, SUM(p.minutes) m ${tracked.sql} GROUP BY p.game_id`).all(...tracked.args)
      .filter((x) => titles.has(x.game_id)).map((x) => [x.game_id, x]));
    const byMinutes = [...lives.values()].sort((a, b) => b.m - a.m || a.game_id - b.game_id);
    // A game's hours "in all", and its rank, are its lifetime: tracked play alone leaves out what was
    // played before tracking began. Such a game was not "started" on its first tracked day either.
    const totals = db.prepare('SELECT e.game_id, SUM(e.playtime_min) m, MAX(e.baseline_min) history FROM entries e WHERE e.excluded = 0 GROUP BY e.game_id').all().filter((x) => titles.has(x.game_id));
    const lifetime = new Map(totals.map((x) => [x.game_id, x]));
    const inAll = (x) => Math.max(x.m, lifetime.get(x.game_id)?.m || 0);
    const lifeRank = new Map([...totals].sort((a, b) => b.m - a.m || a.game_id - b.game_id).map((x, i) => [x.game_id, i + 1]));

    // ---- on this day: the first, the last or the biggest day of a game, in an earlier year
    const became = (x) => {
      const r = lifeRank.get(x.game_id);
      if (daysBetween(x.last, today) < DORMANT_DAYS) return `${fmtMinutes(inAll(x))} so far${r <= TOP_RANKS && totals.length > TOP_RANKS ? `, your ${r === 1 ? '' : `${ordinal(r)} `}most played` : ''}`;
      return `you played it for ${stretch(daysBetween(x.first, x.last) + 1)}, ${fmtMinutes(inAll(x))} in all`;
    };
    for (const x of lives.values()) {
      const t = titles.get(x.game_id);
      if (x.first.slice(5) === md && x.first < `${thisYear}-01-01` && x.m >= STARTED_MIN && !lifetime.get(x.game_id)?.history) {
        const n = thisYear - Number(x.first.slice(0, 4));
        add('on_this_day', 100 + Math.min(n, 20) + Math.min(9, x.m / 600), `${years(n)} ago today you started ${t}: ${became(x)}.`, `${years(n)} ago today`, { game_id: x.game_id, title: t, day: x.first, year: Number(x.first.slice(0, 4)), years_ago: n, minutes: Math.round(x.m), event: 'started' });
      }
      if (x.last.slice(5) === md && x.last < `${thisYear}-01-01` && x.m >= ENDED_MIN && x.last !== x.first) {
        const n = thisYear - Number(x.last.slice(0, 4));
        add('on_this_day', 96 + Math.min(n, 20) + Math.min(9, x.m / 600), `${years(n)} ago today was the last time you played ${t} (${fmtMinutes(inAll(x))} in all).`, `${years(n)} ago today`, { game_id: x.game_id, title: t, day: x.last, year: Number(x.last.slice(0, 4)), years_ago: n, minutes: Math.round(inAll(x)), event: 'last_played' });
      }
    }
    // the biggest day of a game: looked up for the few games with a long day on this date
    const long = db.prepare(`SELECT p.game_id, p.day, SUM(p.minutes) m ${tracked.sql} AND substr(p.day, 6) = ? AND p.day < ? GROUP BY p.game_id, p.day HAVING m >= ?`).all(...tracked.args, md, `${thisYear}-01-01`, PEAK_MIN);
    const peakOf = db.prepare(`SELECT MAX(m) m FROM (SELECT SUM(p.minutes) m ${tracked.sql} AND p.game_id = ? GROUP BY p.day)`);
    for (const x of long) {
      const life = lives.get(x.game_id);
      if (!life || x.day === life.first || x.day === life.last || x.m < peakOf.get(...tracked.args, x.game_id).m) continue;
      const n = thisYear - Number(x.day.slice(0, 4));
      add('on_this_day', 92 + Math.min(n, 20) + Math.min(9, x.m / 120), `${years(n)} ago today was your biggest day in ${titles.get(x.game_id)}: ${fmtMinutes(x.m)}.`, `${years(n)} ago today`, { game_id: x.game_id, title: titles.get(x.game_id), day: x.day, year: Number(x.day.slice(0, 4)), years_ago: n, minutes: Math.round(x.m), event: 'biggest_day' });
    }

    // ---- this week: round numbers passed, ranks gained, games come back to
    const week = db.prepare(`SELECT p.game_id, p.day, SUM(p.minutes) m ${tracked.sql} AND p.day >= ? AND p.day <= ? GROUP BY p.game_id, p.day ORDER BY p.day`).all(...tracked.args, from, today);
    const recent = new Map();
    for (const x of week) { const r = recent.get(x.game_id) || { m: 0, first: x.day, last: x.day, days: [] }; r.m += x.m; r.last = x.day; r.days.push(x); recent.set(x.game_id, r); }
    const before = (x) => x.m - (recent.get(x.game_id)?.m || 0);
    for (const x of totals) {
      const r = recent.get(x.game_id);
      if (!r || r.m < 1) continue;
      const step = passed(x.m, GAME_HOURS);
      if (!step || before(x) >= step * 60) continue;
      // news only while few games have come that far: the forty-first game past ten hours is not
      const reached = totals.filter((y) => y.m >= step * 60).length;
      if (reached > RARE_GAMES) continue;
      let sum = before(x); let on = r.last;
      for (const d of r.days) { sum += d.m; if (sum >= step * 60) { on = d.day; break; } }
      const nth = reached === 1 ? 'the first game you have taken that far' : `the ${ordinal(reached)} game you have taken that far`;
      add('milestone', 80 + Math.log10(step) * 4 + (RARE_GAMES - reached) / 2 - fade(on), `You passed ${step.toLocaleString('en-US')} hours in ${titles.get(x.game_id)} this week: ${nth}.`, `${step.toLocaleString('en-US')} hours`, { game_id: x.game_id, title: titles.get(x.game_id), hours: step, minutes: Math.round(x.m), games_reached: reached, day: on });
    }
    const life = totals.reduce((a, x) => a + x.m, 0);
    const lifeBefore = totals.reduce((a, x) => a + before(x), 0);
    const lifeStep = passed(life, LIFE_HOURS);
    if (lifeStep && lifeBefore < lifeStep * 60) add('lifetime_milestone', 88, `You passed ${lifeStep.toLocaleString('en-US')} hours of play in all this week.`, `${lifeStep.toLocaleString('en-US')} hours`, { hours: lifeStep, minutes: Math.round(life) });

    // a game that climbed the ten most played, by lifetime hours
    const rank = (list, key) => new Map([...list].sort((a, b) => key(b) - key(a) || a.game_id - b.game_id).map((x, i) => [x.game_id, i + 1]));
    const nowRank = rank(totals, (x) => x.m);
    const thenRank = rank(totals, before);
    const climbers = totals.filter((x) => recent.has(x.game_id) && x.m >= 60 && totals.length > TOP_RANKS && nowRank.get(x.game_id) <= TOP_RANKS && nowRank.get(x.game_id) < thenRank.get(x.game_id))
      .sort((a, b) => nowRank.get(a.game_id) - nowRank.get(b.game_id));
    if (climbers.length) {
      const x = climbers[0]; const r = nowRank.get(x.game_id);
      const below = totals.find((y) => nowRank.get(y.game_id) === r + 1 && thenRank.get(y.game_id) < thenRank.get(x.game_id));
      add('rank', 70 + (TOP_RANKS - r) - fade(recent.get(x.game_id).last), `${titles.get(x.game_id)} is now your ${r === 1 ? '' : `${ordinal(r)} `}most played game${below ? `, passing ${titles.get(below.game_id)}` : ''}.`, r === 1 ? 'most played game' : `${ordinal(r)} most played`, { game_id: x.game_id, title: titles.get(x.game_id), rank: r, minutes: Math.round(x.m), passed_game_id: below?.game_id ?? null });
    }

    if (recent.size) {
      const ids = [...recent.keys()];
      const last = db.prepare(`SELECT p.game_id, MAX(p.day) d ${tracked.sql} AND p.day < ? AND p.game_id IN (${ids.map(() => '?').join(',')}) GROUP BY p.game_id`).all(...tracked.args, from, ...ids);
      for (const x of last) {
        const back = recent.get(x.game_id).first;
        const gap = daysBetween(x.d, back);
        if (gap < COMEBACK_DAYS) continue;
        const away = stretch(gap);
        add('comeback', 68 + Math.min(12, gap / 60) - fade(back), `You came back to ${titles.get(x.game_id)} after ${away} away.`, `${away} away`, { game_id: x.game_id, title: titles.get(x.game_id), gap_days: gap, last_day: x.d, day: back });
      }
    }

    // ---- records set this week, the biggest week in a long time, a streak at a mark
    const all = dailyTotals(db);
    let firstDay = null;
    for (const [d, m] of all) if (m >= 1 && (!firstDay || d < firstDay)) firstDay = d;
    if (firstDay && daysBetween(firstDay, today) >= RECORD_MIN_DAYS) {
      const r = records(db, { range: 'all', weekStartsOn, now });
      const L = r.longest_session;
      if (L && L.day >= from) add('record_session', 78 - fade(L.day), `Your longest session yet: ${fmtMinutes(L.minutes)} of ${L.title} on ${nice(L.day)}.`, fmtMinutes(L.minutes), { game_id: L.game_id, title: L.title, day: L.day, minutes: L.minutes });
      if (r.biggest_day && r.biggest_day.day >= from) add('record_day', 77 - fade(r.biggest_day.day), `Your biggest day yet: ${fmtMinutes(r.biggest_day.minutes)} on ${nice(r.biggest_day.day)}.`, fmtMinutes(r.biggest_day.minutes), { day: r.biggest_day.day, minutes: r.biggest_day.minutes });

      // the last seven days against any seven days in a row before them: how long since a bigger week
      const span = daysBetween(firstDay, today) + 1;
      const mins = Array.from({ length: span }, (_, i) => all.get(addDays(firstDay, i)) || 0);
      const sumTo = (i) => { let t = 0; for (let k = Math.max(0, i - WEEK_DAYS + 1); k <= i; k++) t += mins[k]; return t; };
      const thisWeek = sumTo(span - 1);
      if (thisWeek >= 60) {
        // (a rolling sum, from the latest week that does not overlap this one back to the first)
        let bigger = -1; let roll = sumTo(span - 1 - WEEK_DAYS);
        for (let i = span - 1 - WEEK_DAYS; i >= WEEK_DAYS - 1; i--) {
          if (roll >= thisWeek) { bigger = i; break; }
          roll += (mins[i - WEEK_DAYS] || 0) - mins[i];
        }
        const weeks = Math.floor(((bigger < 0 ? span : span - 1 - bigger) - WEEK_DAYS) / 7);
        if (weeks >= BIG_WEEK_MIN) add('big_week', 62 + Math.min(14, weeks / 4), `${fmtMinutes(thisWeek)} in the last seven days: your biggest week ${bigger < 0 ? 'yet' : `in ${stretch(weeks * 7)}`}.`, fmtMinutes(thisWeek), { minutes: Math.round(thisWeek), weeks, record: bigger < 0 });
      }
    }
    const streak = computeStreaks(all, now);
    const playedToday = (all.get(today) || 0) >= 1;
    if (streak.current >= 3) {
      // said when it happens: a record equalled or beaten, a record a day or two away, a round number reached today
      const record = streak.current >= streak.longest && streak.longest >= 7;
      const near = !record && streak.longest - streak.current <= 2 && streak.longest >= 7;
      const mark = playedToday && STREAK_MARKS.includes(streak.current);
      if (record || near || mark) add('streak', 66 + Math.min(14, streak.current / 4) + (record ? 6 : 0), `${streak.current} days in a row${record ? ': your longest streak yet' : near ? `, ${plural(streak.longest - streak.current, 'day')} short of your record` : ''}.`, `${streak.current} days in a row`, { days: streak.current, longest: streak.longest, record });
    }

    // ---- one standing fact a day, for the days nothing happened: true every day, so it only fills in
    if (firstDay && daysBetween(firstDay, today) >= RECORD_MIN_DAYS) {
      const r = records(db, { range: 'all', weekStartsOn, now });
      const pool = [];
      const top = byMinutes[0];
      const sumTracked = byMinutes.reduce((a, x) => a + x.m, 0);
      if (top && byMinutes.length >= 3) pool.push(['most_played', `${titles.get(top.game_id)} is ${Math.round((top.m / sumTracked) * 100)}% of all your tracked play (${fmtMinutes(top.m)}).`, `${Math.round((top.m / sumTracked) * 100)}%`, { game_id: top.game_id, title: titles.get(top.game_id) }]);
      if (byMinutes.length >= 6) { const three = byMinutes.slice(0, 3).reduce((a, x) => a + x.m, 0); pool.push(['top_three', `Your three most played games hold ${Math.round((three / sumTracked) * 100)}% of your tracked play.`, `${Math.round((three / sumTracked) * 100)}%`, {}]); }
      // games given under an hour: tried and put down
      const tried = byMinutes.filter((x) => inAll(x) < 60 && daysBetween(x.last, today) >= DORMANT_DAYS).length;
      if (tried >= 3) pool.push(['tried', `${tried} of the ${byMinutes.length} games you have played got less than an hour.`, `${tried} of the ${byMinutes.length} games`, { games: tried, of: byMinutes.length }]);
      for (const id of ['favorite_weekday', 'time_of_day']) { const hl = r.highlights.find((x) => x.id === id); if (hl) pool.push([id, hl.text, `${hl.value}%`, {}]); }
      if (r.longest_session) pool.push(['longest_session', `Your longest session: ${fmtMinutes(r.longest_session.minutes)} of ${r.longest_session.title} on ${nice(r.longest_session.day)}.`, fmtMinutes(r.longest_session.minutes), { game_id: r.longest_session.game_id, title: r.longest_session.title }]);
      if (r.best_week) pool.push(['best_week', `Your biggest week: ${fmtMinutes(r.best_week.minutes)}, the week of ${nice(r.best_week.from)}.`, fmtMinutes(r.best_week.minutes), {}]);
      if (pool.length) {
        // the day picks it: the same all day, another tomorrow
        const [event, text, bold, extra] = pool[Math.round(parseDay(today) / 86_400_000) % pool.length];
        add('standing', 20, text, bold, { event, ...extra });
      }
    }

    // ---- the backlog, when it is more than a year of play
    const b = backlogReality(db, { now });
    if (b.weeks != null && b.weeks >= 52) add('backlog', 30, `The backlog is ${spanText(b.weeks)} of play at your pace (${plural(b.games, 'game')}, ${fmtMinutes(b.remaining_minutes)}).`, spanText(b.weeks).replace(/^about /, ''), { games: b.games, minutes: b.remaining_minutes, weeks: b.weeks });

    // most notable first; one fact per game (its most notable)
    out.sort((a, b2) => b2.score - a.score || a.id.localeCompare(b2.id));
    const games = new Set();
    const ranked = out.filter((f) => { if (!f.game_id) return true; if (games.has(f.game_id)) return false; games.add(f.game_id); return true; })
      .map((f) => ({ ...f, score: Math.round(f.score * 10) / 10 }));
    return { day: today, facts: ranked.slice(0, limit), on_this_day: ranked.filter((f) => f.kind === 'on_this_day') };
  });
}

/**
 * The weekly summary with facts: `summary.facts` (at most two) and the text with a line for each.
 * What happened on this day comes first.
 */
export function withFacts(db, summary, text, { now = Date.now(), weekStartsOn = 1 } = {}) {
  const f = facts(db, { now, weekStartsOn, limit: 6 });
  const picked = [...f.on_this_day.slice(0, 1), ...f.facts.filter((x) => x.kind !== 'on_this_day')].slice(0, 2);
  if (!picked.length) return { summary: { ...summary, facts: [] }, text };
  const lines = picked.map((x) => (x.kind === 'on_this_day' ? `On this day: ${x.text}` : `Did you know: ${x.text}`));
  return { summary: { ...summary, facts: picked }, text: `${text}\n${lines.join('\n')}` };
}
