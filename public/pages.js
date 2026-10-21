import {
  $, $$, esc, fmtMin, fmtHours, ago, fmtDate, fmtTime, dayLabel, plat, platDot, platTag, STATUSES, cover, icon,
  api, toast, fail, modal, confirmBox, navigate, rerender, state, watchSync, applyTheme,
} from './app.js';
import { barChart, sparkline, donut, heatmap, topList, platformLegend, bindTips } from './charts.js';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function seriesLabel(key, group) {
  if (group === 'month') return new Date(`${key}-01T12:00`).toLocaleDateString(undefined, { month: 'short' });
  if (group === 'year') return key;
  const d = new Date(`${key}T12:00`);
  if (group === 'week') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { day: 'numeric' });
}

function seriesTip(key, group, minutes) {
  let label;
  if (group === 'month') label = new Date(`${key}-01T12:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  else if (group === 'year') label = key;
  else if (group === 'week') label = `Week of ${new Date(`${key}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  else label = new Date(`${key}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${label}: ${fmtMin(minutes)}`;
}

function stackedSeries(stats) {
  const plats = Object.keys(stats.series_by_platform || {});
  return stats.series.map((s, i) => ({
    label: seriesLabel(s.key, stats.range.group),
    value: s.minutes,
    tip: seriesTip(s.key, stats.range.group, s.minutes),
    stack: plats.map((p) => ({ key: p, value: stats.series_by_platform[p][i] || 0, color: plat(p).color })),
  }));
}

function kpi(label, value, sub = '', extra = '', cls = '') {
  return `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}${extra}</div>`;
}

const hoursVal = (m) => `${fmtHours(m)}<small>h</small>`;

function sessionWhen(s) {
  if (s.precise) return `${fmtTime(s.started_at)} – ${fmtTime(s.ended_at)}`;
  if (s.window_start && s.window_end) {
    const span = s.window_end - s.window_start;
    if (span < 36 * 3600e3) return `between ${fmtTime(s.window_start)} and ${fmtTime(s.window_end)}`;
    return `${fmtDate(s.window_start)} – ${fmtDate(s.window_end)}`;
  }
  return fmtDate(s.window_end || s.created_at);
}

function sourceBadge(s) {
  if (s.kind === 'baseline') return '<span class="badge">history</span>';
  if (s.source === 'manual') return '<span class="badge accent">manual</span>';
  if (s.source === 'import') return '<span class="badge">imported</span>';
  if (s.source === 'api') return '<span class="badge">api</span>';
  return s.precise ? '' : '<span class="badge" title="Exact time unknown — spread across the sync window">≈</span>';
}

function sessionItem(s, { showGame = true, selectable = false, selected = false } = {}) {
  return `<div class="item ${selected ? 'sel' : ''}" data-sid="${s.id}">
    ${selectable ? `<input type="checkbox" class="check" data-sel="${s.id}" ${selected ? 'checked' : ''}>` : ''}
    ${showGame ? `<a href="/game/${s.game_id}" data-link>${cover(s)}</a>` : `<span class="dot" style="background:${plat(s.platform).color};width:10px;height:10px"></span>`}
    <div class="grow">
      ${showGame ? `<a href="/game/${s.game_id}" data-link class="ttl ellipsis" style="display:block">${esc(s.title)}</a>` : ''}
      <div class="sub">${showGame ? platDot(s.platform) : `<b style="color:var(--text)">${esc(plat(s.platform).label)}</b>`}<span>${esc(sessionWhen(s))}</span>${sourceBadge(s)}${s.note ? `<span class="ellipsis" title="${esc(s.note)}">· ${esc(s.note)}</span>` : ''}</div>
    </div>
    <div class="amt">${fmtMin(s.minutes)}</div>
    ${selectable ? '' : `<button class="btn ghost sm icon" data-edit-session="${s.id}" aria-label="Edit session">${icon('edit')}</button>`}
  </div>`;
}

function groupByDay(sessions) {
  const groups = [];
  let cur = null;
  for (const s of sessions) {
    const t = s.ended_at || s.window_end || s.created_at;
    const d = new Date(t); d.setHours(0, 0, 0, 0);
    if (!cur || cur.day !== d.getTime()) { cur = { day: d.getTime(), items: [], minutes: 0 }; groups.push(cur); }
    cur.items.push(s); cur.minutes += s.minutes;
  }
  return groups;
}

function emptyState(ic, title, text, actions = '') {
  return `<div class="empty"><div class="em-ic">${icon(ic)}</div><h2>${title}</h2><p style="max-width:440px;margin:0 auto 16px">${text}</p>${actions}</div>`;
}

// ---------- session edit / log ----------
async function gamePicker(input, onPick) {
  let timer;
  const box = document.createElement('div');
  box.className = 'list card';
  box.style.cssText = 'padding:4px 12px;margin-top:6px;max-height:260px;overflow:auto';
  box.hidden = true;
  input.after(box);
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) { box.hidden = true; return; }
      const r = await api(`/games?q=${encodeURIComponent(q)}&limit=8&sort=recent&hidden=all`);
      box.hidden = false;
      box.innerHTML = r.items.map((g) => `<div class="item" style="cursor:pointer" data-pick="${g.id}">${cover(g)}<div class="grow"><div class="ttl ellipsis">${esc(g.title)}</div><div class="sub">${g.platforms.map(platDot).join('')} ${fmtMin(g.minutes)}</div></div></div>`).join('')
        + `<div class="item" style="cursor:pointer" data-new="1"><div class="grow muted">${icon('plus', '')} Add “${esc(q)}” as a new game</div></div>`;
    }, 160);
  });
  box.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-pick]');
    if (p) { const g = (await api(`/games/${p.dataset.pick}`)); input.value = g.title; box.hidden = true; onPick(g); }
    if (e.target.closest('[data-new]')) {
      const g = await api('/games', { method: 'POST', body: { title: input.value.trim() } });
      input.value = g.title; box.hidden = true; onPick(g);
    }
  });
}

function localInput(t) {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

export function logSessionModal(game = null, onDone = rerender) {
  let picked = game;
  const now = Date.now();
  modal({
    title: 'Log a session',
    body: `<form class="stack" id="log-form">
      <div class="field"><label>Game</label>${game ? `<div class="row">${cover(game)}<b>${esc(game.title)}</b></div>` : '<input class="input" id="gp" placeholder="Search your library or type a new title" autocomplete="off">'}</div>
      <div class="field"><label>Duration</label>
        <div class="row"><input class="input" type="number" min="0" max="168" name="h" value="1" style="width:90px"> <span class="muted">h</span>
        <input class="input" type="number" min="0" max="59" name="m" value="0" style="width:90px"> <span class="muted">m</span></div>
        <div class="chips" style="margin-top:4px">${[15, 30, 60, 90, 120, 180].map((m) => `<button type="button" class="chip" data-quick="${m}">${fmtMin(m)}</button>`).join('')}</div>
      </div>
      <div class="field"><label>Ended at</label><input class="input" type="datetime-local" name="ended" value="${localInput(now)}"></div>
      <div class="field"><label>Note <span class="dim">(optional)</span></label><input class="input" name="note" placeholder="Beat the first boss…"></div>
    </form>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="log-save">Save session</button>',
    onMount(el, close) {
      if (!game) gamePicker(el.querySelector('#gp'), (g) => { picked = g; });
      el.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => {
        const m = Number(b.dataset.quick);
        el.querySelector('[name=h]').value = Math.floor(m / 60);
        el.querySelector('[name=m]').value = m % 60;
      }));
      el.querySelector('#log-save').addEventListener('click', async () => {
        const f = el.querySelector('#log-form');
        const minutes = Number(f.h.value || 0) * 60 + Number(f.m.value || 0);
        if (!picked) return toast('Pick a game first', { bad: true });
        if (!minutes) return toast('Enter a duration', { bad: true });
        try {
          await api('/sessions', { method: 'POST', body: { game_id: picked.id, minutes, ended_at: new Date(f.ended.value).getTime(), note: f.note.value } });
          close(); toast(`Logged ${fmtMin(minutes)} of ${picked.title}`); onDone();
        } catch (e) { fail(e); }
      });
    },
  });
}

async function editSessionModal(id, onDone = rerender) {
  let s;
  try { s = await api(`/sessions/${id}`); } catch (e) { return fail(e); }
  const local = s.source !== 'sync';
  modal({
    title: esc(s.title),
    body: `<div class="stack">
      <div class="row wrap">${platTag(s.platform)} ${sourceBadge(s)} <span class="muted small">${esc(sessionWhen(s))}</span></div>
      ${!local ? `<div class="card small muted" style="padding:12px">${icon('info', '')} Synced from ${esc(plat(s.platform).label)}. The platform only reported <b>${fmtMin(s.minutes)}</b> played between ${fmtDate(s.window_start)} ${fmtTime(s.window_start)} and ${fmtDate(s.window_end)} ${fmtTime(s.window_end)}. You can pin the exact time below.</div>` : ''}
      ${local ? `<div class="field"><label>Minutes</label><input class="input" type="number" name="minutes" value="${s.minutes}" min="1"></div>` : ''}
      <div class="grid grid-2">
        <div class="field"><label>Started</label><input class="input" type="datetime-local" name="started" value="${s.started_at ? localInput(s.started_at) : ''}"></div>
        <div class="field"><label>Ended</label><input class="input" type="datetime-local" name="ended" value="${s.ended_at ? localInput(s.ended_at) : ''}"></div>
      </div>
      <div class="field"><label>Note</label><input class="input" name="note" value="${esc(s.note || '')}"></div>
      <div class="setting" style="border:0;padding:0"><div><div class="t">Count in stats</div><div class="d">Off = treat as pre-tracking history (still counts toward lifetime)</div></div>
        <label class="switch"><input type="checkbox" name="play" ${s.kind === 'play' ? 'checked' : ''}><span></span></label></div>
    </div>`,
    foot: `<button class="btn danger" id="s-del">${icon('trash')}${local ? 'Delete' : 'Remove from stats'}</button><span class="grow"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="s-save">Save</button>`,
    onMount(el, close) {
      const v = (n) => el.querySelector(`[name=${n}]`);
      el.querySelector('#s-save').addEventListener('click', async () => {
        const body = { note: v('note').value, kind: v('play').checked ? 'play' : 'baseline' };
        if (v('started').value) body.started_at = new Date(v('started').value).getTime();
        if (v('ended').value) body.ended_at = new Date(v('ended').value).getTime();
        if (local) body.minutes = Number(v('minutes').value);
        try { await api(`/sessions/${s.id}`, { method: 'PATCH', body }); close(); toast('Session updated'); onDone(); } catch (e) { fail(e); }
      });
      el.querySelector('#s-del').addEventListener('click', async () => {
        try { await api(`/sessions/${s.id}`, { method: 'DELETE' }); close(); toast(local ? 'Session deleted' : 'Removed from stats'); onDone(); } catch (e) { fail(e); }
      });
    },
  });
}

function bindSessionEdits(root, onDone) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit-session]');
    if (b) editSessionModal(b.dataset.editSession, onDone);
  });
}

// =====================================================================
// Dashboard
// =====================================================================
async function dashboard(view, stale) {
  const d = await api('/summary');
  if (stale()) return;
  const hasData = d.lifetime.games > 0;
  const greeting = (() => { const h = new Date().getHours(); return h < 5 ? 'Late night session?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; })();
  const syncing = d.accounts.some((a) => a.syncing);

  if (!hasData) {
    view.innerHTML = `<div class="page-h"><div><h1>${greeting}</h1><p>Let’s get your play history in.</p></div></div>
      <div class="card onboard fade-in">
        <h2>Welcome to PlayTracker</h2>
        <p class="muted" style="margin:6px 0 0;max-width:720px">Steam, Xbox and PlayStation report lifetime playtime but not individual sessions. PlayTracker snapshots your totals on a schedule and turns the difference into sessions. Your existing hours are imported as history so your charts don’t start with a fake 500-hour binge.</p>
        <div class="steps">
          <div><b>1 · Connect</b><span class="muted small">Link Steam, Xbox or PlayStation, or create a custom account you push to via the API.</span></div>
          <div><b>2 · Import</b><span class="muted small">The first sync imports your library and lifetime hours as baseline history.</span></div>
          <div><b>3 · Play</b><span class="muted small">Each sync (daily, weekly, monthly or every X days) turns new playtime into sessions.</span></div>
        </div>
        <div class="row wrap" style="margin-top:18px">
          <a class="btn primary" href="/accounts?add=1" data-link>${icon('plus')}Connect an account</a>
          <a class="btn" href="/settings#import" data-link>${icon('upload')}Import CSV / JSON</a>
          <button class="btn" id="dash-log">${icon('clock')}Log a session</button>
        </div>
        ${syncing ? `<p class="muted pulse" style="margin-top:16px">${icon('sync', '')} First sync in progress…</p>` : ''}
      </div>`;
    $('#dash-log').addEventListener('click', () => logSessionModal());
    return;
  }

  const wk = d.week; const mo = d.month;
  const streak = mo.streaks.current;
  const lastSync = Math.max(0, ...d.accounts.map((a) => a.last_sync_at || 0));
  const nextSync = Math.min(...d.accounts.map((a) => a.next_sync_at || Infinity));
  view.innerHTML = `
    <div class="page-h"><div><h1>${greeting}</h1><p>${d.new_sessions_24h ? `${d.new_sessions_24h} new session${d.new_sessions_24h > 1 ? 's' : ''} in the last day · ` : ''}Last sync ${ago(lastSync)}${Number.isFinite(nextSync) ? ` · next ${ago(nextSync)}` : ''}</p></div>
      <div class="row desk-only"><button class="btn" id="dash-log">${icon('plus')}Log session</button></div></div>
    <div class="kpis fade-in">
      ${kpi('This week', hoursVal(wk.total_minutes), `${wk.sessions} sessions · ${wk.games_played} games`, sparkline(wk.series.map((s) => s.minutes)), 'feature')}
      ${kpi('Today', fmtMin(d.today.total_minutes), d.today.top_games[0] ? esc(d.today.top_games[0].title) : 'Nothing yet')}
      ${kpi('Last 30 days', hoursVal(mo.total_minutes), `${fmtMin(mo.avg_per_day_minutes)}/day avg`)}
      ${kpi('Streak', `${streak}<small> day${streak === 1 ? '' : 's'}</small>`, `Best: ${mo.streaks.longest} days`)}
      ${kpi('Lifetime', `${fmtHours(d.lifetime.total_minutes)}<small>h</small>`, `${d.lifetime.games_played} of ${d.lifetime.games} games played`)}
    </div>
    ${d.now_playing.length ? `<div class="card" style="margin-top:16px"><div class="card-h"><h2>Jump back in</h2><a href="/library?sort=trending" data-link>See all</a></div>
      <div class="carousel">${d.now_playing.map((g) => `<a class="tile" href="/game/${g.id}" data-link>${cover(g)}<div class="t">${esc(g.title)}</div><div class="m">${g.platforms.map(platDot).join('')} ${fmtMin(g.recent_minutes)} · 2 wks</div></a>`).join('')}</div></div>` : ''}
    <div class="grid grid-main" style="margin-top:16px">
      <div class="card"><div class="card-h"><h2>Last 30 days</h2><a href="/stats" data-link>Stats →</a></div>
        ${barChart(stackedSeries(mo), { height: 210 })}${platformLegend(mo.platforms)}
      </div>
      <div class="card"><div class="card-h"><h2>Top this month</h2></div>
        ${mo.top_games.length ? topList(mo.top_games, { coverFn: (g) => cover(g), limit: 6 }) : '<p class="muted">No play in the last 30 days.</p>'}
      </div>
    </div>
    <div class="grid grid-main" style="margin-top:16px">
      <div class="card"><div class="card-h"><h2>Recent sessions</h2><a href="/sessions" data-link>All sessions →</a></div>
        <div class="list" id="dash-recent">${d.recent_sessions.length ? d.recent_sessions.map((s) => sessionItem(s)).join('') : '<p class="muted">No sessions yet — they appear after the next sync detects new playtime.</p>'}</div>
      </div>
      <div class="card"><div class="card-h"><h2>Accounts</h2><a href="/accounts" data-link>Manage →</a></div>
        <div class="list">${d.accounts.map((a) => `<div class="item"><span class="plat-ic" style="width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:${plat(a.platform).hex};color:#fff;font-weight:800">${plat(a.platform).short}</span>
          <div class="grow"><div class="ttl ellipsis">${esc(a.name)}</div><div class="sub">${a.syncing ? '<span class="pulse">Syncing…</span>' : a.last_status === 'error' ? `<span style="color:var(--bad)">Error · ${esc(a.last_error || '')}</span>` : `Synced ${ago(a.last_sync_at)}`}</div></div>
          ${a.push ? '<span class="badge">API</span>' : `<span class="tiny muted nowrap">${a.next_sync_at ? `next ${ago(a.next_sync_at)}` : 'manual'}</span>`}</div>`).join('') || '<p class="muted">No accounts linked.</p>'}
        </div>
        <div class="row" style="margin-top:12px"><button class="btn sm" data-action="sync-all">${icon('sync')}Sync now</button><a class="btn sm ghost" href="/accounts?add=1" data-link>${icon('plus')}Add</a></div>
      </div>
    </div>
    <button class="fab" id="fab-log" aria-label="Log session">${icon('plus')}</button>`;
  bindTips(view);
  $('#dash-log')?.addEventListener('click', () => logSessionModal());
  $('#fab-log').addEventListener('click', () => logSessionModal());
  bindSessionEdits(view);
}

// =====================================================================
// Library
// =====================================================================
function libState() {
  const q = new URLSearchParams(location.search);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('pt-lib') || '{}'); } catch { /* ignore */ }
  return {
    q: q.get('q') || '', platform: q.get('platform') || '', status: q.get('status') || '',
    sort: q.get('sort') || saved.sort || state.settings?.default_library_sort || 'recent',
    view: saved.view || 'grid', played: q.get('played') || '', hidden: q.get('hidden') || '',
  };
}

async function library(view, stale) {
  const st = libState();
  const [platforms] = await Promise.all([api('/stats/lifetime')]);
  if (stale()) return;
  const platList = platforms.platforms.map((p) => p.platform);
  view.innerHTML = `
    <div class="page-h"><div><h1>Library</h1><p id="lib-count">&nbsp;</p></div>
      <div class="row"><button class="btn desk-only" id="lib-add">${icon('plus')}Add game</button></div></div>
    <div class="toolbar">
      <div class="row" style="margin-bottom:10px">
        <div class="search grow">${icon('search')}<input class="input" id="lib-q" type="search" placeholder="Search ${platforms.games} games…" value="${esc(st.q)}"></div>
        <select class="input" id="lib-sort" style="width:auto">
          ${[['recent', 'Recently played'], ['trending', 'Trending (2 wks)'], ['playtime', 'Most played'], ['title', 'A → Z'], ['added', 'Recently added'], ['rating', 'Top rated']].map(([v, l]) => `<option value="${v}" ${st.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <div class="seg desk-only"><button data-view="grid" class="${st.view === 'grid' ? 'on' : ''}" aria-label="Grid">${icon('grid', '').replace('<svg', '<svg width="16" height="16"')}</button><button data-view="list" class="${st.view === 'list' ? 'on' : ''}" aria-label="List">${icon('list', '').replace('<svg', '<svg width="16" height="16"')}</button></div>
      </div>
      <div class="chips" id="lib-chips">
        <button class="chip ${!st.platform ? 'on' : ''}" data-plat="">All</button>
        ${platList.map((p) => `<button class="chip ${st.platform === p ? 'on' : ''}" data-plat="${esc(p)}">${platDot(p)}${esc(plat(p).label)}</button>`).join('')}
        <span style="width:1px;background:var(--line);flex:none"></span>
        ${Object.entries(STATUSES).filter(([k]) => k !== 'unset').map(([k, v]) => `<button class="chip ${st.status === k ? 'on' : ''}" data-status="${k}">${v.label}</button>`).join('')}
        <button class="chip ${st.played === 'false' ? 'on' : ''}" data-played="false">Never played</button>
        <button class="chip ${st.hidden === 'only' ? 'on' : ''}" data-hidden="only">${icon('eyeoff', '').replace('<svg', '<svg width="14" height="14"')}Hidden</button>
      </div>
    </div>
    <div id="lib-items"></div>
    <div id="lib-more" style="height:40px"></div>
    <button class="fab" id="fab-add" aria-label="Add game">${icon('plus')}</button>`;

  let items = []; let shown = 0; const PAGE = 90;
  const box = $('#lib-items');
  const draw = (reset) => {
    if (reset) { shown = 0; box.innerHTML = st.view === 'grid' ? '<div class="lib-grid"></div>' : '<div class="card pad-0 lib-list"></div>'; }
    const host = box.firstElementChild;
    const next = items.slice(shown, shown + PAGE);
    const maxMin = Math.max(1, ...items.map((g) => g.minutes));
    host.insertAdjacentHTML('beforeend', next.map((g) => st.view === 'grid'
      ? `<a class="tile" href="/game/${g.id}" data-link><div style="position:relative">${cover(g)}<div class="flags">${g.favorite ? `<span class="badge">♥</span>` : '<span></span>'}${g.status !== 'unset' ? `<span class="badge">${STATUSES[g.status]?.label || g.status}</span>` : ''}</div>${g.minutes ? `<div class="bar"><i style="width:${Math.max(3, Math.sqrt(g.minutes / maxMin) * 100)}%"></i></div>` : ''}</div>
          <div class="t">${esc(g.title)}</div><div class="m">${g.platforms.filter((p) => p !== 'manual' || g.platforms.length === 1).map(platDot).join('')}<span>${g.minutes ? fmtMin(g.minutes, { short: g.minutes >= 600 }) : 'Unplayed'}</span>${g.entry_count > 1 ? `<span class="dim">· ${g.entry_count}×</span>` : ''}</div></a>`
      : `<a class="li" href="/game/${g.id}" data-link>${cover(g)}<div class="grow"><div class="ellipsis" style="font-weight:620">${esc(g.title)}</div><div class="small muted row" style="gap:6px">${g.platforms.map(platDot).join('')}${g.last_played_at ? `Played ${ago(g.last_played_at)}` : 'Never played'}${g.status !== 'unset' ? ` · ${STATUSES[g.status]?.label}` : ''}</div></div><div class="amt" style="font-weight:700">${fmtMin(g.minutes, { short: g.minutes >= 600 })}</div></a>`).join(''));
    shown += next.length;
  };
  const load = async () => {
    const p = new URLSearchParams({ limit: '5000', sort: st.sort });
    if (st.q) p.set('q', st.q);
    if (st.platform) p.set('platform', st.platform);
    if (st.status) p.set('status', st.status);
    if (st.played) p.set('played', st.played);
    if (st.hidden) p.set('hidden', st.hidden);
    const r = await api(`/games?${p}`);
    if (stale()) return;
    items = r.items;
    const total = items.reduce((a, g) => a + g.minutes, 0);
    $('#lib-count').textContent = `${r.total.toLocaleString()} game${r.total === 1 ? '' : 's'} · ${fmtHours(total)}h total`;
    if (!items.length) {
      box.innerHTML = platforms.games ? emptyState('search', 'No matches', 'Try a different search or filter.') : emptyState('library', 'Your library is empty', 'Connect an account to import your games, or add one manually.', `<a class="btn primary" href="/accounts?add=1" data-link>${icon('plus')}Connect an account</a>`);
      return;
    }
    draw(true);
  };
  const sync = () => {
    const p = new URLSearchParams();
    for (const k of ['q', 'platform', 'status', 'played', 'hidden']) if (st[k]) p.set(k, st[k]);
    if (st.sort !== (state.settings?.default_library_sort || 'recent')) p.set('sort', st.sort);
    history.replaceState({}, '', `/library${p.toString() ? `?${p}` : ''}`);
    try { localStorage.setItem('pt-lib', JSON.stringify({ sort: st.sort, view: st.view })); } catch { /* ignore */ }
    load();
  };
  let t;
  $('#lib-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value.trim(); sync(); }, 180); });
  $('#lib-sort').addEventListener('change', (e) => { st.sort = e.target.value; sync(); });
  $$('[data-view]', view).forEach((b) => b.addEventListener('click', () => { st.view = b.dataset.view; $$('[data-view]', view).forEach((x) => x.classList.toggle('on', x === b)); sync(); }));
  $('#lib-chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    if ('plat' in c.dataset) { st.platform = c.dataset.plat; $$('[data-plat]', view).forEach((x) => x.classList.toggle('on', x === c)); }
    if (c.dataset.status) { st.status = st.status === c.dataset.status ? '' : c.dataset.status; $$('[data-status]', view).forEach((x) => x.classList.toggle('on', x.dataset.status === st.status)); }
    if (c.dataset.played) { st.played = st.played ? '' : 'false'; c.classList.toggle('on', !!st.played); }
    if (c.dataset.hidden) { st.hidden = st.hidden ? '' : 'only'; c.classList.toggle('on', !!st.hidden); }
    sync();
  });
  const addGame = () => modal({
    title: 'Add a game',
    body: `<form class="stack" id="ag"><div class="field"><label>Title</label><input class="input" name="title" required placeholder="The Legend of Zelda: Tears of the Kingdom"></div>
      <div class="field"><label>Cover image URL <span class="dim">(optional)</span></label><input class="input" name="cover_url" placeholder="https://…"></div>
      <div class="field"><label>Status</label><select class="input" name="status">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></div>
      <p class="small muted" style="margin:0">Manual games are perfect for Switch, retro or anything without an API. Log sessions on the game page.</p></form>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="ag-save">Add game</button>',
    onMount(el, close) {
      el.querySelector('#ag-save').addEventListener('click', async () => {
        const f = el.querySelector('#ag');
        if (!f.title.value.trim()) return;
        try { const g = await api('/games', { method: 'POST', body: { title: f.title.value, cover_url: f.cover_url.value, status: f.status.value } }); close(); navigate(`/game/${g.id}`); } catch (e) { fail(e); }
      });
    },
  });
  $('#lib-add').addEventListener('click', addGame);
  $('#fab-add').addEventListener('click', addGame);
  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting && shown < items.length) draw(false); }, { rootMargin: '600px' });
  io.observe($('#lib-more'));
  await load();
}

// =====================================================================
// Game detail
// =====================================================================
async function game(view, id, stale) {
  const g = await api(`/games/${id}`);
  if (stale()) return;
  const s = g.summary;
  const trackedPct = s.total_minutes ? (s.tracked_minutes / s.total_minutes) * 100 : 0;
  const rating = g.rating || 0;
  const hasSeries = g.series.some((x) => x.minutes > 0);
  view.innerHTML = `
    <a href="/library" data-link class="btn ghost sm" style="margin:-4px 0 10px -6px" onclick="if(history.length>1){event.preventDefault();event.stopPropagation();history.back()}">${icon('back')}Back</a>
    <div class="hero fade-in">
      ${g.cover_url ? `<div class="bg" style="background-image:url('${esc(g.cover_url)}')"></div>` : ''}
      <div class="in">
        ${cover(g)}
        <div class="grow">
          <div class="row wrap" style="margin-bottom:8px">${g.platforms.map(platTag).join('')}</div>
          <h1>${esc(g.title)}</h1>
          <div class="row wrap" style="margin-top:12px;gap:18px">
            <div><div class="big">${fmtMin(s.total_minutes, { short: s.total_minutes >= 600 })}</div><div class="small muted">lifetime</div></div>
            <div class="desk-only"><div style="font-size:20px;font-weight:750">${s.sessions}</div><div class="small muted">sessions</div></div>
            <div class="desk-only"><div style="font-size:20px;font-weight:750">${g.last_played_at ? ago(g.last_played_at) : '—'}</div><div class="small muted">last played</div></div>
          </div>
        </div>
      </div>
    </div>
    <div class="grid grid-main">
      <div class="stack">
        <div class="card">
          <div class="row wrap between" style="margin-bottom:14px">
            <div class="seg" id="g-status">${Object.entries(STATUSES).map(([k, v]) => `<button data-st="${k}" class="${g.status === k ? 'on' : ''}">${k === 'unset' ? '—' : v.label}</button>`).join('')}</div>
            <div class="row">
              <div class="stars" id="g-stars">${[1, 2, 3, 4, 5].map((i) => `<button data-r="${i * 2}" class="${rating >= i * 2 ? 'on' : ''}" aria-label="${i} stars">${icon('star')}</button>`).join('')}</div>
              <button class="btn icon ghost" id="g-fav" aria-label="Favorite" style="color:${g.favorite ? '#f472b6' : 'inherit'}">${icon('heart').replace('fill="none"', g.favorite ? 'fill="currentColor"' : 'fill="none"')}</button>
            </div>
          </div>
          <div class="kpis k4">
            ${kpi('Tracked', fmtMin(s.tracked_minutes), 'since tracking began')}
            ${kpi('Avg session', fmtMin(s.avg_session_minutes), `${s.sessions} sessions`)}
            ${kpi('Longest', fmtMin(s.longest_session_minutes), '')}
            ${kpi('First tracked', s.first_tracked_at ? fmtDate(s.first_tracked_at) : '—', s.tracking_since ? `owned since ${fmtDate(s.tracking_since)}` : '')}
          </div>
          <div style="margin-top:14px">
            <div class="split-bar"><i style="width:${trackedPct}%;background:var(--accent)"></i><i style="width:${100 - trackedPct}%;background:var(--line)"></i></div>
            <div class="legend"><span><i class="dot" style="background:var(--accent)"></i>Tracked sessions ${fmtMin(s.tracked_minutes)}</span><span><i class="dot" style="background:var(--line)"></i>Before tracking ${fmtMin(s.baseline_minutes)}</span></div>
          </div>
        </div>
        ${hasSeries ? `<div class="card"><div class="card-h"><h2>Playtime by month</h2></div>${barChart(g.series.slice(-24).map((x) => ({ label: seriesLabel(x.key, 'month'), value: x.minutes, tip: seriesTip(x.key, 'month', x.minutes) })), { height: 180 })}</div>` : ''}
        <div class="card"><div class="card-h"><h2>Sessions</h2><button class="btn sm" id="g-log">${icon('plus')}Log session</button></div>
          <div class="list" id="g-sessions">${g.sessions.length ? groupByDay(g.sessions.filter((x) => x.kind === 'play')).map((grp, i) => (i === 25 ? '<button class="btn sm" id="g-more" style="margin:12px auto">Show all sessions</button><div id="g-rest" class="hide">' : '') + `<div class="day-h"><span>${dayLabel(grp.day)}</span><span>${fmtMin(grp.minutes)}</span></div>${grp.items.map((x) => sessionItem(x, { showGame: false })).join('')}`).join('') + (groupByDay(g.sessions.filter((x) => x.kind === 'play')).length > 25 ? '</div>' : '') : '<p class="muted">No sessions yet.</p>'}
          ${g.sessions.filter((x) => x.kind === 'baseline').map((x) => `<div class="item"><span class="dot" style="background:var(--line);width:10px;height:10px"></span><div class="grow"><div class="sub"><b style="color:var(--text)">${esc(plat(x.platform).label)}</b> ${esc(x.note || 'History')} · ${fmtDate(x.window_end)}</div></div><div class="amt muted">${fmtMin(x.minutes)}</div><button class="btn ghost sm icon" data-edit-session="${x.id}">${icon('edit')}</button></div>`).join('')}
          </div>
        </div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-h"><h2>Platforms & accounts</h2><button class="btn sm ghost" id="g-merge">${icon('merge')}Merge</button></div>
          <div class="list">${g.entries.map((e) => `<div class="item" style="${e.excluded ? 'opacity:.55' : ''}">
              ${e.icon_url ? `<img src="${esc(e.icon_url)}" width="32" height="32" style="border-radius:8px" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span style="width:32px;height:32px;border-radius:8px;display:grid;place-items:center;background:${plat(e.platform).hex};color:#fff;font-weight:800">${plat(e.platform).short}</span>`}
              <div class="grow"><div class="ttl ellipsis">${esc(e.account_name || plat(e.platform).label)}</div>
                <div class="sub">${platDot(e.platform)}${esc(e.title !== g.title ? e.title : plat(e.platform).label)}${e.excluded ? ' · <b>excluded</b>' : ''}</div>
                <div class="sub">${e.last_played_at ? `Played ${ago(e.last_played_at)}` : ''}${e.meta?.deck ? ` · Deck ${fmtMin(e.meta.deck)}` : ''}</div></div>
              <div class="amt">${fmtMin(e.playtime_min)}</div>
              <button class="btn ghost sm icon" data-entry-menu="${e.id}" aria-label="Entry options">${icon('more')}</button>
            </div>`).join('')}</div>
          ${g.entries.length > 1 ? '<p class="small muted" style="margin:8px 0 0">Owned on several platforms — totals are summed. Exclude an entry if two platforms report the same playtime.</p>' : ''}
        </div>
        <div class="card"><div class="card-h"><h2>Notes</h2><span class="tiny muted" id="g-notes-st"></span></div>
          <textarea class="input" id="g-notes" placeholder="Thoughts, progress, where you left off…">${esc(g.notes || '')}</textarea></div>
        <div class="card"><div class="card-h"><h2>Details</h2></div>
          <div class="setting"><div><div class="t">Hide from library</div><div class="d">Still counts toward stats</div></div><label class="switch"><input type="checkbox" id="g-hidden" ${g.hidden ? 'checked' : ''}><span></span></label></div>
          <div class="setting"><div><div class="t">Block auto-merge</div><div class="d">New entries with this title won’t be grouped here</div></div><label class="switch"><input type="checkbox" id="g-lock" ${g.merge_locked ? 'checked' : ''}><span></span></label></div>
          <div class="row wrap" style="margin-top:10px"><button class="btn sm" id="g-edit">${icon('edit')}Edit title & cover</button><button class="btn sm danger" id="g-del">${icon('trash')}Delete</button></div>
        </div>
      </div>
    </div>`;
  bindTips(view);
  bindSessionEdits(view);
  const patch = async (body, msg) => { try { await api(`/games/${id}`, { method: 'PATCH', body }); if (msg) toast(msg); } catch (e) { fail(e); } };
  $('#g-status').addEventListener('click', async (e) => { const b = e.target.closest('[data-st]'); if (!b) return; $$('#g-status button').forEach((x) => x.classList.toggle('on', x === b)); await patch({ status: b.dataset.st }); });
  $('#g-stars').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-r]'); if (!b) return;
    const r = Number(b.dataset.r) === (g.rating || 0) ? null : Number(b.dataset.r);
    g.rating = r;
    $$('#g-stars button').forEach((x) => x.classList.toggle('on', r && Number(x.dataset.r) <= r));
    await patch({ rating: r });
  });
  $('#g-fav').addEventListener('click', async () => { g.favorite = !g.favorite; await patch({ favorite: g.favorite }, g.favorite ? 'Added to favorites' : 'Removed from favorites'); rerender(); });
  $('#g-hidden').addEventListener('change', (e) => patch({ hidden: e.target.checked }, e.target.checked ? 'Hidden from library' : 'Visible in library'));
  $('#g-lock').addEventListener('change', (e) => patch({ merge_locked: e.target.checked }));
  let nt;
  $('#g-notes').addEventListener('input', (e) => { $('#g-notes-st').textContent = 'Saving…'; clearTimeout(nt); nt = setTimeout(async () => { await patch({ notes: e.target.value }); $('#g-notes-st').textContent = 'Saved'; }, 600); });
  $('#g-log').addEventListener('click', () => logSessionModal(g));
  $('#g-more')?.addEventListener('click', (e) => { e.target.remove(); $('#g-rest').classList.remove('hide'); });
  $('#g-edit').addEventListener('click', () => modal({
    title: 'Edit game',
    body: `<form class="stack" id="ge"><div class="field"><label>Title</label><input class="input" name="title" value="${esc(g.title)}"></div>
      <div class="field"><label>Cover image URL</label><input class="input" name="cover_url" value="${esc(g.cover_url || '')}"></div>
      ${g.entries.filter((e) => e.cover_url && e.cover_url !== g.cover_url).length ? `<div class="field"><label>Use a platform cover</label><div class="row wrap">${g.entries.filter((e) => e.cover_url).map((e) => `<button type="button" class="btn sm" data-cov="${esc(e.cover_url)}">${platDot(e.platform)}${esc(plat(e.platform).label)}</button>`).join('')}</div></div>` : ''}</form>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="ge-save">Save</button>',
    onMount(el, close) {
      el.querySelectorAll('[data-cov]').forEach((b) => b.addEventListener('click', () => { el.querySelector('[name=cover_url]').value = b.dataset.cov; }));
      el.querySelector('#ge-save').addEventListener('click', async () => { const f = el.querySelector('#ge'); await patch({ title: f.title.value, cover_url: f.cover_url.value }, 'Saved'); close(); rerender(); });
    },
  }));
  $('#g-del').addEventListener('click', async () => {
    const synced = g.entries.some((e) => e.account_id);
    if (!(await confirmBox(synced ? 'This game comes from a synced account and will come back on the next sync. Consider hiding it instead. Delete anyway?' : 'Delete this game and all of its sessions?', { ok: 'Delete', danger: true }))) return;
    try { await api(`/games/${id}${synced ? '?force=true' : ''}`, { method: 'DELETE' }); toast('Deleted'); navigate('/library', { replace: true }); } catch (e) { fail(e); }
  });
  $('#g-merge').addEventListener('click', () => mergeModal(g));
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-entry-menu]');
    if (!b) return;
    const en = g.entries.find((x) => x.id === Number(b.dataset.entryMenu));
    modal({
      title: esc(en.account_name || plat(en.platform).label),
      body: `<div class="stack"><div class="small muted">${esc(en.title)} · ${esc(en.platform)} id <span class="mono">${esc(en.ext_id)}</span><br>First seen ${fmtDate(en.first_seen_at)} · last synced ${ago(en.last_synced_at)}</div>
        <div class="setting" style="border:0;padding:0"><div><div class="t">Exclude from totals</div><div class="d">Use when this entry duplicates playtime already counted on another platform.</div></div><label class="switch"><input type="checkbox" id="en-ex" ${en.excluded ? 'checked' : ''}><span></span></label></div>
        ${g.entries.length > 1 ? `<button class="btn" id="en-split">${icon('split')}Split into its own game</button>` : ''}
        ${en.meta?.store ? `<a class="btn ghost" href="${esc(en.meta.store)}" target="_blank" rel="noopener">Open store page ↗</a>` : ''}</div>`,
      onMount(el, close) {
        el.querySelector('#en-ex').addEventListener('change', async (ev) => { await api(`/entries/${en.id}`, { method: 'PATCH', body: { excluded: ev.target.checked } }); close(); rerender(); });
        el.querySelector('#en-split')?.addEventListener('click', async () => { const ng = await api(`/entries/${en.id}/split`, { method: 'POST' }); close(); toast('Split into a separate game'); navigate(`/game/${ng.id}`); });
      },
    });
  });
}

function mergeModal(g) {
  modal({
    title: `Merge into “${esc(g.title)}”`,
    body: `<p class="small muted" style="margin-top:0">Pick games that are really the same title (e.g. PS4 + PS5 versions, Steam + Game Pass). Their platforms and sessions move here.</p>
      <div class="search">${icon('search')}<input class="input" id="mq" placeholder="Search games" value="${esc(g.title.split(/[:\-–]/)[0].trim())}"></div><div class="list" id="mr" style="margin-top:10px"></div>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="m-go" disabled>Merge</button>',
    onMount(el, close) {
      const picked = new Set();
      const search = async () => {
        const r = await api(`/games?q=${encodeURIComponent(el.querySelector('#mq').value)}&limit=30&hidden=all`);
        el.querySelector('#mr').innerHTML = r.items.filter((x) => x.id !== g.id).map((x) => `<label class="item" style="cursor:pointer"><input type="checkbox" class="check" value="${x.id}" ${picked.has(x.id) ? 'checked' : ''}>${cover(x)}<div class="grow"><div class="ttl ellipsis">${esc(x.title)}</div><div class="sub">${x.platforms.map(platDot).join('')} ${fmtMin(x.minutes)}</div></div></label>`).join('') || '<p class="muted">No other games match.</p>';
      };
      let t;
      el.querySelector('#mq').addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 180); });
      el.querySelector('#mr').addEventListener('change', (e) => { const v = Number(e.target.value); e.target.checked ? picked.add(v) : picked.delete(v); el.querySelector('#m-go').disabled = !picked.size; el.querySelector('#m-go').textContent = picked.size ? `Merge ${picked.size}` : 'Merge'; });
      el.querySelector('#m-go').addEventListener('click', async () => { try { await api(`/games/${g.id}/merge`, { method: 'POST', body: { source_ids: [...picked] } }); close(); toast('Merged'); rerender(); } catch (e) { fail(e); } });
      search();
    },
  });
}

// =====================================================================
// Sessions
// =====================================================================
async function sessions(view, stale) {
  const f = { platform: '', source: '', q: '', kind: 'play' };
  let offset = 0; let all = []; let total = 0; let totalMin = 0; let selecting = false; const sel = new Set();
  const lt = await api('/stats/lifetime');
  if (stale()) return;
  view.innerHTML = `
    <div class="page-h"><div><h1>Sessions</h1><p id="s-count">&nbsp;</p></div>
      <div class="row"><button class="btn" id="s-select">${icon('check')}Select</button><button class="btn primary desk-only" id="s-log">${icon('plus')}Log session</button></div></div>
    <div class="toolbar">
      <div class="row" style="margin-bottom:10px"><div class="search grow">${icon('search')}<input class="input" id="s-q" type="search" placeholder="Filter by game"></div></div>
      <div class="chips" id="s-chips">
        <button class="chip on" data-p="">All</button>
        ${lt.platforms.map((p) => `<button class="chip" data-p="${esc(p.platform)}">${platDot(p.platform)}${esc(plat(p.platform).label)}</button>`).join('')}
        <span style="width:1px;background:var(--line);flex:none"></span>
        <button class="chip" data-src="manual">Manual</button><button class="chip" data-src="sync">Synced</button><button class="chip" data-src="import">Imported</button>
        <button class="chip" data-kind="baseline">History / baseline</button>
      </div>
    </div>
    <div id="s-bulk" class="card hide" style="position:sticky;top:70px;z-index:11;margin-bottom:12px;padding:10px 14px"><div class="row wrap"><b id="s-bulk-n">0 selected</b><span class="grow"></span>
      <button class="btn sm" data-bulk="baseline">Move to history</button><button class="btn sm" data-bulk="play">Count in stats</button><button class="btn sm danger" data-bulk="delete">${icon('trash')}Delete</button><button class="btn sm ghost" id="s-bulk-x">Done</button></div></div>
    <div class="card" style="padding-top:0"><div class="list" id="s-list"></div><div id="s-more" class="center" style="padding:14px"></div></div>
    <button class="fab" id="fab-log" aria-label="Log session">${icon('plus')}</button>`;
  const list = $('#s-list');
  const draw = () => {
    list.innerHTML = all.length ? groupByDay(all).map((grp) => `<div class="day-h"><span>${dayLabel(grp.day)}</span><span>${fmtMin(grp.minutes)}</span></div>${grp.items.map((s) => sessionItem(s, { selectable: selecting, selected: sel.has(s.id) })).join('')}`).join('')
      : emptyState('sessions', 'No sessions', f.kind === 'baseline' ? 'No imported history.' : 'Sessions appear when a sync detects new playtime, or when you log one.');
    $('#s-more').innerHTML = all.length < total ? `<button class="btn" id="s-load">Load more</button>` : (all.length ? '<span class="tiny dim">That’s everything</span>' : '');
    $('#s-load')?.addEventListener('click', () => load(false));
    $('#s-count').textContent = `${total.toLocaleString()} session${total === 1 ? '' : 's'} · ${fmtMin(totalMin, { short: true })}`;
    $('#s-bulk-n').textContent = `${sel.size} selected`;
  };
  const load = async (reset = true) => {
    if (reset) { offset = 0; all = []; }
    const p = new URLSearchParams({ limit: '150', offset: String(offset), kind: f.kind });
    if (f.platform) p.set('platform', f.platform);
    if (f.source) p.set('source', f.source);
    if (f.q) p.set('q', f.q);
    const r = await api(`/sessions?${p}`);
    all = all.concat(r.items); total = r.total; totalMin = r.total_minutes; offset += r.items.length;
    draw();
  };
  let t;
  $('#s-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 200); });
  $('#s-chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    if ('p' in c.dataset) { f.platform = c.dataset.p; $$('[data-p]', view).forEach((x) => x.classList.toggle('on', x === c)); }
    if (c.dataset.src) { f.source = f.source === c.dataset.src ? '' : c.dataset.src; $$('[data-src]', view).forEach((x) => x.classList.toggle('on', x.dataset.src === f.source)); }
    if (c.dataset.kind) { f.kind = f.kind === 'baseline' ? 'play' : 'baseline'; c.classList.toggle('on', f.kind === 'baseline'); }
    load();
  });
  const toggleSelect = (on) => { selecting = on; sel.clear(); $('#s-bulk').classList.toggle('hide', !on); draw(); };
  $('#s-select').addEventListener('click', () => toggleSelect(!selecting));
  $('#s-bulk-x').addEventListener('click', () => toggleSelect(false));
  list.addEventListener('change', (e) => { const id = Number(e.target.dataset.sel); if (!id) return; e.target.checked ? sel.add(id) : sel.delete(id); e.target.closest('.item').classList.toggle('sel', e.target.checked); $('#s-bulk-n').textContent = `${sel.size} selected`; });
  $('#s-bulk').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-bulk]'); if (!b || !sel.size) return;
    if (b.dataset.bulk === 'delete' && !(await confirmBox(`Delete ${sel.size} session(s)? Synced sessions are moved to history instead, since their playtime comes from the platform.`, { ok: 'Delete', danger: true }))) return;
    try { await api('/sessions/bulk', { method: 'POST', body: { ids: [...sel], action: b.dataset.bulk } }); toast('Updated'); toggleSelect(false); load(); } catch (err) { fail(err); }
  });
  bindSessionEdits(view, () => load());
  $('#s-log').addEventListener('click', () => logSessionModal(null, () => load()));
  $('#fab-log').addEventListener('click', () => logSessionModal(null, () => load()));
  await load();
}

// =====================================================================
// Stats
// =====================================================================
async function stats(view, stale) {
  const q = new URLSearchParams(location.search);
  let range = q.get('range') || '30d';
  let platform = q.get('platform') || '';
  const [years, lt] = await Promise.all([api('/stats/years'), api('/stats/lifetime')]);
  if (stale()) return;
  let heatYear = years[0];
  view.innerHTML = `
    <div class="page-h"><div><h1>Stats</h1><p>Lifetime ${fmtHours(lt.total_minutes)}h · ${fmtHours(lt.tracked_minutes)}h tracked as sessions · ${fmtHours(lt.baseline_minutes)}h imported history</p></div>
      <a class="btn" href="/wrapped/${years[0]}" data-link>${icon('gift')}${years[0]} in review</a></div>
    <div class="toolbar"><div class="row wrap">
      <div class="seg" id="st-range">${[['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['365d', '12 months'], ...years.map((y) => [`year:${y}`, String(y)]), ['all', 'All time']].map(([v, l]) => `<button data-r="${v}" class="${range === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <select class="input" id="st-plat" style="width:auto"><option value="">All platforms</option>${lt.platforms.map((p) => `<option value="${esc(p.platform)}" ${platform === p.platform ? 'selected' : ''}>${esc(plat(p.platform).label)}</option>`).join('')}</select>
    </div></div>
    <div id="st-body"></div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Activity</h2><div class="seg" id="hm-year">${years.map((y) => `<button data-y="${y}" class="${y === heatYear ? 'on' : ''}">${y}</button>`).join('')}</div></div><div id="hm"></div></div>`;
  const body = $('#st-body');
  const load = async () => {
    const p = new URLSearchParams({ range });
    if (platform) p.set('platform', platform);
    history.replaceState({}, '', `/stats?${p}`);
    const s = await api(`/stats?${p}`);
    const maxWd = Math.max(1, ...s.weekday);
    const order = [1, 2, 3, 4, 5, 6, 0];
    const hasHours = s.hours.some((h) => h > 0);
    body.innerHTML = `
      <div class="kpis fade-in">
        ${kpi('Played', hoursVal(s.total_minutes), s.range.label, sparkline(s.series.map((x) => x.minutes)), 'feature')}
        ${kpi('Sessions', s.sessions, `avg ${fmtMin(s.avg_session_minutes)}`)}
        ${kpi('Games', s.games_played, `${s.days_played} days played`)}
        ${kpi('Daily avg', fmtMin(s.avg_per_day_minutes), s.busiest_day ? `best ${fmtDate(new Date(`${s.busiest_day.day}T12:00`).getTime())} · ${fmtMin(s.busiest_day.minutes)}` : '')}
        ${kpi('Streak', `${s.streaks.current}<small>d</small>`, `longest ${s.streaks.longest} days`)}
      </div>
      <div class="card" style="margin-top:16px"><div class="card-h"><h2>Playtime per ${s.range.group}</h2></div>${barChart(stackedSeries(s), { height: 230 })}${platformLegend(s.platforms)}</div>
      <div class="grid grid-3" style="margin-top:16px">
        <div class="card"><div class="card-h"><h2>Top games</h2></div>${s.top_games.length ? topList(s.top_games, { coverFn: (g) => cover(g), limit: 10 }) : '<p class="muted">No play in this range.</p>'}</div>
        <div class="card"><div class="card-h"><h2>Platforms</h2></div>
          ${s.platforms.length ? `<div class="donut-wrap">${donut(s.platforms.map((p) => ({ label: plat(p.platform).label, value: p.minutes, color: plat(p.platform).color })), { label: `${fmtHours(s.total_minutes)}h`, sub: 'played' })}
          <div class="col" style="gap:8px;min-width:0">${s.platforms.map((p) => `<div class="row small"><span class="dot" style="background:${plat(p.platform).color}"></span><span class="grow ellipsis">${esc(plat(p.platform).label)}</span><b>${Math.round((p.minutes / Math.max(1, s.total_minutes)) * 100)}%</b></div>`).join('')}</div></div>` : '<p class="muted">—</p>'}
          ${s.longest_session ? `<div style="margin-top:18px" class="small muted">Longest session</div><a href="/game/${s.longest_session.game_id}" data-link><b>${fmtMin(s.longest_session.minutes)}</b> · ${esc(s.longest_session.title)}</a>` : ''}
        </div>
        <div class="card"><div class="card-h"><h2>By weekday</h2></div>
          ${order.map((d) => `<div class="row small" style="margin:7px 0"><span style="width:34px" class="muted">${WD[d]}</span><div class="grow" style="height:8px;border-radius:9px;background:var(--bg2);overflow:hidden"><i style="display:block;height:100%;width:${(s.weekday[d] / maxWd) * 100}%;background:var(--accent2);border-radius:9px"></i></div><span style="width:56px;text-align:right">${fmtMin(s.weekday[d], { short: true })}</span></div>`).join('')}
          ${hasHours ? `<div class="card-h" style="margin-top:18px;margin-bottom:6px"><h3>Time of day</h3><span class="tiny dim">exact sessions only</span></div>${barChart(s.hours.map((m, h) => ({ label: h % 6 === 0 ? `${h}h` : '', value: m, tip: `${h}:00 – ${h + 1}:00: ${fmtMin(m)}` })), { height: 150, width: 340, color: 'var(--accent2)', labelEvery: 1 })}` : '<p class="tiny dim" style="margin-top:14px">Sync more often (or log sessions manually) to unlock time-of-day stats.</p>'}
        </div>
      </div>`;
    bindTips(body);
  };
  const loadHeat = async () => {
    const h = await api(`/stats/heatmap?year=${heatYear}`);
    $('#hm').innerHTML = heatmap(heatYear, h.days, { weekStartsOn: state.settings?.week_starts_on ?? 1 });
    bindTips($('#hm'));
  };
  $('#st-range').addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (!b) return; range = b.dataset.r; $$('#st-range button').forEach((x) => x.classList.toggle('on', x === b)); load(); });
  $('#st-plat').addEventListener('change', (e) => { platform = e.target.value; load(); });
  $('#hm-year').addEventListener('click', (e) => { const b = e.target.closest('[data-y]'); if (!b) return; heatYear = Number(b.dataset.y); $$('#hm-year button').forEach((x) => x.classList.toggle('on', x === b)); loadHeat(); });
  await Promise.all([load(), loadHeat()]);
}

async function wrapped(view, year, stale) {
  const w = await api(`/stats/year/${year}`);
  if (stale()) return;
  const top = w.top_games[0];
  const maxM = Math.max(1, ...w.months.map((m) => m.minutes));
  view.innerHTML = `
    <div class="page-h"><div><h1>${w.year} in review</h1><p>Your year in games, from tracked sessions.</p></div><a class="btn ghost" href="/stats" data-link>${icon('back')}Stats</a></div>
    ${!w.total_minutes ? emptyState('gift', 'Nothing tracked yet', `No sessions were tracked in ${w.year}. Imported history doesn’t count toward a year in review.`) : `
    <div class="wrapped fade-in">
      <div class="wcard g1"><div class="muted">You played</div><div class="big">${fmtHours(w.total_minutes)} hours</div><div class="muted">across ${w.sessions} sessions on ${w.days_played} days</div></div>
      ${top ? `<a class="wcard g2" href="/game/${top.game_id}" data-link style="display:flex;gap:16px;align-items:center">${cover(top, '', 'width:90px;')}<div><div class="muted">Game of the year</div><div style="font-size:24px;font-weight:800;line-height:1.1;margin:6px 0">${esc(top.title)}</div><div class="muted">${fmtMin(top.minutes)} · ${top.sessions} sessions</div></div></a>` : ''}
      <div class="wcard g3"><div class="muted">Longest streak</div><div class="big">${w.longest_streak} days</div><div class="muted">${w.busiest_day ? `Biggest day: ${fmtDate(new Date(`${w.busiest_day.day}T12:00`).getTime(), { month: 'long', day: 'numeric' })} (${fmtMin(w.busiest_day.minutes)})` : ''}</div></div>
      <div class="wcard"><div class="muted">Games played</div><div class="big">${w.games_played}</div><div class="muted">${w.new_games} started fresh this year · ${w.completed} completed</div></div>
      <div class="wcard"><div class="muted">Best month</div><div class="big">${w.best_month ? w.best_month.month : '—'}</div><div class="muted">${w.best_month ? fmtMin(w.best_month.minutes) : ''}</div>
        <div class="row" style="align-items:flex-end;height:50px;gap:3px;margin-top:10px">${w.months.map((m) => `<div title="${m.month}: ${fmtMin(m.minutes)}" style="flex:1;height:${Math.max(4, (m.minutes / maxM) * 100)}%;background:${m.month === w.best_month?.month ? 'var(--accent)' : 'var(--line)'};border-radius:3px"></div>`).join('')}</div></div>
      <div class="wcard"><div class="muted">Favorite day</div><div class="big">${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][w.weekday.indexOf(Math.max(...w.weekday))]}</div><div class="muted">${w.longest_session ? `Longest session: ${fmtMin(w.longest_session.minutes)} of ${esc(w.longest_session.title)}` : ''}</div></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-h"><h2>Top 10</h2></div>${topList(w.top_games, { coverFn: (g) => cover(g), limit: 10 })}</div>
      <div class="card"><div class="card-h"><h2>New this year</h2></div><div class="list">${w.new_game_list.map((g) => `<a class="item" href="/game/${g.game_id}" data-link>${cover(g)}<div class="grow ttl ellipsis">${esc(g.title)}</div><span class="small muted">${fmtDate(g.first)}</span></a>`).join('') || '<p class="muted">—</p>'}</div></div>
    </div>`}`;
}

// =====================================================================
// Duplicates
// =====================================================================
async function duplicates(view, stale) {
  const d = await api('/duplicates');
  if (stale()) return;
  const gameCard = (g) => `<a class="row" href="/game/${g.id}" data-link style="min-width:0;flex:1">${cover(g, '', 'width:46px;')}<div style="min-width:0"><div class="ttl ellipsis" style="font-weight:650">${esc(g.title)}</div><div class="small muted row" style="gap:5px">${(g.platforms || []).map(platDot).join('')}${fmtMin(g.minutes)}</div></div></a>`;
  view.innerHTML = `
    <div class="page-h"><div><h1>Duplicates</h1><p>Keep one game per title and make sure nothing is counted twice.</p></div></div>
    <div class="stack">
      <div class="card"><div class="card-h"><h2>Possible double counting <span class="badge ${d.double_counted.length ? 'warn' : ''}">${d.double_counted.length}</span></h2></div>
        <p class="small muted" style="margin-top:-6px">The same game is counted from two sources that probably report the same playtime — e.g. an imported spreadsheet plus the live Steam account, or two accounts sharing a library.</p>
        <div class="list">${d.double_counted.map((x) => `<div class="item" style="flex-wrap:wrap">
          <a href="/game/${x.game.id}" data-link>${cover(x.game)}</a>
          <div class="grow"><a class="ttl" href="/game/${x.game.id}" data-link>${esc(x.game.title)}</a><div class="sub">${esc(x.reason)}</div>
            <div class="sub">${x.entries.map((e) => `${platDot(e.platform)}${esc(e.account_name || plat(e.platform).label)} ${fmtMin(e.playtime_min)}`).join(' &nbsp;·&nbsp; ')}</div></div>
          <div class="row"><button class="btn sm primary" data-exclude="${x.suggest_exclude}">Exclude ${esc((x.entries.find((e) => e.id === x.suggest_exclude)?.account_name) || plat(x.entries.find((e) => e.id === x.suggest_exclude)?.platform).label)}</button><button class="btn sm ghost" data-dismiss="${esc(x.key)}">Ignore</button></div></div>`).join('') || '<p class="muted">Nothing double counted. 🎉</p>'}</div>
      </div>
      <div class="card"><div class="card-h"><h2>Merge suggestions <span class="badge ${d.suggestions.length ? 'accent' : ''}">${d.suggestions.length}</span></h2>${d.suggestions.length > 1 ? '<button class="btn sm" id="merge-all">Merge all ≥ 95%</button>' : ''}</div>
        <p class="small muted" style="margin-top:-6px">Similar titles that weren’t grouped automatically (editions, subtitles, platform tags).</p>
        <div class="list">${d.suggestions.map((x) => `<div class="item" style="flex-wrap:wrap;gap:14px">
          ${gameCard(x.games[0])}<span class="badge">${Math.round(x.score * 100)}%</span>${gameCard(x.games[1])}
          <div class="row"><button class="btn sm primary" data-merge="${x.games[0].id}:${x.games[1].id}">${icon('merge')}Merge</button><button class="btn sm ghost" data-dismiss="${esc(x.key)}">Not the same</button></div></div>`).join('') || '<p class="muted">No suggestions.</p>'}</div>
      </div>
      <div class="card"><div class="card-h"><h2>Owned on multiple platforms <span class="badge">${d.cross_platform.length}</span></h2></div>
        <div class="list">${d.cross_platform.slice(0, 100).map((x) => `<a class="item" href="/game/${x.game.id}" data-link>${cover(x.game)}<div class="grow"><div class="ttl ellipsis">${esc(x.game.title)}</div><div class="sub">${x.entries.map((e) => `<span style="${e.excluded ? 'text-decoration:line-through;opacity:.6' : ''}">${platDot(e.platform)} ${esc(e.account_name || plat(e.platform).label)} ${fmtMin(e.playtime_min)}</span>`).join(' &nbsp;')}</div></div></a>`).join('') || '<p class="muted">No games are grouped across platforms yet.</p>'}</div>
      </div>
    </div>`;
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-merge],[data-dismiss],[data-exclude],#merge-all');
    if (!b) return;
    try {
      if (b.dataset.merge) {
        const [a, c] = b.dataset.merge.split(':').map(Number);
        const ga = d.suggestions.flatMap((x) => x.games).find((g) => g.id === a);
        const gc = d.suggestions.flatMap((x) => x.games).find((g) => g.id === c);
        const [target, src] = (gc.minutes > ga.minutes) ? [c, a] : [a, c];
        await api(`/games/${target}/merge`, { method: 'POST', body: { source_ids: [src] } });
        toast('Merged');
      } else if (b.dataset.dismiss) {
        await api('/duplicates/dismiss', { method: 'POST', body: { key: b.dataset.dismiss } });
      } else if (b.dataset.exclude) {
        await api(`/entries/${b.dataset.exclude}`, { method: 'PATCH', body: { excluded: true } });
        toast('Excluded from totals');
      } else if (b.id === 'merge-all') {
        const done = new Set();
        let n = 0;
        for (const x of d.suggestions.filter((s) => s.score >= 0.95)) {
          const [a, c] = x.games;
          if (done.has(a.id) || done.has(c.id)) continue;
          const [target, src] = c.minutes > a.minutes ? [c.id, a.id] : [a.id, c.id];
          await api(`/games/${target}/merge`, { method: 'POST', body: { source_ids: [src] } });
          done.add(src); n++;
        }
        toast(`Merged ${n} pair${n === 1 ? '' : 's'}`);
      }
      rerender();
    } catch (err) { fail(err); }
  });
}

// =====================================================================
// Accounts
// =====================================================================
const SCHED_MODES = [['daily', 'Daily'], ['days', 'Every X days'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['hours', 'Every X hours'], ['hourly', 'Hourly'], ['off', 'Manual only']];

function scheduleFields(s, prefix = '') {
  const mode = s.schedule_mode || 'daily';
  return `<div class="field"><label>Frequency</label><select class="input" name="${prefix}schedule_mode">${SCHED_MODES.map(([v, l]) => `<option value="${v}" ${mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="grid grid-2">
      <div class="field" data-when="days hours"><label>Every</label><input class="input" type="number" min="1" max="365" name="${prefix}schedule_every" value="${s.schedule_every ?? 2}"></div>
      <div class="field" data-when="weekly"><label>Weekday</label><select class="input" name="${prefix}schedule_weekday">${WD.map((d, i) => `<option value="${i}" ${Number(s.schedule_weekday) === i ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
      <div class="field" data-when="monthly"><label>Day of month</label><input class="input" type="number" min="1" max="28" name="${prefix}schedule_monthday" value="${s.schedule_monthday ?? 1}"></div>
      <div class="field" data-when="daily days weekly monthly"><label>Time</label><input class="input" type="time" name="${prefix}schedule_time" value="${esc(s.schedule_time || '04:00')}"></div>
    </div>`;
}

function bindScheduleFields(root, prefix = '') {
  const sel = root.querySelector(`[name=${prefix}schedule_mode]`);
  if (!sel) return;
  const upd = () => root.querySelectorAll('[data-when]').forEach((el) => { el.style.display = el.dataset.when.split(' ').includes(sel.value) ? '' : 'none'; });
  sel.addEventListener('change', upd); upd();
}

function readSchedule(root, prefix = '') {
  const v = (k) => root.querySelector(`[name=${prefix}${k}]`)?.value;
  return { schedule_mode: v('schedule_mode'), schedule_every: Number(v('schedule_every')), schedule_weekday: Number(v('schedule_weekday')), schedule_monthday: Number(v('schedule_monthday')), schedule_time: v('schedule_time') };
}

async function accountModal(platforms, existing = null) {
  const pick = (p) => {
    const info = platforms.find((x) => x.id === p);
    const a = existing || { config: {}, name: info.label, enabled: true, schedule: null };
    modal({
      title: existing ? `Edit ${esc(a.name)}` : `Connect ${esc(info.label)}`,
      body: `<form class="stack" id="acc-f" autocomplete="off">
        <p class="small muted" style="margin:0">${esc(info.notes)}</p>
        <div class="field"><label>Display name</label><input class="input" name="name" value="${esc(a.name)}"></div>
        ${info.fields.map((f) => `<div class="field"><label>${esc(f.label)}${f.required ? '' : ' <span class="dim">(optional)</span>'}</label>
          <input class="input" name="cfg_${f.key}" type="${f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}" value="${esc(a.config[f.key] ?? '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" spellcheck="false">
          ${f.help ? `<div class="help">${esc(f.help).replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')}</div>` : ''}</div>`).join('')}
        ${info.push ? `<div class="card small" style="padding:12px">Push totals with <code>POST /api/v1/accounts/${existing ? existing.id : ':id'}/report</code> — see the <a href="/api" data-link style="color:var(--accent)">API page</a>.</div>` : `
        <div class="setting" style="padding:0;border:0"><div><div class="t">Custom schedule</div><div class="d">Override the global sync schedule for this account</div></div><label class="switch"><input type="checkbox" id="acc-own" ${a.schedule ? 'checked' : ''}><span></span></label></div>
        <div id="acc-sched" class="stack ${a.schedule ? '' : 'hide'}">${scheduleFields(a.schedule || state.settings || {}, 'a_')}</div>`}
        <div id="acc-test-r" class="small"></div>
      </form>`,
      foot: `${existing ? `<button class="btn danger" id="acc-del">${icon('trash')}</button>` : ''}<span class="grow"></span>${info.push ? '' : '<button class="btn" id="acc-test">Test</button>'}<button class="btn primary" id="acc-save">${existing ? 'Save' : 'Connect & import'}</button>`,
      onMount(el, close) {
        bindScheduleFields(el, 'a_');
        el.querySelector('#acc-own')?.addEventListener('change', (e) => el.querySelector('#acc-sched').classList.toggle('hide', !e.target.checked));
        const collect = () => {
          const f = el.querySelector('#acc-f');
          const config = {};
          for (const fl of info.fields) config[fl.key] = f[`cfg_${fl.key}`].value.trim();
          const own = el.querySelector('#acc-own')?.checked;
          return { platform: p, name: f.name.value.trim() || info.label, config, schedule: own ? readSchedule(el, 'a_') : null };
        };
        el.querySelector('#acc-test')?.addEventListener('click', async (ev) => {
          const b = ev.currentTarget; b.disabled = true; b.textContent = 'Testing…';
          const out = el.querySelector('#acc-test-r');
          try {
            const body = collect();
            if (existing && Object.values(body.config).some((v) => String(v).startsWith('••'))) { out.innerHTML = '<span class="muted">Re-enter secrets to test, or just Save and Sync.</span>'; return; }
            const r = await api('/accounts/test', { method: 'POST', body });
            out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--good)"><b style="color:var(--good)">✓ Connected</b> — ${r.games} games, ${r.played} played, ${fmtHours(r.minutes)}h total.${r.sample?.length ? `<div class="muted">e.g. ${r.sample.map(esc).join(', ')}</div>` : ''}${r.warning ? `<div class="muted">${esc(r.warning)}</div>` : ''}</div>`;
          } catch (e) { out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--bad);color:var(--bad)">${esc(e.message)}</div>`; } finally { b.disabled = false; b.textContent = 'Test'; }
        });
        el.querySelector('#acc-save').addEventListener('click', async () => {
          const body = collect();
          try {
            if (existing) {
              await api(`/accounts/${existing.id}`, { method: 'PATCH', body });
              toast('Account saved');
            } else {
              await api('/accounts', { method: 'POST', body });
              toast(info.push ? 'Account created' : 'Connected — importing your library…');
              state.syncing = true;
              setTimeout(() => watchSync(), 1000);
            }
            close(); rerender();
          } catch (e) { fail(e); }
        });
        el.querySelector('#acc-del')?.addEventListener('click', async () => {
          if (!(await confirmBox(`Unlink ${esc(a.name)}? All games, snapshots and sessions from this account will be deleted.`, { ok: 'Unlink & delete', danger: true }))) return;
          try { await api(`/accounts/${existing.id}`, { method: 'DELETE' }); close(); toast('Account removed'); rerender(); } catch (e) { fail(e); }
        });
      },
    });
  };
  if (existing) return pick(existing.platform);
  modal({
    title: 'Connect an account',
    body: `<div class="plat-pick">${platforms.map((p) => `<button data-p="${p.id}"><span class="ic" style="background:${plat(p.id).hex}">${plat(p.id).short}</span><div><b>${esc(p.label)}</b><div class="tiny muted">${p.push ? 'Push via API' : 'Automatic sync'}</div></div></button>`).join('')}</div>
      <p class="small muted">Nintendo, Epic, GOG, emulators? Use a <b>Custom</b> account with the push API, or add games manually and log sessions.</p>`,
    onMount(el, close) { el.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { close(); pick(b.dataset.p); })); },
  });
}

async function accounts(view, stale) {
  const [accs, platforms, syncs] = await Promise.all([api('/accounts'), api('/platforms'), api('/syncs?limit=40')]);
  if (stale()) return;
  view.innerHTML = `
    <div class="page-h"><div><h1>Accounts</h1><p>Global schedule: ${esc(state.settings?.schedule_label || '')} · <a href="/settings" data-link style="color:var(--accent)">change</a></p></div>
      <div class="row"><button class="btn" data-action="sync-all">${icon('sync')}Sync all</button><button class="btn primary" id="acc-add">${icon('plus')}Connect</button></div></div>
    ${accs.length ? `<div class="grid grid-2">${accs.map((a) => `<div class="card acct">
      <div class="row"><span class="ic" style="background:${plat(a.platform).hex}">${plat(a.platform).short}</span>
        <div class="grow"><h2 class="ellipsis">${esc(a.name)}</h2><div class="small muted">${esc(plat(a.platform).label)} · ${a.push ? 'API push' : esc(a.schedule_label)}${a.schedule ? ' <span class="badge">custom</span>' : ''}</div></div>
        ${a.syncing ? '<span class="badge accent pulse">Syncing</span>' : a.last_status === 'error' ? '<span class="badge bad">Error</span>' : a.last_status === 'warning' ? '<span class="badge warn">Warning</span>' : !a.enabled ? '<span class="badge">Paused</span>' : a.last_sync_at ? '<span class="badge good">OK</span>' : '<span class="badge">New</span>'}</div>
      ${a.last_error ? `<div class="small" style="color:${a.last_status === 'error' ? 'var(--bad)' : 'var(--warn)'}">${esc(a.last_error)}</div>` : ''}
      <div class="meta"><div><b>${a.games ?? 0}</b><span>games</span></div><div><b>${fmtHours(a.minutes ?? 0)}h</b><span>lifetime</span></div><div><b>${a.last_sync_at ? ago(a.last_sync_at) : 'never'}</b><span>${a.push ? 'last report' : a.next_sync_at && a.enabled ? `next ${ago(a.next_sync_at)}` : 'last sync'}</span></div></div>
      <div class="row wrap">
        ${a.push ? '' : `<button class="btn sm" data-sync="${a.id}" ${a.syncing ? 'disabled' : ''}>${icon('sync')}Sync now</button>`}
        <button class="btn sm ghost" data-edit="${a.id}">${icon('edit')}Edit</button>
        <button class="btn sm ghost" data-toggle="${a.id}">${a.enabled ? 'Pause' : 'Resume'}</button>
        <a class="btn sm ghost" href="/library?platform=${a.platform}" data-link>Games</a>
      </div></div>`).join('')}</div>`
    : `<div class="card">${emptyState('accounts', 'No accounts yet', 'Connect Steam, Xbox or PlayStation. The first sync imports your library and existing playtime as history; later syncs turn new playtime into sessions.', `<button class="btn primary" id="acc-add2">${icon('plus')}Connect an account</button>`)}</div>`}
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Sync history</h2></div>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>When</th><th>Account</th><th>Result</th><th>Games</th><th>Sessions</th><th>Played</th><th>History</th></tr></thead><tbody>
      ${syncs.map((s) => `<tr><td class="nowrap">${fmtDate(s.started_at)} ${fmtTime(s.started_at)}<div class="tiny dim">${esc(s.trigger)}${s.initial ? ' · initial import' : ''}</div></td>
        <td class="nowrap">${platDot(s.platform || 'custom')} ${esc(s.account_name || '—')}</td>
        <td>${s.status === 'ok' ? '<span class="badge good">ok</span>' : s.status === 'running' ? '<span class="badge accent pulse">running</span>' : `<span class="badge ${s.status === 'warning' ? 'warn' : 'bad'}">${esc(s.status)}</span>`}${s.error ? `<div class="tiny muted" style="max-width:260px">${esc(s.error)}</div>` : ''}</td>
        <td>${s.games_seen}${s.games_new ? ` <span class="tiny muted">(+${s.games_new})</span>` : ''}</td><td>${s.sessions_created ? `<a href="/sessions" data-link style="color:var(--accent)">${s.sessions_created}</a>` : 0}</td><td>${fmtMin(s.minutes_added)}</td><td class="muted">${s.baseline_minutes ? fmtMin(s.baseline_minutes, { short: true }) : '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No syncs yet.</td></tr>'}
      </tbody></table></div></div>`;
  $('#acc-add')?.addEventListener('click', () => accountModal(platforms));
  $('#acc-add2')?.addEventListener('click', () => accountModal(platforms));
  if (new URLSearchParams(location.search).get('add')) { history.replaceState({}, '', '/accounts'); accountModal(platforms); }
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sync],[data-edit],[data-toggle]');
    if (!b) return;
    try {
      if (b.dataset.sync) { await api(`/accounts/${b.dataset.sync}/sync`, { method: 'POST' }); toast('Sync started'); state.syncing = true; setTimeout(() => { rerender(); watchSync(); }, 500); }
      if (b.dataset.edit) accountModal(platforms, accs.find((a) => a.id === Number(b.dataset.edit)));
      if (b.dataset.toggle) { const a = accs.find((x) => x.id === Number(b.dataset.toggle)); await api(`/accounts/${a.id}`, { method: 'PATCH', body: { enabled: !a.enabled } }); rerender(); }
    } catch (err) { fail(err); }
  });
}

// =====================================================================
// Settings
// =====================================================================
async function settings(view, stale) {
  const [s, tokens, auth] = await Promise.all([api('/settings'), api('/tokens'), api('/auth/status')]);
  if (stale()) return;
  const sw = (key, title, desc) => `<div class="setting"><div><div class="t">${title}</div><div class="d">${desc}</div></div><label class="switch"><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}><span></span></label></div>`;
  view.innerHTML = `
    <div class="page-h"><div><h1>Settings</h1></div></div>
    <div class="grid grid-2">
      <div class="stack">
        <div class="card"><div class="card-h"><h2>Sync schedule</h2><span class="badge accent" id="sched-label">${esc(s.schedule_label)}</span></div>
          <p class="small muted" style="margin-top:-6px">How often PlayTracker snapshots your playtime. Shorter intervals = more precise sessions; the difference between two snapshots becomes a session. Accounts can override this.</p>
          <form class="stack" id="sched-f">${scheduleFields(s)}</form>
          <div class="row" style="margin-top:14px"><button class="btn primary" id="sched-save">Save schedule</button></div>
        </div>
        <div class="card"><div class="card-h"><h2>Session detection</h2></div>
          <div class="setting"><div><div class="t">Minimum session</div><div class="d">Smaller deltas accumulate until they reach this many minutes</div></div><input class="input" type="number" min="0" max="120" data-num="min_session_minutes" value="${s.min_session_minutes}" style="width:90px"></div>
          <div class="setting"><div><div class="t">Wall-clock tolerance</div><div class="d">If a platform reports more playtime than time elapsed since the last sync (+ this many minutes), the excess is filed as history</div></div><input class="input" type="number" min="0" max="600" data-num="max_overage_minutes" value="${s.max_overage_minutes}" style="width:90px"></div>
          ${sw('use_recent_on_import', 'Use Steam “last 2 weeks” on import', 'On a first import, Steam’s two-week playtime becomes a real session instead of history')}
          ${sw('auto_merge_titles', 'Auto-group same titles', 'Same game on Steam/Xbox/PSN becomes one library entry (editions & platform tags ignored)')}
          <div class="setting"><div><div class="t">Week starts on</div></div><select class="input" data-num="week_starts_on" style="width:auto"><option value="1" ${s.week_starts_on === 1 ? 'selected' : ''}>Monday</option><option value="0" ${s.week_starts_on === 0 ? 'selected' : ''}>Sunday</option></select></div>
        </div>
        <div class="card"><div class="card-h"><h2>Appearance</h2></div>
          <div class="setting"><div class="t">Theme</div><div class="seg" id="theme">${['dark', 'light', 'auto'].map((t) => `<button data-t="${t}" class="${s.theme === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
          <div class="setting"><div class="t">Accent</div><div class="row">${['#7c5cff', '#22d3ee', '#34d399', '#f472b6', '#fb923c', '#facc15', '#ef4444'].map((c) => `<button class="btn icon sm" data-accent="${c}" style="background:${c};border-color:${s.accent === c ? 'var(--text)' : 'transparent'}" aria-label="${c}"></button>`).join('')}</div></div>
          <div class="setting"><div class="t">Default library sort</div><select class="input" data-str="default_library_sort" style="width:auto">${[['recent', 'Recently played'], ['playtime', 'Most played'], ['title', 'A → Z'], ['trending', 'Trending']].map(([v, l]) => `<option value="${v}" ${s.default_library_sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        </div>
      </div>
      <div class="stack">
        <div class="card" id="import"><div class="card-h"><h2>Import</h2></div>
          <p class="small muted" style="margin-top:-6px">Bring history from spreadsheets, other trackers, Switch, etc. CSV columns: <code>title</code>, <code>platform</code>, <code>playtime_hours</code> or <code>playtime_minutes</code>, <code>last_played</code>, <code>status</code>, <code>rating</code>, <code>notes</code>. JSON may include per-game <code>sessions</code>. Totals without sessions become <b>history</b> — counted in lifetime, never as a burst in your charts.</p>
          <label class="btn" style="cursor:pointer">${icon('upload')}Choose CSV / JSON<input type="file" id="imp-file" accept=".csv,.json,.txt,text/csv,application/json" hidden></label>
          <details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">…or paste</summary><textarea class="input mono" id="imp-text" placeholder="title,platform,playtime_hours,status&#10;Hades,switch,42,completed" style="margin-top:8px"></textarea><button class="btn sm" id="imp-go" style="margin-top:8px">Import pasted data</button></details>
          <div id="imp-r" class="small" style="margin-top:10px"></div>
        </div>
        <div class="card"><div class="card-h"><h2>Export & backup</h2></div>
          <div class="row wrap"><a class="btn" href="/api/v1/export" download>${icon('download')}JSON</a><a class="btn" href="/api/v1/export?format=csv" download>${icon('download')}CSV</a><a class="btn" href="/api/v1/backup" download>${icon('download')}SQLite backup</a></div>
          <p class="small muted">Your data lives in <code>/data/playtracker.db</code> inside the container — map it to <code>/mnt/user/appdata/playtracker</code> on Unraid.</p>
        </div>
        <div class="card"><div class="card-h"><h2>Notifications</h2></div>
          <div class="field"><label>Webhook URL</label><input class="input" data-str="webhook_url" value="${esc(s.webhook_url)}" placeholder="https://discord.com/api/webhooks/…"><div class="help">Discord and Slack get a formatted message; anything else gets JSON. Works with ntfy, Gotify bridges, Home Assistant, n8n…</div></div>
          <div class="setting"><div class="t">Send when</div><select class="input" data-str="webhook_on" style="width:auto"><option value="sessions" ${s.webhook_on === 'sessions' ? 'selected' : ''}>New sessions or errors</option><option value="always" ${s.webhook_on === 'always' ? 'selected' : ''}>Every sync</option><option value="errors" ${s.webhook_on === 'errors' ? 'selected' : ''}>Errors only</option></select></div>
        </div>
        <div class="card"><div class="card-h"><h2>Security</h2></div>
          ${auth.password_source === 'env' ? '<p class="small muted">Password is set with <code>PLAYTRACKER_PASSWORD</code>.</p>' : `
          <form class="stack" id="pw-f">${auth.auth_enabled ? '<div class="field"><label>Current password</label><input class="input" type="password" name="current" autocomplete="current-password"></div>' : '<p class="small muted" style="margin:0">No password set — anyone on your network can open PlayTracker. Set one before exposing it through a reverse proxy.</p>'}
            <div class="field"><label>${auth.auth_enabled ? 'New password (empty = remove)' : 'Password'}</label><input class="input" type="password" name="password" autocomplete="new-password"></div>
            <div><button class="btn">${auth.auth_enabled ? 'Update password' : 'Set password'}</button></div></form>`}
        </div>
        <div class="card"><div class="card-h"><h2>API tokens</h2><button class="btn sm" id="tok-new">${icon('key')}New token</button></div>
          <div class="list">${tokens.map((t) => `<div class="item"><div class="grow"><div class="ttl">${esc(t.name)}</div><div class="sub"><span class="mono">${esc(t.prefix)}…</span> · created ${fmtDate(t.created_at)} · ${t.last_used_at ? `used ${ago(t.last_used_at)}` : 'never used'}</div></div><button class="btn sm ghost danger" data-revoke="${t.id}">Revoke</button></div>`).join('') || '<p class="small muted">Tokens let scripts, Home Assistant, Homepage widgets or Playnite call the API. <a href="/api" data-link style="color:var(--accent)">API docs →</a></p>'}</div>
        </div>
      </div>
    </div>`;
  bindScheduleFields(view);
  const save = async (patch, msg = 'Saved') => {
    try { const r = await api('/settings', { method: 'PUT', body: patch }); state.settings = { ...state.settings, ...r }; $('#sched-label').textContent = r.schedule_label; toast(msg); return r; } catch (e) { fail(e); }
  };
  $('#sched-save').addEventListener('click', () => save(readSchedule(view), 'Schedule saved'));
  $$('[data-set]', view).forEach((el) => el.addEventListener('change', () => save({ [el.dataset.set]: el.checked })));
  $$('[data-num]', view).forEach((el) => el.addEventListener('change', () => save({ [el.dataset.num]: Number(el.value) })));
  $$('[data-str]', view).forEach((el) => el.addEventListener('change', () => save({ [el.dataset.str]: el.value })));
  $('#theme').addEventListener('click', async (e) => { const b = e.target.closest('[data-t]'); if (!b) return; $$('#theme button').forEach((x) => x.classList.toggle('on', x === b)); const r = await save({ theme: b.dataset.t }, 'Theme updated'); if (r) applyTheme(r); });
  $$('[data-accent]', view).forEach((b) => b.addEventListener('click', async () => { $$('[data-accent]', view).forEach((x) => { x.style.borderColor = x === b ? 'var(--text)' : 'transparent'; }); const r = await save({ accent: b.dataset.accent }, 'Accent updated'); if (r) applyTheme(r); }));
  const doImport = async (text, name = '') => {
    const out = $('#imp-r');
    out.innerHTML = '<span class="pulse muted">Importing…</span>';
    try {
      const isJson = name.endsWith('.json') || /^\s*[[{]/.test(text);
      const r = await api('/import', { method: 'POST', body: isJson ? JSON.parse(text) : text, headers: isJson ? {} : { 'Content-Type': 'text/csv' } });
      out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--good)"><b style="color:var(--good)">✓ Imported ${r.games} games</b> — ${r.entries_created} new, ${r.entries_updated} updated, ${r.sessions} sessions (${fmtMin(r.tracked_minutes)}), ${fmtHours(r.baseline_minutes)}h added as history${r.skipped ? `, ${r.skipped} rows skipped` : ''}.<div class="muted">Check <a href="/duplicates" data-link style="color:var(--accent)">Duplicates</a> if these games are also on a synced account.</div></div>`;
    } catch (e) { out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--bad);color:var(--bad)">${esc(e.message)}</div>`; }
  };
  $('#imp-file').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) doImport(await f.text(), f.name.toLowerCase()); e.target.value = ''; });
  $('#imp-go').addEventListener('click', () => { const t = $('#imp-text').value; if (t.trim()) doImport(t); });
  $('#pw-f')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api('/auth/password', { method: 'PUT', body: { current: e.target.current?.value, password: e.target.password.value } }); state.authEnabled = r.auth_enabled; toast(r.auth_enabled ? 'Password saved' : 'Password removed'); rerender(); } catch (err) { fail(err); }
  });
  $('#tok-new').addEventListener('click', () => modal({
    title: 'New API token',
    body: '<div class="field"><label>Name</label><input class="input" id="tok-name" placeholder="Home Assistant"></div><div id="tok-out"></div>',
    foot: '<button class="btn" data-close>Close</button><button class="btn primary" id="tok-go">Create</button>',
    onMount(el) {
      el.querySelector('#tok-go').addEventListener('click', async (ev) => {
        try {
          const r = await api('/tokens', { method: 'POST', body: { name: el.querySelector('#tok-name').value || 'API token' } });
          ev.target.remove();
          el.querySelector('#tok-out').innerHTML = `<p class="small muted">Copy it now — it won’t be shown again.</p><pre class="code" style="white-space:pre-wrap;word-break:break-all">${esc(r.token)}</pre><button class="btn sm" id="tok-copy">Copy</button>`;
          el.querySelector('#tok-copy').addEventListener('click', () => navigator.clipboard?.writeText(r.token).then(() => toast('Copied')));
          el.querySelector('[data-close]').addEventListener('click', () => rerender(), { once: true });
        } catch (e) { fail(e); }
      });
    },
  }));
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b) return;
    if (!(await confirmBox('Revoke this token? Anything using it will stop working.', { ok: 'Revoke', danger: true }))) return;
    await api(`/tokens/${b.dataset.revoke}`, { method: 'DELETE' }); rerender();
  });
  if (location.hash === '#import') setTimeout(() => $('#import').scrollIntoView({ behavior: 'smooth' }), 100);
}

// =====================================================================
// API docs
// =====================================================================
async function apidocs(view, stale) {
  const res = await fetch('/api/openapi.json');
  const spec = await res.json();
  if (stale()) return;
  const origin = location.origin;
  const groups = {};
  for (const [p, ops] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(ops)) (groups[op.tags[0]] ||= []).push({ p, m, op });
  view.innerHTML = `
    <div class="page-h"><div><h1>API</h1><p>Everything in the UI is available over a JSON REST API. <a href="/api/openapi.json" target="_blank" style="color:var(--accent)">OpenAPI spec ↗</a></p></div></div>
    <div class="grid grid-2">
      <div class="card"><h2>Authentication</h2><p class="small muted">Create a token under Settings → API tokens and send it as a header (or <code>?api_key=</code> for simple widgets). Without a UI password the API is open on your LAN.</p>
        <pre class="code">curl -H "Authorization: Bearer pt_…" ${esc(origin)}/api/v1/widget</pre></div>
      <div class="card"><h2>Push playtime (custom accounts)</h2><p class="small muted">Send lifetime totals from Playnite, a Switch spreadsheet or a script. PlayTracker diffs them like any other sync.</p>
        <pre class="code">curl -X POST ${esc(origin)}/api/v1/accounts/ID/report \\
  -H "Authorization: Bearer pt_…" -H "Content-Type: application/json" \\
  -d '{"games":[{"id":"zelda-totk","title":"Zelda: TotK","playtime_minutes":5230}]}'</pre></div>
      <div class="card"><h2>Log a session</h2><pre class="code">curl -X POST ${esc(origin)}/api/v1/sessions -H "Authorization: Bearer pt_…" \\
  -H "Content-Type: application/json" -d '{"game_id":12,"minutes":45,"note":"Chapter 3"}'</pre></div>
      <div class="card"><h2>Dashboards</h2><p class="small muted"><code>GET /api/v1/widget</code> returns flat numbers for Homepage / Homarr / Home Assistant REST sensors. Prometheus metrics live at <code>/metrics</code>.</p>
        <pre class="code">- PlayTracker:
    widget:
      type: customapi
      url: ${esc(origin)}/api/v1/widget?api_key=pt_…
      mappings:
        - field: week_hours
          label: This week
          suffix: h</pre></div>
    </div>
    <div class="card" style="margin-top:16px">${Object.entries(groups).map(([tag, ops]) => `<h2 style="margin:18px 0 8px;text-transform:capitalize">${esc(tag)}</h2>
      <table class="tbl">${ops.map(({ p, m, op }) => `<tr><td style="width:70px"><span class="method m-${m}">${m.toUpperCase()}</span></td><td><span class="mono">${esc(p)}</span><div class="small muted">${esc(op.summary)}</div>
        ${op.parameters.filter((x) => x.in === 'query').length ? `<div class="tiny dim">query: ${op.parameters.filter((x) => x.in === 'query').map((x) => `<code>${esc(x.name)}</code>${x.description ? ` ${esc(x.description)}` : ''}`).join(' · ')}</div>` : ''}
        ${op.requestBody ? `<div class="tiny dim">body: <code>${esc(op.requestBody.content['application/json'].schema.description)}</code></div>` : ''}</td></tr>`).join('')}</table>`).join('')}</div>`;
}

// =====================================================================
// More (mobile)
// =====================================================================
async function more(view) {
  const links = [['/duplicates', 'dupes', 'Duplicates', 'Merge editions, fix double counting'], ['/accounts', 'accounts', 'Accounts', 'Steam, Xbox, PlayStation, custom'], ['/settings', 'settings', 'Settings', 'Schedule, import/export, security'], ['/api', 'code', 'API', 'Tokens, push endpoint, docs'], [`/wrapped/${new Date().getFullYear()}`, 'gift', 'Year in review', 'Your year in games']];
  view.innerHTML = `<div class="page-h"><h1>More</h1></div><div class="card pad-0">${links.map(([href, ic, t, d]) => `<a class="item" href="${href}" data-link style="padding:14px 16px"><span style="width:36px;height:36px;border-radius:10px;background:var(--panel2);display:grid;place-items:center">${icon(ic).replace('<svg', '<svg width="19" height="19"')}</span><div class="grow"><div class="ttl">${t}</div><div class="sub">${d}</div></div></a>`).join('')}</div>
    ${state.authEnabled ? `<button class="btn" style="margin-top:16px;width:100%" data-action="logout">${icon('logout')}Log out</button>` : ''}`;
}

export const pages = { dashboard, library, game, sessions, stats, wrapped, duplicates, accounts, settings, apidocs, more };
