import { $, $$, esc, fmtMin, fmtHours, fmtDate, plat, cover, icon, api, state } from '../app.js';
import { barChart, sparkline, donut, heatmap, topList, platformLegend, mountCharts } from '../charts.js';
import { WD, hourLabel, stackedSeries, estimatedLegend, kpi, hoursVal, emptyState, logSessionModal } from './shared.js';

// =====================================================================
// Stats
// =====================================================================
export async function stats(view, stale) {
  const q = new URLSearchParams(location.search);
  let range = q.get('range') || '30d';
  let platform = q.get('platform') || '';
  let estimates = q.get('estimates') || state.settings?.stats_estimates || 'include';
  const [years, lt] = await Promise.all([api('/stats/years'), api('/stats/lifetime')]);
  if (stale()) return;
  let heatYear = years[0];
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
      <div class="row" style="gap:8px">
        <div class="seg" id="st-range" aria-label="Range">${[['7d', '7 days', '7d'], ['30d', '30 days', '30d'], ['90d', '90 days', '90d'], ['365d', '12 months', '12m']].map(([v, l, sh]) => `<button data-r="${v}" class="${range === v ? 'on' : ''}" title="Last ${l}"><span class="lg">${l}</span><span class="sm">${sh}</span></button>`).join('')}</div>
        <select class="input" id="st-year" aria-label="Year" style="width:auto"><option value="">Year…</option>${[...years.map((y) => [`year:${y}`, String(y)]), ['all', 'All time']].map(([v, l]) => `<option value="${v}" ${range === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <label class="row small" style="gap:8px;cursor:pointer" title="Include playtime from before tracking began, dated by inference (hatched in charts)"><span class="switch"><input type="checkbox" id="st-est" ${estimates !== 'exclude' ? 'checked' : ''}><span></span></span>Estimated history</label>
      <select class="input" id="st-plat" style="width:auto" aria-label="Platform"><option value="">All platforms</option>${lt.platforms.map((p) => `<option value="${esc(p.platform)}" ${platform === p.platform ? 'selected' : ''}>${esc(plat(p.platform).label)}</option>`).join('')}</select>
    </div></div>
    <div id="st-body"></div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Activity</h2><div class="seg" id="hm-year" aria-label="Activity year">${years.map((y) => `<button data-y="${y}" class="${y === heatYear ? 'on' : ''}">${y}</button>`).join('')}</div></div><div id="hm"></div></div>`;
  const body = $('#st-body');
  const load = async () => {
    const p = new URLSearchParams({ range, estimates });
    if (platform) p.set('platform', platform);
    history.replaceState({}, '', `/stats?${p}`);
    const s = await api(`/stats?${p}`);
    const maxWd = Math.max(1, ...s.weekday);
    const order = [1, 2, 3, 4, 5, 6, 0];
    const hasHours = s.hours.some((h) => h > 0);
    if (!s.total_minutes) {
      body.innerHTML = `<div class="card">${emptyState('stats', 'Nothing played in this range', `${esc(s.range.label)}${platform ? ` on ${esc(plat(platform).label)}` : ''}${estimates === 'exclude' ? ', tracked play only' : ''}: no sessions and no dated history.`, `<button class="btn" data-r-all>Show all time</button><button class="btn" data-st-log>${icon('clock')}Log a session</button>`)}</div>`;
      body.querySelector('[data-r-all]').addEventListener('click', () => { range = 'all'; $$('#st-range button').forEach((x) => x.classList.remove('on')); $('#st-year').value = 'all'; load(); });
      body.querySelector('[data-st-log]').addEventListener('click', () => logSessionModal());
      return;
    }
    body.innerHTML = `
      <div class="kpis fade-in">
        ${kpi('Played', hoursVal(s.total_minutes), s.estimated_minutes ? `${fmtHours(s.tracked_minutes)}h tracked + ${fmtHours(s.estimated_minutes)}h estimated` : s.range.label, sparkline(s.series.map((x) => x.minutes)), 'feature')}
        ${kpi('Sessions', s.sessions, `avg ${fmtMin(s.avg_session_minutes)}`)}
        ${kpi('Games', s.games_played, `${s.days_played} days played`)}
        ${kpi('Daily avg', fmtMin(s.avg_per_day_minutes), s.busiest_day ? `best ${fmtDate(new Date(`${s.busiest_day.day}T12:00`).getTime())} · ${fmtMin(s.busiest_day.minutes)}` : '')}
        ${kpi('Streak', `${s.streaks.current}<small>d</small>`, `longest ${s.streaks.longest} days`)}
      </div>
      <div class="card" style="margin-top:16px"><div class="card-h"><h2>Playtime per ${s.range.group}</h2></div>${barChart(stackedSeries(s), { size: 'page', title: `Playtime per ${s.range.group}, ${s.range.label.toLowerCase()}` })}${platformLegend(s.platforms, estimatedLegend(s))}</div>
      <div class="grid grid-3" style="margin-top:16px">
        <div class="card"><div class="card-h"><h2>Top games</h2></div>${s.top_games.length ? topList(s.top_games, { coverFn: (g) => cover(g), limit: 10 }) : '<p class="muted">No play in this range.</p>'}</div>
        <div class="card"><div class="card-h"><h2>Platforms</h2></div>
          ${s.platforms.length ? `<div class="donut-wrap">${donut(s.platforms.map((p) => ({ label: plat(p.platform).label, value: p.minutes, color: plat(p.platform).color })), { label: `${fmtHours(s.total_minutes)}h`, sub: 'played', title: 'Playtime by platform' })}
          <div class="col" style="gap:8px;min-width:0">${s.platforms.map((p) => `<div class="row small"><span class="dot" style="background:${plat(p.platform).color}"></span><span class="grow ellipsis">${esc(plat(p.platform).label)}</span><b>${Math.round((p.minutes / Math.max(1, s.total_minutes)) * 100)}%</b></div>`).join('')}</div></div>` : '<p class="muted">—</p>'}
          ${s.longest_session ? `<div style="margin-top:18px" class="small muted">Longest session</div><a href="/game/${s.longest_session.game_id}" data-link><b>${fmtMin(s.longest_session.minutes)}</b> · ${esc(s.longest_session.title)}</a>` : ''}
        </div>
        <div class="card"><div class="card-h"><h2>By weekday</h2></div>
          ${order.map((d) => `<div class="row small" style="margin:7px 0"><span style="width:34px" class="muted">${WD[d]}</span><div class="grow" style="height:8px;border-radius:9px;background:var(--bg2);overflow:hidden"><i style="display:block;height:100%;width:${(s.weekday[d] / maxWd) * 100}%;background:var(--accent2);border-radius:9px"></i></div><span style="width:56px;text-align:right">${fmtMin(s.weekday[d], { short: true })}</span></div>`).join('')}
          ${hasHours ? `<div class="card-h" style="margin-top:18px;margin-bottom:6px"><h3>Time of day</h3><span class="tiny dim">exact sessions only</span></div>${barChart(s.hours.map((m, h) => ({ label: h % 6 === 0 ? hourLabel(h) : '', name: `${h}:00`, value: m, tip: `${h}:00 – ${h + 1}:00: ${fmtMin(m)}` })), { size: 'small', color: 'var(--accent2)', labelEvery: 1, maxBar: 14, title: 'Exact sessions by time of day' })}` : '<p class="tiny dim" style="margin-top:14px">Sync more often (or log sessions manually) to unlock time-of-day stats.</p>'}
        </div>
      </div>`;
    mountCharts(body);
  };
  const loadHeat = async () => {
    const h = await api(`/stats/heatmap?year=${heatYear}&estimates=${estimates}`);
    $('#hm').innerHTML = heatmap(heatYear, h.days, { weekStartsOn: state.settings?.week_starts_on ?? 1, estimated: h.estimated_days || {} });
    mountCharts($('#hm'));
  };
  $('#st-range').addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (!b) return; range = b.dataset.r; $$('#st-range button').forEach((x) => x.classList.toggle('on', x === b)); $('#st-year').value = ''; load(); });
  $('#st-year').addEventListener('change', (e) => { if (!e.target.value) return; range = e.target.value; $$('#st-range button').forEach((x) => x.classList.remove('on')); load(); });
  $('#st-plat').addEventListener('change', (e) => { platform = e.target.value; load(); });
  $('#st-est').addEventListener('change', (e) => { estimates = e.target.checked ? 'include' : 'exclude'; load(); loadHeat(); });
  $('#hm-year').addEventListener('click', (e) => { const b = e.target.closest('[data-y]'); if (!b) return; heatYear = Number(b.dataset.y); $$('#hm-year button').forEach((x) => x.classList.toggle('on', x === b)); loadHeat(); });
  await Promise.all([load(), loadHeat()]);
}
