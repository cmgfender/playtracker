// Findings, for Insights: what stands out in a range of your play that you would not think to look
// for - how long after release you get to games, how much one game or one series takes, the day
// that carries your week, play after midnight, what you start and what you finish.
// A finding: { id, title, parts, score }; `parts` as a legend's chapters have them (services/legends/story.js):
// text, { g: game id, t: title }, { d: day, p: day|month|year }, { b: a figure }, { l: href, t: text }.
// The most telling come first; one that the range cannot support is left out, never guessed.

import { memo, dayKey, resolveRange, parseDay } from './stats.js';
import { membership } from './legends/members.js';
import { hrs } from './legends/story.js';

const DAY = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const G = (g) => ({ g: g.id, t: g.title });
const B = (text) => ({ b: text });
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
/** "Unreal Engine 4" and "Unreal Engine 5" are one family: the name without its version. */
export const engineFamily = (name) => String(name).replace(/(?:\s+(?:v?\d+(?:\.\d+)*|[ivx]{1,4}))+$/i, '').trim() || String(name);

/**
 * GET /stats/findings: { range: { from, to, label }, findings: [{ id, title, parts, score }] }
 * `estimates`: 'exclude' leaves history dated by inference out (tracked play only).
 */
export function findings(db, { range = '365d', platform = null, estimates = 'include', weekStartsOn = 1, now = Date.now(), limit = 8 } = {}) {
  return memo(db, `findings:${range}:${platform}:${estimates}:${weekStartsOn}:${limit}:${dayKey(now)}`, () => {
    const r = resolveRange(range, now, weekStartsOn);
    const where = ['p.excluded = 0'];
    const args = [];
    if (platform) { where.push('p.platform = ?'); args.push(platform); }
    if (estimates === 'exclude') where.push('p.estimated = 0');
    const W = where.join(' AND ');
    const toDay = dayKey(r.to);
    let fromDay = dayKey(r.from);
    if (r.from === 0) fromDay = db.prepare(`SELECT MIN(p.day) d FROM play_days p WHERE ${W}`).get(...args).d || toDay;
    const whole = r.from === 0;
    const { games, units, seriesNames } = membership(db, { now });
    // a game holding two releases (an original and its remake): each entry's play goes with its own release
    const unitOfEntry = new Map();
    for (const u of units?.values() || []) for (const id of u.part.entries) unitOfEntry.set(id, u);
    const out = [];
    const add = (id, title, score, ...parts) => out.push({ id, title, score: Math.round(score), parts: parts.flat(Infinity).filter((x) => x !== '' && x != null && x !== false) });

    // what was played in the range, by game and year
    const per = new Map();
    for (const row of db.prepare(`SELECT p.game_id, p.entry_id, substr(p.day, 1, 4) y, SUM(p.minutes) m, MIN(p.day) f FROM play_days p WHERE ${W} AND p.day >= ? AND p.day <= ? GROUP BY p.game_id, p.entry_id, y`).all(...args, fromDay, toDay)) {
      const g = games.get(row.game_id);
      if (!g) continue;
      if (!per.has(g.id)) per.set(g.id, { game: g, minutes: 0, years: [], first: row.f, releases: [] });
      const x = per.get(g.id);
      x.minutes += row.m; x.years.push({ year: Number(row.y), minutes: row.m });
      const u = unitOfEntry.get(row.entry_id);
      if (u) x.releases.push({ year: Number(row.y), minutes: row.m, release: u.release_year });
      if (row.f < x.first) x.first = row.f;
    }
    const played = [...per.values()].sort((a, b) => b.minutes - a.minutes);
    const total = played.reduce((a, x) => a + x.minutes, 0);
    if (!played.length || total < 60) return { range: { from: fromDay, to: toDay, label: r.label }, findings: [] };

    // how long after release you get to games
    let lagSum = 0; let lagMin = 0; let oldest = null;
    for (const x of played) {
      if (x.releases.length) {
        // its releases, each against its own year: the 2026 remake is not 28 years late
        for (const y of x.releases) { lagSum += Math.max(0, y.year - y.release) * y.minutes; lagMin += y.minutes; }
        const old = x.releases.filter((y) => y.minutes >= 60).reduce((a, y) => (a == null || y.release < a ? y.release : a), null);
        if (old != null && (!oldest || old < oldest.year)) oldest = { game: x.game, year: old };
        continue;
      }
      const ry = x.game.release_year ?? x.game.entry?.year;
      if (!ry) continue;
      for (const y of x.years) { lagSum += Math.max(0, y.year - ry) * y.minutes; lagMin += y.minutes; }
      if (x.minutes >= 60 && (!oldest || ry < oldest.year)) oldest = { game: x.game, year: ry };
    }
    if (lagMin >= total * 0.5 && played.length >= 4) {
      const lag = Math.round((lagSum / lagMin) * 10) / 10;
      add('lag', lag < 1 ? 'Right on release' : 'Behind the release calendar', 62 + Math.min(20, lag * 3),
        lag < 1 ? ['You play games ', B('the year they come out'), `: ${lag === 0 ? 'none' : `${lag} years`} behind, on average.`] : ['On average you get to a game ', B(`${lag} years`), ' after it came out.'],
        oldest && oldest.year < new Date(parseDay(toDay)).getFullYear() - 5 ? [' The oldest thing here: ', G(oldest.game), ` (${oldest.year}).`] : '');
    }

    // one game, or many
    if (played.length >= 4) {
      const p1 = pct(played[0].minutes, total); const p3 = pct(played.slice(0, 3).reduce((a, x) => a + x.minutes, 0), total);
      if (p1 >= 25) add('concentration', 'One game', 45 + p1 / 2, G(played[0].game), ' alone is ', B(`${p1}%`), ` of it; your top three make ${p3}%.`);
      else if (p3 <= 40) add('concentration', 'Spread thin', 50, 'No game owns this: your most played, ', G(played[0].game), ', is only ', B(`${p1}%`), ` of it, and it took ${count(played.length, 'game')} to fill the rest.`);
    }

    // one series
    const bySeries = new Map();
    for (const x of played) if (x.game.series) { const s = bySeries.get(x.game.series) || { id: x.game.series, minutes: 0, games: 0 }; s.minutes += x.minutes; s.games++; bySeries.set(s.id, s); }
    const topSeries = [...bySeries.values()].sort((a, b) => b.minutes - a.minutes)[0];
    if (topSeries && topSeries.games >= 2 && pct(topSeries.minutes, total) >= 20) {
      add('series', 'One series', 42 + pct(topSeries.minutes, total) / 3, { l: `/legend/series/${encodeURIComponent(topSeries.id)}`, t: seriesNames.get(topSeries.id) || topSeries.id }, ' is ', B(`${pct(topSeries.minutes, total)}%`), ` of it, across ${count(topSeries.games, 'game')}.`);
    }

    // the day that carries the week
    const wd = db.prepare(`SELECT CAST(strftime('%w', p.day) AS INTEGER) w, SUM(p.minutes) m FROM play_days p WHERE ${W} AND p.day >= ? AND p.day <= ? GROUP BY w`).all(...args, fromDay, toDay);
    const spanDays = Math.round((parseDay(toDay) - parseDay(fromDay)) / DAY) + 1;
    if (wd.length >= 5 && spanDays >= 28) {
      const best = wd.reduce((a, x) => (x.m > a.m ? x : a)); const worst = wd.reduce((a, x) => (x.m < a.m ? x : a));
      const x = worst.m > 0 ? Math.round((best.m / worst.m) * 10) / 10 : null;
      if (x && x >= 1.6) add('weekday', 'Your day', 40 + Math.min(30, x * 5), B(`${WEEKDAYS[best.w]}s`), ` carry ${pct(best.m, total)}% of your play, ${x}× your quietest day (${WEEKDAYS[worst.w]}).`);
    }

    // after midnight (tracked play with exact hours only)
    const hf = ['h.excluded = 0', 'h.estimated = 0', ...(platform ? ['h.platform = ?'] : [])].join(' AND ');
    const hours = db.prepare(`SELECT SUM(CASE WHEN h.hour < 5 THEN h.minutes ELSE 0 END) late, SUM(CASE WHEN h.hour >= 5 AND h.hour < 12 THEN h.minutes ELSE 0 END) morning, SUM(h.minutes) total
      FROM play_hours h WHERE ${hf} AND h.day >= ? AND h.day <= ?`).get(...(platform ? [platform] : []), fromDay, toDay);
    if (hours.total >= 600) {
      const late = pct(hours.late, hours.total); const morning = pct(hours.morning, hours.total);
      if (late >= 10) add('late', 'After midnight', 50 + late / 2, B(`${late}%`), ` of your tracked play happens between midnight and 5 a.m.: ${hrs(hours.late)} of it.`);
      else if (morning >= 25) add('late', 'Before noon', 48 + morning / 3, B(`${morning}%`), ' of your tracked play happens before noon.');
    }

    // old favourites and new (a range that is not the whole record)
    if (!whole) {
      const fresh = played.filter((x) => (x.game.years[0]?.first || x.first) >= fromDay);
      const known = total - fresh.reduce((a, x) => a + x.minutes, 0);
      if (played.length >= 4 && spanDays >= 28) {
        const p = pct(known, total);
        add('known', p >= 50 ? 'Old favourites' : 'New ground', 44 + Math.abs(p - 50) / 2, p >= 50 ? [B(`${p}%`), ' of it went to games you already knew.'] : [B(`${100 - p}%`), ' of it went to games you had never played before.'],
          fresh.length ? [` ${count(fresh.length, 'game')} ${fresh.length === 1 ? 'was' : 'were'} new to you`, ', ', G(fresh[0].game), ' the biggest.'] : ' Nothing in it was new to you.');
      }
    }

    // what you start, what you finish
    const started = played.filter((x) => whole || (x.game.years[0]?.first || x.first) >= fromDay);
    if (started.length >= 5) {
      const done = started.filter((x) => x.game.state === 'finished').length;
      add('finish', 'Starting and finishing', 46 + (done ? 0 : 6), `You started ${count(started.length, 'game')} ${whole ? 'in all' : 'here'} and finished `, done ? [`${done}: `, B(`1 in ${Math.round((started.length / done) * 10) / 10}`), '.'] : [B('none of them'), ' yet.']);
    }

    // a taste and no more (the whole record: games left for good)
    const cutoff = dayKey(parseDay(toDay) - 90 * DAY);
    const tasted = [...games.values()].filter((g) => g.minutes > 0 && g.minutes < 60 && g.years.length && g.years.at(-1).last < cutoff && (!platform || g.plat.has(platform)));
    if (whole && tasted.length >= 3) {
      const ex = tasted.sort((a, b) => a.minutes - b.minutes)[0];
      add('tasted', 'A taste and no more', 38 + Math.min(20, tasted.length), B(count(tasted.length, 'game')), ' got less than an hour from you and never a second look. ', G(ex), ` got ${hrs(ex.minutes)}.`);
    }

    // rare company
    const t0 = parseDay(fromDay); const t1 = parseDay(toDay) + DAY;
    const rare = db.prepare(`SELECT COUNT(*) n FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.excluded = 0 AND a.unlocked = 1 AND a.rarity IS NOT NULL AND a.rarity < 5 AND a.unlocked_at >= ? AND a.unlocked_at < ?${platform ? ' AND e.platform = ?' : ''}`)
      .get(t0, t1, ...(platform ? [platform] : [])).n;
    if (rare >= 1) {
      const top = db.prepare(`SELECT a.name, a.rarity, e.game_id FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.excluded = 0 AND a.unlocked = 1 AND a.rarity IS NOT NULL AND a.unlocked_at >= ? AND a.unlocked_at < ?${platform ? ' AND e.platform = ?' : ''}
        ORDER BY a.rarity, a.unlocked_at LIMIT 1`).get(t0, t1, ...(platform ? [platform] : []));
      const g = top && games.get(top.game_id);
      add('rare', 'Rare company', 48 + Math.min(20, rare), B(count(rare, 'unlock')), ` here ${rare === 1 ? 'is one' : 'are ones'} fewer than 1 in 20 players have.`,
        g && top.name ? [' The rarest: ', B(top.name), ' in ', G(g), ` (${top.rarity < 1 ? top.rarity.toFixed(1) : Math.round(top.rarity)}%).`] : '');
    }

    // under the hood: the engines (as far as IGDB names them)
    const ids = played.map((x) => x.game.id);
    const fam = new Map(); let known = 0; const withEngine = new Set();
    for (const t of db.prepare("SELECT game_id, name FROM game_tags WHERE kind = 'engine' AND game_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids))) {
      const k = engineFamily(t.name);
      const f = fam.get(k) || { name: k, minutes: 0, games: new Set() };
      if (!f.games.has(t.game_id)) { f.minutes += per.get(t.game_id).minutes; f.games.add(t.game_id); }
      fam.set(k, f);
      if (!withEngine.has(t.game_id)) { withEngine.add(t.game_id); known += per.get(t.game_id).minutes; }
    }
    const engines = [...fam.values()].sort((a, b) => b.minutes - a.minutes);
    if (withEngine.size >= 5 && engines.length >= 2) {
      const [a, b] = engines;
      add('engine', 'Under the hood', 58 + pct(a.minutes, known) / 4, B(a.name), ` runs ${pct(a.minutes, known)}% of what you played here with a known engine (${count(a.games.size, 'game')}); ${b.name} is next at ${pct(b.minutes, known)}%.`);
    }

    // the longest day
    const big = db.prepare(`SELECT p.day, SUM(p.minutes) m FROM play_days p WHERE ${W} AND p.estimated = 0 AND p.day >= ? AND p.day <= ? GROUP BY p.day ORDER BY m DESC LIMIT 1`).get(...args, fromDay, toDay);
    if (big && big.m >= 240) {
      const lead = db.prepare(`SELECT p.game_id, SUM(p.minutes) m FROM play_days p WHERE ${W} AND p.estimated = 0 AND p.day = ? GROUP BY p.game_id ORDER BY m DESC LIMIT 1`).get(...args, big.day);
      const g = lead && games.get(lead.game_id);
      add('longest_day', 'The longest day', 30 + Math.min(30, big.m / 30), B(hrs(big.m)), ' on ', { d: big.day, p: 'day' }, g ? [lead.m >= big.m * 0.8 ? ', nearly all of it ' : ', most of it ', G(g), '.'] : '.');
    }

    out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { range: { from: fromDay, to: toDay, label: r.label }, findings: out.slice(0, limit) };
  });
}
