import { $, esc, fmtMin, fmtHours, fmtDate, plat, platDot, cover, icon, api, navigate, plural, MARK } from '../app.js';
import { topList, mountCharts, dayName } from '../charts.js';
import { eraStrip } from '../insights.js';
import { hourLabel, emptyState, fmtRarity, achIcon } from './shared.js';

// =====================================================================
// Year in review
// =====================================================================
export async function wrapped(view, year, stale) {
  const est = new URLSearchParams(location.search).get('estimates') === 'exclude' ? 'exclude' : 'include';
  const y = Number(year);
  const opt = (u) => api(u).catch(() => null);
  const [w, years, ach, tl, pc, rec] = await Promise.all([
    api(`/stats/year/${y}?estimates=${est}`), opt('/stats/years'),
    opt(`/stats/achievements?range=year:${y}&limit=5`), opt(`/stats/timeline?range=year:${y}&group=month&estimates=${est}`),
    opt(`/stats/punchcard?range=year:${y}`), opt(`/stats/records?range=year:${y}&estimates=${est}`),
  ]);
  if (stale()) return;
  const ys = (years || [y]).slice().sort((a, b) => a - b);
  const i = ys.indexOf(y);
  const prev = i > 0 ? ys[i - 1] : i < 0 ? ys.filter((x) => x < y).pop() : null;
  const next = i >= 0 && i < ys.length - 1 ? ys[i + 1] : i < 0 ? ys.find((x) => x > y) : null;
  const q = est === 'exclude' ? '?estimates=exclude' : '';
  const step = (to, dir) => (to ? `<a class="btn icon ghost" href="/wrapped/${to}${q}" data-link aria-label="${to} in review" title="${to}">${icon(dir === 'prev' ? 'back' : 'chevR')}</a>` : `<span class="btn icon ghost" aria-hidden="true" style="visibility:hidden">${icon('back')}</span>`);
  const top = w.top_games[0];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const months12 = MONTHS.map((m) => w.months.find((x) => x.month === m) || { month: m, minutes: 0 }); // the year so far: the rest are empty
  const maxM = Math.max(1, ...months12.map((m) => m.minutes));
  const L = rec?.longest_session || null;
  const busyDay = pc?.busiest_weekday;
  const tod = rec?.highlights?.find((h) => h.id === 'time_of_day');
  const parts = [w.tracked_minutes && `${fmtHours(w.tracked_minutes)}h tracked`, w.estimated_minutes && `${fmtHours(w.estimated_minutes)}h estimated history`].filter(Boolean);
  const rarest = ach?.rarest?.[0];
  const head = `<div class="wr-top"><a href="/stats" data-link class="btn ghost sm" onclick="if(history.length>1){event.preventDefault();event.stopPropagation();history.back()}">${icon('back')}Back</a></div>
    <div class="wr-head">
      <span class="brand-mark wr-mark">${MARK}</span>
      <div class="grow"><h1>Your ${y} trail</h1>
        <p>${w.total_minutes ? `The trail you left in ${y}: <b>${fmtHours(w.total_minutes)}h</b>${parts.length > 1 ? ` · ${parts.join(' + ')}` : parts.length ? ` · ${parts[0]}` : ''}.` : `Nothing recorded for ${y} yet.`}</p></div>
      <div class="wr-ctl">
        <nav class="row wr-years" aria-label="Year">${step(prev, 'prev')}<span class="wr-y" aria-current="page">${y}</span>${step(next, 'next')}</nav>
        <label class="row small" style="gap:8px;cursor:pointer" title="Playtime from before tracking began, dated by inference"><span class="switch"><input type="checkbox" id="wr-est" ${est === 'include' ? 'checked' : ''}><span></span></span>Estimated history</label>
      </div>
    </div>`;
  if (!w.total_minutes) {
    view.innerHTML = `<div class="wr">${head}<div class="card">${emptyState('trail', `No tracks in ${y}`, est === 'exclude' ? `No tracked play in ${y}. Turn estimated history on to see play dated from before tracking began.` : `Nothing is dated in ${y} — neither tracked sessions nor history from before tracking. Dating old playtime can fill the trail in.`, `<a class="btn primary" href="/history" data-link>${icon('history')}Improve history</a>`)}</div></div>`;
    bindWrapped();
    return;
  }
  const L1 = (m) => new Date(2024, ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m), 15);
  view.innerHTML = `<div class="wr">${head}
    <div class="wrapped fade-in">
      <div class="wcard g1"><div class="muted">You played</div><div class="big">${fmtHours(w.total_minutes)} hours</div><div class="muted">${w.sessions ? `across ${plural(w.sessions, 'tracked session')} on ${plural(w.days_played, 'day')}` : 'before tracking began'}${w.estimated_minutes ? ` · ${fmtHours(w.estimated_minutes)}h estimated from your history` : ''}</div></div>
      ${top ? `<a class="wcard g2" href="/game/${top.game_id}" data-link style="display:flex;gap:16px;align-items:center">${cover(top, '', 'width:90px;')}<div style="min-width:0"><div class="muted">Game of the year</div><div class="wr-gotm">${esc(top.title)}</div><div class="muted">${fmtMin(top.minutes)}${top.sessions ? ` · ${plural(top.sessions, 'session')}` : ''}</div></div></a>` : ''}
      <div class="wcard g3"><div class="muted">Longest streak</div><div class="big">${plural(w.longest_streak, 'day')}</div><div class="muted">${w.busiest_day ? `Biggest day: ${fmtDate(new Date(`${w.busiest_day.day}T12:00`).getTime(), { month: 'long', day: 'numeric' })} (${fmtMin(w.busiest_day.minutes)})` : ''}</div></div>
      <div class="wcard"><div class="muted">Games played</div><div class="big">${w.games_played}</div><div class="muted">${w.new_games} started fresh this year · ${w.completed} completed</div></div>
      <div class="wcard"><div class="muted">Best month</div><div class="big">${w.best_month ? L1(w.best_month.month).toLocaleDateString(undefined, { month: 'long' }) : '—'}</div><div class="muted">${w.best_month ? fmtMin(w.best_month.minutes) : ''}</div>
        <div class="wr-months" aria-hidden="true">${months12.map((m) => `<div title="${m.month}: ${fmtMin(m.minutes)}"><i style="height:${m.minutes ? Math.max(4, (m.minutes / maxM) * 46) : 0}px" class="${m.month === w.best_month?.month ? 'best' : ''}"></i><span>${L1(m.month).toLocaleDateString(undefined, { month: 'narrow' })}</span></div>`).join('')}</div></div>
      <div class="wcard"><div class="muted">Favourite time</div><div class="big wr-mid">${busyDay ? `${dayName(busyDay.weekday, 'long')}s` : ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][w.weekday.indexOf(Math.max(...w.weekday))]}</div><div class="muted">${tod ? `${tod.value}% of timed play in the ${esc(tod.part)} (${hourLabel(tod.from_hour)}–${hourLabel(tod.to_hour % 24)})` : pc?.busiest_hour ? `Busiest hour ${hourLabel(pc.busiest_hour.hour)}–${hourLabel((pc.busiest_hour.hour + 1) % 24)}` : 'No sessions with exact times this year'}</div></div>
      ${L ? `<a class="wcard" href="/game/${L.game_id}" data-link><div class="muted">Longest session</div><div class="big">${fmtMin(L.minutes)}</div><div class="muted">${esc(L.title)} · ${fmtDate(new Date(`${L.day}T12:00`).getTime(), { month: 'long', day: 'numeric' })}</div></a>` : ''}
      ${w.platforms?.length ? `<div class="wcard"><div class="muted">Played on</div><div class="big wr-mid">${esc(plat(w.platforms[0].platform).label)}</div><div class="muted">${Math.round((w.platforms[0].minutes / Math.max(1, w.total_minutes)) * 100)}% of the year</div>
        <div class="split-bar" style="margin-top:14px" aria-hidden="true">${w.platforms.map((p) => `<i style="width:${(p.minutes / Math.max(1, w.total_minutes)) * 100}%;background:${plat(p.platform).color}"></i>`).join('')}</div>
        <div class="legend">${w.platforms.slice(0, 4).map((p) => `<span><i class="dot" style="background:${plat(p.platform).color}"></i>${esc(plat(p.platform).label)} ${fmtHours(p.minutes)}h</span>`).join('')}</div></div>` : ''}
      ${ach && (ach.unlocked || ach.completed_count) ? `<div class="wcard wr-ach"><div class="muted">Achievements</div><div class="big">${ach.unlocked.toLocaleString()}</div><div class="muted">unlocked${ach.points ? ` · ${ach.points.toLocaleString()}G` : ''}${ach.grades?.platinum ? ` · ${plural(ach.grades.platinum, 'platinum')}` : ''} · ${plural(ach.completed_count, 'game')} completed</div>
        ${rarest ? `<div class="wr-rare">${achIcon(rarest, { size: 30 })}<div style="min-width:0"><div class="ellipsis"><b>${esc(rarest.name || 'Hidden achievement')}</b></div><div class="small muted">${esc(rarest.title)} · the rarest, ${fmtRarity(rarest.rarity ?? 0)} of players</div></div></div>` : ''}</div>` : ''}
    </div>
    ${tl?.eras?.length ? `<div class="card wr-eras" style="margin-top:16px"><div class="card-h"><h2>The eras of ${y}</h2><span class="tiny muted">who led each month</span></div>${eraStrip(tl, { through: `${y}-12` })}</div>` : ''}
    ${ach?.completed?.length ? `<div class="card" style="margin-top:16px"><div class="card-h"><h2>Completed in ${y}</h2></div><div class="list">${ach.completed.map((x) => `<a class="item" href="/game/${x.game_id}" data-link>${cover(x)}<div class="grow"><div class="ttl ellipsis">${esc(x.title)}</div><div class="sub">${platDot(x.platform)}${x.platinum ? 'Platinum' : `${x.unlocked} of ${x.total}`} · ${fmtDate(x.completed_at, { month: 'long', day: 'numeric' })}</div></div><span class="badge good">${x.platinum ? 'Platinum' : '100%'}</span></a>`).join('')}</div></div>` : ''}
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-h"><h2>Top 10</h2></div>${topList(w.top_games, { coverFn: (g) => cover(g), limit: 10 })}</div>
      <div class="card"><div class="card-h"><h2>New this year</h2></div><div class="list">${w.new_game_list.map((g) => `<a class="item" href="/game/${g.game_id}" data-link>${cover(g)}<div class="grow ttl ellipsis">${esc(g.title)}</div><span class="small muted">${fmtDate(g.first)}</span></a>`).join('') || '<p class="muted">—</p>'}</div></div>
    </div></div>`;
  mountCharts(view);
  bindWrapped();
  function bindWrapped() {
    $('#wr-est').addEventListener('change', (e) => navigate(`/wrapped/${y}${e.target.checked ? '' : '?estimates=exclude'}`, { replace: true }));
  }
}
