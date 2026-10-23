import {
  $, $$, esc, fmtMin, fmtHours, ago, fmtDate, fmtTime, dayLabel, plat, platDot, platTag, STATUSES, cover, icon,
  api, toast, fail, modal, confirmBox, navigate, rerender, state, watchSync, applyTheme,
} from './app.js';
import { barChart, sparkline, donut, heatmap, topList, platformLegend, bindTips } from './charts.js';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// a URL safe inside CSS url('...'): quotes, parentheses, backslashes and newlines percent-encoded
const cssUrl = (u) => String(u).replace(/['"()\\\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

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

// Tracked play stacks by platform; inferred pre-tracking history sits on top, hatched.
function stackedSeries(stats) {
  const plats = Object.keys(stats.series_by_platform || {});
  const est = stats.series_estimated || [];
  return stats.series.map((s, i) => ({
    label: seriesLabel(s.key, stats.range.group),
    value: s.minutes,
    tip: seriesTip(s.key, stats.range.group, s.minutes) + (est[i] ? ` (${fmtMin(est[i])} estimated from history)` : ''),
    stack: [...plats.map((p) => ({ key: p, value: stats.series_by_platform[p][i] || 0, color: plat(p).color })), ...(est[i] ? [{ key: 'estimated', value: est[i], color: 'url(#pt-hatch)' }] : [])],
  }));
}

function estimatedLegend(stats) {
  return stats.estimated_minutes ? `<span title="Playtime from before tracking began, dated from first/last played, achievements and release dates"><i class="dot hatch-dot"></i>Estimated history · ${fmtMin(stats.estimated_minutes, { short: true })}</span>` : '';
}

const CONF = {
  exact: ['live', 'good', 'Exact times from live presence or a manual log'],
  pinned: ['', '', 'End pinned to the platform\'s last-played time'],
  window: ['≈', '', 'Exact time unknown - spread across the sync window'],
  high: ['high', 'good', 'Dated from first and last played'],
  medium: ['medium', 'warn', 'Dated from achievements / recent play'],
  low: ['low', 'bad', 'Rough estimate - only one date known'],
};

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
  if (s.kind === 'estimate') return `<span class="badge" title="${esc(CONF[s.confidence]?.[2] || '')}">estimated · ${esc(s.confidence || '')}</span>`;
  if (s.source === 'manual') return '<span class="badge accent">manual</span>';
  if (s.note?.startsWith('Length estimated')) return '<span class="badge" title="The platform reports no playtime for this game and live presence missed this session: it ends at the reported last-played time, with your typical session length. Edit it if you know better.">≈ length</span>';
  if (s.confidence === 'exact') return `<span class="badge good" title="${CONF.exact[2]}">● live</span>${s.device ? `<span class="badge">${esc(s.device)}</span>` : ''}`;
  if (s.device) return `<span class="badge">${esc(s.device)}</span>${s.precise ? '' : '<span class="badge" title="Exact time unknown — spread across the sync window">≈</span>'}`;
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
  // the history of a synced game is like a synced session: it can only leave the stats
  const local = s.source !== 'sync' && !(s.source === 'inferred' && s.account_id);
  modal({
    title: esc(s.title),
    body: `<div class="stack">
      <div class="row wrap">${platTag(s.platform)} ${sourceBadge(s)} <span class="muted small">${esc(sessionWhen(s))}</span></div>
      ${!local ? `<div class="card small muted" style="padding:12px">${icon('info', '')} Synced from ${esc(plat(s.platform).label)}. ${s.source === 'inferred'
        ? `This is history from before tracking started: its <b>${fmtMin(s.minutes)}</b> are part of the platform's total, so it can only leave the stats.`
        : `The platform only reported <b>${fmtMin(s.minutes)}</b> played between ${fmtDate(s.window_start)} ${fmtTime(s.window_start)} and ${fmtDate(s.window_end)} ${fmtTime(s.window_end)}. You can pin the exact time below.`}</div>` : ''}
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
        // only times you changed: unchanged ones let new minutes move the start
        if (v('started').value && v('started').value !== v('started').defaultValue) body.started_at = new Date(v('started').value).getTime();
        if (v('ended').value && v('ended').value !== v('ended').defaultValue) body.ended_at = new Date(v('ended').value).getTime();
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
  const layout = parseLayout(state.settings?.dashboard_layout);
  const on = new Set(layout.filter((x) => x.on).map((x) => x.key));
  const year = new Date().getFullYear();
  const [heat, upNext] = await Promise.all([
    on.has('heatmap') ? api(`/stats/heatmap?year=${year}`).catch(() => null) : null,
    on.has('backlog') ? api('/games?status=playing,backlog&sort=recent&limit=16').catch(() => null) : null,
  ]);
  if (stale()) return;
  const noTracked = !wk.sessions && !mo.tracked_minutes;
  const html = {
    kpis: () => `<div class="kpis fade-in">
      ${kpi('This week', hoursVal(wk.total_minutes), noTracked ? 'Sessions appear after you play' : `${wk.sessions} sessions · ${wk.games_played} games`, sparkline(wk.series.map((s) => s.minutes)), 'feature')}
      ${kpi('Today', fmtMin(d.today.total_minutes), d.today.top_games[0] ? esc(d.today.top_games[0].title) : 'Nothing yet')}
      ${kpi('Last 30 days', hoursVal(mo.tracked_minutes), `${fmtMin(mo.avg_per_day_minutes)}/day avg${mo.estimated_minutes ? ` · +${fmtHours(mo.estimated_minutes)}h est.` : ''}`)}
      ${kpi('Streak', `${streak}<small> day${streak === 1 ? '' : 's'}</small>`, `Best: ${mo.streaks.longest} days`)}
      ${kpi('Lifetime', `${fmtHours(d.lifetime.total_minutes)}<small>h</small>`, `${d.lifetime.games_played} of ${d.lifetime.games} games played`)}
    </div>`,
    live: () => (d.playing_now?.length ? `<div class="card live-card"><div class="row wrap">${d.playing_now.map((p) => `<a class="row" href="${p.game_id ? `/game/${p.game_id}` : '/accounts'}" data-link style="min-width:0;flex:1">${cover({ title: p.title, cover_url: p.cover_url }, '', 'width:44px;')}<div style="min-width:0"><div class="small" style="color:var(--good);font-weight:700"><span class="live-dot"></span>Playing now · ${esc(plat(p.platform).label)}</div><div class="ttl ellipsis" style="font-weight:700">${esc(p.title)}</div><div class="tiny muted">for ${fmtMin(Math.max(1, p.minutes))}</div></div></a>`).join('')}</div></div>` : ''),
    jump: () => (d.now_playing.length ? `<div class="card"><div class="card-h"><h2>Jump back in</h2><a href="/library?sort=trending" data-link>See all</a></div>
      <div class="carousel">${d.now_playing.map((g) => `<a class="tile" href="/game/${g.id}" data-link>${cover(g)}<div class="t">${esc(g.title)}</div><div class="m">${g.platforms.map(platDot).join('')} ${fmtMin(g.recent_minutes)} · 2 wks</div></a>`).join('')}</div></div>` : ''),
    chart: () => `<div class="card"><div class="card-h"><h2>Last 30 days</h2><a href="/stats" data-link>Stats →</a></div>
        ${barChart(stackedSeries(mo), { height: 210 })}${platformLegend(mo.platforms, estimatedLegend(mo))}</div>`,
    top: () => `<div class="card"><div class="card-h"><h2>Top this month</h2></div>
        ${mo.top_games.length ? topList(mo.top_games, { coverFn: (g) => cover(g), limit: 6 }) : '<p class="muted">No play in the last 30 days.</p>'}</div>`,
    recent: () => `<div class="card"><div class="card-h"><h2>Recent sessions</h2><a href="/sessions" data-link>All sessions →</a></div>
        <div class="list" id="dash-recent">${d.recent_sessions.length ? d.recent_sessions.map((s) => sessionItem(s)).join('') : '<p class="muted">No sessions yet — they appear after the next sync detects new playtime.</p>'}</div></div>`,
    accounts: () => `<div class="card"><div class="card-h"><h2>Accounts</h2><a href="/accounts" data-link>Manage →</a></div>
        <div class="list">${d.accounts.map((a) => `<div class="item"><span class="plat-ic" style="width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:${plat(a.platform).hex};color:#fff;font-weight:800">${plat(a.platform).short}</span>
          <div class="grow"><div class="ttl ellipsis">${esc(a.name)}</div><div class="sub">${a.syncing ? '<span class="pulse">Syncing…</span>' : a.last_status === 'error' ? `<span style="color:var(--bad)">Error · ${esc(a.last_error || '')}</span>` : `Synced ${ago(a.last_sync_at)}`}</div></div>
          ${a.push ? '<span class="badge">API</span>' : `<span class="tiny muted nowrap">${a.next_sync_at ? `next ${ago(a.next_sync_at)}` : 'manual'}</span>`}</div>`).join('') || '<p class="muted">No accounts linked.</p>'}
        </div>
        <div class="row" style="margin-top:12px"><button class="btn sm" data-action="sync-all">${icon('sync')}Sync now</button><a class="btn sm ghost" href="/accounts?add=1" data-link>${icon('plus')}Add</a></div></div>`,
    heatmap: () => (heat ? `<div class="card"><div class="card-h"><h2>${year} at a glance</h2><a href="/stats" data-link>Stats →</a></div><div class="scroll-x">${heatmap(year, heat.days, { weekStartsOn: state.settings?.week_starts_on ?? 1, estimated: heat.estimated_days || {} })}</div></div>` : ''),
    backlog: () => (upNext ? `<div class="card"><div class="card-h"><h2>Up next</h2><a href="/library?status=playing" data-link>Library →</a></div>
      ${upNext.items.length ? `<div class="carousel">${upNext.items.map((g) => `<a class="tile" href="/game/${g.id}" data-link>${cover(g)}<div class="t">${esc(g.title)}</div><div class="m">${g.platforms.map(platDot).join('')} ${STATUSES[g.status]?.label || ''}</div></a>`).join('')}</div>`
        : '<p class="muted small" style="margin:0">Mark games as <b>Playing</b> or <b>Backlog</b> on their page and they show up here.</p>'}</div>` : ''),
  };
  // half-width sections sit side by side with the next half-width one; alone they go full width
  const blocks = [];
  const shown = layout.filter((x) => x.on && html[x.key]).map((x) => ({ ...x, out: html[x.key]() })).filter((x) => x.out);
  for (let i = 0; i < shown.length; i++) {
    const x = shown[i];
    const nx = shown[i + 1];
    if (DASH_SECTIONS[x.key].half && nx && DASH_SECTIONS[nx.key].half) { blocks.push(`<div class="grid grid-main">${x.out}${nx.out}</div>`); i++; } else blocks.push(x.out);
  }
  view.innerHTML = `
    <div class="page-h"><div><h1>${greeting}</h1><p>${d.new_sessions_24h ? `${d.new_sessions_24h} new session${d.new_sessions_24h > 1 ? 's' : ''} in the last day · ` : ''}Last sync ${ago(lastSync)}${Number.isFinite(nextSync) ? ` · next ${ago(nextSync)}` : ''}</p></div>
      <div class="row"><button class="btn ghost sm" id="dash-custom">${icon('settings')}Customize</button><button class="btn desk-only" id="dash-log">${icon('plus')}Log session</button></div></div>
    <div class="dash">
    ${d.errors_24h ? `<a class="card row" href="/system" data-link style="border-color:color-mix(in srgb,var(--bad) 45%,var(--line));padding:12px 16px">${icon('info')}<span class="grow"><b>${d.errors_24h} error${d.errors_24h > 1 ? 's' : ''}</b> in the last 24 hours</span><span class="small muted">View log →</span></a>` : ''}
    ${blocks.join('\n') || `<div class="card muted">Every section is hidden. <a href="#" id="dash-custom2" style="color:var(--accent)">Customize</a> to bring some back.</div>`}
    </div>
    <button class="fab" id="fab-log" aria-label="Log session">${icon('plus')}</button>`;
  bindTips(view);
  $('#dash-log')?.addEventListener('click', () => logSessionModal());
  $('#fab-log').addEventListener('click', () => logSessionModal());
  const custom = (e) => { e?.preventDefault(); layoutModal(); };
  $('#dash-custom').addEventListener('click', custom);
  $('#dash-custom2')?.addEventListener('click', custom);
  bindSessionEdits(view);
}

// ---------- home layout ----------
const DASH_SECTIONS = {
  kpis: { label: 'Stat cards', desc: 'This week, today, 30 days, streak, lifetime' },
  live: { label: 'Playing now', desc: 'While presence sees a game running' },
  jump: { label: 'Jump back in', desc: 'Played in the last two weeks' },
  chart: { label: 'Last 30 days', desc: 'Daily chart', half: true },
  top: { label: 'Top this month', desc: 'Most played games', half: true },
  recent: { label: 'Recent sessions', desc: '', half: true },
  accounts: { label: 'Accounts', desc: 'Sync status', half: true },
  heatmap: { label: 'Year heatmap', desc: 'Every day of this year' },
  backlog: { label: 'Up next', desc: 'Games marked Playing or Backlog' },
};
const DEFAULT_LAYOUT = 'kpis,live,jump,chart,top,recent,accounts,-heatmap,-backlog';

function parseLayout(str) {
  const out = String(str || DEFAULT_LAYOUT).split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => ({ key: x.replace(/^-/, ''), on: !x.startsWith('-') })).filter((x) => DASH_SECTIONS[x.key]);
  for (const k of Object.keys(DASH_SECTIONS)) if (!out.some((x) => x.key === k)) out.push({ key: k, on: false });
  return out;
}
const layoutString = (list) => list.map((x) => (x.on ? x.key : `-${x.key}`)).join(',');

/** Show/hide and reorder home sections; calls onChange(layoutString) on every edit. */
function layoutEditor(host, layout, onChange) {
  const list = layout.map((x) => ({ ...x }));
  const draw = () => {
    host.innerHTML = `<div class="layout-list">${list.map((x, i) => `<div class="layout-row ${x.on ? '' : 'off'}" data-i="${i}">
      <label class="switch"><input type="checkbox" data-on ${x.on ? 'checked' : ''} aria-label="Show ${esc(DASH_SECTIONS[x.key].label)}"><span></span></label>
      <div class="grow">${esc(DASH_SECTIONS[x.key].label)}${DASH_SECTIONS[x.key].desc ? ` <span class="d">· ${esc(DASH_SECTIONS[x.key].desc)}</span>` : ''}${DASH_SECTIONS[x.key].half ? ' <span class="d">· half width</span>' : ''}</div>
      <button class="btn icon ghost sm" data-up ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button class="btn icon ghost sm" data-down ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button></div>`).join('')}</div>
      <p class="tiny muted" style="margin:8px 0 0">Two half-width sections next to each other share a row.</p>`;
  };
  host.addEventListener('click', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.closest('[data-up]') && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    else if (e.target.closest('[data-down]') && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    else return;
    draw(); onChange(layoutString(list));
  });
  host.addEventListener('change', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row || !e.target.matches('[data-on]')) return;
    list[Number(row.dataset.i)].on = e.target.checked;
    draw(); onChange(layoutString(list));
  });
  draw();
}

async function saveSettings(patch) {
  const r = await api('/settings', { method: 'PUT', body: patch });
  state.settings = { ...state.settings, ...r };
  applyTheme(state.settings);
  return r;
}

function layoutModal() {
  let next = null;
  modal({
    title: 'Customize home',
    body: '<div id="lay-ed"></div>',
    foot: '<button class="btn ghost" id="lay-reset">Reset</button><span class="grow"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="lay-save">Save</button>',
    onMount(el, close) {
      let host = el.querySelector('#lay-ed');
      const mount = (layout) => {
        const fresh = host.cloneNode(false); // drop the old editor's listeners
        host.replaceWith(fresh); host = fresh;
        layoutEditor(host, layout, (v) => { next = v; });
      };
      mount(parseLayout(state.settings?.dashboard_layout));
      el.querySelector('#lay-reset').addEventListener('click', () => { next = DEFAULT_LAYOUT; mount(parseLayout(DEFAULT_LAYOUT)); });
      el.querySelector('#lay-save').addEventListener('click', async () => {
        try { if (next) await saveSettings({ dashboard_layout: next }); close(); rerender(); } catch (err) { fail(err); }
      });
    },
  });
}

// =====================================================================
// Library
// =====================================================================
function libState() {
  const q = new URLSearchParams(location.search);
  return {
    q: q.get('q') || '', platform: q.get('platform') || '', status: q.get('status') || '',
    sort: q.get('sort') || state.settings?.default_library_sort || 'recent', // the URL keeps any other sort
    view: state.settings?.library_view || 'grid',
    // "hide never-played" setting: show played games unless a filter in the URL says otherwise
    played: q.get('played') ?? (state.settings?.library_hide_unplayed ? 'true' : ''), hidden: q.get('hidden') || '',
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
        ${state.settings?.library_hide_unplayed ? `<button class="chip ${st.played === '' ? 'on' : ''}" data-played="all">Include unplayed</button>` : ''}
        <button class="chip ${st.hidden === 'only' ? 'on' : ''}" data-hidden="only">${icon('eyeoff', '').replace('<svg', '<svg width="14" height="14"')}Hidden</button>
      </div>
    </div>
    <div id="lib-items"></div>
    <div id="lib-more" style="height:40px"></div>
    <button class="fab" id="fab-add" aria-label="Add game">${icon('plus')}</button>`;

  // Server-side paging: only one page of games is ever in memory/DOM per scroll step,
  // so 50k-game libraries stay smooth on phones.
  const PAGE = 120;
  let total = 0; let loaded = 0; let maxMin = 1; let loading = false; let seq = 0;
  const box = $('#lib-items');
  const render = (items) => {
    const host = box.firstElementChild;
    host.insertAdjacentHTML('beforeend', items.map((g) => st.view === 'grid'
      ? `<a class="tile" href="/game/${g.id}" data-link><div style="position:relative">${cover(g)}<div class="flags">${g.favorite ? `<span class="badge">♥</span>` : '<span></span>'}${g.status !== 'unset' ? `<span class="badge">${STATUSES[g.status]?.label || g.status}</span>` : ''}</div>${g.minutes ? `<div class="bar"><i style="width:${Math.max(3, Math.sqrt(g.minutes / maxMin) * 100)}%"></i></div>` : ''}</div>
          <div class="t">${esc(g.title)}</div><div class="m">${g.platforms.filter((p) => p !== 'manual' || g.platforms.length === 1).map(platDot).join('')}<span>${g.minutes ? fmtMin(g.minutes, { short: g.minutes >= 600 }) : 'Unplayed'}</span>${g.entry_count > 1 ? `<span class="dim">· ${g.entry_count}×</span>` : ''}</div></a>`
      : `<a class="li" href="/game/${g.id}" data-link>${cover(g)}<div class="grow"><div class="ellipsis" style="font-weight:620">${esc(g.title)}</div><div class="small muted row" style="gap:6px">${g.platforms.map(platDot).join('')}${g.last_played_at ? `Played ${ago(g.last_played_at)}` : 'Never played'}${g.status !== 'unset' ? ` · ${STATUSES[g.status]?.label}` : ''}</div></div><div class="amt" style="font-weight:700">${fmtMin(g.minutes, { short: g.minutes >= 600 })}</div></a>`).join(''));
  };
  const params = (offset) => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort: st.sort });
    if (st.q) p.set('q', st.q);
    if (st.platform) p.set('platform', st.platform);
    if (st.status) p.set('status', st.status);
    if (st.played) p.set('played', st.played);
    if (st.hidden) p.set('hidden', st.hidden);
    return p;
  };
  const more = async () => {
    if (loading || loaded >= total) return;
    loading = true;
    const my = seq;
    try {
      const r = await api(`/games?${params(loaded)}`);
      if (my !== seq || stale()) return;
      loaded += r.items.length;
      render(r.items);
      if (!r.items.length) total = loaded;
    } finally { loading = false; }
    checkMore();
  };
  const load = async () => {
    const my = ++seq;
    loading = true;
    let r;
    try { r = await api(`/games?${params(0)}`); } finally { loading = false; }
    if (my !== seq || stale()) return;
    total = r.total; loaded = r.items.length; maxMin = Math.max(1, r.max_minutes || 1);
    $('#lib-count').textContent = `${r.total.toLocaleString()} game${r.total === 1 ? '' : 's'} · ${fmtHours(r.total_minutes)}h total`;
    if (!r.items.length) {
      box.innerHTML = platforms.games ? emptyState('search', 'No matches', 'Try a different search or filter.') : emptyState('library', 'Your library is empty', 'Connect an account to import your games, or add one manually.', `<a class="btn primary" href="/accounts?add=1" data-link>${icon('plus')}Connect an account</a>`);
      return;
    }
    box.innerHTML = st.view === 'grid' ? '<div class="lib-grid"></div>' : '<div class="card pad-0 lib-list"></div>';
    render(r.items);
    checkMore();
  };
  // keep loading while the sentinel is on screen (tall screens / fast scrolling)
  const checkMore = () => {
    const el = $('#lib-more');
    if (el && el.getBoundingClientRect().top < window.innerHeight + 800) more();
  };
  const sync = () => {
    const p = new URLSearchParams();
    for (const k of ['q', 'platform', 'status', 'hidden']) if (st[k]) p.set(k, st[k]);
    // the URL only records a played filter that differs from the default
    if (st.played !== (state.settings?.library_hide_unplayed ? 'true' : '')) p.set('played', st.played);
    if (st.sort !== (state.settings?.default_library_sort || 'recent')) p.set('sort', st.sort);
    history.replaceState({}, '', `/library${p.toString() ? `?${p}` : ''}`);
    load();
  };
  let t;
  $('#lib-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value.trim(); sync(); }, 180); });
  $('#lib-sort').addEventListener('change', (e) => { st.sort = e.target.value; sync(); });
  $$('[data-view]', view).forEach((b) => b.addEventListener('click', () => {
    st.view = b.dataset.view; $$('[data-view]', view).forEach((x) => x.classList.toggle('on', x === b)); sync();
    if (state.settings?.library_view !== st.view) saveSettings({ library_view: st.view }).catch(() => {}); // remembered on every device
  }));
  $('#lib-chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    if ('plat' in c.dataset) { st.platform = c.dataset.plat; $$('[data-plat]', view).forEach((x) => x.classList.toggle('on', x === c)); }
    if (c.dataset.status) { st.status = st.status === c.dataset.status ? '' : c.dataset.status; $$('[data-status]', view).forEach((x) => x.classList.toggle('on', x.dataset.status === st.status)); }
    if (c.dataset.played) {
      const def = state.settings?.library_hide_unplayed ? 'true' : '';
      st.played = c.dataset.played === 'all' ? (st.played === '' ? def : '') : (st.played === 'false' ? def : 'false');
      $$('[data-played]', view).forEach((x) => x.classList.toggle('on', x.dataset.played === 'all' ? st.played === '' : st.played === x.dataset.played));
    }
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
  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) more(); }, { rootMargin: '800px' });
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
  const pct = (m) => (s.total_minutes ? Math.max(0, Math.min(100, (m / s.total_minutes) * 100)) : 0);
  const rating = g.rating || 0;
  const hasSeries = g.series.some((x) => x.minutes > 0);
  view.innerHTML = `
    <a href="/library" data-link class="btn ghost sm" style="margin:-4px 0 10px -6px" onclick="if(history.length>1){event.preventDefault();event.stopPropagation();history.back()}">${icon('back')}Back</a>
    <div class="hero fade-in">
      ${g.cover_url ? `<div class="bg" style="background-image:url('${esc(cssUrl(g.cover_url))}')"></div>` : ''}
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
            <div class="split-bar"><i style="width:${pct(s.tracked_minutes)}%;background:var(--accent)"></i><i class="hatch-bg" style="width:${pct(s.estimated_minutes || 0)}%"></i><i style="width:${pct(s.baseline_minutes)}%;background:var(--line)"></i></div>
            <div class="legend"><span><i class="dot" style="background:var(--accent)"></i>Tracked ${fmtMin(s.tracked_minutes)}</span>${s.estimated_minutes ? `<span><i class="dot hatch-dot"></i>Estimated history ${fmtMin(s.estimated_minutes)}</span>` : ''}${s.baseline_minutes ? `<span><i class="dot" style="background:var(--line)"></i>Undated ${fmtMin(s.baseline_minutes)}</span>` : ''}</div>
          </div>
        </div>
        ${hasSeries ? `<div class="card"><div class="card-h"><h2>Playtime by month</h2></div>${barChart(g.series.slice(-24).map((x) => ({ label: seriesLabel(x.key, 'month'), value: x.minutes, tip: seriesTip(x.key, 'month', x.minutes) + (x.estimated ? ` (${fmtMin(x.estimated)} estimated)` : ''), stack: [{ value: x.minutes - (x.estimated || 0), color: 'var(--accent)' }, { value: x.estimated || 0, color: 'url(#pt-hatch)' }] })), { height: 180 })}</div>` : ''}
        <div class="card"><div class="card-h"><h2>Sessions</h2><button class="btn sm" id="g-log">${icon('plus')}Log session</button></div>
          <div class="list" id="g-sessions">${g.sessions.length ? groupByDay(g.sessions.filter((x) => x.kind === 'play')).map((grp, i) => (i === 25 ? '<button class="btn sm" id="g-more" style="margin:12px auto">Show all sessions</button><div id="g-rest" class="hide">' : '') + `<div class="day-h"><span>${dayLabel(grp.day)}</span><span>${fmtMin(grp.minutes)}</span></div>${grp.items.map((x) => sessionItem(x, { showGame: false })).join('')}`).join('') + (groupByDay(g.sessions.filter((x) => x.kind === 'play')).length > 25 ? '</div>' : '') : '<p class="muted">No sessions yet.</p>'}
          ${g.sessions_truncated ? `<a class="btn sm" href="/sessions?game_id=${g.id}" data-link style="margin:12px 0">All ${s.sessions.toLocaleString()} sessions →</a>` : ''}
          ${g.sessions.filter((x) => x.kind === 'baseline' && x.source !== 'inferred').map((x) => `<div class="item"><span class="dot" style="background:var(--line);width:10px;height:10px"></span><div class="grow"><div class="sub"><b style="color:var(--text)">${esc(plat(x.platform).label)}</b> ${esc(x.note || 'History')} · ${fmtDate(x.window_end)}</div></div><div class="amt muted">${fmtMin(x.minutes)}</div><button class="btn ghost sm icon" data-edit-session="${x.id}">${icon('edit')}</button></div>`).join('')}
          </div>
        </div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-h"><h2>Platforms & accounts</h2><button class="btn sm ghost" id="g-merge">${icon('merge')}Merge</button></div>
          <div class="list">${g.entries.map((e) => `<div class="item" style="${e.excluded ? 'opacity:.55' : ''}">
              ${e.icon_url ? `<img src="${esc(e.icon_url)}" width="32" height="32" style="border-radius:8px" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span style="width:32px;height:32px;border-radius:8px;display:grid;place-items:center;background:${plat(e.platform).hex};color:#fff;font-weight:800">${plat(e.platform).short}</span>`}
              <div class="grow"><div class="ttl ellipsis">${esc(e.account_name || plat(e.platform).label)}</div>
                <div class="sub">${platDot(e.platform)}${esc(e.title !== g.title ? e.title : plat(e.platform).label)}${e.excluded ? ' · <b>excluded</b>' : ''}</div>
                <div class="sub">${e.last_played_at ? `Played ${ago(e.last_played_at)}` : ''}${e.meta?.devices?.deck ? ` · Deck ${fmtMin(e.meta.devices.deck)}` : ''}${e.play_count ? ` · ${e.play_count} launches` : ''}${e.missing_since ? ` · <span style="color:var(--warn)">no longer in library since ${fmtDate(e.missing_since)}</span>` : ''}</div></div>
              <div class="amt">${fmtMin(e.playtime_min)}</div>
              <button class="btn ghost sm icon" data-entry-menu="${e.id}" aria-label="Entry options">${icon('more')}</button>
            </div>`).join('')}</div>
          ${g.entries.length > 1 ? '<p class="small muted" style="margin:8px 0 0">Owned on several platforms — totals are summed. Exclude an entry if two platforms report the same playtime.</p>' : ''}
        </div>
        ${g.entries.some((e) => e.history) ? `<div class="card"><div class="card-h"><h2>History before tracking</h2></div>
          <p class="small muted" style="margin-top:-6px">Playtime that existed before PlayTracker started watching. Instead of landing on import day it is dated from everything the platform reports, and shown hatched in charts.</p>
          ${g.entries.filter((e) => e.history).map((e) => historyBlock(e)).join('')}</div>` : ''}
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
  view.addEventListener('click', async (ev) => {
    const ed = ev.target.closest('[data-hist-edit]');
    if (ed) return historyModal(g.entries.find((x) => x.id === Number(ed.dataset.histEdit)), rerender);
    const md = ev.target.closest('[data-hist-mode]');
    const rs = ev.target.closest('[data-hist-reset]');
    const cf = ev.target.closest('[data-hist-confirm]');
    try {
      if (cf) { await api(`/entries/${cf.dataset.histConfirm}/history`, { method: 'PATCH', body: { confirm: true } }); toast('Kept as guessed'); rerender(); }
      if (md) { await api(`/entries/${md.dataset.entry}/history`, { method: 'PATCH', body: { mode: md.dataset.histMode } }); toast(md.dataset.histMode === 'undated' ? 'Removed from charts' : 'Charted'); rerender(); }
      if (rs) { await api(`/entries/${rs.dataset.histReset}/history`, { method: 'PATCH', body: { reset: true } }); toast('Back to automatic dating'); rerender(); }
    } catch (err) { fail(err); }
  });
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

function historyBlock(e) {
  const h = e.history;
  const ev = h.evidence || {};
  const conf = h.confidence;
  const chips = [
    ev.first_played_at && ['First played', fmtDate(ev.first_played_at, { year: 'numeric', month: 'short', day: 'numeric' })],
    ev.last_played_at && ['Last played', fmtDate(ev.last_played_at, { year: 'numeric', month: 'short', day: 'numeric' })],
    ev.play_count && ['Launches', ev.play_count],
    ev.recent_min && ['Last 2 weeks', fmtMin(ev.recent_min)],
    ev.anchors && ['Achievement times', ev.anchors],
    ev.date_added && ['Added', fmtDate(ev.date_added, { year: 'numeric', month: 'short', day: 'numeric' })],
    ev.release_at && ['Released', fmtDate(ev.release_at, { year: 'numeric', month: 'short', day: 'numeric' })],
  ].filter(Boolean);
  return `<div class="stack" style="padding:12px 0;border-top:1px solid var(--line)" data-hist="${e.id}">
    <div class="row between"><div class="row">${platDot(e.platform)}<b>${esc(e.account_name || plat(e.platform).label)}</b></div><b>${fmtMin(h.minutes, { short: h.minutes >= 600 })}</b></div>
    ${h.mode === 'undated' ? '<div class="small muted">Not charted — counts toward lifetime only.</div>'
      : h.window ? `<div class="small">Estimated <b>${fmtDate(h.window[0], { year: 'numeric', month: 'short', day: 'numeric' })} – ${fmtDate(h.window[1], { year: 'numeric', month: 'short', day: 'numeric' })}</b> · <span class="conf-${conf}">${conf} confidence</span>${h.undated ? ` · ${fmtMin(h.undated)} undated` : ''}</div>`
      : `<div class="small muted">No dates known — counts toward lifetime only.${e.platform === 'steam' && !h.enriched ? ' Looking up achievement times…' : ''}</div>`}
    ${(h.reasons || []).length ? `<div class="tiny muted">${h.reasons.map(esc).join(' · ')}</div>` : ''}
    ${chips.length ? `<div class="evidence">${chips.map(([k, v]) => `<span class="badge">${k}: ${esc(v)}</span>`).join('')}</div>` : ''}
    <div class="row wrap">${h.window && !h.manual && h.mode !== 'undated' && conf !== 'high' ? `<button class="btn sm" data-hist-confirm="${e.id}">${icon('check')}Looks right</button>` : ''}<button class="btn sm" data-hist-edit="${e.id}">${icon('edit')}Set dates</button>
      ${h.mode === 'undated' ? `<button class="btn sm ghost" data-hist-mode="auto" data-entry="${e.id}">Chart it</button>` : `<button class="btn sm ghost" data-hist-mode="undated" data-entry="${e.id}">Don’t chart</button>`}
      ${h.manual || h.mode === 'undated' ? `<button class="btn sm ghost" data-hist-reset="${e.id}">Reset to automatic</button>` : ''}</div>
  </div>`;
}

function historyModal(e, onDone) {
  const h = e.history;
  const d = (t) => (t ? new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '');
  modal({
    title: 'When did you play this?',
    body: `<p class="small muted" style="margin-top:0">${fmtMin(h.minutes)} on ${esc(plat(e.platform).label)} happened before tracking began. Set the period you played it and the hours are re-spread across it.</p>
      <div class="grid grid-2"><div class="field"><label>Started playing</label><input class="input" type="date" name="s" value="${d(h.manual?.start || h.window?.[0])}"></div>
      <div class="field"><label>Last played</label><input class="input" type="date" name="e" value="${d(h.manual?.end || h.window?.[1])}"></div></div>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="h-save">Save</button>',
    onMount(el, close) {
      el.querySelector('#h-save').addEventListener('click', async () => {
        const s = el.querySelector('[name=s]').value; const en = el.querySelector('[name=e]').value;
        try {
          await api(`/entries/${e.id}/history`, { method: 'PATCH', body: { first_played_at: s ? `${s}T12:00:00` : null, last_played_at: en ? `${en}T20:00:00` : null, mode: 'auto' } });
          close(); toast('History re-dated'); onDone();
        } catch (err) { fail(err); }
      });
    },
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
  const f = { platform: '', source: '', q: '', kind: 'play', game_id: new URLSearchParams(location.search).get('game_id') || '' };
  let cursor = null; let all = []; let total = 0; let totalMin = 0; let selecting = false; const sel = new Set();
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
    $('#s-more').innerHTML = cursor && all.length < total ? `<button class="btn" id="s-load">Load more</button>` : (all.length ? '<span class="tiny dim">That’s everything</span>' : '');
    $('#s-load')?.addEventListener('click', () => load(false));
    $('#s-count').innerHTML = `${total.toLocaleString()} session${total === 1 ? '' : 's'} · ${fmtMin(totalMin, { short: true })}${f.game_id && all[0] ? ` · ${esc(all[0].title)} <a href="/sessions" data-link style="color:var(--accent)">show all games</a>` : ''}`;
    $('#s-bulk-n').textContent = `${sel.size} selected`;
  };
  let seq = 0;
  const load = async (reset = true) => {
    // only the latest request may draw (fast filter clicks / typing overlap)
    const my = ++seq;
    const p = new URLSearchParams({ limit: '150', kind: f.kind });
    if (!reset && cursor) p.set('before', cursor);
    if (f.platform) p.set('platform', f.platform);
    if (f.source) p.set('source', f.source);
    if (f.q) p.set('q', f.q);
    if (f.game_id) p.set('game_id', f.game_id);
    const r = await api(`/sessions?${p}`);
    if (my !== seq || stale()) return;
    all = (reset ? [] : all).concat(r.items); total = r.total; totalMin = r.total_minutes; cursor = r.next;
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
  let estimates = q.get('estimates') || state.settings?.stats_estimates || 'include';
  const [years, lt] = await Promise.all([api('/stats/years'), api('/stats/lifetime')]);
  if (stale()) return;
  let heatYear = years[0];
  view.innerHTML = `
    <div class="page-h"><div><h1>Stats</h1><p title="Tracked = observed between syncs. Estimated = playtime from before tracking, dated from first/last played, achievements and release dates. Undated = no dates available (lifetime only).">Lifetime ${fmtHours(lt.total_minutes)}h · ${fmtHours(lt.tracked_minutes)}h tracked · ${fmtHours(lt.estimated_minutes || 0)}h estimated history · ${fmtHours(lt.baseline_minutes)}h undated</p></div>
      <a class="btn" href="/wrapped/${years[0]}" data-link>${icon('gift')}${years[0]} in review</a></div>
    <div class="toolbar"><div class="row wrap">
      <div class="seg" id="st-range">${[['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['365d', '12 months'], ...years.map((y) => [`year:${y}`, String(y)]), ['all', 'All time']].map(([v, l]) => `<button data-r="${v}" class="${range === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <label class="row small" style="gap:8px;cursor:pointer" title="Include playtime from before tracking began, dated by inference (hatched in charts)"><label class="switch"><input type="checkbox" id="st-est" ${estimates !== 'exclude' ? 'checked' : ''}><span></span></label>Estimated history</label>
      <select class="input" id="st-plat" style="width:auto"><option value="">All platforms</option>${lt.platforms.map((p) => `<option value="${esc(p.platform)}" ${platform === p.platform ? 'selected' : ''}>${esc(plat(p.platform).label)}</option>`).join('')}</select>
    </div></div>
    <div id="st-body"></div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Activity</h2><div class="seg" id="hm-year">${years.map((y) => `<button data-y="${y}" class="${y === heatYear ? 'on' : ''}">${y}</button>`).join('')}</div></div><div id="hm"></div></div>`;
  const body = $('#st-body');
  const load = async () => {
    const p = new URLSearchParams({ range, estimates });
    if (platform) p.set('platform', platform);
    history.replaceState({}, '', `/stats?${p}`);
    const s = await api(`/stats?${p}`);
    const maxWd = Math.max(1, ...s.weekday);
    const order = [1, 2, 3, 4, 5, 6, 0];
    const hasHours = s.hours.some((h) => h > 0);
    body.innerHTML = `
      <div class="kpis fade-in">
        ${kpi('Played', hoursVal(s.total_minutes), s.estimated_minutes ? `${fmtHours(s.tracked_minutes)}h tracked + ${fmtHours(s.estimated_minutes)}h estimated` : s.range.label, sparkline(s.series.map((x) => x.minutes)), 'feature')}
        ${kpi('Sessions', s.sessions, `avg ${fmtMin(s.avg_session_minutes)}`)}
        ${kpi('Games', s.games_played, `${s.days_played} days played`)}
        ${kpi('Daily avg', fmtMin(s.avg_per_day_minutes), s.busiest_day ? `best ${fmtDate(new Date(`${s.busiest_day.day}T12:00`).getTime())} · ${fmtMin(s.busiest_day.minutes)}` : '')}
        ${kpi('Streak', `${s.streaks.current}<small>d</small>`, `longest ${s.streaks.longest} days`)}
      </div>
      <div class="card" style="margin-top:16px"><div class="card-h"><h2>Playtime per ${s.range.group}</h2></div>${barChart(stackedSeries(s), { height: 230 })}${platformLegend(s.platforms, estimatedLegend(s))}</div>
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
    const h = await api(`/stats/heatmap?year=${heatYear}&estimates=${estimates}`);
    $('#hm').innerHTML = heatmap(heatYear, h.days, { weekStartsOn: state.settings?.week_starts_on ?? 1, estimated: h.estimated_days || {} });
    bindTips($('#hm'));
  };
  $('#st-range').addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (!b) return; range = b.dataset.r; $$('#st-range button').forEach((x) => x.classList.toggle('on', x === b)); load(); });
  $('#st-plat').addEventListener('change', (e) => { platform = e.target.value; load(); });
  $('#st-est').addEventListener('change', (e) => { estimates = e.target.checked ? 'include' : 'exclude'; load(); loadHeat(); });
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
    ${!w.total_minutes ? emptyState('gift', 'Nothing tracked yet', `No play is recorded for ${w.year} - neither tracked sessions nor dated history.`) : `
    <div class="wrapped fade-in">
      <div class="wcard g1"><div class="muted">You played</div><div class="big">${fmtHours(w.total_minutes)} hours</div><div class="muted">${w.sessions ? `across ${w.sessions} tracked sessions on ${w.days_played} days` : 'before tracking began'}${w.estimated_minutes ? ` · ${fmtHours(w.estimated_minutes)}h estimated from your history` : ''}</div></div>
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
      <div class="card"><div class="card-h"><h2>Possible double counting <span class="badge ${d.counts.double_counted ? 'warn' : ''}">${d.counts.double_counted.toLocaleString()}</span></h2></div>
        <p class="small muted" style="margin-top:-6px">The same game is counted from two sources that probably report the same playtime — e.g. an imported spreadsheet plus the live Steam account, or two accounts sharing a library.</p>
        <div class="list">${d.double_counted.map((x) => `<div class="item" style="flex-wrap:wrap">
          <a href="/game/${x.game.id}" data-link>${cover(x.game)}</a>
          <div class="grow"><a class="ttl" href="/game/${x.game.id}" data-link>${esc(x.game.title)}</a><div class="sub">${esc(x.reason)}</div>
            <div class="sub">${x.entries.map((e) => `${platDot(e.platform)}${esc(e.account_name || plat(e.platform).label)} ${fmtMin(e.playtime_min)}`).join(' &nbsp;·&nbsp; ')}</div></div>
          <div class="row"><button class="btn sm primary" data-exclude="${x.suggest_exclude}">Exclude ${esc((x.entries.find((e) => e.id === x.suggest_exclude)?.account_name) || plat(x.entries.find((e) => e.id === x.suggest_exclude)?.platform).label)}</button><button class="btn sm ghost" data-dismiss="${esc(x.key)}">Ignore</button></div></div>`).join('') || '<p class="muted">Nothing double counted. 🎉</p>'}</div>
      </div>
      <div class="card"><div class="card-h"><h2>Merge suggestions <span class="badge ${d.counts.suggestions ? 'accent' : ''}">${d.counts.suggestions.toLocaleString()}</span></h2>${d.suggestions.length > 1 ? '<button class="btn sm" id="merge-all">Merge all ≥ 95%</button>' : ''}</div>
        <p class="small muted" style="margin-top:-6px">Similar titles that weren’t grouped automatically (editions, subtitles, platform tags).${d.counts.suggestions > d.suggestions.length ? ` Showing the ${d.suggestions.length} strongest — resolve some and more appear.` : ''}</p>
        <div class="list">${d.suggestions.map((x) => `<div class="item" style="flex-wrap:wrap;gap:14px">
          ${gameCard(x.games[0])}<span class="badge">${Math.round(x.score * 100)}%</span>${gameCard(x.games[1])}
          <div class="row"><button class="btn sm primary" data-merge="${x.games[0].id}:${x.games[1].id}">${icon('merge')}Merge</button><button class="btn sm ghost" data-dismiss="${esc(x.key)}">Not the same</button></div></div>`).join('') || '<p class="muted">No suggestions.</p>'}</div>
      </div>
      <div class="card"><div class="card-h"><h2>Owned on multiple platforms <span class="badge">${d.counts.cross_platform.toLocaleString()}</span></h2></div>
        ${d.counts.cross_platform > d.cross_platform.length ? `<p class="small muted" style="margin-top:-6px">Showing the first ${d.cross_platform.length}.</p>` : ''}
        <div class="list">${d.cross_platform.map((x) => `<a class="item" href="/game/${x.game.id}" data-link>${cover(x.game)}<div class="grow"><div class="ttl ellipsis">${esc(x.game.title)}</div><div class="sub">${x.entries.map((e) => `<span style="${e.excluded ? 'text-decoration:line-through;opacity:.6' : ''}">${platDot(e.platform)} ${esc(e.account_name || plat(e.platform).label)} ${fmtMin(e.playtime_min)}</span>`).join(' &nbsp;')}</div></div></a>`).join('') || '<p class="muted">No games are grouped across platforms yet.</p>'}</div>
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

function capabilityTable(info) {
  const c = info.capabilities || {};
  const rows = [
    ['Lifetime playtime', c.lifetime], ['Recent playtime', c.recent], ['Last played', c.last_played], ['First played', c.first_played],
    ['Launch count', c.play_count], ['Devices', c.per_device], ['Live presence', c.presence], ['History dating', c.history_anchors], ['Rate limits', c.rate_limit],
  ];
  return `<table class="tbl cap-table" style="margin-top:8px">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v ? esc(v) : '<span class="dim">not available</span>'}</td></tr>`).join('')}</table>
    ${(c.limitations || []).length ? `<div class="small" style="margin-top:8px"><b>Limitations</b><ul style="margin:6px 0 0;padding-left:18px" class="muted">${c.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>` : ''}`;
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
          ${f.type === 'select' ? `<select class="input" name="cfg_${f.key}">${f.options.map((o) => `<option value="${esc(o)}" ${(a.config[f.key] ?? f.options[0]) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
            : `<input class="input" name="cfg_${f.key}" type="${f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}" value="${esc(a.config[f.key] ?? '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" spellcheck="false">`}
          ${f.help ? `<div class="help">${esc(f.help).replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')}</div>` : ''}</div>`).join('')}
        ${info.push ? `<div class="card small" style="padding:12px">Push totals with <code>POST /api/v1/accounts/${existing ? existing.id : ':id'}/report</code> — see the <a href="/api" data-link style="color:var(--accent)">API page</a>.</div>` : `
        <div class="setting" style="padding:0;border:0"><div><div class="t">Custom schedule</div><div class="d">Override the global sync schedule for this account</div></div><label class="switch"><input type="checkbox" id="acc-own" ${a.schedule ? 'checked' : ''}><span></span></label></div>
        <div id="acc-sched" class="stack ${a.schedule ? '' : 'hide'}">${scheduleFields(a.schedule || state.settings || {}, 'a_')}</div>`}
        <div id="acc-test-r" class="small"></div>
        <details><summary class="small muted" style="cursor:pointer">What ${esc(info.label)} provides &amp; its limits</summary>${capabilityTable(info)}</details>
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
            out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--good)"><b style="color:var(--good)">✓ Connected</b> — ${r.games} games, ${r.played} played, ${fmtHours(r.minutes)}h total.
              <div class="muted">${r.with_dates} of ${r.games} titles have play dates for dating your history${r.account_created_at ? ` · account created ${fmtDate(r.account_created_at, { year: 'numeric', month: 'short' })}` : ''}${r.presence ? ` · presence: ${esc(r.presence)}` : ''} · ${r.api_calls} API calls</div>
              ${r.sample?.length ? `<div class="muted">e.g. ${r.sample.map(esc).join(', ')}</div>` : ''}${r.warning ? `<div style="color:var(--warn)">${esc(r.warning)}</div>` : ''}</div>`;
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
      ${a.history_model ? `<div class="small muted" title="How ${esc(plat(a.platform).label)} reports history and how PlayTracker interprets it">Totals update ${esc(a.history_model.update)} · last played = ${esc(a.history_model.last_played)}${a.history_model.counters.length ? ` · ${esc(a.history_model.counters.join(', '))}` : ''}</div>` : ''}
      ${a.presence ? `<div class="small muted row" style="gap:6px">${a.presence.enabled ? (a.presence.error ? `<span style="color:var(--warn)">Presence: ${esc(a.presence.error)}</span>` : `<span class="live-dot" style="animation:none;background:${a.presence.last_poll ? 'var(--good)' : 'var(--dim)'}"></span>Live presence every ${Math.round(a.presence.interval_sec / 60) || 1} min${a.presence.last_poll ? ` · checked ${ago(a.presence.last_poll)}` : ''}`) : 'Live presence off'}</div>` : ''}
      ${a.hourly_limit ? `<div class="small muted">API this hour: ${a.api_usage_hour.calls}/${a.hourly_limit}<div class="meter" style="margin-top:4px"><i class="${a.api_usage_hour.calls > a.hourly_limit * 0.8 ? 'hot' : ''}" style="width:${Math.min(100, (a.api_usage_hour.calls / a.hourly_limit) * 100)}%"></i></div></div>` : ''}
      <div class="meta"><div><b>${a.games ?? 0}</b><span>games</span></div><div><b>${fmtHours(a.minutes ?? 0)}h</b><span>lifetime</span></div><div><b>${a.last_sync_at ? ago(a.last_sync_at) : 'never'}</b><span>${a.push ? 'last report' : a.next_sync_at && a.enabled ? `next ${ago(a.next_sync_at)}` : 'last sync'}</span></div></div>
      <div class="row wrap">
        ${a.push ? '' : `<button class="btn sm" data-sync="${a.id}" ${a.syncing ? 'disabled' : ''}>${icon('sync')}Sync now</button>`}
        <button class="btn sm ghost" data-edit="${a.id}">${icon('edit')}Edit</button>
        <button class="btn sm ghost" data-toggle="${a.id}">${a.enabled ? 'Pause' : 'Resume'}</button>
        <a class="btn sm ghost" href="/library?platform=${a.platform}" data-link>Games</a>
      </div></div>`).join('')}</div>`
    : `<div class="card">${emptyState('accounts', 'No accounts yet', 'Connect Steam, Xbox or PlayStation. The first sync imports your library and existing playtime as history; later syncs turn new playtime into sessions.', `<button class="btn primary" id="acc-add2">${icon('plus')}Connect an account</button>`)}</div>`}
    <details class="card" style="margin-top:16px"><summary style="cursor:pointer"><h2 style="display:inline">What each platform reports</h2> <span class="small muted">— and how PlayTracker uses it</span></summary>
      <div class="grid grid-2" style="margin-top:14px">${platforms.map((p) => `<div><div class="row" style="margin-bottom:6px"><span class="dot" style="background:${plat(p.id).color};width:10px;height:10px"></span><h3>${esc(p.label)}</h3></div><p class="small muted" style="margin:0 0 6px">${esc(p.notes)}</p>${p.history_model ? `<div class="small" style="margin-bottom:6px"><b>Reporting model:</b> totals update ${esc(p.history_model.update)}; last played = ${esc(p.history_model.last_played)}${p.history_model.counters.length ? `; extra counters: ${esc(p.history_model.counters.join(', '))}` : ''}${p.history_model.grouping ? `; versions grouped by ${esc(p.history_model.grouping)}` : ''}</div>` : ''}${capabilityTable(p)}</div>`).join('')}</div>
    </details>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Sync history</h2></div>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>When</th><th>Account</th><th>Result</th><th>Games</th><th>Sessions</th><th>Played</th><th>History</th></tr></thead><tbody>
      ${syncs.map((s) => `<tr><td class="nowrap">${fmtDate(s.started_at)} ${fmtTime(s.started_at)}<div class="tiny dim">${esc(s.trigger)}${s.initial ? ' · initial import' : ''}</div></td>
        <td class="nowrap">${platDot(s.platform || 'custom')} ${esc(s.account_name || '—')}</td>
        <td>${s.status === 'ok' ? '<span class="badge good">ok</span>' : s.status === 'running' ? '<span class="badge accent pulse">running</span>' : `<span class="badge ${s.status === 'warning' ? 'warn' : 'bad'}">${esc(s.status)}</span>`}${s.error ? `<div class="tiny muted" style="max-width:260px">${esc(s.error)}</div>` : ''}</td>
        <td>${s.games_seen}${s.games_new ? ` <span class="tiny muted">(+${s.games_new})</span>` : ''}${s.details?.api ? `<div class="tiny dim">${s.details.api.calls} calls${s.details.api.rate_limited ? ` · ${s.details.api.rate_limited} rate-limited` : ''} · ${((s.duration_ms || 0) / 1000).toFixed(1)}s</div>` : ''}</td><td>${s.sessions_created ? `<a href="/sessions" data-link style="color:var(--accent)">${s.sessions_created}</a>` : 0}</td><td>${fmtMin(s.minutes_added)}</td><td class="muted">${s.baseline_minutes ? fmtMin(s.baseline_minutes, { short: true }) : '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No syncs yet.</td></tr>'}
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
const ACCENTS = ['#7c5cff', '#22d3ee', '#34d399', '#f472b6', '#fb923c', '#facc15', '#ef4444', '#60a5fa'];
function segSetting(key, title, opts, s, desc = '') {
  return `<div class="setting"><div><div class="t">${title}</div>${desc ? `<div class="d">${desc}</div>` : ''}</div><div class="seg" data-seg="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(s[key]) === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>`;
}

async function settings(view, stale) {
  const [s, tokens, auth] = await Promise.all([api('/settings'), api('/tokens'), api('/auth/status')]);
  if (stale()) return;
  const sw = (key, title, desc) => `<div class="setting"><div><div class="t">${title}</div><div class="d">${desc}</div></div><label class="switch"><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''}><span></span></label></div>`;
  view.innerHTML = `
    <div class="page-h"><div><h1>Settings</h1></div></div>
    <div class="grid grid-2">
      <div class="stack">
        <div class="card" id="appearance"><div class="card-h"><h2>Appearance</h2><span class="tiny muted">saved for every device</span></div>
          ${segSetting('theme', 'Theme', [['dark', 'Dark'], ['black', 'Black'], ['light', 'Light'], ['auto', 'Auto']], s, 'Black is pure black for OLED screens')}
          <div class="setting"><div><div class="t">Accent</div></div><div class="row wrap" style="justify-content:flex-end">${ACCENTS.map((c) => `<button class="btn icon sm" data-accent="${c}" style="background:${c};border-color:${s.accent === c ? 'var(--text)' : 'transparent'}" aria-label="${c}"></button>`).join('')}
            <input type="color" class="swatch" id="accent-custom" value="${esc(s.accent)}" title="Custom color" aria-label="Custom accent color"></div></div>
          ${segSetting('ui_density', 'Density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], s, 'Compact fits more on screen')}
          ${segSetting('time_format', 'Time format', [['hm', '1h 5m'], ['decimal', '1.1h']], s)}
          <div class="setting"><div><div class="t">Start page</div><div class="d">What opens when you launch PlayTracker</div></div><select class="input" data-str="start_page" style="width:auto">${[['home', 'Home'], ['library', 'Library'], ['sessions', 'Sessions'], ['stats', 'Stats']].map(([v, l]) => `<option value="${v}" ${s.start_page === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <h3 style="margin:16px 0 2px">Library</h3>
          ${segSetting('library_view', 'Default view', [['grid', 'Covers'], ['list', 'List']], s)}
          ${segSetting('cover_size', 'Cover size', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']], s)}
          ${segSetting('cover_titles', 'Titles on covers', [['auto', 'No art'], ['always', 'Always'], ['never', 'Never']], s, '“No art” only labels games without a cover image')}
          <div class="setting"><div class="t">Default sort</div><select class="input" data-str="default_library_sort" style="width:auto">${[['recent', 'Recently played'], ['playtime', 'Most played'], ['title', 'A → Z'], ['trending', 'Trending'], ['added', 'Recently added'], ['rating', 'Top rated']].map(([v, l]) => `<option value="${v}" ${s.default_library_sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          ${sw('library_hide_unplayed', 'Hide never-played games', 'Owned games you have never launched stay out of the library unless you ask for them')}
          <h3 style="margin:16px 0 8px">Home sections</h3>
          <div id="set-layout"></div>
        </div>
        <div class="card"><div class="card-h"><h2>Sync schedule</h2><span class="badge accent" id="sched-label">${esc(s.schedule_label)}</span></div>
          <p class="small muted" style="margin-top:-6px">How often PlayTracker snapshots your playtime. Shorter intervals = more precise sessions; the difference between two snapshots becomes a session. Accounts can override this.</p>
          <form class="stack" id="sched-f">${scheduleFields(s)}</form>
          <div class="row" style="margin-top:14px"><button class="btn primary" id="sched-save">Save schedule</button></div>
        </div>
        <div class="card"><div class="card-h"><h2>Session detection</h2></div>
          <div class="setting"><div><div class="t">Minimum session</div><div class="d">Smaller deltas accumulate until they reach this many minutes</div></div><input class="input" type="number" min="0" max="120" data-num="min_session_minutes" value="${s.min_session_minutes}" style="width:90px"></div>
          <div class="setting"><div><div class="t">Wall-clock tolerance</div><div class="d">If a platform reports more playtime than time elapsed since the last sync (+ this many minutes), the excess is filed as history</div></div><input class="input" type="number" min="0" max="600" data-num="max_overage_minutes" value="${s.max_overage_minutes}" style="width:90px"></div>
          ${sw('use_recent_on_import', 'Use Steam “last 2 weeks” on import', 'On a first import, Steam’s two-week playtime becomes a real session instead of history')}
          ${sw('history_learn', 'Learn my play pattern', 'Games tracked from first session to last teach how you spread play over a game; pre-tracking history is dated the same way')}
          ${sw('auto_merge_titles', 'Auto-group same titles', 'Same game on Steam/Xbox/PSN becomes one library entry (editions & platform tags ignored)')}
          <div class="setting"><div><div class="t">Week starts on</div></div><select class="input" data-num="week_starts_on" style="width:auto"><option value="1" ${s.week_starts_on === 1 ? 'selected' : ''}>Monday</option><option value="0" ${s.week_starts_on === 0 ? 'selected' : ''}>Sunday</option></select></div>
        </div>
      </div>
      <div class="stack">
        <div class="card" id="import"><div class="card-h"><h2>Import</h2></div>
          <p class="small muted" style="margin-top:-6px">Bring history from spreadsheets, other trackers, Switch, etc. CSV columns: <code>title</code>, <code>platform</code>, <code>playtime_hours</code> or <code>playtime_minutes</code>, <code>last_played</code>, <code>status</code>, <code>rating</code>, <code>notes</code>. JSON may include per-game <code>sessions</code>. Totals without sessions become <b>history</b> — counted in lifetime, never as a burst in your charts.</p>
          <label class="btn" style="cursor:pointer">${icon('upload')}Choose CSV / JSON / GameTrack .zip<input type="file" id="imp-file" accept=".csv,.json,.txt,.zip,text/csv,application/json,application/zip" hidden></label>
          <p class="tiny muted" style="margin:8px 0 0">GameTrack: in GameTrack choose Settings → Export, then pick the .zip here. Unlock times date your synced games' history; hours no account here tracks are added as history; nothing is counted twice.</p>
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
    try { const r = await api('/settings', { method: 'PUT', body: patch }); state.settings = { ...state.settings, ...r }; $('#sched-label').textContent = r.schedule_label; applyTheme(state.settings); toast(msg); return r; } catch (e) { fail(e); }
  };
  $('#sched-save').addEventListener('click', () => save(readSchedule(view), 'Schedule saved'));
  $$('[data-set]', view).forEach((el) => el.addEventListener('change', () => save({ [el.dataset.set]: el.checked })));
  $$('[data-num]', view).forEach((el) => el.addEventListener('change', () => save({ [el.dataset.num]: Number(el.value) })));
  $$('[data-str]', view).forEach((el) => el.addEventListener('change', () => save({ [el.dataset.str]: el.value })));
  $$('[data-seg]', view).forEach((g) => g.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    $$('button', g).forEach((x) => x.classList.toggle('on', x === b));
    const r = await save({ [g.dataset.seg]: b.dataset.v }, 'Saved');
    if (r) applyTheme(state.settings);
  }));
  const setAccent = async (c) => {
    $$('[data-accent]', view).forEach((x) => { x.style.borderColor = x.dataset.accent === c ? 'var(--text)' : 'transparent'; });
    $('#accent-custom').value = c;
    const r = await save({ accent: c }, 'Accent updated');
    if (r) applyTheme(state.settings);
  };
  $$('[data-accent]', view).forEach((b) => b.addEventListener('click', () => setAccent(b.dataset.accent)));
  $('#accent-custom').addEventListener('input', (e) => document.documentElement.style.setProperty('--accent', e.target.value)); // live preview
  $('#accent-custom').addEventListener('change', (e) => setAccent(e.target.value));
  let layoutTimer;
  layoutEditor($('#set-layout'), parseLayout(s.dashboard_layout), (v) => { clearTimeout(layoutTimer); layoutTimer = setTimeout(() => save({ dashboard_layout: v }, 'Home layout saved'), 400); });
  // Imports preview first (dry run: nothing changes), then apply on confirm.
  const li = (cond, html) => (cond ? `<li>${html}</li>` : '');
  const fileSummary = (r) => `<ul class="small" style="margin:6px 0 0;padding-left:18px">
      ${li(r.merged_synced, `${r.merged_synced} game${r.merged_synced === 1 ? '' : 's'} your synced accounts already track: their totals stay, the file adds dates and details${r.sessions_restored ? ` and ${r.sessions_restored} exact past sessions (replacing estimates)` : ''}`)}
      ${li(r.entries_created, `${r.entries_created} new game${r.entries_created === 1 ? '' : 's'} / entries`)}
      ${li(r.entries_updated, `${r.entries_updated} existing manual or imported entr${r.entries_updated === 1 ? 'y' : 'ies'} joined (totals only grow, never shrink)`)}
      ${li(r.sessions, `${r.sessions} sessions (${fmtMin(r.tracked_minutes)})`)}
      ${li(r.baseline_minutes, `${fmtHours(r.baseline_minutes)}h added as history, dated from the file`)}
      ${li(r.details_filled, `${r.details_filled} games get a status, rating or notes they did not have (yours are never replaced)`)}
      ${li(r.skipped, `<span class="muted">${r.skipped} rows skipped (no title or unreadable)</span>`)}
      ${!r.merged_synced && !r.entries_created && !r.entries_updated && !r.details_filled ? '<li>Nothing new - everything in this file is already here.</li>' : ''}
    </ul>`;
  const gameTrackSummary = (r) => {
    const i = r.import || {};
    return `<ul class="small" style="margin:6px 0 0;padding-left:18px">
      ${li(true, `${r.gametrack_games.toLocaleString()} GameTrack games read`)}
      ${li(r.anchors, `${r.anchors.toLocaleString()} achievement / trophy times date history${r.anchored_entries ? ` of ${r.anchored_entries} synced games` : ''}`)}
      ${li(r.imported_titles, `${r.imported_titles} games with playtime no account here tracks: ${fmtHours(i.baseline_minutes || 0)}h added as history`)}
      ${li(r.skipped_synced, `${r.skipped_synced} games skipped: already counted by your synced accounts`)}
      ${li(r.statuses || r.ratings || r.covers, `${r.statuses} statuses, ${r.ratings} ratings, ${r.covers} covers filled in where empty`)}
      ${li(r.wishlist_added, `${r.wishlist_added} wish-listed games added`)}
      ${li(r.skipped_no_playtime, `<span class="muted">${r.skipped_no_playtime} collection games without playtime left out</span>`)}
    </ul>`;
  };
  const previewThenApply = async ({ label, send, summary }) => {
    const out = $('#imp-r');
    out.innerHTML = `<span class="pulse muted">Checking ${esc(label)}…</span>`;
    try {
      const p = await send(true);
      out.innerHTML = `<div class="card" style="padding:12px"><b>Preview: ${esc(label)}</b>${summary(p)}
        <div class="small muted" style="margin-top:6px">Nothing has changed yet. Imports join your library: they fill gaps and add history, never replace what you set.</div>
        <div class="row" style="margin-top:10px"><button class="btn primary sm" id="imp-apply">${icon('check')}Import</button><button class="btn sm ghost" id="imp-cancel">Cancel</button></div></div>`;
      $('#imp-cancel').addEventListener('click', () => { out.innerHTML = ''; });
      $('#imp-apply').addEventListener('click', async () => {
        out.innerHTML = '<span class="pulse muted">Importing…</span>';
        try {
          const r = await send(false);
          out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--good)"><b style="color:var(--good)">✓ Imported ${esc(label)}</b>${summary(r)}<div class="muted small" style="margin-top:6px">Importing the same file again changes nothing.</div></div>`;
        } catch (e) { out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--bad);color:var(--bad)">${esc(e.message)}</div>`; }
      });
    } catch (e) { out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--bad);color:var(--bad)">${esc(e.message)}</div>`; }
  };
  const doImport = (text, name = '') => {
    let body; let headers = {};
    const isJson = name.endsWith('.json') || /^\s*[[{]/.test(text);
    try { body = isJson ? JSON.parse(text) : text; } catch { $('#imp-r').innerHTML = '<div class="card" style="padding:12px;border-color:var(--bad);color:var(--bad)">That file is not valid JSON</div>'; return; }
    if (!isJson) headers = { 'Content-Type': 'text/csv' };
    return previewThenApply({ label: name || 'pasted data', send: (dry) => api(`/import${dry ? '?dry_run=true' : ''}`, { method: 'POST', body, headers }), summary: fileSummary });
  };
  const doGameTrack = (file) => previewThenApply({
    label: file.name, summary: gameTrackSummary,
    send: (dry) => api(`/import/gametrack${dry ? '?dry_run=true' : ''}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' } }),
  });
  $('#imp-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f && /\.zip$/i.test(f.name)) doGameTrack(f);
    else if (f) doImport(await f.text(), f.name.toLowerCase());
    e.target.value = '';
  });
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
  if (['#import', '#appearance'].includes(location.hash)) setTimeout(() => $(location.hash).scrollIntoView({ behavior: 'smooth' }), 100);
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
// System: health, error log, API usage, diagnostics
// =====================================================================
async function system(view, stale) {
  const [sys, logs] = await Promise.all([api('/system'), api('/logs?level=error,warn&limit=200')]);
  if (stale()) return;
  const mb = (b) => `${(b / 1048576).toFixed(b > 1e8 ? 0 : 1)} MB`;
  const up = (sec) => (sec > 86400 ? `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h` : sec > 3600 ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m` : `${Math.floor(sec / 60)}m`);
  const health = sys.errors_24h ? ['bad', `${sys.errors_24h} error${sys.errors_24h > 1 ? 's' : ''} in 24h`] : sys.warnings_24h ? ['warn', `${sys.warnings_24h} warning${sys.warnings_24h > 1 ? 's' : ''} in 24h`] : ['good', 'Healthy'];
  view.innerHTML = `
    <div class="page-h"><div><h1>System</h1><p>PlayTracker ${esc(sys.version)} · Node ${esc(sys.node)} · up ${up(sys.uptime_s)} · TZ ${esc(sys.tz)}${sys.tz_env ? '' : ' <span style="color:var(--warn)">(TZ not set)</span>'}</p></div>
      <div class="row"><span class="badge ${health[0]}" style="height:30px;padding:0 12px">${health[1]}</span><button class="btn" id="sys-dl">${icon('download')}Diagnostics</button></div></div>
    <div class="kpis">
      ${kpi('Errors (24h)', sys.errors_24h, `${sys.warnings_24h} warnings`)}
      ${kpi('Requests', sys.http?.requests?.toLocaleString() || 0, `${sys.http?.errors || 0} failed · ${sys.http?.slow || 0} slow`)}
      ${kpi('Database', mb(sys.db_bytes), `${sys.counts.sessions_tracked.toLocaleString()} sessions`)}
      ${kpi('Memory', `${sys.memory_mb}<small>MB</small>`, `heap ${sys.heap_mb} MB`)}
      ${kpi('Library', sys.counts.games.toLocaleString(), `${sys.counts.entries.toLocaleString()} entries`)}
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Accounts &amp; API usage</h2><a href="/accounts" data-link>Manage →</a></div>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>Account</th><th>Last sync</th><th>Next</th><th>API calls (1h / 24h)</th><th>Rate limited</th><th>Reporting model</th><th>Presence</th><th>History dating</th></tr></thead><tbody>
      ${sys.accounts.map((a) => `<tr>
        <td class="nowrap">${platDot(a.platform)} <b>${esc(a.name)}</b>${a.last_status === 'error' ? `<div class="tiny" style="color:var(--bad);max-width:260px;white-space:normal">${esc(a.last_error || '')}</div>` : ''}${a.failed_syncs_7d ? `<div class="tiny muted">${a.failed_syncs_7d} failed syncs in 7 days</div>` : ''}</td>
        <td class="nowrap">${a.last_sync ? `<span class="badge ${a.last_sync.status === 'ok' ? 'good' : a.last_sync.status === 'warning' ? 'warn' : 'bad'}">${esc(a.last_sync.status)}</span> ${ago(a.last_sync.started_at)}<div class="tiny dim">${esc(a.last_sync.trigger)} · ${((a.last_sync.duration_ms || 0) / 1000).toFixed(1)}s</div>` : 'never'}</td>
        <td class="nowrap">${a.push ? 'push' : a.next_sync_at ? ago(a.next_sync_at) : '—'}</td>
        <td class="nowrap">${a.api_usage_hour.calls}${a.hourly_limit ? ` / ${a.hourly_limit}` : ''} · ${a.api_usage_24h.calls}${a.api_usage_24h.errors ? `<div class="tiny" style="color:var(--warn)">${a.api_usage_24h.errors} failed</div>` : ''}
          ${a.api_quota?.remaining != null ? `<div class="tiny dim">service reports ${a.api_quota.remaining} left${a.api_quota.resetAt ? ` · resets ${fmtTime(a.api_quota.resetAt)}` : ''}</div>` : ''}
          ${a.api_quota?.blockedUntil > Date.now() ? `<div class="tiny" style="color:var(--warn)">paused until ${fmtTime(a.api_quota.blockedUntil)}</div>` : ''}</td>
        <td>${a.api_usage_24h.rate_limited ? `<span class="badge warn">${a.api_usage_24h.rate_limited}</span>` : '—'}</td>
        <td class="small" style="min-width:180px">${a.history_model ? `${esc(a.history_model.update)}<div class="tiny dim">last played = ${esc(a.history_model.last_played)}</div>` : '—'}</td>
        <td class="nowrap small">${a.presence ? (a.presence.enabled ? (a.presence.error ? `<span style="color:var(--warn)">${esc(a.presence.error)}</span>` : a.presence.last_poll ? `ok · ${ago(a.presence.last_poll)}` : 'waiting') : 'off') : '—'}</td>
        <td class="small">${!a.can_enrich ? '<span class="muted">from platform dates</span>' : a.enrichment_pending ? `${a.enrichment_pending} titles queued` : 'up to date'}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No accounts.</td></tr>'}
      </tbody></table></div>
      <div class="row wrap" style="margin-top:12px"><button class="btn sm" id="sys-reinfer">Re-date all history</button><a class="btn sm ghost" href="/history" data-link>Improve history →</a>${sys.accounts.filter((a) => a.enrichment_pending && a.can_enrich).map((a) => `<button class="btn sm ghost" data-enrich="${a.id}">Fetch history dates for ${esc(a.name)}</button>`).join('')}</div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Error log</h2><div class="row">
        <div class="seg" id="log-lvl"><button data-l="error,warn" class="on">Errors &amp; warnings</button><button data-l="error">Errors</button><button data-l="warn">Warnings</button></div>
        <button class="btn sm ghost" id="log-clear">${icon('trash')}Clear</button></div></div>
      <div class="search" style="margin-bottom:10px">${icon('search')}<input class="input" id="log-q" placeholder="Filter messages (account, game, error…)"></div>
      <div id="log-list"></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-h"><h2>Recent console output</h2><span class="tiny muted">same as docker logs</span></div><div class="console">${sys.console.map(esc).join('\n') || 'Nothing yet.'}</div></div>
      <div class="card"><div class="card-h"><h2>Storage</h2></div>
        <table class="tbl cap-table">${[['Database file', sys.data_dir || 'in-memory'], ['Size (incl. WAL)', mb(sys.db_bytes)], ['Tracked sessions', sys.counts.sessions_tracked.toLocaleString()], ['Estimated history chunks', sys.counts.sessions_estimated.toLocaleString()], ['Rollup rows', sys.counts.rollup_rows.toLocaleString()], ['Pending rollups', sys.counts.rollup_queue], ['Snapshots', sys.counts.snapshots.toLocaleString()], ['Presence spans', sys.counts.presence_spans.toLocaleString()], ['Stored log entries', sys.counts.logs.toLocaleString()], ['Running as uid', sys.uid ?? '—'], ['UI password', sys.auth_enabled ? 'on' : 'off']].map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('')}</table>
        <p class="tiny muted">Logs are also written to stdout (Unraid: container → Logs). Set <code>LOG_LEVEL=debug</code>, <code>LOG_FORMAT=json</code> or <code>PLAYTRACKER_LOG_FILE=/data/playtracker.log</code> for more.</p></div>
    </div>`;
  let level = 'error,warn'; let q = '';
  const drawLogs = (items) => {
    $('#log-list').innerHTML = items.length ? items.map((l) => `<details class="log-row"><summary><span class="lvl lvl-${l.level}">${l.level}</span><span class="tiny muted nowrap">${fmtDate(l.time)} ${fmtTime(l.time)}</span><span class="tiny dim nowrap">${esc(l.source)}</span><span class="grow small" style="word-break:break-word">${esc(l.message)}</span></summary>
      ${l.context ? `<pre class="code">${esc(JSON.stringify(l.context, null, 2))}</pre>` : ''}${l.stack ? `<pre class="code">${esc(l.stack)}</pre>` : ''}</details>`).join('')
      : `<div class="empty" style="padding:24px"><div class="em-ic">${icon('check')}</div><h2>All clear</h2><p>No ${level === 'warn' ? 'warnings' : 'errors'} logged.</p></div>`;
  };
  drawLogs(logs.items);
  const reload = async () => drawLogs((await api(`/logs?level=${level}&limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`)).items);
  $('#log-lvl').addEventListener('click', (e) => { const b = e.target.closest('[data-l]'); if (!b) return; level = b.dataset.l; $$('#log-lvl button').forEach((x) => x.classList.toggle('on', x === b)); reload(); });
  let t;
  $('#log-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); reload(); }, 250); });
  $('#log-clear').addEventListener('click', async () => { if (await confirmBox('Clear all stored log entries?', { ok: 'Clear', danger: true })) { await api('/logs', { method: 'DELETE' }); rerender(); } });
  $('#sys-reinfer').addEventListener('click', async () => { try { const r = await api('/history/reinfer', { method: 'POST' }); toast(`Re-dated history for ${r.entries} titles`); } catch (e) { fail(e); } });
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-enrich]');
    if (!b) return;
    try { await api(`/accounts/${b.dataset.enrich}/enrich`, { method: 'POST' }); toast('Fetching achievement times / release dates in the background'); } catch (err) { fail(err); }
  });
  $('#sys-dl').addEventListener('click', async () => {
    const [d, l, syncs] = await Promise.all([api('/system'), api('/logs?limit=1000'), api('/syncs?limit=200')]);
    const blob = new Blob([JSON.stringify({ generated_at: new Date().toISOString(), system: d, logs: l.items, syncs }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `playtracker-diagnostics-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  });
}

// =====================================================================
// Improve history: answer "when did you play this?" for the least certain games
// =====================================================================
const PERIODS = [['year', 'Whole year', 0, 11], ['q1', 'Jan – Mar', 0, 2], ['q2', 'Apr – Jun', 3, 5], ['q3', 'Jul – Sep', 6, 8], ['q4', 'Oct – Dec', 9, 11],
  ...['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => [`m${i}`, m, i, i])];

async function historyPage(view, stale) {
  const [rev, accts] = await Promise.all([api('/history/review?limit=30'), api('/accounts')]);
  if (stale()) return;
  const steam = (accts.items || accts).filter((a) => a.platform === 'steam');
  const m = rev.meter;
  const all = Object.values(m).reduce((a, x) => a + x, 0) || 1;
  const seg = [['high', 'var(--good)', 'High confidence'], ['manual', 'var(--accent)', 'Set by you'], ['medium', 'var(--warn)', 'Medium'], ['low', 'var(--bad)', 'Low'], ['undated', 'var(--line)', 'Undated']];
  const sure = Math.round(((m.high + m.manual + m.medium * 0.5) / all) * 100);
  const yearOpts = (it) => {
    const hi = new Date(Math.min(Date.now(), it.evidence.tracking_start || Date.now())).getFullYear();
    const lo = Math.max(2003, it.evidence.release_at ? new Date(it.evidence.release_at).getFullYear() : hi - 20);
    const guess = it.window ? new Date((it.window[0] + it.window[1]) / 2).getFullYear() : hi;
    const out = [];
    for (let y = hi; y >= lo; y--) out.push(`<option value="${y}" ${y === guess ? 'selected' : ''}>${y}</option>`);
    return out.join('');
  };
  const row = (it) => `<div class="item hist-row" data-entry="${it.entry_id}" style="align-items:flex-start;padding:14px 4px">
      ${cover({ title: it.title, cover_url: it.cover_url }, 'sm')}
      <div class="grow stack" style="gap:6px;min-width:0">
        <div class="row between wrap"><a class="ttl" href="/game/${it.game_id}" data-link>${esc(it.title)}</a><b class="nowrap">${fmtMin(it.minutes, { short: it.minutes >= 600 })}</b></div>
        <div class="tiny muted">${platDot(it.platform)} ${esc(it.account_name || plat(it.platform).label)} · ${it.window
          ? `now guessed <b>${fmtDate(it.window[0], { year: 'numeric', month: 'short' })} – ${fmtDate(it.window[1], { year: 'numeric', month: 'short' })}</b> <span class="conf-${it.confidence}">(${it.confidence})</span>`
          : 'no dates known'}${it.undated ? ` · ${fmtMin(it.undated)} undated` : ''}${it.evidence.last_played_at ? ` · last played ${fmtDate(it.evidence.last_played_at, { year: 'numeric', month: 'short', day: 'numeric' })}` : ''}</div>
        ${it.window ? `<div class="row wrap" style="gap:6px"><button class="btn sm" data-confirm>${icon('check')}Looks right</button><span class="tiny muted">or correct it:</span></div>` : ''}
        <div class="row wrap" style="gap:6px"><span class="small">Mostly played in</span>
          <select class="input sm" name="y" style="width:auto">${yearOpts(it)}</select>
          <select class="input sm" name="p" style="width:auto">${PERIODS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
          <label class="small row" style="gap:4px"><input type="checkbox" name="span"> until</label>
          <select class="input sm hide" name="y2" style="width:auto">${yearOpts(it)}</select>
          <button class="btn sm primary" data-answer>${icon('check')}Save</button>
          <button class="btn sm ghost" data-undated>Don’t chart</button>
          <button class="btn sm ghost" data-skip>Skip</button></div>
      </div></div>`;
  view.innerHTML = `
    <div class="page-h"><div><h1>Improve history</h1><p>Platforms only report lifetime totals, so play from before tracking is dated from whatever evidence exists. Answer roughly when you played the least certain games — one click each.</p></div></div>
    <div class="card"><div class="card-h"><h2>How well your history is dated</h2><b class="nowrap">${sure}% solid</b></div>
      <div class="meter" style="height:12px;display:flex">${seg.map(([k, c]) => (m[k] ? `<i style="width:${(m[k] / all) * 100}%;background:${c}" title="${k}"></i>` : '')).join('')}</div>
      <div class="row wrap" style="margin-top:10px;gap:14px">${seg.map(([k, c, l]) => `<span class="tiny"><span class="dot" style="background:${c}"></span> ${l} ${fmtHours(m[k], 0)}h</span>`).join('')}</div>
      <p class="tiny muted" style="margin-bottom:0">${rev.style ? `Dating uses your own play pattern, learned from ${rev.style.games} games tracked from start to finish.` : 'Once a few games have been tracked from first session to last, PlayTracker learns how you spread play over a game and dates history the same way.'}</p></div>
    ${steam.length ? `<div class="card" style="margin-top:16px"><div class="card-h"><h2>Steam purchase dates</h2><a class="small" href="https://store.steampowered.com/account/licenses/" target="_blank" rel="noopener">Open your licenses page ↗</a></div>
      <p class="small muted" style="margin-top:0">Steam never shares when you got a game, but its licenses page lists it. Select the whole table there (Ctrl+A works), copy, and paste it here — every matched game gets a start date for its history.</p>
      <div class="field"><textarea class="input" id="lic-text" rows="4" style="height:auto;padding:10px 12px;font-family:var(--mono, monospace);font-size:12.5px" placeholder="20 Nov, 2015	Counter-Strike: Global Offensive	Steam Store"></textarea></div>
      <div class="row wrap" style="margin-top:10px">${steam.length > 1 ? `<select class="input sm" id="lic-acc" style="width:auto">${steam.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>` : `<input type="hidden" id="lic-acc" value="${steam[0].id}">`}
        <button class="btn primary sm" id="lic-go">Import purchase dates</button><span class="tiny muted" id="lic-res"></span></div></div>` : ''}
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Least certain first</h2><span class="tiny muted">${rev.total} games · ${fmtHours(rev.uncertain_minutes, 0)}h uncertain</span></div>
      <div id="hist-list">${rev.items.map(row).join('') || `<div class="empty" style="padding:24px"><div class="em-ic">${icon('check')}</div><h2>Nothing left to answer</h2><p>All pre-tracking history is dated from solid evidence or by you.</p></div>`}</div>
      ${rev.total > rev.items.length ? '<button class="btn sm ghost" id="hist-more" style="margin-top:10px">Show more</button>' : ''}</div>`;
  let offset = rev.items.length;
  const done = (el, msg) => { el.style.opacity = '.45'; el.querySelectorAll('button,select,input').forEach((x) => { x.disabled = true; }); if (msg) toast(msg); };
  view.addEventListener('change', (e) => {
    if (e.target.name === 'span') e.target.closest('.hist-row').querySelector('[name=y2]').classList.toggle('hide', !e.target.checked);
  });
  view.addEventListener('click', async (e) => {
    const el = e.target.closest('.hist-row');
    if (el && e.target.closest('[data-skip]')) { el.remove(); return; }
    if (el && e.target.closest('[data-confirm]')) {
      try { await api(`/entries/${el.dataset.entry}/history`, { method: 'PATCH', body: { confirm: true } }); done(el, 'Kept as guessed'); } catch (err) { fail(err); }
      return;
    }
    if (el && e.target.closest('[data-undated]')) {
      try { await api(`/entries/${el.dataset.entry}/history`, { method: 'PATCH', body: { mode: 'undated' } }); done(el, 'Kept out of charts'); } catch (err) { fail(err); }
      return;
    }
    if (el && e.target.closest('[data-answer]')) {
      const y = Number(el.querySelector('[name=y]').value);
      const [, , m0, m1] = PERIODS.find(([k]) => k === el.querySelector('[name=p]').value);
      const y2 = el.querySelector('[name=span]').checked ? Math.max(y, Number(el.querySelector('[name=y2]').value)) : y;
      const start = new Date(y, m0, 1, 12);
      const end = new Date(Math.min(Date.now(), new Date(y2, m1 + 1, 0, 20).getTime()));
      try {
        await api(`/entries/${el.dataset.entry}/history`, { method: 'PATCH', body: { first_played_at: start.toISOString(), last_played_at: end.toISOString(), mode: 'auto' } });
        done(el, `Re-dated to ${fmtDate(start, { year: 'numeric', month: 'short' })} – ${fmtDate(end, { year: 'numeric', month: 'short' })}`);
      } catch (err) { fail(err); }
      return;
    }
    if (e.target.closest('#hist-more')) {
      const more = await api(`/history/review?limit=30&offset=${offset}`);
      offset += more.items.length;
      $('#hist-list').insertAdjacentHTML('beforeend', more.items.map(row).join(''));
      if (offset >= more.total || !more.items.length) e.target.closest('#hist-more').remove();
      return;
    }
    if (e.target.closest('#lic-go')) {
      const text = $('#lic-text').value.trim();
      if (!text) return toast('Paste the licenses table first', { bad: true });
      const url = (dry) => `/accounts/${$('#lic-acc').value}/licenses${dry ? '?dry_run=true' : ''}`;
      try {
        const p = await api(url(true), { method: 'POST', body: { text } });
        $('#lic-res').innerHTML = `Preview: ${p.licenses} licenses · ${p.matched} games matched · ${p.history_redated} would be re-dated${p.unmatched ? ` · ${p.unmatched} not in library (bundles, DLC, removed)` : ''} <button class="btn sm primary" id="lic-apply">Apply</button>`;
        $('#lic-apply').addEventListener('click', async () => {
          try {
            const r = await api(url(false), { method: 'POST', body: { text } });
            $('#lic-res').textContent = `${r.licenses} licenses read · ${r.matched} games matched · ${r.history_redated} re-dated`;
            toast(`Purchase dates added to ${r.matched} games`);
          } catch (err) { fail(err); }
        });
      } catch (err) { fail(err); }
    }
  });
}

// =====================================================================
// More (mobile)
// =====================================================================
async function more(view) {
  const links = [['/duplicates', 'dupes', 'Duplicates', 'Merge editions, fix double counting'], ['/accounts', 'accounts', 'Accounts', 'Steam, Xbox, PlayStation, custom'], ['/history', 'clock', 'Improve history', 'Date play from before tracking'], ['/system', 'info', 'System', 'Error log, API usage, diagnostics'], ['/settings', 'settings', 'Settings', 'Schedule, import/export, security'], ['/api', 'code', 'API', 'Tokens, push endpoint, docs'], [`/wrapped/${new Date().getFullYear()}`, 'gift', 'Year in review', 'Your year in games']];
  view.innerHTML = `<div class="page-h"><h1>More</h1></div><div class="card pad-0">${links.map(([href, ic, t, d]) => `<a class="item" href="${href}" data-link style="padding:14px 16px"><span style="width:36px;height:36px;border-radius:10px;background:var(--panel2);display:grid;place-items:center">${icon(ic).replace('<svg', '<svg width="19" height="19"')}</span><div class="grow"><div class="ttl">${t}</div><div class="sub">${d}</div></div></a>`).join('')}</div>
    ${state.authEnabled ? `<button class="btn" style="margin-top:16px;width:100%" data-action="logout">${icon('logout')}Log out</button>` : ''}`;
}

export const pages = { dashboard, library, game, sessions, stats, wrapped, duplicates, accounts, settings, apidocs, more, system, history: historyPage };
