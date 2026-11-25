// A legend's story: the numbers of a slice of your career (a series, a maker, a console generation,
// a trend, a platform, an era of your own) and the chapters that tell it. A chapter is a title and
// `parts`: strings and references the page links and formats -
//   { g: game id, t: title }   a game
//   { d: 'YYYY-MM-DD', p: 'day' | 'month' | 'year' }   a date, as exact as it is known
//   { b: text }   a figure, in bold
// Play dated from history before tracking (estimated) is told by the month, with "around".

const DAY = 86_400_000;
const PLAYED = new Set(['played', 'playing', 'finished', 'dropped']);
const day = (k) => new Date(`${k}T12:00`).getTime();
const yearOf = (k) => Number(k.slice(0, 4));
/** Played, with or without time on record: a play inside a window is play by itself; else the game says (unlocks, a last played date). */
const wasPlayed = (p) => p.minutes > 0 || (p.seen ?? (!p.months && p.game.minutes === 0 && PLAYED.has(p.game.state)));

/** "1,240 hours", "4.5 hours", "35 minutes". */
export function hrs(min) {
  if (min < 60) return `${Math.max(1, Math.round(min))} minute${Math.round(min) === 1 ? '' : 's'}`;
  if (min < 600) { const h = Math.round(min / 6) / 10; return `${h} hour${h === 1 ? '' : 's'}`; }
  return `${Math.round(min / 60).toLocaleString('en-US')} hours`;
}
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const G = (x) => ({ g: x.id, t: x.title });
const B = (text) => ({ b: text });
/** A date as exact as it is known: estimated play by the month, with "around". */
const when = (k, estimated) => (estimated ? ['around ', { d: k, p: 'month' }] : ['on ', { d: k, p: 'day' }]);
const span = (fromDay, toDay) => {
  const months = Math.max(1, Math.round((day(toDay) - day(fromDay)) / (30.44 * DAY)));
  if (months < 24) return count(months, 'month');
  const y = Math.round(months / 12 * 2) / 2;
  return `${y} years`;
};

/**
 * The plays of a legend's games over the whole record: [{ game, minutes, dated, years: [{ year, minutes, estimated, first, last }],
 * first, last, firstEstimated, plat: Map }].
 */
export function careerPlays(games) {
  return games.map((g) => ({
    game: g, minutes: g.minutes, dated: g.dated, years: g.years, plat: g.plat,
    first: g.years[0]?.first || null, last: g.years.at(-1)?.last || null,
    firstEstimated: g.years.length ? g.years[0].estimated >= g.years[0].minutes / 2 : false,
  }));
}

/** The plays on one platform: its lifetime minutes for each game there, and the dated play it reported. */
export function platformPlays(db, games, platform) {
  const years = new Map();
  for (const r of db.prepare(`SELECT game_id, substr(day, 1, 4) y, SUM(minutes) m, SUM(minutes * estimated) e, MIN(day) f, MAX(day) l
      FROM play_days WHERE excluded = 0 AND platform = ? GROUP BY game_id, y ORDER BY game_id, y`).all(platform)) {
    if (!years.has(r.game_id)) years.set(r.game_id, []);
    years.get(r.game_id).push({ year: Number(r.y), minutes: r.m, estimated: r.e, first: r.f, last: r.l });
  }
  // played there with or without time on record (an older console reports unlocks and a last played date only)
  const seen = new Set(db.prepare(`SELECT DISTINCT e.game_id FROM entries e WHERE e.excluded = 0 AND e.platform = ? AND (e.playtime_min > 0 OR e.last_played_at IS NOT NULL
      OR EXISTS (SELECT 1 FROM achievements a WHERE a.entry_id = e.id AND a.unlocked = 1))`).all(platform).map((r) => r.game_id));
  return [...games.values()].filter((g) => g.plat.has(platform)).map((g) => {
    const ys = years.get(g.id) || [];
    return { game: g, seen: seen.has(g.id), minutes: g.plat.get(platform) || 0, dated: ys.reduce((a, y) => a + y.minutes, 0), years: ys, plat: new Map([[platform, g.plat.get(platform) || 0]]),
      first: ys[0]?.first || null, last: ys.at(-1)?.last || null, firstEstimated: ys.length ? ys[0].estimated >= ys[0].minutes / 2 : false };
  });
}

/** The plays inside a window of days (an era of your own): only what was played then, by month. */
export function windowPlays(db, games, fromDay, toDay) {
  const by = new Map();
  for (const r of db.prepare(`SELECT game_id, substr(day, 1, 7) ym, platform, SUM(minutes) m, SUM(minutes * estimated) e, MIN(day) f, MAX(day) l
      FROM play_days WHERE excluded = 0 AND day >= ? AND day <= ? GROUP BY game_id, ym, platform ORDER BY game_id, ym`).all(fromDay, toDay)) {
    const g = games.get(r.game_id);
    if (!g) continue;
    if (!by.has(g.id)) by.set(g.id, { game: g, minutes: 0, dated: 0, estimated: 0, months: new Map(), years: new Map(), plat: new Map(), first: r.f, last: r.l, firstEstimated: false });
    const p = by.get(g.id);
    p.minutes += r.m; p.dated += r.m; p.estimated += r.e;
    if (r.f < p.first) p.first = r.f;
    if (r.l > p.last) p.last = r.l;
    const mo = p.months.get(r.ym) || { minutes: 0, estimated: 0 };
    mo.minutes += r.m; mo.estimated += r.e; p.months.set(r.ym, mo);
    const y = Number(r.ym.slice(0, 4));
    const yr = p.years.get(y) || { year: y, minutes: 0, estimated: 0, first: r.f, last: r.l };
    yr.minutes += r.m; yr.estimated += r.e; if (r.f < yr.first) yr.first = r.f; if (r.l > yr.last) yr.last = r.l; p.years.set(y, yr);
    p.plat.set(r.platform, (p.plat.get(r.platform) || 0) + r.m);
  }
  return [...by.values()].map((p) => {
    const firstMonth = p.months.get(p.first.slice(0, 7));
    return { ...p, years: [...p.years.values()].sort((a, b) => a.year - b.year), firstEstimated: firstMonth.estimated >= firstMonth.minutes / 2 };
  });
}

/** What the home page shows of a legend: { games, played, minutes, from (year), to (year), top: title, covers: [url] }. */
export function brief(plays) {
  const played = plays.filter((p) => p.minutes > 0);
  const top = [...played].sort((a, b) => b.minutes - a.minutes);
  const firsts = plays.map((p) => p.first).filter(Boolean).sort();
  const lasts = plays.map((p) => p.last).filter(Boolean).sort();
  return {
    games: plays.length, played: plays.filter(wasPlayed).length, minutes: Math.round(plays.reduce((a, p) => a + p.minutes, 0)),
    from: firsts[0] ? yearOf(firsts[0]) : null, to: lasts.length ? yearOf(lasts.at(-1)) : null,
    top: top[0]?.game.title || null, covers: top.filter((p) => p.game.cover_url).slice(0, 3).map((p) => p.game.cover_url),
  };
}

/**
 * The whole story of a legend.
 * L: { kind, id, name, tagline, plays, window: { from, to } | null (an era of your own), today (YYYY-MM-DD),
 *      seriesNames: Map, ...what its kind brings: series (the franchise detail), gen, trend, era, allFirst (game id -> its first day ever) }
 */
export function tell(L) {
  const plays = L.plays;
  const total = plays.reduce((a, p) => a + p.minutes, 0);
  const dated = plays.reduce((a, p) => a + p.dated, 0);
  const ranked = [...plays].filter((p) => p.minutes > 0).sort((a, b) => b.minutes - a.minutes || a.game.title.localeCompare(b.game.title));
  // years, every one from the first to the last, with the game that led each
  const yearMap = new Map();
  for (const p of plays) for (const y of p.years) {
    const x = yearMap.get(y.year) || { year: y.year, minutes: 0, estimated: 0, top: null };
    x.minutes += y.minutes; x.estimated += y.estimated;
    if (!x.top || y.minutes > x.top.minutes) x.top = { id: p.game.id, title: p.game.title, minutes: y.minutes };
    yearMap.set(y.year, x);
  }
  const active = [...yearMap.values()].sort((a, b) => a.year - b.year);
  const years = [];
  if (active.length) for (let y = active[0].year; y <= active.at(-1).year; y++) years.push(yearMap.get(y) || { year: y, minutes: 0, estimated: 0, top: null });
  // months, for an era of three years or less
  let months = null;
  if (L.window && plays.some((p) => p.months)) {
    const mm = new Map();
    for (const p of plays) for (const [k, v] of p.months || []) {
      const x = mm.get(k) || { key: k, minutes: 0, estimated: 0, top: null };
      x.minutes += v.minutes; x.estimated += v.estimated;
      if (!x.top || v.minutes > x.top.minutes) x.top = { id: p.game.id, title: p.game.title, minutes: v.minutes };
      mm.set(k, x);
    }
    const [fy, fm] = L.window.from.split('-').map(Number); const [ty, tm] = L.window.to.split('-').map(Number);
    const n = (ty - fy) * 12 + (tm - fm) + 1;
    if (n <= 36) { months = []; for (let i = 0; i < n; i++) { const d = new Date(fy, fm - 1 + i, 1); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; months.push(mm.get(k) || { key: k, minutes: 0, estimated: 0, top: null }); } }
  }
  const firstPlay = plays.filter((p) => p.first).sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : b.minutes - a.minutes))[0] || null;
  const lastPlay = plays.filter((p) => p.last).sort((a, b) => (a.last > b.last ? -1 : a.last < b.last ? 1 : b.minutes - a.minutes))[0] || null;
  // the series inside it, and the platforms
  const seriesMap = new Map();
  for (const p of plays) {
    if (!p.game.series || !(p.minutes > 0)) continue;
    const x = seriesMap.get(p.game.series) || { id: p.game.series, name: L.seriesNames?.get(p.game.series) || p.game.series, minutes: 0, games: 0 };
    x.minutes += p.minutes; x.games++; seriesMap.set(p.game.series, x);
  }
  const series = [...seriesMap.values()].sort((a, b) => b.minutes - a.minutes).map((x) => ({ ...x, minutes: Math.round(x.minutes) }));
  const platMap = new Map();
  for (const p of plays) for (const [k, m] of p.plat || []) { const x = platMap.get(k) || { platform: k, minutes: 0, games: 0 }; x.minutes += m; x.games++; platMap.set(k, x); }
  const platforms = [...platMap.values()].filter((x) => x.minutes > 0 || !L.window).sort((a, b) => b.minutes - a.minutes).map((x) => ({ ...x, minutes: Math.round(x.minutes) }));
  const finished = L.window ? null : plays.filter((p) => p.game.state === 'finished').length;
  const nPlayed = plays.filter(wasPlayed).length;
  const totals = {
    games: plays.length, played: nPlayed, finished, minutes: Math.round(total), dated: Math.round(dated), undated: Math.max(0, Math.round(total - dated)),
    first_day: firstPlay?.first || null, last_day: lastPlay?.last || null, active_years: active.filter((y) => y.minutes > 0).length, series: series.length,
  };

  // ---- the chapters
  const chapters = [];
  const chapter = (id, title, ...parts) => {
    const p = parts.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== '' && x !== false);
    if (typeof p[0] === 'string') p[0] = p[0].trimStart();
    if (p.length && p.some((x) => typeof x !== 'string' || x.trim())) chapters.push({ id, title, parts: p });
  };
  const first = firstPlay && [G(firstPlay.game), ', ', when(firstPlay.first, firstPlay.firstEstimated)];
  const name = L.name;

  // where it began
  if (L.kind === 'series') {
    const s = L.series;
    const began = s?.released?.from;
    const item = firstPlay && s?.items.find((it) => it.game?.id === firstPlay.game.id || it.others?.some((o) => o.id === firstPlay.game.id));
    const late = began && firstPlay ? yearOf(firstPlay.first) - began : 0;
    chapter('began', 'Where it began',
      began && s.curated ? `The series began in ${began}. ` : '',
      !firstPlay ? (total > 0 ? 'None of your time with it has a date yet.' : 'You have not played any of it yet.')
        : item?.curated && s.items.filter((it) => it.kind === 'main')[0]?.key === item.key ? ['You were there from the first game: ', first, '.']
          : ['You arrived ', when(firstPlay.first, firstPlay.firstEstimated), ' with ', G(firstPlay.game), late >= 2 && s?.curated ? `, ${late} years in` : '', '.']);
  } else if (L.kind === 'generation') {
    const g = L.gen;
    chapter('began', 'Where it began',
      g.toDay ? ['It ran from ', { d: g.fromDay, p: 'month' }, ' to ', { d: g.toDay, p: 'month' }, '. '] : ['It began in ', { d: g.fromDay, p: 'month' }, ' and is the current one. '],
      `${count(plays.length, 'game')} of it ${plays.length === 1 ? 'is' : 'are'} in your library.`, first ? [' The first you played: ', first, '.'] : '');
  } else if (L.kind === 'trend') {
    const t = L.trend;
    chapter('began', 'Where it began',
      t.to ? `It was at its height from ${t.from} to ${t.to}. ` : `It took off around ${t.from} and has not let go. `,
      first ? ['Your way in: ', first, '.'] : (total > 0 ? 'None of your time with it has a date yet.' : ''));
  } else if (L.kind === 'era') {
    chapter('began', 'Where it began', [{ d: L.window.from, p: 'month' }, ' to ', L.era.to ? { d: L.window.to, p: 'month' } : 'today', `: ${span(L.window.from, L.window.to)}. `],
      firstPlay ? ['It opens with ', G(firstPlay.game), firstPlay.firstEstimated ? ' (dated from your history).' : '.'] : 'Nothing you played is dated to it yet: history from before tracking fills in as its dates are set.');
  } else {
    chapter('began', 'Where it began', first
      ? [L.kind === 'career' ? 'As far back as the record goes: ' : L.kind === 'platform' ? `Your first game on ${name} on record: ` : `Your first ${name} game on record: `, first, '.']
      : (total > 0 ? 'None of your time with it has a date yet.' : ''));
  }

  // the peak
  const peakYears = active.filter((y) => y.minutes > 0);
  if (months && months.some((m) => m.minutes > 0)) {
    const top = months.reduce((a, m) => (m.minutes > a.minutes ? m : a));
    chapter('peak', 'The peak', 'The busiest stretch: ', { d: `${top.key}-01`, p: 'month' }, ', ', B(hrs(top.minutes)), top.top ? ['. ', G({ id: top.top.id, title: top.top.title }), ' led it.'] : '.');
  } else if (peakYears.length === 1) {
    chapter('peak', 'The peak', `All of it that has a date is in ${peakYears[0].year}: `, B(hrs(peakYears[0].minutes)), '.');
  } else if (peakYears.length > 1) {
    const top = peakYears.reduce((a, y) => (y.minutes > a.minutes ? y : a));
    chapter('peak', 'The peak', `Your biggest year was ${top.year}: `, B(hrs(top.minutes)), `, ${pct(top.minutes, dated)}% of the time that has a date.`,
      top.top ? [' ', G({ id: top.top.id, title: top.top.title }), ' led it.'] : '');
  }

  // what defined it
  if (ranked.length === 1) chapter('defined', 'What defined it', G(ranked[0].game), ' is all of it so far: ', B(hrs(ranked[0].minutes)), '.');
  else if (ranked.length > 1) {
    const [a, b, c] = ranked;
    chapter('defined', 'What defined it', G(a.game), ' is the heart of it: ', B(hrs(a.minutes)), `, ${pct(a.minutes, total)}% of the total. Then `, G(b.game), ` (${hrs(b.minutes)})`,
      c ? [' and ', G(c.game), ` (${hrs(c.minutes)})`] : '', '.');
  }

  // how far it went
  if (plays.length) {
    const n = plays.length;
    const reach = L.window ? [`${count(n, 'game')} played in it.`]
      : n === 1 ? [nPlayed ? (finished ? 'One game, and you finished it.' : 'One game so far.') : 'One game, not played yet.']
        : [n === nPlayed ? `${count(n, 'game')}, all of them played` : `${count(n, 'game')} in all, ${nPlayed} played`, finished ? `, ${finished} finished.` : '.'];
    const sr = L.kind !== 'series' && series.length > 1 ? [` They span ${series.length} series, `, B(series[0].name), ` (${hrs(series[0].minutes)}) and `, B(series[1].name), ` (${hrs(series[1].minutes)}) most of all.`] : '';
    const pl = platforms.length > 1 && L.kind !== 'platform' ? ` ${platforms.length} platforms carried it.` : '';
    chapter('reach', 'How far it went', reach, sr, pl, L.achievements ? [' ', B(count(L.achievements, 'achievement')), ' came with it.'] : '');
  }

  // what its kind adds
  if (L.kind === 'series' && L.series?.mainline) {
    const m = L.series.mainline;
    const era = L.series.your_era;
    const eraStats = era && L.series.eras?.[era.index];
    chapter('place', 'Where you stand', `You have played ${m.played} of its ${count(m.total, 'main game')}, in one version or another`, m.finished ? `, and finished ${m.finished}.` : '.',
      eraStats && L.series.eras.length > 1 ? [' The era you know best: ', B(era.name), ` (${hrs(eraStats.minutes)}).`] : '',
      L.series.next ? [` Next in line: `, B(L.series.next.title), ` (${L.series.next.year}).`] : ' There is nothing in it left for you to start.');
  }
  if ((L.kind === 'generation' && L.gen.toDay) || (L.kind === 'trend' && L.trend.to)) {
    // how much of it you played in its day, and how much after
    const endYear = L.kind === 'generation' ? yearOf(L.gen.toDay) : L.trend.to;
    const startYear = L.kind === 'generation' ? yearOf(L.gen.fromDay) : L.trend.from;
    let during = 0; let after = 0;
    for (const y of active) { if (y.year > endYear) after += y.minutes; else if (y.year >= startYear) during += y.minutes; }
    if (during + after > 0) {
      const p = pct(after, during + after);
      const what = L.kind === 'generation' ? 'the generation ended' : 'its moment had passed';
      chapter('after', 'In its day, and after', `Of the ${hrs(during + after)} you can put a date on, `,
        p >= 90 ? [B(`${p}%`), ` came after ${what} in ${endYear}: you came to it late and stayed.`]
          : p >= 40 ? [B(`${p}%`), ` came after ${what} in ${endYear}: you kept going back.`]
            : p >= 10 ? [B(`${100 - p}%`), ` was played in its day, the rest after ${endYear}.`]
              : ['nearly all was played in its day: you were there.']);
    }
  }
  if (L.kind === 'era') {
    const fresh = ranked.filter((p) => L.allFirst?.get(p.game.id) >= L.window.from);
    const weeks = Math.max(1, (day(L.window.to) - day(L.window.from)) / (7 * DAY));
    chapter('new', 'What was new', fresh.length === 1 ? ['One game you had never played before starts here: ', G(fresh[0].game), '.']
      : fresh.length ? [`${count(fresh.length, 'game')} you had never played before start here, `, G(fresh[0].game), ' and ', G(fresh[1].game), ' among them.'] : '',
      total > 0 ? [' It comes to ', B(`${(Math.round((total / 60 / weeks) * 10) / 10).toLocaleString('en-US')} hours a week`), L.careerWeekly ? `, against ${(Math.round(L.careerWeekly * 10) / 10).toLocaleString('en-US')} across the whole record.` : '.'] : '');
  }

  // the longest break
  let gap = null;
  for (let i = 1; i < peakYears.length; i++) { const n = peakYears[i].year - peakYears[i - 1].year - 1; if (n >= 2 && (!gap || n > gap.n)) gap = { n, from: peakYears[i - 1].year, to: peakYears[i].year }; }
  if (gap) chapter('break', 'The long break', `${gap.n} years without it, from ${gap.from} to ${gap.to}. Then you came back.`);

  // where it stands
  if (lastPlay) {
    const quiet = Math.round((day(L.today) - day(lastPlay.last)) / DAY);
    if (L.kind === 'era' && L.era.to && L.era.to < L.today) {
      const top = ranked[0];
      const since = top && top.game.last_day && top.game.last_day > L.window.to;
      chapter('now', 'How it ended', 'It closed in ', { d: L.window.to, p: 'month' }, '. ', top ? [G(top.game), since ? ' came with you: you have played it since.' : ' stayed behind: you have not played it since.'] : '');
    } else if (quiet <= 45) chapter('now', 'Where it stands', 'It is still going: you last played ', G(lastPlay.game), ' ', when(lastPlay.last, false), '.');
    else chapter('now', 'Where it stands', 'It has been quiet since ', { d: lastPlay.last, p: 'month' }, ', when you last played ', G(lastPlay.game), '.');
  }

  const games = [...plays].sort((a, b) => b.minutes - a.minutes || a.game.title.localeCompare(b.game.title)).map((p) => ({
    id: p.game.id, title: p.game.title, cover_url: p.game.cover_url, minutes: Math.round(p.minutes), first_day: p.first, last_day: p.last, state: L.window ? (p.minutes > 0 ? 'played' : 'owned') : p.game.state,
    platforms: p.game.platforms, release_year: p.game.release_year, series: p.game.series,
  }));
  return { totals, chapters, years: years.map((y) => ({ ...y, minutes: Math.round(y.minutes), estimated: Math.round(y.estimated) })),
    months: months && months.map((m) => ({ ...m, minutes: Math.round(m.minutes), estimated: Math.round(m.estimated) })), games, series: series.slice(0, 12), platforms };
}

export { PLAYED };
