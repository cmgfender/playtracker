// Facts: short, true sentences about the player's own history, picked for today. Where Insights
// lays out every chart, this answers "tell me something": what happened on this day in earlier
// years, a round number just passed, a record just set, a game come back to. Each fact comes from
// a fixed template with the numbers behind it, and carries a score: the most notable come first.
// Tracked play only, except lifetime totals (which count the hours the platforms report).

import { memo, filter, dayKey, parseDay, dailyTotals, computeStreaks } from './stats.js';
import { records } from './insights.js';
import { backlogReality, spanText } from './forecast.js';
import { fmtMinutes } from '../util.js';

const WEEK_DAYS = 7;           // "this week" for facts: today and the six days before
const COMEBACK_DAYS = 90;      // a gap this long makes a return worth saying
const RECORD_MIN_DAYS = 30;    // records count once there is a month of history to beat
const TREND_MIN_PERCENT = 20;
const TOP_RANKS = 20;
const GAME_HOURS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const LIFE_HOURS = [100, 250, 500, 1000, 2500, 5000, 10000, 25000];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const addDays = (day, n) => { const d = new Date(parseDay(day)); d.setDate(d.getDate() + n); return dayKey(d.getTime()); };
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86_400_000);
const ordinal = (n) => { const t = n % 100; return `${n}${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`; };
const years = (n) => (n === 1 ? 'A year' : `${n} years`);
const passed = (value, steps) => steps.filter((s) => s * 60 <= value).pop();

/**
 * The facts of today, most notable first: { day, facts: [{ id, kind, text, bold (the part of the
 * text that is the number), score, game_id?, title?, ...numbers }], on_this_day: the facts of
 * kind on_this_day (all of them, also those beyond `limit`) }. At most one fact per game.
 */
export function facts(db, { now = Date.now(), weekStartsOn = 1, limit = 6 } = {}) {
  const today = dayKey(now);
  return memo(db, `facts:${today}:${weekStartsOn}:${limit}`, () => {
    const out = [];
    const add = (kind, score, text, bold, extra = {}) => out.push({ id: `${kind}${extra.game_id ? `:${extra.game_id}` : ''}${extra.year ? `:${extra.year}` : ''}`, kind, text, bold, score, ...extra });
    const titles = new Map(db.prepare('SELECT id, title FROM games').all().map((g) => [g.id, g.title]));
    const md = today.slice(5);
    const thisYear = Number(today.slice(0, 4));
    const tracked = filter('p', { estimates: 'exclude' });

    // ---- on this day: a game started, or played, on this date in an earlier year
    const started = db.prepare(`SELECT p.game_id, MIN(p.day) first, SUM(p.minutes) m ${tracked.sql} GROUP BY p.game_id HAVING substr(first, 6) = ? AND first < ?`).all(...tracked.args, md, `${thisYear}-01-01`);
    const startedKeys = new Set();
    for (const s of started) {
      const n = thisYear - Number(s.first.slice(0, 4));
      startedKeys.add(`${s.game_id}:${s.first}`);
      add('on_this_day', 100 + Math.min(n, 20), `${years(n)} ago today you started ${titles.get(s.game_id)}: ${fmtMinutes(s.m)} tracked since.`, `${years(n)} ago today`, { game_id: s.game_id, title: titles.get(s.game_id), day: s.first, year: Number(s.first.slice(0, 4)), years_ago: n, minutes: Math.round(s.m), event: 'started' });
    }
    const played = db.prepare(`SELECT p.day, p.game_id, SUM(p.minutes) m ${tracked.sql} AND substr(p.day, 6) = ? AND p.day < ? GROUP BY p.day, p.game_id ORDER BY p.day DESC, m DESC`).all(...tracked.args, md, `${thisYear}-01-01`);
    const seenDay = new Set();
    for (const p of played) {
      // the most played game of each of those days; a game started that day is already said
      if (seenDay.has(p.day)) continue;
      seenDay.add(p.day);
      if (startedKeys.has(`${p.game_id}:${p.day}`) || p.m < 10) continue;
      const n = thisYear - Number(p.day.slice(0, 4));
      add('on_this_day', 90 + Math.min(n, 20) + Math.min(9, p.m / 60), `${years(n)} ago today you played ${titles.get(p.game_id)} for ${fmtMinutes(p.m)}.`, `${years(n)} ago today`, { game_id: p.game_id, title: titles.get(p.game_id), day: p.day, year: Number(p.day.slice(0, 4)), years_ago: n, minutes: Math.round(p.m), event: 'played' });
    }

    // ---- this week: round numbers passed, ranks gained, games come back to
    const from = addDays(today, -(WEEK_DAYS - 1));
    const recent = new Map(db.prepare(`SELECT p.game_id, SUM(p.minutes) m, MIN(p.day) first ${tracked.sql} AND p.day >= ? AND p.day <= ? GROUP BY p.game_id`).all(...tracked.args, from, today).map((x) => [x.game_id, x]));
    const totals = db.prepare('SELECT e.game_id, SUM(e.playtime_min) m FROM entries e WHERE e.excluded = 0 GROUP BY e.game_id').all().filter((x) => titles.has(x.game_id));
    const before = (x) => x.m - (recent.get(x.game_id)?.m || 0);
    for (const x of totals) {
      if (!recent.has(x.game_id) || recent.get(x.game_id).m < 1) continue;
      const step = passed(x.m, GAME_HOURS);
      if (step && before(x) < step * 60) add('milestone', 80 + Math.log10(step) * 4, `You passed ${step.toLocaleString('en-US')} hours in ${titles.get(x.game_id)} this week.`, `${step.toLocaleString('en-US')} hours`, { game_id: x.game_id, title: titles.get(x.game_id), hours: step, minutes: Math.round(x.m) });
    }
    const life = totals.reduce((a, x) => a + x.m, 0);
    const lifeBefore = totals.reduce((a, x) => a + before(x), 0);
    const lifeStep = passed(life, LIFE_HOURS);
    if (lifeStep && lifeBefore < lifeStep * 60) add('lifetime_milestone', 85, `You passed ${lifeStep.toLocaleString('en-US')} hours of play in all this week.`, `${lifeStep.toLocaleString('en-US')} hours`, { hours: lifeStep, minutes: Math.round(life) });

    // a game that climbed into (or up) the most played, by lifetime hours
    const rank = (list, key) => new Map([...list].sort((a, b) => key(b) - key(a) || a.game_id - b.game_id).map((x, i) => [x.game_id, i + 1]));
    const nowRank = rank(totals, (x) => x.m);
    const thenRank = rank(totals, before);
    const climbers = totals.filter((x) => recent.has(x.game_id) && x.m >= 60 && nowRank.get(x.game_id) <= TOP_RANKS && nowRank.get(x.game_id) < thenRank.get(x.game_id))
      .sort((a, b) => nowRank.get(a.game_id) - nowRank.get(b.game_id));
    if (climbers.length) {
      const x = climbers[0]; const r = nowRank.get(x.game_id);
      const below = totals.find((y) => nowRank.get(y.game_id) === r + 1 && thenRank.get(y.game_id) < thenRank.get(x.game_id));
      add('rank', 70 + (TOP_RANKS - r) / 4, `${titles.get(x.game_id)} is now your ${r === 1 ? '' : `${ordinal(r)} `}most played game${below ? `, passing ${titles.get(below.game_id)}` : ''}.`, r === 1 ? 'most played game' : `${ordinal(r)} most played`, { game_id: x.game_id, title: titles.get(x.game_id), rank: r, minutes: Math.round(x.m), passed_game_id: below?.game_id ?? null });
    }

    if (recent.size) {
      const ids = [...recent.keys()];
      const last = db.prepare(`SELECT p.game_id, MAX(p.day) d ${tracked.sql} AND p.day < ? AND p.game_id IN (${ids.map(() => '?').join(',')}) GROUP BY p.game_id`).all(...tracked.args, from, ...ids);
      for (const x of last) {
        const gap = daysBetween(x.d, recent.get(x.game_id).first);
        if (gap < COMEBACK_DAYS) continue;
        const away = gap >= 365 ? `${Math.round(gap / 36.5) / 10} years`.replace(/^1 years/, 'a year') : plural(Math.round(gap / 30.4), 'month');
        add('comeback', 65 + Math.min(10, gap / 100), `You came back to ${titles.get(x.game_id)} after ${away} away.`, `${away} away`, { game_id: x.game_id, title: titles.get(x.game_id), gap_days: gap, last_day: x.d });
      }
    }

    // ---- records set this week, a streak under way, a month unlike the one before
    const all = dailyTotals(db);
    let firstDay = null;
    for (const [d, m] of all) if (m >= 1 && (!firstDay || d < firstDay)) firstDay = d;
    if (firstDay && daysBetween(firstDay, today) >= RECORD_MIN_DAYS) {
      const r = records(db, { range: 'all', weekStartsOn, now });
      const L = r.longest_session;
      if (L && L.day >= from) add('record_session', 75, `Your longest session yet: ${fmtMinutes(L.minutes)} of ${L.title} on ${L.day}.`, fmtMinutes(L.minutes), { game_id: L.game_id, title: L.title, day: L.day, minutes: L.minutes });
      if (r.biggest_day && r.biggest_day.day >= from) add('record_day', 74, `Your biggest day yet: ${fmtMinutes(r.biggest_day.minutes)} on ${r.biggest_day.day}.`, fmtMinutes(r.biggest_day.minutes), { day: r.biggest_day.day, minutes: r.biggest_day.minutes });
    }
    const streak = computeStreaks(all, now);
    if (streak.current >= 3) {
      const best = streak.current >= streak.longest;
      add('streak', 60 + Math.min(15, streak.current / 2), `${streak.current} days in a row${best ? ': your longest streak yet' : `, ${plural(streak.longest - streak.current, 'day')} short of your record`}.`, `${streak.current} days in a row`, { days: streak.current, longest: streak.longest });
    }
    const trend = records(db, { range: '30d', weekStartsOn, now }).patterns?.find((x) => x.id === 'trend');
    if (trend && Math.abs(trend.value) >= TREND_MIN_PERCENT) add('trend', 40 + Math.min(15, Math.abs(trend.value) / 10), `${Math.abs(trend.value)}% ${trend.value > 0 ? 'more' : 'less'} play than the 30 days before: ${fmtMinutes(trend.minutes)} against ${fmtMinutes(trend.previous_minutes)}.`, `${Math.abs(trend.value)}% ${trend.value > 0 ? 'more' : 'less'}`, { percent: trend.value, minutes: trend.minutes, previous_minutes: trend.previous_minutes });

    // ---- the backlog, when it is more than a year of play
    const b = backlogReality(db, { now });
    if (b.weeks != null && b.weeks >= 52) add('backlog', 30, `At your pace the backlog is ${spanText(b.weeks)} of play (${plural(b.games, 'game')}, ${fmtMinutes(b.remaining_minutes)}).`, spanText(b.weeks).replace(/^about /, ''), { games: b.games, minutes: b.remaining_minutes, weeks: b.weeks });

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
