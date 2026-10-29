import { $, $$, esc, fmtMin, fmtHours, fmtDate, plat, cover, icon, api, state, plural, a11y, tagHref } from '../app.js';
import { barChart, sparkline, donut, heatmap, topList, platformLegend, mountCharts, dayName } from '../charts.js';
import { WD, hourLabel, stackedSeries, estimatedLegend, kpi, hoursVal, emptyState, logSessionModal, dayKey, D, rarityText } from './shared.js';

const ymdAdd = (k, n) => { const d = new Date(`${k}T12:00`); d.setDate(d.getDate() + n); return dayKey(d.getTime()); };
const monthEnd = (k) => { const [y, m] = k.split('-').map(Number); return `${k}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };
/** The days a chart bucket covers (day, week, month or year key), for a link to its sessions. */
const bucketDays = (k, group) => (group === 'day' ? [k, k] : group === 'week' ? [k, ymdAdd(k, 6)] : group === 'month' ? [`${k}-01`, monthEnd(k)] : [`${k}-01-01`, `${k}-12-31`]);

/** "the 30 days before", "last week to this point", "2025": what a range is compared with. */
function compareName(range) {
  let m;
  if ((m = /^(\d+)d$/.exec(range))) return `the ${m[1]} days before`;
  if (range === 'week') return 'last week, to the same point';
  if (range === 'month') return 'last month, to the same day';
  if (range === 'year') return 'last year, to the same date';
  if ((m = /^year:(\d{4})$/.exec(range))) return Number(m[1]) === new Date().getFullYear() ? `${m[1] - 1}, to the same date` : String(m[1] - 1);
  if ((m = /^month:(\d{4})-(\d{2})$/.exec(range))) return new Date(Number(m[1]), Number(m[2]) - 2, 15).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return 'the period before';
}

/** ▲ 23% / ▼ 8% against the previous period; its value in the tooltip. Nothing when there is no previous to compare with. */
function delta(cur, prev, range, fmt = (v) => String(v)) {
  if (prev == null) return '';
  const vs = `vs ${compareName(range)}: ${fmt(prev)}`;
  if (!prev) return cur ? `<span class="delta up" title="${esc(vs)}">${icon('up', 'ic-inline')}<span class="vh">up from nothing, </span>new</span>` : '';
  const d = Math.round(((cur - prev) / prev) * 100);
  if (!d) return `<span class="delta" title="${esc(vs)}">same<span class="vh"> ${esc(vs)}</span></span>`;
  return `<span class="delta ${d > 0 ? 'up' : 'down'}" title="${esc(vs)}">${icon(d > 0 ? 'up' : 'down', 'ic-inline')}<span class="vh">${d > 0 ? 'up' : 'down'} </span>${Math.abs(d)}%<span class="vh"> ${esc(vs)}</span></span>`;
}

// =====================================================================
// Stats
// =====================================================================
function moreRanges(years) {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const mk = (d) => `month:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return [
    ['Periods', [['week', 'This week'], ['month', 'This month'], [mk(last), 'Last month'], ['year', 'This year']]],
    ['Years', years.map((y) => [`year:${y}`, String(y)])],
    ['', [['all', 'All time']]],
  ];
}

export async function stats(view, stale) {
  const q = new URLSearchParams(location.search);
  let range = q.get('range') || '30d';
  let platform = q.get('platform') || '';
  let estimates = q.get('estimates') || state.settings?.stats_estimates || 'include';
  // offline (or a failing years call): the current year still gives the page its controls
  const [years, lt] = await Promise.all([api('/stats/years').catch(() => [new Date().getFullYear()]), api('/stats/lifetime')]);
  if (stale()) return;
  let heatYear = /^year:\d{4}$/.test(range) && years.includes(Number(range.slice(5))) ? Number(range.slice(5)) : years[0];
  let weekdayMode = 'avg';
  if (!lt.total_minutes) {
    // nothing played at all: no zero KPIs or blank charts
    view.innerHTML = `<div class="page-h"><div><h1>Stats</h1><p>Playtime, sessions and streaks, once there is play to count.</p></div></div>
      <div class="card">${emptyState('stats', 'No play to chart yet', lt.games ? 'Your library is in, but nothing has been played or dated yet. Sessions appear after a sync spots new playtime — or log one yourself.' : 'Connect Steam, Xbox or PlayStation and Vestigo picks up your library — and every hour you’ve already played.', `${lt.games ? '' : `<a class="btn primary" href="/accounts?add=1" data-link>${icon('plus')}Connect an account</a>`}<button class="btn${lt.games ? ' primary' : ''}" id="st-log">${icon('clock')}Log a session</button>`)}</div>`;
    $('#st-log').addEventListener('click', () => logSessionModal());
    return;
  }
  view.innerHTML = `
    <div class="page-h"><div><h1>Stats</h1><p title="Tracked = observed between syncs. Estimated = playtime from before tracking, dated from first/last played, achievements and release dates. Undated = no dates available (lifetime only).">Lifetime ${fmtHours(lt.total_minutes)}h · ${fmtHours(lt.tracked_minutes)}h tracked · ${fmtHours(lt.estimated_minutes || 0)}h estimated history · ${fmtHours(lt.baseline_minutes)}h undated</p></div>
      <div class="row wrap"><a class="btn" href="/insights" data-link>${icon('insights')}Insights</a><a class="btn" href="/wrapped/${years[0]}" data-link>${icon('trail')}${years[0]} in review</a></div></div>
    <div class="toolbar"><div class="row wrap">
      <div class="row wrap" style="gap:8px">
        <div class="seg" id="st-range" aria-label="Range">${[['7d', '7 days', '7d'], ['30d', '30 days', '30d'], ['90d', '90 days', '90d'], ['365d', '12 months', '12m']].map(([v, l, sh]) => `<button data-r="${v}" class="${range === v ? 'on' : ''}" title="Last ${l}"><span class="lg">${l}</span><span class="sm">${sh}</span></button>`).join('')}</div>
        <select class="input" id="st-year" aria-label="More ranges" style="width:auto;max-width:120px"><option value="">More…</option>${moreRanges(years).map(([grp, list]) => `<optgroup label="${grp}">${list.map(([v, l]) => `<option value="${v}" ${range === v ? 'selected' : ''}>${l}</option>`).join('')}</optgroup>`).join('')}</select>
      </div>
      <label class="row small" style="gap:8px;cursor:pointer" title="Include playtime from before tracking began, dated by inference (hatched in charts)"><span class="switch"><input type="checkbox" id="st-est" ${estimates !== 'exclude' ? 'checked' : ''}><span></span></span>Estimated history</label>
      <select class="input" id="st-plat" style="width:auto" aria-label="Platform"><option value="">All platforms</option>${lt.platforms.map((p) => `<option value="${esc(p.platform)}" ${platform === p.platform ? 'selected' : ''}>${esc(plat(p.platform).label)}</option>`).join('')}</select>
    </div></div>
    <div id="st-body"></div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Activity</h2><div class="seg" id="hm-year" aria-label="Activity year">${years.map((y) => `<button data-y="${y}" class="${y === heatYear ? 'on' : ''}">${y}</button>`).join('')}</div></div><div id="hm"></div></div>`;
  const body = $('#st-body');
  // the latest choice wins: an answer for an earlier range that arrives late is dropped
  let loadSeq = 0; let heatSeq = 0;
  const load = async () => {
    const my = ++loadSeq;
    const p = new URLSearchParams({ range, estimates });
    if (platform) p.set('platform', platform);
    history.replaceState({}, '', `/stats?${p}`);
    let s; let tags;
    try {
      [s, tags] = await Promise.all([api(`/stats?${p}&compare=true&highlights=true`), api(`/stats/tags?${p}&kind=genre&limit=8`).catch(() => null)]);
    } catch (e) {
      if (my !== loadSeq || stale()) return;
      body.innerHTML = `<div class="card">${emptyState('stats', 'Stats did not load', esc(e.message), '<button class="btn" data-st-retry>Try again</button>')}</div>`;
      body.querySelector('[data-st-retry]').addEventListener('click', () => load());
      return;
    }
    if (my !== loadSeq || stale()) return;
    const pv = s.previous;
    const hasHours = s.hours.some((h) => h > 0);
    if (!s.total_minutes) {
      body.innerHTML = `<div class="card">${emptyState('stats', 'Nothing played in this range', `${esc(s.range.label)}${platform ? ` on ${esc(plat(platform).label)}` : ''}${estimates === 'exclude' ? ', tracked play only' : ''}: no sessions and no dated history.`, `<button class="btn" data-r-all>Show all time</button><button class="btn" data-st-log>${icon('clock')}Log a session</button>`)}</div>`;
      body.querySelector('[data-r-all]').addEventListener('click', () => { range = 'all'; $$('#st-range button').forEach((x) => x.classList.remove('on')); $('#st-year').value = 'all'; load(); });
      body.querySelector('[data-st-log]').addEventListener('click', () => logSessionModal());
      return;
    }
    body.innerHTML = `
      <div class="kpis fade-in">
        ${kpi('Played', hoursVal(s.total_minutes), `${delta(s.total_minutes, pv?.total_minutes, range, fmtMin)} ${s.estimated_minutes ? `${fmtHours(s.tracked_minutes)}h tracked + ${fmtHours(s.estimated_minutes)}h estimated` : s.range.label}`, sparkline(s.series.map((x) => x.minutes)), 'feature')}
        ${kpi('Sessions', s.sessions, `${delta(s.sessions, pv?.sessions, range)} avg ${fmtMin(s.avg_session_minutes)}`)}
        ${kpi('Games', s.games_played, `${delta(s.games_played, pv?.games_played, range)} ${plural(s.days_played, 'day')} played`)}
        ${kpi('Daily avg', fmtMin(s.avg_per_day_minutes), `${delta(s.avg_per_day_minutes, pv?.avg_per_day_minutes, range, fmtMin)} ${s.busiest_day ? `best ${fmtDate(new Date(`${s.busiest_day.day}T12:00`).getTime())} · ${fmtMin(s.busiest_day.minutes)}` : ''}`)}
        ${kpi('Streak', `${s.streaks.current}<small>d</small>`, `longest ${s.streaks.longest} days`)}
      </div>
      <div class="card" style="margin-top:16px"><div class="card-h"><h2>Playtime per ${s.range.group}</h2></div>${barChart(stackedSeries(s).map((x, i) => { const [a, b] = bucketDays(s.series[i].key, s.range.group); return { ...x, href: `/sessions?from=${a}&to=${b}${platform ? `&platform=${encodeURIComponent(platform)}` : ''}` }; }), { size: 'page', title: `Playtime per ${s.range.group}, ${s.range.label.toLowerCase()}`, hrefHint: 'see sessions', keys: `Playtime per ${s.range.group}; arrow keys read each bar, Enter opens its sessions` })}${platformLegend(s.platforms, estimatedLegend(s))}</div>
      ${highlightsCard(s)}
      <div class="grid grid-3" style="margin-top:16px">
        <div class="card"><div class="card-h"><h2>Top games</h2></div>${s.top_games.length ? topList(s.top_games, { coverFn: (g) => cover(g), limit: 10 }) : '<p class="muted">No play in this range.</p>'}</div>
        <div class="stack"><div class="card"><div class="card-h"><h2>Platforms</h2></div>
          ${s.platforms.length ? `<div class="donut-wrap">${donut(s.platforms.map((p) => ({ label: plat(p.platform).label, value: p.minutes, color: plat(p.platform).color })), { label: `${fmtHours(s.total_minutes)}h`, sub: 'played', title: 'Playtime by platform' })}
          <div class="col" style="gap:4px;min-width:0">${s.platforms.map((p) => `<button type="button" class="row small st-plat${platform === p.platform ? ' on' : ''}" data-st-plat="${platform === p.platform ? '' : esc(p.platform)}" aria-pressed="${platform === p.platform}" title="${platform === p.platform ? 'Show all platforms' : `Only ${esc(plat(p.platform).label)}`}"><span class="dot" style="background:${plat(p.platform).color}"></span><span class="grow ellipsis">${esc(plat(p.platform).label)}</span><b>${Math.round((p.minutes / Math.max(1, s.total_minutes)) * 100)}%</b></button>`).join('')}</div></div>` : '<p class="muted">—</p>'}
          ${s.longest_session ? `<div style="margin-top:18px" class="small muted">Longest session</div><a href="/game/${s.longest_session.game_id}" data-link><b>${fmtMin(s.longest_session.minutes)}</b> · ${esc(s.longest_session.title)}</a>` : ''}
        </div>${genreCard(tags)}</div>
        <div class="card"><div class="card-h"><h2>By weekday</h2><div class="seg compact" id="st-wd" aria-label="Weekday values"><button data-wd="avg" class="${weekdayMode === 'avg' ? 'on' : ''}" title="Average per day: a weekday's play divided by how many of that weekday the range has">Avg</button><button data-wd="total" class="${weekdayMode === 'total' ? 'on' : ''}">Total</button></div></div>
          <div id="st-wdrows">${weekdayRows(s)}</div>
          ${hasHours ? `<div class="card-h" style="margin-top:18px;margin-bottom:6px"><h3>Time of day</h3><span class="tiny dim">exact sessions only</span></div>${barChart(s.hours.map((m, h) => ({ label: h % 6 === 0 ? hourLabel(h) : '', name: `${h}:00`, value: m, tip: `${h}:00 – ${h + 1}:00: ${fmtMin(m)}` })), { size: 'small', color: 'var(--accent2)', labelEvery: 1, maxBar: 14, title: 'Exact sessions by time of day' })}` : '<p class="tiny dim" style="margin-top:14px">Sync more often (or log sessions manually) to unlock time-of-day stats.</p>'}
        </div>
      </div>`;
    mountCharts(body);
    a11y(body); // the redrawn toggles get their roles and keys again
    body.querySelector('#st-wd')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-wd]');
      if (!b) return;
      weekdayMode = b.dataset.wd;
      $$('#st-wd button').forEach((x) => x.classList.toggle('on', x === b));
      $('#st-wdrows').innerHTML = weekdayRows(s);
      a11y($('#st-wd'));
    });
    body.querySelectorAll('[data-st-plat]').forEach((b) => b.addEventListener('click', () => { platform = b.dataset.stPlat; $('#st-plat').value = platform; load(); }));
  };
  // a weekday's total, or its average per day: the range has a different number of each weekday
  function weekdayRows(s) {
    const order = [...Array(7)].map((_, i) => ((state.settings?.week_starts_on ?? 1) + i) % 7);
    const count = Array(7).fill(0);
    for (let t = new Date(s.range.from).setHours(12, 0, 0, 0); t <= s.range.to; t += D) count[new Date(t).getDay()]++;
    const vals = s.weekday.map((m, d) => (weekdayMode === 'avg' ? m / Math.max(1, count[d]) : m));
    const max = Math.max(1, ...vals);
    return order.map((d) => `<div class="row small" style="margin:7px 0" title="${WD[d]}: ${fmtMin(s.weekday[d])} over ${plural(count[d], dayName(d, 'long'))}"><span style="width:34px" class="muted">${WD[d]}</span><div class="grow" style="height:8px;border-radius:9px;background:var(--bg2);overflow:hidden"><i style="display:block;height:100%;width:${(vals[d] / max) * 100}%;background:var(--accent2);border-radius:9px"></i></div><span style="width:62px;text-align:right" class="nowrap">${fmtMin(Math.round(vals[d]), { short: weekdayMode === 'total' })}</span></div>`).join('');
  }
  const loadHeat = async () => {
    const my = ++heatSeq;
    const h = await api(`/stats/heatmap?year=${heatYear}&estimates=${estimates}`).catch(() => null);
    if (my !== heatSeq || stale() || !$('#hm')) return;
    if (!h) { $('#hm').innerHTML = '<p class="small muted">The activity heatmap did not load.</p>'; return; }
    $('#hm').innerHTML = heatmap(heatYear, h.days, { weekStartsOn: state.settings?.week_starts_on ?? 1, estimated: h.estimated_days || {} });
    mountCharts($('#hm'));
  };
  $('#st-range').addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (!b) return; range = b.dataset.r; $$('#st-range button').forEach((x) => x.classList.toggle('on', x === b)); $('#st-year').value = ''; load(); });
  $('#st-year').addEventListener('change', (e) => {
    if (!e.target.value) return;
    range = e.target.value;
    $$('#st-range button').forEach((x) => x.classList.remove('on'));
    load();
    const y = /^year:\d{4}$/.test(range) ? Number(range.slice(5)) : null;
    if (y && y !== heatYear && years.includes(y)) { heatYear = y; $$('#hm-year button').forEach((x) => x.classList.toggle('on', Number(x.dataset.y) === y)); loadHeat(); }
  });
  $('#st-plat').addEventListener('change', (e) => { platform = e.target.value; load(); });
  $('#st-est').addEventListener('change', (e) => { estimates = e.target.checked ? 'include' : 'exclude'; load(); loadHeat(); });
  $('#hm-year').addEventListener('click', (e) => { const b = e.target.closest('[data-y]'); if (!b) return; heatYear = Number(b.dataset.y); $$('#hm-year button').forEach((x) => x.classList.toggle('on', x === b)); loadHeat(); });
  await Promise.all([load(), loadHeat()]);
}

/** New games, achievements and the most varied day of the range (GET /stats?highlights=true). */
function highlightsCard(s) {
  const h = s.highlights;
  if (!h) return '';
  const ng = h.new_games; const a = h.achievements; const v = h.most_varied_day;
  if (!ng.count && !a.unlocked && !v) return '';
  const day = (k) => new Date(`${k}T12:00`).getTime();
  const col = (title, inner) => `<div class="hlc"><div class="eyebrow">${title}</div>${inner}</div>`;
  return `<div class="card" style="margin-top:16px"><div class="card-h"><h2>Highlights</h2><span class="tiny muted">${esc(s.range.label)}</span></div><div class="hl-cols">
    ${col('New games', ng.count ? `<div class="rv">${ng.count}</div><div class="list">${ng.items.slice(0, 4).map((g) => `<a class="item" href="/game/${g.game_id}" data-link>${cover(g, '', 'width:32px')}<div class="grow"><div class="ttl ellipsis">${esc(g.title)}</div><div class="sub">first played ${fmtDate(day(g.first_day))}</div></div></a>`).join('')}</div>${ng.count > 4 ? `<p class="tiny muted" style="margin:6px 0 0">and ${ng.count - 4} more</p>` : ''}` : '<p class="small muted">None: no game was played for the first time.</p>')}
    ${col('Achievements', a.unlocked ? `<div class="rv">${a.unlocked.toLocaleString()}</div><div class="small muted">unlocked in ${plural(a.games, 'game')}${a.points ? ` · ${a.points.toLocaleString()} G` : ''}</div>${a.rarest ? `<a class="item" style="margin-top:8px" href="/game/${a.rarest.game_id}" data-link><div class="grow"><div class="ttl ellipsis">Rarest: ${esc(a.rarest.name || 'Hidden')}</div><div class="sub ellipsis">${esc(a.rarest.title)}</div></div>${rarityText(a.rarest)}</a>` : ''}` : '<p class="small muted">None unlocked in this range.</p>')}
    ${col('Most varied day', v ? `<a class="rv" href="/sessions?from=${v.day}&to=${v.day}" data-link title="See the sessions">${plural(v.games, 'game')}</a><div class="small muted">on ${fmtDate(day(v.day), { weekday: 'long', month: 'short', day: 'numeric' })}</div>` : '<p class="small muted">One game a day at most.</p>')}
  </div></div>`;
}

/** Genres of the range (IGDB): only once games have them. */
function genreCard(t) {
  if (!t?.items?.length) return '';
  const max = t.items[0].minutes;
  return `<div class="card"><div class="card-h"><h2>Genres</h2><a href="/insights#ins-genres" data-link class="tiny">More</a></div>
    ${t.items.map((x) => `<a class="mrow mlink" href="${tagHref('genre', x.name)}" data-link><span class="ml">${esc(x.name)}</span><span class="mbar"><i style="width:${(x.minutes / max) * 100}%;background:var(--accent2)"></i></span><span class="mv">${fmtMin(x.minutes, { short: true })}</span></a>`).join('')}
    <p class="tiny muted" style="margin:8px 0 0">A game counts in each of its genres · ${t.coverage.matched_games} of ${plural(t.coverage.games, 'game')} have genres.</p></div>`;
}
