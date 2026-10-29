import { $, $$, esc, fmtMin, fmtHours, fmtDate, plat, platDot, cover, icon, api, state, plural, STATUSES } from './app.js';
import { mountCharts, punchcard, histogram, areaChart, swimlanes, scatterChart, lineChart, barChart, dayName, chart, registerChart, textWidth } from './charts.js';
import { seriesLabel, seriesName, hourLabel, emptyState, kpi, rarityText, achIcon } from './pages.js';

/*
 * Insights: when, what and how you play, from the insights API. Sections load as they come near
 * the screen (the first at once), so a large library never fetches everything up front; the
 * controls (range, platform, estimated history) reload the sections already shown and mark the
 * others to load fresh when they appear. Tracked play and estimated history stay apart: estimated
 * history is hatched, and the estimates switch takes it out (punchcard and session lengths are
 * tracked play only, always).
 */

const RANGES = [['7d', '7 days', '7d'], ['30d', '30 days', '30d'], ['90d', '90 days', '90d'], ['365d', '12 months', '12m']];
const SECTIONS = [
  // [id, title, line, the height it usually takes (its placeholder's, so sections further down stay unloaded)]
  ['when', 'When you play', 'Weekday, hour and session length · tracked play', 460],
  ['what', 'What you played', 'Games over time, eras and platforms', 1500],
  ['style', 'How you play', 'Focus, the games you start, comebacks · tracked play', 900],
  ['records', 'Records & highlights', '', 720],
  ['ach', 'Achievements', 'Unlocks, rarities and completion', 900],
  ['yoy', 'Year over year', 'Month by month, and the year so far', 700],
  ['library', 'Your library', 'Everything you own, whatever the range', 1500],
];
const day = (k) => new Date(`${k}T12:00`).getTime();
const longDay = (k) => fmtDate(day(k), { year: 'numeric', month: 'short', day: 'numeric' });
const monthName = (k, opts = { month: 'short', year: 'numeric' }) => new Date(`${k}-01T12:00`).toLocaleDateString(undefined, opts);
const pct = (x) => `${Math.round(x * 100)}%`;
const monthEnd = (k) => { const [y, m] = k.split('-').map(Number); return `${k}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };
const note = (text) => `<p class="small muted ins-note">${text}</p>`;
const none = (text) => `<div class="ins-none">${icon('info', 'ic-16')}<span>${text}</span></div>`;
/** A row of label, bar and value (status, platform, buckets): the bar is relative to `max`. */
const meterRow = (label, value, max, extra = '', color = 'var(--accent-mark)', est = 0) => `<div class="mrow"><span class="ml">${label}</span><span class="mbar"><i style="width:${max ? ((value - est) / max) * 100 : 0}%;background:${color}"></i>${est ? `<i class="hatch-bg" style="width:${(est / max) * 100}%"></i>` : ''}</span><span class="mv">${extra}</span></div>`;

export async function insights(view, stale) {
  const q = new URLSearchParams(location.search);
  const f = {
    range: q.get('range') || '365d',
    platform: q.get('platform') || '',
    estimates: q.get('estimates') || state.settings?.stats_estimates || 'include',
    by: q.get('by') === 'device' ? 'device' : 'platform',
    years: (q.get('years') || '').split(',').map(Number).filter((y) => y > 1970),
    yoy: q.get('yoy') === 'total' ? 'total' : 'month',
  };
  const [lt, years, ig] = await Promise.all([api('/stats/lifetime'), api('/stats/years'), api('/igdb/status').catch(() => null)]);
  if (stale()) return;
  // genres and the rest appear once IGDB has matched games (or while it is matching them)
  const SECS = ig && (ig.coverage.matched || ig.running) ? [...SECTIONS.slice(0, 3), ['genres', 'Genres & series', 'From IGDB · a game counts in each of its genres', 900], ...SECTIONS.slice(3)] : SECTIONS;
  if (!f.years.length) f.years = years.slice(0, 2).reverse();
  const head = `<div class="page-h"><div><h1>Insights</h1><p>${lt.games ? `${plural(lt.games, 'game')} · ${fmtHours(lt.total_minutes)}h lifetime · ${fmtHours(lt.tracked_minutes)}h tracked` : 'When, what and how you play'}</p></div>
    <a class="btn ghost desk-only" href="/stats" data-link>${icon('stats')}Stats</a></div>`;
  if (!lt.games) {
    view.innerHTML = `${head}<div class="card">${emptyState('stats', 'No tracks yet', 'Insights draw on your sessions and library. Connect Steam, Xbox or PlayStation and Vestigo picks up your library — and every hour you’ve already played.', `<a class="btn primary" href="/accounts?add=1" data-link>${icon('plus')}Connect an account</a><a class="btn" href="/settings#import" data-link>${icon('upload')}Import CSV / JSON</a>`)}</div>`;
    return;
  }
  const yearOpts = [...years.map((y) => [`year:${y}`, String(y)]), ['all', 'All time']];
  view.innerHTML = `${head}
    <div class="toolbar"><div class="row wrap">
      <div class="row" style="gap:8px">
        <div class="seg" id="in-range" aria-label="Range">${RANGES.map(([v, l, sh]) => `<button data-r="${v}" class="${f.range === v ? 'on' : ''}" title="Last ${l}"><span class="lg">${l}</span><span class="sm">${sh}</span></button>`).join('')}</div>
        <select class="input" id="in-year" aria-label="Year" style="width:auto"><option value="">Year…</option>${yearOpts.map(([v, l]) => `<option value="${v}" ${f.range === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <label class="row small" style="gap:8px;cursor:pointer" title="Include playtime from before tracking began, dated by inference (hatched in charts)"><span class="switch"><input type="checkbox" id="in-est" ${f.estimates !== 'exclude' ? 'checked' : ''}><span></span></span>Estimated history</label>
      <select class="input" id="in-plat" style="width:auto" aria-label="Platform"><option value="">All platforms</option>${lt.platforms.map((p) => `<option value="${esc(p.platform)}" ${f.platform === p.platform ? 'selected' : ''}>${esc(plat(p.platform).label)}</option>`).join('')}</select>
    </div></div>
    <div class="chips ins-toc" role="group" aria-label="Jump to a section">${SECS.map(([id, t]) => `<button class="chip" data-quick data-jump="${id}">${t}</button>`).join('')}</div>
    ${SECS.map(([id, t, sub, ph]) => `<section class="ins-sec" id="ins-${id}" data-sec="${id}" aria-labelledby="ins-h-${id}">
      <div class="ins-sh"><h2 id="ins-h-${id}">${t}</h2>${sub ? `<span class="small muted">${sub}</span>` : ''}</div>
      <div class="ins-body"><div class="ins-ph" style="height:${ph}px" aria-hidden="true"></div></div></section>`).join('')}`;

  // ---------------------------------------------------------------- loading
  const loaded = new Map(); // section -> the params it was drawn with
  const sel = (id) => view.querySelector(`[data-sec="${id}"] .ins-body`);
  const params = (extra = {}) => {
    const p = new URLSearchParams({ range: f.range, estimates: f.estimates, ...extra });
    if (f.platform) p.set('platform', f.platform);
    return p;
  };
  const key = (id) => JSON.stringify([id, f.range, f.platform, f.estimates, ...(id === 'what' ? [f.by] : []), ...(id === 'yoy' ? [f.years, f.yoy] : [])]);
  const seq = {};
  async function load(id) {
    const k = key(id);
    if (loaded.get(id) === k) return;
    loaded.set(id, k);
    const my = (seq[id] = (seq[id] || 0) + 1);
    const body = sel(id);
    body.setAttribute('aria-busy', 'true');
    try {
      const html = await RENDER[id]();
      if (my !== seq[id] || stale()) return;
      body.innerHTML = html;
      mountCharts(body);
    } catch (e) {
      if (my !== seq[id] || stale()) return;
      loaded.delete(id);
      body.innerHTML = none(`Could not load this section: ${esc(e.message)}`);
    } finally { if (my === seq[id]) body.removeAttribute('aria-busy'); }
  }
  const RENDER = { when, what, style, genres, records, ach, yoy, library };

  async function when() {
    const [pc, sl] = await Promise.all([api(`/stats/punchcard?${params()}`), api(`/stats/session-lengths?${params()}`)]);
    const ws = state.settings?.week_starts_on ?? 1;
    const busy = pc.busiest_weekday;
    const punch = pc.total_minutes ? `${punchcard({ minutes: pc.minutes, weekStartsOn: ws }, { hourLabel, keys: 'Play by weekday and hour; arrow keys read each hour' })}
        <div class="legend"><span>${icon('clock', 'ic-14')}${fmtMin(pc.total_minutes)} of ${fmtMin(pc.tracked_minutes)} tracked has exact times</span>${busy ? `<span>Most on ${dayName(busy.weekday, 'long')}s</span>` : ''}${pc.busiest_hour ? `<span>Busiest hour ${hourLabel(pc.busiest_hour.hour)}–${hourLabel((pc.busiest_hour.hour + 1) % 24)}</span>` : ''}</div>
        ${pc.untimed_minutes ? note(`${fmtMin(pc.untimed_minutes)} of tracked play is only known to a sync window, so it has no hour and is left out.`) : ''}`
      : none(pc.tracked_minutes ? `None of the ${fmtMin(pc.tracked_minutes)} tracked in this range has exact times. Live presence, or sessions you log yourself, fill this grid.` : 'No tracked play in this range.');
    const L = sl.longest;
    const lengths = sl.sessions ? `<div class="kpis k4 strip">
        ${kpi('Median', fmtMin(sl.median_minutes), plural(sl.sessions, 'session'))}
        ${kpi('90% under', fmtMin(sl.p90_minutes), `mean ${fmtMin(sl.mean_minutes)}`)}
        ${kpi('Longest', L ? fmtMin(L.minutes) : '—', L ? `<a class="link" href="/game/${L.game_id}" data-link>${esc(L.title)}</a>` : '')}
        ${kpi('In total', fmtMin(sl.total_minutes, { short: sl.total_minutes >= 6000 }), sl.exact_sessions < sl.sessions ? `${sl.exact_sessions} with exact times` : 'all exact')}
      </div>${histogram({ buckets: sl.buckets, median: sl.median_minutes, p90: sl.p90_minutes }, { keys: 'Sessions by length; arrow keys read each bar' })}`
      : none('No tracked sessions in this range.');
    return `<div class="grid grid-2 ins-grid">
      <div class="card"><div class="card-h"><h3>Weekday and hour</h3><span class="tiny muted">${esc(pc.range.label)}</span></div>${punch}</div>
      <div class="card"><div class="card-h"><h3>Session length</h3><span class="tiny muted">${esc(sl.range.label)}</span></div>${lengths}</div></div>`;
  }

  async function what() {
    const [tl, ps] = await Promise.all([api(`/stats/timeline?${params()}`), api(`/stats/platforms?${params({ by: f.by })}`)]);
    const g = tl.range.group;
    const labels = tl.keys.map((k) => ({ label: seriesLabel(k, g), name: g === 'week' ? `Week of ${seriesName(k, 'day')}` : seriesName(k, g) }));
    const others = tl.games_played - tl.games.length;
    const rows = [...tl.games.map((x) => ({ title: x.title, tracked: x.tracked, estimated: x.estimated, minutes: x.minutes })),
      ...(others > 0 && [...tl.others.tracked, ...tl.others.estimated].some((v) => v > 0) ? [{ title: `${plural(others, 'other game')}`, tracked: tl.others.tracked, estimated: tl.others.estimated, others: true, minutes: 0 }] : [])];
    const lanes = tl.games.length ? `${swimlanes({ labels, rows }, { keys: 'Top games over time; arrow keys read each period' })}
      <div class="legend"><span><i class="dot" style="background:var(--accent-mark)"></i>Tracked</span>${tl.games.some((x) => x.estimated_minutes) ? '<span><i class="dot hatch-dot"></i>Estimated history</span>' : ''}<span>${plural(tl.games_played, 'game')} played · top ${tl.games.length} shown${others > 0 ? ', the rest on one lane with its own scale' : ''}</span></div>
      <div class="ins-top">${tl.games.map((x, i) => `<a class="row small" href="/game/${x.game_id}" data-link><span class="num">${i + 1}</span><span class="grow ellipsis">${esc(x.title)}</span><b>${fmtMin(x.minutes, { short: x.minutes >= 600 })}</b></a>`).join('')}</div>`
      : none('Nothing played in this range.');
    const series = ps.series.map((s) => ({ name: s.name == null ? (f.by === 'device' ? 'Unknown device' : 'Unknown') : f.by === 'platform' ? plat(s.name).label : s.name, color: s.name == null ? 'var(--import)' : plat(s.name).color, tracked: s.tracked, estimated: s.estimated, minutes: s.minutes, est: s.estimated_minutes }));
    const plabels = ps.keys.map((k) => ({ label: seriesLabel(k, ps.range.group), name: seriesName(k, ps.range.group) }));
    const any = series.some((s) => s.minutes > 0);
    const platCard = `<div class="card"><div class="card-h"><h3>${f.by === 'device' ? 'Devices' : 'Platforms'} over time</h3>
        <div class="seg" id="in-by" aria-label="Group by"><button data-by="platform" class="${f.by === 'platform' ? 'on' : ''}">Platform</button><button data-by="device" class="${f.by === 'device' ? 'on' : ''}">Device</button></div></div>
      ${any ? `${areaChart({ labels: plabels, series }, { title: `Playtime by ${f.by} per ${ps.range.group}`, keys: `Playtime by ${f.by} per ${ps.range.group}; arrow keys read each period` })}
        <div class="legend">${series.filter((s) => s.minutes).map((s) => `<span><i class="dot" style="background:${s.color}"></i>${esc(s.name)} · ${fmtMin(s.minutes, { short: true })}${s.est ? ` (${fmtMin(s.est, { short: true })} est.)` : ''}</span>`).join('')}${series.some((s) => s.est) ? '<span><i class="dot hatch-dot"></i>Estimated history, hatched</span>' : ''}</div>
        ${f.by === 'device' && series.length === 1 && series[0].name === 'Unknown device' ? note('No platform here reports devices for these sessions (Steam Deck and PlayStation consoles do, through live presence).') : ''}`
      : none('Nothing played in this range.')}</div>`;
    // eras: the range on a time axis, in runs of months one game led
    return `<div class="card"><div class="card-h"><h3>Top games over time</h3><span class="tiny muted">${esc(tl.range.label)} · by ${g}</span></div>${lanes}</div>
      <div class="card ins-eras" style="margin-top:16px"><div class="card-h"><h3>Eras</h3><span class="tiny muted">${esc(tl.range.label)} · who led each month</span></div>${eraStrip(tl)}</div>
      <div style="margin-top:16px">${platCard}</div>`;
  }

  async function style() {
    const p = new URLSearchParams({ range: f.range });
    if (f.platform) p.set('platform', f.platform);
    const s = await api(`/stats/style?${p}`);
    const fo = s.focus;
    const weekEnd = (k) => { const d = new Date(`${k}T12:00`); d.setDate(d.getDate() + 6); return d; };
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const STYLE_WORDS = { focused: 'Focused', balanced: 'Balanced', varied: 'Varied' };
    const focus = fo ? `<p class="ins-lead"><b>${STYLE_WORDS[fo.style]}</b>: ${fo.style === 'varied' ? `your top game takes ${pct(fo.median_top_share)} of a typical week, ${fo.games_per_week} games a week on average` : `one game takes ${pct(fo.median_top_share)} of a typical week, with ${fo.games_per_week} games a week on average`}.</p>
      ${barChart(fo.series.map((w) => ({ label: seriesLabel(w.key, 'week'), name: `the week of ${seriesName(w.key, 'day')}`, value: w.games, href: `/sessions?from=${w.key}&to=${ymd(weekEnd(w.key))}`,
        tip: `Week of ${seriesName(w.key, 'day')}${w.partial ? ' (so far)' : ''}: ${plural(w.games, 'game')}, the top one ${pct(w.top_share)} of ${fmtMin(w.minutes)}`, color: w.partial ? 'var(--line-strong)' : w.top_share >= s.rules.focused ? 'var(--accent-mark)' : 'var(--accent2)' })),
      { unit: 'count', size: 'card', title: 'Games played per week', hrefHint: 'see sessions', keys: 'Games per week; arrow keys read each week, Enter opens its sessions', summary: (d) => summarizeCount('Games played per week', d, 'game') })}
      <div class="legend"><span><i class="dot" style="background:var(--accent-mark)"></i>One game ${pct(s.rules.focused)}+ of the week</span><span><i class="dot" style="background:var(--accent2)"></i>Spread out</span></div>`
      : none('No tracked play in this range.');
    const st = s.starts;
    const OUT = [['finished', 'Finished', 'var(--good)', 'good'], ['playing', 'Still going', 'var(--accent-mark)', 'accent'], ['invested', `Stuck with (${fmtMin(s.rules.invested, { short: true })}+)`, 'var(--accent2)', ''],
      ['faded', 'Faded', 'var(--muted)', ''], ['tried', 'Only tried', 'var(--line-strong)', ''], ['dropped', 'Dropped', 'var(--bad)', 'bad']];
    const outLabel = Object.fromEntries(OUT.map(([k, l, , cls]) => [k, [l.replace(/ \(.*/, ''), cls]]));
    const maxO = Math.max(1, ...Object.values(st.outcomes));
    const starts = st.count ? `<p class="ins-lead">You started <b>${plural(st.count, 'game')}</b>${st.outcomes.finished ? `, finished ${st.outcomes.finished}` : ''}${st.outcomes.tried ? `, only tried ${st.outcomes.tried}` : ''}. A typical start gets ${fmtMin(st.median_minutes)} over ${plural(Math.round(st.median_days), 'day')}.</p>
      ${OUT.filter(([k]) => st.outcomes[k]).map(([k, l, color]) => meterRow(esc(l), st.outcomes[k], maxO, plural(st.outcomes[k], 'game'), color)).join('')}
      <div class="list" style="margin-top:8px">${st.items.map((x) => `<a class="item" href="/game/${x.game_id}" data-link>${cover(x)}<div class="grow"><div class="ttl ellipsis">${esc(x.title)}</div><div class="sub">since ${fmtDate(day(x.first_day))} · ${plural(x.days, 'day')} played${x.early_share >= 0.5 && x.days > 1 ? ` · ${pct(x.early_share)} in the first week` : ''}</div></div><div class="amt">${fmtMin(x.minutes, { short: x.minutes >= 600 })}<div><span class="badge ${outLabel[x.outcome][1]}">${outLabel[x.outcome][0]}</span></div></div></a>`).join('')}</div>
      ${st.count > st.items.length ? note(`The latest ${st.items.length} of ${st.count} starts.`) : ''}`
      : none('No new games started in this range (a start is the first play of a game, tracked as it happened).');
    const sp = s.staying_power;
    const staying = sp ? `<div class="kpis k2 strip">${kpi('First week', `${Math.round(sp.median_early_share * 100)}<small>%</small>`, `of a game’s hours, at the median`)}${kpi('Played over', plural(Math.round(sp.median_span_days), 'day'), 'first to last session, at the median')}</div>
      ${note(`From the ${plural(sp.games, 'game')} started at least ${s.rules.settled} days ago and played ${fmtMin(s.rules.tried)} or more. ${sp.median_early_share >= 0.5 ? 'Most of a game’s time comes right after you start it.' : 'You keep coming back to games well after the first week.'}`)}`
      : none(`Needs games started at least ${s.rules.settled} days ago: try a longer range.`);
    const cb = s.comebacks;
    const comebacks = cb.count ? `<div class="list">${cb.items.map((x) => `<a class="item" href="/game/${x.game_id}" data-link>${cover(x)}<div class="grow"><div class="ttl ellipsis">${esc(x.title)}</div><div class="sub">back on ${fmtDate(day(x.returned_on))} after ${x.gap_days >= 61 ? plural(Math.round(x.gap_days / 30.4), 'month') : plural(x.gap_days, 'day')}</div></div><div class="amt">${fmtMin(x.minutes_since, { short: x.minutes_since >= 600 })}<div class="tiny muted">since</div></div></a>`).join('')}</div>${cb.count > cb.items.length ? note(`The latest ${cb.items.length} of ${cb.count}.`) : ''}`
      : none(`No comebacks in this range: a return to a game after ${s.rules.gap}+ days without it.`);
    return `<div class="grid grid-2 ins-grid">
      <div class="card"><div class="card-h"><h3>Focus</h3><span class="tiny muted">${esc(s.range.label)} · games per week</span></div>${focus}</div>
      <div class="card"><div class="card-h"><h3>Staying power</h3></div>${staying}</div>
      <div class="card"><div class="card-h"><h3>Games you started</h3><span class="tiny muted">${esc(s.range.label)}</span></div>${starts}</div>
      <div class="card"><div class="card-h"><h3>Comebacks</h3><span class="tiny muted">back after ${s.rules.gap}+ days</span></div>${comebacks}</div></div>`;
  }

  async function genres() {
    const p = params({ kind: 'genre', limit: '10' });
    const [g, fr, dev, pace, st] = await Promise.all([api(`/stats/tags?${p}`), api(`/stats/tags?${params({ kind: 'franchise', limit: '6' })}`), api(`/stats/tags?${params({ kind: 'developer', limit: '6' })}`), api('/stats/pace?limit=6'), api('/igdb/status').catch(() => null)]);
    // while IGDB is matching, the section fills in as it goes
    clearTimeout(genreTimer);
    if (st?.running) genreTimer = setTimeout(() => { if (!stale() && near(sel('genres'))) { loaded.delete('genres'); load('genres'); } }, 8000);
    const cov = g.coverage;
    const progress = st?.running ? `<p class="small muted pulse" style="margin:0 0 12px">Matching your games on IGDB: ${st.done.toLocaleString()} of ${st.total.toLocaleString()} in this pass. This section fills in as it goes.</p>` : '';
    const coverage = cov.games ? note(`Metadata for ${cov.matched_games} of ${plural(cov.games, 'game')} played in this range (${pct(cov.minutes ? cov.matched_minutes / cov.minutes : 0)} of the time).${cov.matched_games < cov.games ? ' <a class="link" href="/settings#metadata" data-link>IGDB settings</a>' : ''}`) : '';
    if (!g.items.length) return `${progress}${none(cov.games ? 'None of the games played in this range has genres yet.' : 'No play in this range.')}`;
    const max = g.items[0].minutes;
    const PALETTE = (i) => `var(--era-${i % ERA_COLORS})`;
    const rows = g.items.map((t, i) => `<a class="mrow mlink" href="/library?tag=${encodeURIComponent(`genre:${t.name}`)}" data-link><span class="ml"><i class="dot" style="background:${PALETTE(i)}"></i>${esc(t.name)}</span><span class="mbar"><i style="width:${(t.minutes / max) * 100}%;background:${PALETTE(i)}"></i></span><span class="mv">${fmtMin(t.minutes, { short: t.minutes >= 600 })} · ${plural(t.games, 'game')}${t.finished ? ` · ${t.finished} finished` : ''}</span></a>`).join('');
    const top = g.series.slice(0, 5);
    const grp = g.range.group;
    const chart = top.length && g.keys.length > 2 ? `${lineChart({ labels: g.keys.map((k) => ({ label: seriesLabel(k, grp), name: grp === 'week' ? `Week of ${seriesName(k, 'day')}` : seriesName(k, grp) })), series: top.map((t, i) => ({ name: t.name, color: PALETTE(i), values: t.values })) }, { mode: 'lines', size: 'card', title: `Top genres per ${grp}`, keys: `Top genres per ${grp}; arrow keys read each period` })}
      <div class="legend">${top.map((t, i) => `<span><i class="dot" style="background:${PALETTE(i)}"></i>${esc(t.name)}</span>`).join('')}</div>` : '';
    const list = (d, kind) => (d.items.length ? d.items.map((t) => meterRow(`<a class="link" href="/library?tag=${encodeURIComponent(`${kind}:${t.name}`)}" data-link>${esc(t.name)}</a>`, t.minutes, d.items[0].minutes, `${fmtMin(t.minutes, { short: t.minutes >= 600 })} · ${plural(t.games, 'game')}`, 'var(--accent2)')).join('') : none('Nothing yet.'));
    const paceCard = pace.games ? `<p class="ins-lead">You finish games in <b>${pace.median_ratio.toFixed(1)}×</b> the typical main story time${pace.median_ratio >= 1.3 ? ': you take your time' : pace.median_ratio <= 0.8 ? ': you move fast' : ''}.</p>
      <div class="list">${pace.items.map((x) => `<a class="item" href="/game/${x.game_id}" data-link>${cover(x)}<div class="grow"><div class="ttl ellipsis">${esc(x.title)}</div><div class="sub">${fmtMin(x.minutes, { short: x.minutes >= 600 })} against ${fmtMin(x.typical_minutes, { short: x.typical_minutes >= 600 })} typical${x.basis === 'extra' ? ' (main + extras)' : ''}</div></div><div class="amt">${x.ratio.toFixed(1)}×</div></a>`).join('')}</div>
      ${note(`From ${plural(pace.games, 'finished game')} with IGDB’s times to beat (all time).`)}` : none('Mark games Completed or Beaten and, where IGDB knows a time to beat, your pace shows here.');
    return `${progress}<div class="grid grid-2 ins-grid">
      <div class="card"><div class="card-h"><h3>Genres</h3><span class="tiny muted">${esc(g.range.label)}</span></div>${rows}${coverage}</div>
      <div class="card"><div class="card-h"><h3>Genres over time</h3><span class="tiny muted">top 5 · by ${grp}</span></div>${chart || none('A longer range shows how your genres change.')}</div>
      <div class="card"><div class="card-h"><h3>Series</h3><span class="tiny muted">${esc(fr.range.label)}</span></div>${list(fr, 'franchise')}</div>
      <div class="card"><div class="card-h"><h3>Developers</h3><span class="tiny muted">${esc(dev.range.label)}</span></div>${list(dev, 'developer')}</div>
      <div class="card"><div class="card-h"><h3>Your pace</h3><span class="tiny muted">against the typical time to beat</span></div>${paceCard}</div></div>`;
  }
  let genreTimer;

  async function records() {
    const r = await api(`/stats/records?${params()}`);
    const L = r.longest_session;
    const game = (x) => (x ? `<a class="link" href="/game/${x.game_id}" data-link>${esc(x.title)}</a>` : '');
    const cards = [
      L && ['Longest session', fmtMin(L.minutes), `${game(L)} · ${longDay(L.day)}`],
      r.biggest_day && ['Biggest day', fmtMin(r.biggest_day.minutes), longDay(r.biggest_day.day), `/sessions?from=${r.biggest_day.day}&to=${r.biggest_day.day}`],
      r.best_week && ['Best week', fmtMin(r.best_week.minutes), `${fmtDate(day(r.best_week.from))} – ${longDay(r.best_week.to)}`, `/sessions?from=${r.best_week.from}&to=${r.best_week.to}`],
      r.best_month && ['Best month', fmtMin(r.best_month.minutes), monthName(r.best_month.key, { month: 'long', year: 'numeric' }), `/sessions?from=${r.best_month.key}-01&to=${monthEnd(r.best_month.key)}`],
      r.longest_streak && ['Longest streak', plural(r.longest_streak.days, 'day'), `${fmtDate(day(r.longest_streak.from))} – ${longDay(r.longest_streak.to)}`],
      ['Current streak', plural(r.current_streak || 0, 'day'), r.current_streak ? 'ending today or yesterday' : 'play today to start one'],
      r.most_played && ['Most played', fmtMin(r.most_played.minutes, { short: r.most_played.minutes >= 600 }), `${game(r.most_played)} · ${pct(r.most_played.share)} of play${r.most_played.estimated_minutes ? ` · ${fmtMin(r.most_played.estimated_minutes, { short: true })} est.` : ''}`],
      r.first_session && ['First tracked session', longDay(r.first_session.day), `${game(r.first_session)} · ${fmtMin(r.first_session.minutes)}`],
    ].filter(Boolean);
    if (!r.sessions && !r.most_played) return none('No records yet in this range: they start with the first tracked session.');
    const lines = (r.highlights || []).map((h) => highlight(h, r)).filter(Boolean);
    const by = r.most_played_by?.items || [];
    return `<div class="recs">${cards.map(([l, v, s, href]) => `<div class="rec"><div class="eyebrow">${l}</div>${href ? `<a class="rv" href="${href}" data-link title="See the sessions">${v}</a>` : `<div class="rv">${v}</div>`}<div class="small muted">${s}</div></div>`).join('')}</div>
      <div class="grid grid-2 ins-grid" style="margin-top:16px">
        <div class="card"><div class="card-h"><h3>Highlights</h3><span class="tiny muted">${esc(r.range.label)}</span></div>${lines.length ? `<ul class="hl">${lines.map((x) => `<li>${x}</li>`).join('')}</ul>` : none('Nothing stands out yet.')}</div>
        <div class="card"><div class="card-h"><h3>Most played by ${r.most_played_by?.group || 'year'}</h3></div>${by.length ? `<div class="list">${by.slice().reverse().slice(0, 6).map((x) => `<a class="item" href="/game/${x.game_id}" data-link>${cover(x)}<div class="grow"><div class="ttl ellipsis">${esc(x.title)}</div><div class="sub">${esc(r.most_played_by.group === 'month' ? monthName(x.key) : x.key)} · ${pct(x.share)} of play</div></div><div class="amt">${fmtMin(x.minutes, { short: x.minutes >= 600 })}${x.estimated_minutes ? `<div class="tiny muted">${fmtMin(x.estimated_minutes, { short: true })} est.</div>` : ''}</div></a>`).join('')}</div>` : none('No play in this range.')}</div>
      </div>`;
  }

  async function ach() {
    const p = new URLSearchParams({ range: f.range, limit: '8' });
    if (f.platform) p.set('platform', f.platform);
    const a = await api(`/stats/achievements?${p}`);
    const t = a.totals;
    if (!t.total) return none('No achievements or trophies read yet. They appear after a sync of Steam, Xbox or PlayStation reads them.');
    const g = a.range.group;
    const grades = t.grades && Object.values(t.grades).some(Boolean) ? ['platinum', 'gold', 'silver', 'bronze'].map((k) => `<span class="grade g-${k}" title="${k}">${t.grades[k]}<span class="vh"> ${k}</span></span>`).join('') : '';
    const kpis = `<div class="kpis k4">
      ${kpi('Unlocked', a.unlocked.toLocaleString(), esc(a.range.label))}
      ${kpi('Completion', `${Math.floor(t.percent)}<small>%</small>`, `${t.unlocked.toLocaleString()} of ${t.total.toLocaleString()} · all time`)}
      ${kpi('Completed games', String(t.completed), `${a.completed_count} in this range`)}
      ${t.points_total ? kpi('Gamerscore', t.points.toLocaleString(), `of ${t.points_total.toLocaleString()} · +${(a.points || 0).toLocaleString()} in range`) : grades ? kpi('Trophies', `<span class="grades">${grades}</span>`, 'platinum · gold · silver · bronze') : kpi('Games with achievements', String(t.entries), '')}
    </div>`;
    const per = a.series.some((x) => x.unlocked) ? barChart(a.series.map((x) => ({ label: seriesLabel(x.key, g), name: seriesName(x.key, g), value: x.unlocked, tip: `${seriesName(x.key, g)}: ${plural(x.unlocked, 'unlock')}${x.points ? ` · ${x.points}G` : ''}` })), { unit: 'count', size: 'card', title: `Unlocks per ${g}`, summary: (d) => summarizeCount(`Unlocks per ${g}`, d) }) : none('No unlocks in this range.');
    const rarest = a.rarest.length ? `<div class="list">${a.rarest.map((x) => `<a class="item ach-row" href="/game/${x.game_id}" data-link>${achIcon(x)}<div class="grow"><div class="ttl ellipsis">${esc(x.name || 'Hidden achievement')}</div><div class="sub">${platDot(x.platform)}${esc(x.title)}${x.unlocked_at ? ` · ${fmtDate(x.unlocked_at)}` : ''}</div></div>${rarityText(x)}</a>`).join('')}</div>` : none('No unlocks with a rarity in this range.');
    const done = a.completed.length ? `<div class="list">${a.completed.map((x) => `<a class="item" href="/game/${x.game_id}" data-link>${cover(x)}<div class="grow"><div class="ttl ellipsis">${esc(x.title)}</div><div class="sub">${platDot(x.platform)}${x.platinum ? 'Platinum' : `${x.unlocked} of ${x.total}`} · ${fmtDate(x.completed_at, { year: 'numeric', month: 'short', day: 'numeric' })}</div></div><span class="badge good">${x.platinum ? 'Platinum' : '100%'}</span></a>`).join('')}</div>` : none('No games completed in this range.');
    const c = a.completion;
    const dist = c.entries ? `${barChart(c.buckets.map((b) => ({ label: b.label.replace('-', '–'), name: b.label, value: b.count, tip: `${b.label.replace('-', '–')} complete: ${plural(b.count, 'game')}`, color: b.label === '100%' ? 'var(--good)' : undefined })), { unit: 'count', size: 'card', title: 'Played games by completion', summary: (d) => summarizeCount('Played games by completion', d, 'game') })}
      ${note(`${plural(c.entries, 'played game')} with achievements, ${Math.round(c.average_percent)}% complete on average.`)}` : none('No played games with achievements.');
    return `${kpis}<div class="grid grid-2 ins-grid" style="margin-top:16px">
      <div class="card"><div class="card-h"><h3>Unlocks per ${g}</h3><span class="tiny muted">${esc(a.range.label)}</span></div>${per}</div>
      <div class="card"><div class="card-h"><h3>Completion</h3><span class="tiny muted">all time</span></div>${dist}</div>
      <div class="card"><div class="card-h"><h3>Rarest unlocks</h3><span class="tiny muted">${esc(a.range.label)}</span></div>${rarest}</div>
      <div class="card"><div class="card-h"><h3>Recently completed</h3><span class="tiny muted">${esc(a.range.label)}</span></div>${done}</div></div>`;
  }

  async function yoy() {
    const p = new URLSearchParams({ years: f.years.join(','), estimates: f.estimates });
    if (f.platform) p.set('platform', f.platform);
    const y = await api(`/stats/year-over-year?${p}`);
    const COLORS = ['var(--accent-mark)', 'var(--muted)', 'var(--custom)', 'var(--steam)'];
    const list = y.years; // oldest first
    const color = (i) => COLORS[list.length - 1 - i] || 'var(--manual)';
    const now = new Date();
    const chips = years.slice(0, 8).map((yr) => `<button class="chip ${f.years.includes(yr) ? 'on' : ''}" data-year="${yr}">${yr}</button>`).join('');
    const labels = Array.from({ length: 12 }, (_, m) => ({ label: new Date(2024, m, 15).toLocaleDateString(undefined, { month: 'short' }), name: new Date(2024, m, 15).toLocaleDateString(undefined, { month: 'long' }) }));
    const series = list.map((yr, i) => {
      const future = (m) => yr.year > now.getFullYear() || (yr.year === now.getFullYear() && m > now.getMonth());
      let run = 0;
      const vals = yr.months.map((mo, m) => { run += mo.minutes; return future(m) ? null : f.yoy === 'total' ? run : mo.minutes; });
      return { name: String(yr.year), color: color(i), values: vals, estimated: f.yoy === 'total' ? [] : yr.months.map((mo) => mo.estimated) };
    });
    const any = list.some((yr) => yr.total_minutes);
    const cur = list.find((yr) => yr.partial) || list[list.length - 1];
    const prev = list.filter((yr) => yr.year < cur.year).pop();
    const through = cur?.to_date?.through ? fmtDate(new Date(`${cur.year}-${cur.to_date.through}T12:00`).getTime(), { month: 'long', day: 'numeric' }) : '';
    let lead = '';
    if (cur && prev && through) {
      const a = cur.to_date.minutes; const b = prev.to_date.minutes;
      const d = b ? Math.round(((a - b) / b) * 100) : null;
      lead = `<p class="ins-lead"><b>${fmtMin(a, { short: a >= 600 })}</b> in ${cur.year} so far — ${d == null ? `nothing by ${through} ${prev.year}` : d === 0 ? `the same as ${prev.year} by ${through}` : `${Math.abs(d)}% ${d > 0 ? 'more' : 'less'} than ${prev.year} by ${through} (${fmtMin(b, { short: b >= 600 })})`}.</p>`;
    }
    const chart = any ? `${lineChart({ labels, series }, { mode: f.yoy === 'total' ? 'lines' : 'bars', size: 'page', title: f.yoy === 'total' ? 'Running total by month' : 'Playtime per month', keys: 'Years side by side; arrow keys read each month', summary: () => `${f.yoy === 'total' ? 'Running total by month' : 'Playtime per month'}: ${list.map((yr) => `${yr.year} ${fmtMin(yr.total_minutes)}`).join(', ')}` })}
      <div class="legend">${list.map((yr, i) => `<span><i class="dot" style="background:${color(i)}"></i>${yr.year} · ${fmtMin(yr.total_minutes, { short: true })}${yr.estimated_minutes ? ` (${fmtMin(yr.estimated_minutes, { short: true })} est.)` : ''}</span>`).join('')}${f.yoy === 'month' && list.some((yr) => yr.estimated_minutes) ? '<span><i class="dot hatch-dot"></i>Estimated history, hatched</span>' : ''}</div>` : none('No play recorded in these years.');
    return `<div class="card">
      <div class="card-h"><div class="chips" role="group" aria-label="Years to compare">${chips}</div>
        <div class="seg" id="in-yoy" aria-label="Show"><button data-yoy="month" class="${f.yoy === 'month' ? 'on' : ''}">Per month</button><button data-yoy="total" class="${f.yoy === 'total' ? 'on' : ''}">Running total</button></div></div>
      ${lead}${chart}
      <div class="scroll-x" style="margin-top:12px"><table class="tbl"><thead><tr><th>Year</th><th>Played</th><th>So far${through ? ` (to ${esc(through)})` : ''}</th><th>Sessions</th><th>Games</th><th>New</th><th>Top game</th></tr></thead><tbody>
        ${list.slice().reverse().map((yr) => `<tr><td><b>${yr.year}</b>${yr.partial ? ' <span class="tiny muted">so far</span>' : ''}</td><td class="nowrap">${fmtMin(yr.total_minutes, { short: true })}${yr.estimated_minutes ? `<div class="tiny muted">${yr.tracked_minutes ? `${fmtMin(yr.tracked_minutes, { short: true })} tracked` : 'all estimated history'}</div>` : ''}</td><td class="nowrap">${fmtMin(yr.to_date.minutes, { short: true })}</td><td>${yr.sessions.toLocaleString()}</td><td>${yr.games_played}</td><td>${yr.new_games}</td><td>${yr.top_game ? `<a class="link" href="/game/${yr.top_game.game_id}" data-link>${esc(yr.top_game.title)}</a>` : '—'}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  }

  async function library() {
    const l = await api('/stats/library');
    const st = l.by_status.filter((s) => s.games);
    const maxSt = Math.max(1, ...st.map((s) => s.minutes));
    const pl = l.by_platform;
    const maxPl = Math.max(1, ...pl.map((s) => s.minutes));
    const status = st.map((s) => meterRow(esc(STATUSES[s.status]?.label || s.status), s.minutes, maxSt, `${plural(s.games, 'game')} · ${fmtMin(s.minutes, { short: true })}`, 'var(--accent-mark)', s.history_minutes)).join('');
    const plats = pl.map((s) => meterRow(`${platDot(s.platform)}${esc(plat(s.platform).label)}`, s.minutes, maxPl, `${plural(s.games, 'game')} · ${fmtMin(s.minutes, { short: true })}`, plat(s.platform).color, s.history_minutes)).join('');
    const hours = barChart(l.hours.map((b) => ({ label: b.label.replace('-', '–'), name: b.label, value: b.games, tip: `${b.label.replace('-', '–')}: ${plural(b.games, 'game')}${b.minutes ? ` (${fmtMin(b.minutes, { short: true })})` : ''}`, color: b.label === 'Never' ? 'var(--line-strong)' : undefined })), { unit: 'count', size: 'card', title: 'Games by hours played', summary: (d) => summarizeCount('Games by hours played', d, 'game') });
    const fy = l.by_first_played_year;
    const first = fy.length ? barChart(fy.map((x) => ({ label: String(x.year), name: String(x.year), value: x.games, tip: `${x.year}: ${plural(x.games, 'game')} first played${x.from_history ? ` (${x.from_history} dated from history)` : ''}` })), { unit: 'count', size: 'small', title: 'Games by the year first played', summary: (d) => summarizeCount('Games by the year first played', d, 'game') }) : none('No first-play dates known.');
    const dusty = l.dusty.items.length ? `<div class="list">${l.dusty.items.map((x) => `<a class="item" href="/game/${x.game_id}" data-link>${cover(x)}<div class="grow"><div class="ttl ellipsis">${esc(x.title)}</div><div class="sub">Last played ${fmtDate(x.last_played_at, { year: 'numeric', month: 'short' })} · ${plural(Math.round(x.days_since / 30.4), 'month')} ago${x.status !== 'unset' ? ` · ${esc(STATUSES[x.status]?.label || x.status)}` : ''}</div></div><div class="amt">${fmtMin(x.minutes, { short: x.minutes >= 600 })}</div></a>`).join('')}</div>${l.dusty.count > l.dusty.items.length ? note(`Showing ${l.dusty.items.length} of ${l.dusty.count}, most hours first.`) : ''}`
      : none('No dusty games: everything you played has been touched within a year, or is finished.');
    const b = l.backlog;
    const maxB = Math.max(1, ...b.buckets.map((x) => x.games));
    const backlog = b.count ? `<p class="ins-lead"><b>${plural(b.count, 'game')}</b> in the backlog${b.median_days != null ? `, waiting ${plural(Math.round(b.median_days / 30.4), 'month')} at the median` : ''}.</p>
      ${b.buckets.map((x) => meterRow(esc(x.label), x.games, maxB, plural(x.games, 'game'), 'var(--accent2)')).join('')}
      ${b.oldest.length ? `<div class="list" style="margin-top:8px">${b.oldest.slice(0, 5).map((x) => `<a class="item" href="/game/${x.game_id}" data-link>${cover(x)}<div class="grow"><div class="ttl ellipsis">${esc(x.title)}</div><div class="sub">since ${fmtDate(x.since, { year: 'numeric', month: 'short', day: 'numeric' })}</div></div><div class="amt">${plural(Math.round(x.days / 30.4), 'month')}</div></a>`).join('')}</div>` : ''}`
      : none('Nothing marked Backlog. Set a game’s status to Backlog and its wait is counted here.');
    const c = l.completion;
    const scatter = c.points.length ? `${scatterChart({ points: c.points.map((x) => ({ x: x.minutes, y: x.percent, color: x.percent >= 100 ? 'var(--good)' : undefined, tip: `${x.title}: ${fmtMin(x.minutes, { short: x.minutes >= 600 })}, ${Math.floor(x.percent)}% (${x.unlocked} of ${x.total})` })) }, { keys: 'Completion against hours played; arrow keys read each game, most played first' })}
      <div class="legend"><span><i class="dot" style="background:var(--accent-mark)"></i>In progress</span><span><i class="dot" style="background:var(--good)"></i>100%</span><span>Hours on a log scale</span></div>
      ${c.truncated ? note(`Showing the ${c.points.length.toLocaleString()} most played of ${c.games.toLocaleString()} games with achievements.`) : ''}` : none('No games with achievements yet.');
    const playedPct = l.games ? Math.round((l.played / l.games) * 100) : 0;
    return `<div class="kpis k4">
        ${kpi('Games', l.games.toLocaleString(), l.hidden_included ? 'hidden included' : 'hidden left out')}
        ${kpi('Played', `${playedPct}<small>%</small>`, `${l.played.toLocaleString()} played · ${l.never_played.toLocaleString()} never`, `<div class="split-bar" style="margin-top:8px"><i style="width:${playedPct}%;background:var(--accent-mark)"></i></div>`)}
        ${kpi('Lifetime', `${fmtHours(l.minutes)}<small>h</small>`, `${fmtHours(l.tracked_minutes)}h tracked · ${fmtHours(l.history_minutes)}h history`)}
        ${kpi('Backlog', String(b.count), b.count ? `median ${plural(Math.round((b.median_days || 0) / 30.4), 'month')} waiting` : 'nothing waiting')}
      </div>
      <div class="grid grid-2 ins-grid" style="margin-top:16px">
        <div class="card"><div class="card-h"><h3>By status</h3><span class="tiny muted">hours, history hatched</span></div>${status || none('No games.')}</div>
        <div class="card"><div class="card-h"><h3>By platform</h3><span class="tiny muted">a game on two platforms counts on both</span></div>${plats || none('No platforms.')}</div>
        <div class="card"><div class="card-h"><h3>Hours played</h3></div>${hours}</div>
        <div class="card"><div class="card-h"><h3>First played</h3></div>${first}</div>
        <div class="card"><div class="card-h"><h3>Dusty games</h3><span class="tiny muted">played, untouched for a year, not finished</span></div>${dusty}</div>
        <div class="card"><div class="card-h"><h3>Backlog age</h3></div>${backlog}</div>
      </div>
      <div class="card" style="margin-top:16px"><div class="card-h"><h3>Completion vs hours</h3><span class="tiny muted">games with achievements</span></div>${scatter}</div>`;
  }

  // ---------------------------------------------------------------- controls
  const go = () => {
    const p = new URLSearchParams();
    if (f.range !== '365d') p.set('range', f.range);
    if (f.platform) p.set('platform', f.platform);
    if (f.estimates !== (state.settings?.stats_estimates || 'include')) p.set('estimates', f.estimates);
    if (f.by !== 'platform') p.set('by', f.by);
    if (f.yoy !== 'month') p.set('yoy', f.yoy);
    if (f.years.join(',') !== years.slice(0, 2).reverse().join(',')) p.set('years', f.years.join(','));
    history.replaceState({}, '', `/insights${p.toString() ? `?${p}` : ''}`);
    // sections on or near the screen redraw now; the others when they come into view again
    for (const s of $$('[data-sec]', view)) { if (near(s)) load(s.dataset.sec); else loaded.delete(s.dataset.sec); }
  };
  const near = (el) => { const r = el.getBoundingClientRect(); return r.top < innerHeight + 600 && r.bottom > -600; };
  $('#in-range').addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (!b) return; f.range = b.dataset.r; $$('#in-range button').forEach((x) => x.classList.toggle('on', x === b)); $('#in-year').value = ''; go(); });
  $('#in-year').addEventListener('change', (e) => { if (!e.target.value) return; f.range = e.target.value; $$('#in-range button').forEach((x) => x.classList.remove('on')); go(); });
  $('#in-plat').addEventListener('change', (e) => { f.platform = e.target.value; go(); });
  $('#in-est').addEventListener('change', (e) => { f.estimates = e.target.checked ? 'include' : 'exclude'; go(); });
  view.addEventListener('click', (e) => {
    const by = e.target.closest('[data-by]');
    if (by && by.dataset.by !== f.by) { f.by = by.dataset.by; go(); return; }
    const yo = e.target.closest('[data-yoy]');
    if (yo && yo.dataset.yoy !== f.yoy) { f.yoy = yo.dataset.yoy; go(); return; }
    const yr = e.target.closest('[data-year]');
    if (yr) {
      const y = Number(yr.dataset.year);
      const next = f.years.includes(y) ? f.years.filter((x) => x !== y) : [...f.years, y].sort().slice(-4);
      if (next.length) { f.years = next; go(); }
      return;
    }
    const j = e.target.closest('[data-jump]');
    if (j) {
      const sec = $(`#ins-${j.dataset.jump}`);
      load(j.dataset.jump);
      sec.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: no-preference)').matches ? 'smooth' : 'auto', block: 'start' });
      sec.querySelector('h2').tabIndex = -1;
      sec.querySelector('h2').focus({ preventScroll: true });
    }
  });
  const io = new IntersectionObserver((es) => { for (const x of es) if (x.isIntersecting) load(x.target.dataset.sec); }, { rootMargin: '300px 0px' });
  $$('[data-sec]', view).forEach((s) => io.observe(s));
  // the first section is part of the page's first render (no empty card flashing in)
  await load('when');
}

// ---------------------------------------------------------------- eras
/*
 * The eras of GET /stats/timeline (also on Year in review): a strip on a true time axis (every month
 * of the range the same width, breaks left empty, years marked under it; arrow keys read each era)
 * and the list it stands for, by year and in the same order, so each row is the block above it.
 * Colours come from a categorical palette by the era's color_index (--era-0 … --era-9, set per
 * theme with an ink that reads on all of them); mostly estimated eras are hatched, variety striped.
 */
const ERA_COLORS = 10;
const eraColor = (e) => (e.kind === 'game' ? `var(--era-${(e.color_index ?? 0) % ERA_COLORS})` : 'var(--era-mix)');
const mostlyEst = (e) => e.kind !== 'break' && e.estimated_minutes * 2 > e.minutes;
const monthNo = (k) => { const [y, m] = k.split('-').map(Number); return y * 12 + m - 1; };
const nth = (n) => `${n}${{ one: 'st', two: 'nd', few: 'rd' }[new Intl.PluralRules('en', { type: 'ordinal' }).select(n)] || 'th'}`;
const names = (list) => { const t = list.map((g) => g.title); return t.length < 3 ? t.join(' and ') : `${t.slice(0, -1).join(', ')} and ${t.at(-1)}`; };
const hrs = (m) => fmtMin(m, { short: m >= 600 });
const r1 = (v) => Math.round(v * 10) / 10;

function eraSpan(e) {
  if (e.from === e.to) return monthName(e.from);
  const sameYear = e.from.slice(0, 4) === e.to.slice(0, 4);
  return `${monthName(e.from, sameYear ? { month: 'short' } : { month: 'short', year: 'numeric' })} – ${monthName(e.to)}`;
}

function eraTip(e) {
  const span = `${eraSpan(e)} (${plural(e.months, 'month')})`;
  if (e.kind === 'break') return `Break · ${eraSpan(e)} · ${plural(e.months, 'month')}, no play`;
  if (e.kind === 'variety') return `A mix of games · ${span} · ${e.games.map((g) => g.title).join(', ')} · ${fmtMin(e.minutes)}${mostlyEst(e) ? ' · mostly estimated' : ''}`;
  return `${e.title} · ${span} · ${pct(e.share)} of play · ${fmtMin(e.minutes)}${e.ordinal > 1 ? ` · ${nth(e.ordinal)} era` : ''}${mostlyEst(e) ? ' · mostly estimated' : ''}`;
}

/** "3 eras in 12 months: Baldur's Gate 3 led Jul – Oct 2026, …" */
function eraSummary(eras, months) {
  const shown = eras.filter((e) => e.kind !== 'break');
  const parts = shown.slice(0, 6).map((e) => (e.kind === 'game' ? `${e.title} led ${eraSpan(e)}` : `a mix of games ${eraSpan(e)}`));
  if (shown.length > 6) parts.push(`${shown.length - 6} more`);
  const off = eras.filter((e) => e.kind === 'break').reduce((a, e) => a + e.months, 0);
  if (off) parts.push(`${plural(off, 'month')} without play`);
  return `${plural(shown.length, 'era')} in ${plural(months, 'month')}: ${parts.join(', ') || 'no play'}`;
}

/** The text, cut with an ellipsis to fit `room` px of 12px semibold (nothing when under 3 letters fit). */
function fitText(s, room) {
  const per = 7.1;
  if (s.length * per <= room) return s;
  const n = Math.floor(room / per) - 1;
  return n >= 3 ? `${s.slice(0, n).trimEnd()}…` : '';
}

registerChart('erastrip', ({ eras, from, to, through }, opts, box) => {
  const start = monthNo(from);
  const last = Math.max(monthNo(to), through ? monthNo(through) : 0);
  const n = last - start + 1;
  const W = box.w;
  const mw = W / n;
  const H = W < 520 ? 34 : 40;
  const gap = mw >= 8 ? 2 : 1;
  const x0 = (k) => (monthNo(k) - start) * mw;
  let marks = `<rect class="era-track" x="0" y="0" width="${r1(W)}" height="${H}" rx="8"/>`;
  // the rest of the year (Year in review): months still to come
  if (monthNo(to) < last) marks += `<rect class="era-future" x="${r1(x0(to) + mw + gap / 2)}" y="0.5" width="${r1((last - monthNo(to)) * mw - gap)}" height="${H - 1}" rx="7"/>`;
  for (const e of eras) {
    const x = x0(e.from) + gap / 2;
    const w = Math.max(1, e.months * mw - gap);
    const rect = `x="${r1(x)}" y="0" width="${r1(w)}" height="${H}" rx="${r1(Math.min(7, w / 2))}"`;
    const tip = esc(eraTip(e));
    if (e.kind === 'break') {
      marks += `<rect class="hit era-break" ${rect} data-tip="${tip}"/>`;
      const t = fitText('Break', w - 14);
      if (t) marks += `<text class="era-l brk" x="${r1(x + 7)}" y="${H / 2 + 4}">${t}</text>`;
      continue;
    }
    marks += `<rect class="hit era-b" ${rect} fill="${eraColor(e)}" data-kind="${e.kind}" data-tip="${tip}"/>`;
    if (e.kind === 'variety') marks += `<rect ${rect} fill="url(#${box.id}-mix)" pointer-events="none"/>`;
    else if (mostlyEst(e)) marks += `<rect class="era-est" ${rect} fill="url(#${box.id}-est)" pointer-events="none"/>`;
    const t = fitText(e.kind === 'game' ? e.title : 'Mix', w - 14);
    if (t) marks += `<text class="era-l${e.kind === 'variety' ? ' mix' : ''}" x="${r1(x + 7)}" y="${H / 2 + 4}">${esc(t)}</text>`;
  }
  // under the strip: the years (a tick at each January), and quarters where there is room
  const month = (m) => new Date(2000, m, 1).toLocaleDateString(undefined, { month: 'short' });
  const items = [];
  let ticks = '';
  for (let i = 0; i < n; i++) {
    const m = (start + i) % 12;
    const y = Math.floor((start + i) / 12);
    if (i === 0 || m === 0) items.push({ i, text: i === 0 && m !== 0 ? `${month(m)} ${y}` : String(y), yr: true });
    if (m === 0 && i > 0) ticks += `<line class="era-tick" x1="${r1(i * mw)}" x2="${r1(i * mw)}" y1="${H + 2}" y2="${H + 9}"/>`;
  }
  if (mw * 3 >= 40) for (let i = 1; i < n; i++) if ([3, 6, 9].includes((start + i) % 12)) items.push({ i, text: month((start + i) % 12) });
  const placed = [];
  for (const it of items) {
    const tw = textWidth(it.text);
    const x = Math.max(0, Math.min(W - tw, it.i * mw + (it.i ? 4 : 1)));
    if (placed.some((p) => x < p.r + 8 && x + tw > p.l - 8)) continue;
    placed.push({ l: x, r: x + tw, ...it, x });
  }
  const labels = placed.map((p) => `<text class="${p.yr ? 'yr' : ''}" x="${r1(p.x)}" y="${H + 19}">${esc(p.text)}</text>`).join('');
  const defs = `<defs><pattern id="${box.id}-est" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="var(--era-hatch)" stroke-width="1.6"/></pattern>`
    + `<pattern id="${box.id}-mix" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="8" stroke="var(--era-mix-stripe)" stroke-width="3"/></pattern></defs>`;
  return { defs, h: H + 24, svg: `${marks}<g class="axis">${ticks}${labels}</g>`, label: eraSummary(eras, n) };
});

/**
 * One era of the list: the colour of its block, a cover, the title (a link) and a "2nd era" tag for a
 * return; its span (and a quiet "mostly estimated"); its share and hours, then what came alongside.
 * Variety rows show their top games, breaks one dim line.
 */
function eraRow(e) {
  const est = mostlyEst(e) ? '<span class="era-est" title="Mostly estimated history: played before tracking began, dated by inference"> · mostly estimated</span>' : '';
  const when = `<div class="era-sub era-when">${eraSpan(e)} · ${plural(e.months, 'month')}${est}</div>`;
  if (e.kind === 'break') {
    return `<li class="era-row brk"><span class="era-sw" aria-hidden="true"></span><div class="era-main"><div class="era-t">Break · ${plural(e.months, 'month')}, no play</div><div class="era-sub era-when">${eraSpan(e)}</div></div></li>`;
  }
  if (e.kind === 'variety') {
    return `<li class="era-row mix"><span class="era-sw" aria-hidden="true"></span><span class="era-mixtile" aria-hidden="true">${icon('grid')}</span>
      <div class="era-main"><div class="era-t"><b>A mix of games</b></div>${when}
      <div class="era-sub era-meta"><span><b>${hrs(e.minutes)}</b> across games</span>${e.games.length ? `<span class="era-with">mostly ${esc(names(e.games.slice(0, 2)))}</span>` : ''}</div></div></li>`;
  }
  return `<li class="era-row${mostlyEst(e) ? ' est' : ''}" style="--era-c:${eraColor(e)}"><span class="era-sw" aria-hidden="true"></span>${cover(e)}
    <div class="era-main"><div class="era-t"><a href="/game/${e.game_id}" data-link class="ellipsis">${esc(e.title)}</a>${e.ordinal > 1 ? `<span class="era-tag" title="${esc(e.title)} led an earlier era too">${nth(e.ordinal)} era</span>` : ''}</div>
      ${when}
      <div class="era-sub era-meta"><span><b>${pct(e.share)}</b> of your play · <b>${hrs(e.minutes)}</b></span>${e.alongside.length ? `<span class="era-with">alongside ${esc(names(e.alongside.slice(0, 2)))}</span>` : ''}</div></div></li>`;
}

/**
 * The eras card body for a timeline response: the strip, a legend for what is not a game, and the
 * list grouped by year (no year heads when it is one year). opts.through: extend the axis to this
 * month (YYYY-MM), drawing the months still to come (Year in review: the rest of the year).
 */
export function eraStrip(tl, { through } = {}) {
  const eras = tl.eras || [];
  if (!eras.length) return none('No months with play in this range.');
  const range = tl.era_range || { from: eras[0].from, to: eras.at(-1).to };
  const years = new Map();
  for (const e of eras) {
    const y = e.from.slice(0, 4);
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(e);
  }
  const legend = [
    eras.some((e) => e.kind === 'game' && mostlyEst(e)) && '<span><i class="dot era-dot est"></i>Hatched: mostly estimated history</span>',
    eras.some((e) => e.kind === 'variety') && '<span><i class="dot era-dot mix"></i>A mix: no game clearly led</span>',
    eras.some((e) => e.kind === 'break') && '<span><i class="dot era-dot brk"></i>No play</span>',
  ].filter(Boolean);
  const games = eras.filter((e) => e.kind === 'game');
  const returns = games.filter((e) => e.ordinal > 1).length;
  return `${chart('erastrip', { eras, from: range.from, to: range.to, through: through && through > range.to ? through : null }, { keys: 'Eras on a timeline; arrow keys read each era' })}
    ${legend.length ? `<div class="legend era-legend">${legend.join('')}</div>` : ''}
    <div class="era-years">${[...years].map(([y, list]) => `<section class="era-year">${years.size > 1 ? `<h4 class="era-yh">${y}</h4>` : ''}<ol class="era-list">${list.map(eraRow).join('')}</ol></section>`).join('')}</div>
    ${note(`${plural(games.length, 'era')} of ${plural(new Set(games.map((e) => e.game_id)).size, 'game')}${returns ? `, ${plural(returns, 'return')}` : ''}. An era is a run of months one game led; a narrow one-month detour does not split it.`)}`;
}

/** "Unlocks per month: 196 in all, most in August 2026 (30)" for count charts. */
function summarizeCount(title, items, word = 'unlock') {
  const total = items.reduce((a, d) => a + (d.value || 0), 0);
  if (!total) return `${title}: none`;
  const top = items.reduce((a, d) => (d.value > a.value ? d : a), items[0]);
  return `${title}: ${plural(total, word)} in all, most in ${top.name || top.label} (${top.value})`;
}

/** A highlight of GET /stats/records as a line, numbers first, dates in words (its own text otherwise). */
function highlight(h, r) {
  const g = (id) => (id ? `<a class="link" href="/game/${id}" data-link>` : '');
  switch (h.id) {
    case 'longest_session': return `<b>${fmtMin(h.value)}</b> — your longest session, ${g(h.game_id)}${esc(r.longest_session?.title || '')}${h.game_id ? '</a>' : ''} on ${longDay(h.day)}.`;
    case 'biggest_day': return `<b>${fmtMin(h.value)}</b> on ${longDay(h.day)}, your biggest day.`;
    case 'best_week': return `<b>${fmtMin(h.value)}</b> in the week of ${longDay(h.day)}, your best week.`;
    case 'longest_streak': return `<b>${plural(h.value, 'day')}</b> in a row, your longest streak (to ${longDay(h.day)}).`;
    case 'most_played': return `<b>${h.value}%</b> of your play went to ${g(h.game_id)}${esc(r.most_played?.title || '')}${h.game_id ? '</a>' : ''} (${fmtMin(h.minutes, { short: h.minutes >= 600 })}).`;
    case 'favorite_weekday': return `<b>${h.value}%</b> of tracked play falls on ${dayName(h.weekday, 'long')}s, your favourite day.`;
    case 'time_of_day': return `<b>${h.value}%</b> of timed play is in the ${esc(h.part)} (${hourLabel(h.from_hour)}–${hourLabel(h.to_hour % 24)}).`;
    case 'first_session': return `Your trail starts on ${longDay(h.day)}: ${g(h.game_id)}${esc(r.first_session?.title || '')}${h.game_id ? '</a>' : ''}, ${fmtMin(h.value)}.`;
    default: return h.text ? esc(h.text) : '';
  }
}
